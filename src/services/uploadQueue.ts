/**
 * Upload queue (Phase 1).
 *
 * The import loop used to live inside `Closet.tsx`, which tied three bad
 * things to the component: the work stopped when the sheet closed, progress
 * was React state the sheet owned, and cancel was a boolean flag that could
 * not interrupt a call already in flight. All three are fixed here — the
 * queue is a module, so the wearer can pick 20 photos, close the sheet, and
 * watch the closet fill up.
 *
 * Concurrency: 2 lanes. Decode moved to a worker, so lanes now mostly wait
 * on the tagging API; more lanes would just add memory pressure and a higher
 * chance of tripping a free-tier rate limit for no throughput gain.
 *
 * Cancellation is a real `AbortSignal`, propagated into the fetch calls, so
 * "Stop" frees the network immediately instead of waiting for the current
 * photo to finish tagging.
 */

import { prepareImage, blobToDataUrl } from "../lib/imagePipeline";
import { tagGarmentPhoto, taggingToGarment, type TaggingResult } from "./aiStylistService";
import { markStage } from "../lib/telemetry";
import type { Garment } from "../types";

/** Lanes are I/O-bound on the tagger, so this is about rate limits + memory. */
const LANES = 2;

/** Per-stage ceilings. Generous, but finite — no step may pend forever. */
const PREPARE_TIMEOUT_MS = 35_000;
const TAG_TIMEOUT_MS = 60_000;

export interface QueueItem {
  file: File;
  fileName: string;
}

export interface QueueCallbacks {
  /**
   * Fires as each item is tagged — the closet fills progressively.
   *
   * Both the tagging result and its converted garment are supplied: the
   * default path wants the garment for `addGarment`, while the review screen
   * wants the raw tags (and needs `fileName` for a stable sort).
   */
  onItem: (
    garment: Omit<Garment, "id" | "createdAt">,
    tags: TaggingResult,
    fileName: string
  ) => void;
  /**
   * 0..1 as a fraction, plus raw counts for the label.
   *
   * Optional: a caller that only cares about the final result should not be
   * forced to supply it, and a missing callback must not be able to abort the
   * import (see `safeCall`). It was required, and omitting it silently stranded
   * the import — measured on device.
   */
  onProgress?: (done: number, total: number) => void;
  /** One file failed; the rest of the import continues. */
  onError: (fileName: string, message: string) => void;
  /** All lanes drained. `added` counts successes. */
  onComplete: (added: number, total: number) => void;
}

export interface ImportHandle {
  /** Idempotent. Aborts in-flight network work and stops pulling files. */
  cancel: () => void;
}

/**
 * Invoke a consumer callback without letting it break the import.
 *
 * Every callback below is app-supplied, and a throw from one used to escape
 * the lane: `finishOne()` is called from inside the lane's `try`, so a throwing
 * `onProgress` was caught by the per-file handler, which then called `onError`
 * and `finishOne()` again — throwing a second time from the handler, this time
 * out of `runLane`. That rejected the lane, and the `Promise.all` catch reported
 * it via `onError` WITHOUT ever calling `onComplete`, so the caller's "import
 * finished" signal never arrived and the sheet's spinner could not be cleared.
 * Measured on device: garments were added successfully while the import
 * reported as never completing.
 *
 * A consumer's reporting bug must not be able to lose an already-imported
 * garment, and must never strand the caller without `onComplete`. The error is
 * still surfaced (logged + attributed to the file) rather than swallowed.
 */
function safeCall<T extends (...args: never[]) => unknown>(
  fn: T | undefined,
  ...args: Parameters<T>
): void {
  if (!fn) return;
  try {
    fn(...args);
  } catch (e) {
    console.warn("[uploadQueue] callback threw; import continues:", e);
  }
}

export class ImportCancelled extends Error {
  constructor() {
    super("Import cancelled");
    this.name = "ImportCancelled";
  }
}

const isAbort = (e: unknown): boolean =>
  e instanceof ImportCancelled ||
  (e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message)));

/**
 * Race a promise against a timeout that rejects, so a hung step can never
 * strand a lane (and with it the whole import) indefinitely.
 */
function deadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
  });
  return Promise.race([p, guard]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Start an import. Returns immediately; progress arrives via callbacks.
 *
 * Never rejects: a per-file failure is reported through `onError` and the
 * remaining files still import. Callbacks fire off the React tree, so the
 * sheet may already be closed.
 */
export function startImport(items: QueueItem[], cb: QueueCallbacks): ImportHandle {
  const controller = new AbortController();
  const { signal } = controller;
  const queue = [...items];
  const total = items.length;
  let done = 0;
  let added = 0;

  markStage("import:start", `files=${total}`);

  const finishOne = () => {
    done++;
    safeCall(cb.onProgress, done, total);
  };

  const runLane = async (): Promise<void> => {
    while (queue.length > 0) {
      if (signal.aborted) return;
      const item = queue.shift();
      if (!item) return;
      try {
        // Off-main-thread decode + encode. The prepared image also carries
        // pixel truth, so tagging gets the colors without a second decode.
        markStage("import:prepare-start", item.fileName);
        const prepared = await deadline(
          prepareImage(item.file, { timeoutMs: PREPARE_TIMEOUT_MS }),
          PREPARE_TIMEOUT_MS + 2_000,
          `Reading ${item.fileName}`
        );
        markStage("import:prepare-end", `${item.fileName} via=${prepared.via}`);

        if (signal.aborted) return;

        // Gemini needs inline base64, so this one consumer still gets a
        // data URL — but only this, instead of every downstream call.
        const dataUrl = await blobToDataUrl(prepared.blob);
        if (signal.aborted) return;

        markStage("import:tag-start", item.fileName);
        const tags: TaggingResult = await deadline(
          tagGarmentPhoto(prepared.blob, item.fileName, {
            dataUrl,
            signal,
            pixelTruth: {
              colors: prepared.colors,
              pattern: prepared.pattern,
              shares: prepared.shares,
            },
          }),
          TAG_TIMEOUT_MS,
          `Analyzing ${item.fileName}`
        );
        markStage("import:tag-end", item.fileName);
        if (signal.aborted) return;

        // Optimistic: the item lands now, tags and all, rather than waiting
        // for the whole batch to finish. The prepared hash rides along as the
        // recon cache identity (Phase 2) — no extra work, it is already here.
        safeCall(cb.onItem, taggingToGarment(tags, dataUrl, prepared.sha256), tags, item.fileName);
        added++;
        finishOne();
      } catch (e) {
        if (signal.aborted && isAbort(e)) {
          // A cancelled item is not a failure — don't report it as one, and
          // don't count it as progress.
          return;
        }
        safeCall(
          cb.onError,
          item.fileName,
          e instanceof Error ? e.message : "Could not analyze that photo"
        );
        finishOne();
      }
    }
  };

  void Promise.all(
    Array.from({ length: Math.min(LANES, Math.max(1, total)) }, runLane)
  )
    .catch((e: unknown) => {
      // Last-resort net. `runLane` is written not to throw, but a bug must
      // never leave the caller without its "finished" signal — that is what
      // strands a spinner. Report the failure, then fall through to onComplete.
      markStage("import:failed", e instanceof Error ? e.message : "unknown");
      safeCall(cb.onError, "import", e instanceof Error ? e.message : "Import failed");
    })
    .then(() => {
      markStage("import:drained", `added=${added}/${total}`);
      if (signal.aborted) return;
      // Always last, and always: `onComplete` is the only thing that lets the
      // caller clear its progress UI, so it must fire on both paths.
      safeCall(cb.onComplete, added, total);
    });

  return {
    cancel: () => {
      if (signal.aborted) return;
      markStage("import:cancel", `done=${done}/${total}`);
      controller.abort();
    },
  };
}

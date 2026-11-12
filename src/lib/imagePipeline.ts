/**
 * Image pipeline (Phase 1): decode → downscale → encode → pixel-truth,
 * off the main thread wherever the browser allows it.
 *
 * `prepareImage` is the one entry point. It prefers a dedicated worker
 * (`workers/compress.worker.ts`) and falls back to an equivalent main-thread
 * path when `createImageBitmap`/`OffscreenCanvas` are missing (older Safari,
 * some Android WebViews). Both paths run the same `pixelSample` core, so
 * behaviour does not fork by browser — only the thread does.
 *
 * Returns a real `Blob` rather than a data URL. The old pipeline handed
 * every consumer a ~1.3 MB base64 string that was then re-wrapped with
 * `fetch(dataUrl).blob()` at upload time — decoding the payload, inflating
 * it, and copying it again for nothing. A Blob passes by reference, so the
 * bytes cross the worker boundary once and never re-encode.
 *
 * `blobToDataUrl` still exists for callers that genuinely need a string
 * (Gemini's inline base64 payload, the `photo` field) — a deliberate,
 * bounded re-encode rather than the default.
 */

import {
  EMPTY_PIXEL_TRUTH,
  SAMPLE_MAX_DIM,
  pixelTruthFromImageData,
  type PixelTruth,
} from "./pixelSample";
import type { PrepareRequest, PrepareResponse } from "../workers/compress.worker";

export interface PrepareOptions {
  /** Longest edge after downscale. */
  maxSide?: number;
  /** Soft ceiling for the encoded JPEG. */
  maxBytes?: number;
  /** Milliseconds before the attempt is abandoned. */
  timeoutMs?: number;
}

export interface PreparedImage {
  blob: Blob;
  /** Base64 SHA-256 of the output bytes (Phase 2 recon-cache key input). */
  sha256: string;
  width: number;
  height: number;
  /** Pixel truth from the same decode — no second decode required. */
  colors: string[];
  pattern: "solid" | "striped" | "colorblock" | "other";
  shares: number[];
  /** Which path produced this — surfaced for diagnostics. */
  via: "worker" | "main";
}

export const DEFAULT_MAX_SIDE = 1024;
export const DEFAULT_MAX_BYTES = 1_000_000;

type Pending = {
  resolve: (v: PreparedImage) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * One worker, reused for every file. Spawning a worker per photo would
 * re-instantiate the module and cost more than it saves; a single lane also
 * keeps peak memory bounded during a bulk import.
 */
let worker: Worker | null = null;
let workerBroken = false;
const pending = new Map<string, Pending>();
let seq = 0;

function supportsOffscreen(): boolean {
  return (
    typeof Worker !== "undefined" &&
    typeof createImageBitmap === "function" &&
    typeof OffscreenCanvas !== "undefined" &&
    // convertToBlob is the one call the whole worker path rests on.
    typeof OffscreenCanvas.prototype.convertToBlob === "function"
  );
}

function getWorker(): Worker | null {
  if (workerBroken || !supportsOffscreen()) return null;
  if (worker) return worker;
  try {
    worker = new Worker(new URL("../workers/compress.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (ev: MessageEvent<PrepareResponse>) => {
      const res = ev.data;
      if (!res) return;
      const entry = pending.get(res.id);
      if (!entry) return;
      pending.delete(res.id);
      clearTimeout(entry.timer);
      if (res.ok) {
        entry.resolve({
          blob: res.blob,
          sha256: res.sha256,
          width: res.width,
          height: res.height,
          colors: res.colors,
          pattern: res.pattern,
          shares: res.shares,
          via: "worker",
        });
      } else {
        entry.reject(new Error(res.error));
      }
    });
    // A worker-level error (module load failure, CSP) must not wedge every
    // later import: fail the in-flight calls and demote to the main thread
    // for the rest of the session.
    worker.addEventListener("error", () => {
      workerBroken = true;
      const err = new Error("Image worker failed to start");
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(err);
      }
      pending.clear();
      worker?.terminate();
      worker = null;
    });
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** Diagnostic hook: drop the worker so the next call re-evaluates support. */
export function resetImagePipelineForTests(): void {
  worker?.terminate();
  worker = null;
  workerBroken = false;
  for (const [, entry] of pending) {
    clearTimeout(entry.timer);
    entry.reject(new Error("Image pipeline reset"));
  }
  pending.clear();
}

function runOnWorker(
  w: Worker,
  file: Blob,
  maxSide: number,
  maxBytes: number,
  timeoutMs: number
): Promise<PreparedImage> {
  const id = `img-${++seq}`;
  return new Promise<PreparedImage>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out reading that image"));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    const req: PrepareRequest = { id, file, maxSide, maxBytes };
    w.postMessage(req);
  });
}


/* --------------------------- main-thread path --------------------------- */

/** Structural subset shared by the two canvas implementations. */
type AnyCtx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

async function mainThreadPrepare(
  file: Blob,
  maxSide: number,
  maxBytes: number,
  timeoutMs: number
): Promise<PreparedImage> {
  // Keep the old decode-guard: some files (HEIC, truncated) fire neither
  // onload nor onerror, and a promise that pends forever used to strand the
  // upload spinner.
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      const timer = setTimeout(
        () => reject(new Error("Timed out reading that image")),
        timeoutMs
      );
      el.onload = () => {
        clearTimeout(timer);
        resolve(el);
      };
      el.onerror = () => {
        clearTimeout(timer);
        reject(new Error("Could not read that image"));
      };
      el.src = url;
    });

    const srcW = img.naturalWidth || img.width;
    const srcH = img.naturalHeight || img.height;
    if (srcW < 1 || srcH < 1) throw new Error("Image has no pixels");

    const paint = (c: AnyCtx, w: number, h: number) => {
      // JPEG has no alpha channel; transparent pixels would bake in black.
      c.fillStyle = "#ffffff";
      c.fillRect(0, 0, w, h);
    };

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");

    let scale = Math.min(1, maxSide / Math.max(srcW, srcH));
    let quality = 0.85;
    const encode = (): Promise<Blob> =>
      new Promise<Blob>((resolve, reject) => {
        try {
          canvas.width = Math.max(1, Math.round(srcW * scale));
          canvas.height = Math.max(1, Math.round(srcH * scale));
          paint(ctx, canvas.width, canvas.height);
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          // toBlob, not toDataURL: the base64 step was the expensive half of
          // the old path and nothing here needs a string.
          canvas.toBlob(
            (out) =>
              out ? resolve(out) : reject(new Error("Could not compress image")),
            "image/jpeg",
            quality
          );
        } catch (e) {
          reject(e instanceof Error ? e : new Error("Could not compress image"));
        }
      });

    let blob = await encode();
    while (blob.size > maxBytes && (quality > 0.5 || scale > 0.35)) {
      if (quality > 0.5) quality -= 0.12;
      else scale *= 0.78;
      blob = await encode();
    }

    let truth: PixelTruth = EMPTY_PIXEL_TRUTH;
    try {
      const sScale = Math.min(1, SAMPLE_MAX_DIM / Math.max(srcW, srcH));
      const sw = Math.max(1, Math.round(srcW * sScale));
      const sh = Math.max(1, Math.round(srcH * sScale));
      const sc = document.createElement("canvas");
      sc.width = sw;
      sc.height = sh;
      const sctx = sc.getContext("2d", { willReadFrequently: true });
      if (sctx) {
        paint(sctx, sw, sh);
        sctx.drawImage(img, 0, 0, sw, sh);
        truth = pixelTruthFromImageData(sctx.getImageData(0, 0, sw, sh).data, sw, sh);
      }
    } catch {
      /* sampling is an enhancement */
    }

    let sha256 = "no-subtlecrypto";
    try {
      if (typeof crypto !== "undefined" && crypto.subtle) {
        const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
        sha256 = Array.from(new Uint8Array(digest))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      }
    } catch {
      /* keep the marker */
    }

    return {
      blob,
      sha256,
      width: srcW,
      height: srcH,
      colors: truth.colors,
      pattern: truth.pattern,
      shares: truth.shares,
      via: "main",
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ------------------------------ entry point ---------------------------- */

/**
 * Decode, downscale, encode and pixel-sample one image, off the main thread
 * when the browser supports it.
 *
 * Rejects with a user-presentable message; callers surface it per file and
 * keep going, because one bad photo must not abandon a bulk import.
 */
export async function prepareImage(
  file: Blob,
  opts: PrepareOptions = {}
): Promise<PreparedImage> {
  const maxSide = opts.maxSide ?? DEFAULT_MAX_SIDE;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const w = getWorker();
  if (w) {
    try {
      return await runOnWorker(w, file, maxSide, maxBytes, timeoutMs);
    } catch {
      // Either this single file failed (corrupt/HEIC) or the worker died.
      // Retry once on the main thread: it costs a main-thread task only in
      // the rare case, and it means a worker hiccup can never fail an import
      // the fallback would have completed. A dead worker has already set
      // workerBroken, so later files go straight to the fallback.
      return mainThreadPrepare(file, maxSide, maxBytes, timeoutMs);
    }
  }
  return mainThreadPrepare(file, maxSide, maxBytes, timeoutMs);
}

/** Object URL for a prepared blob. Caller must revoke. */
export function previewUrl(blob: Blob): string {
  return URL.createObjectURL(blob);
}

/** Re-encode a prepared blob as a data URL, for the few string-only sinks. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Could not read image"));
    reader.readAsDataURL(blob);
  });
}

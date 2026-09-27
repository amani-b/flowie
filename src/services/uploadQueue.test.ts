/**
 * @vitest-environment jsdom
 *
 * Import-callback robustness tests.
 *
 * These exist because of a bug found on device, not by inspection: a consumer
 * that omitted the (then-required) `onProgress` callback had its import strand
 * forever. `finishOne()` called `cb.onProgress(...)` from inside the lane's
 * `try`, so the resulting TypeError was caught by the per-file handler, which
 * called `onError` and `finishOne()` again — throwing again, this time out of
 * the lane. The `Promise.all` catch reported it and returned WITHOUT calling
 * `onComplete`, so the caller's "import finished" signal never arrived and its
 * spinner could not be cleared, even though the garment had been added.
 *
 * The contract these lock down: consumer callbacks are app-supplied code, and a
 * throw in one must never cost an imported garment or strand the caller
 * without `onComplete`.
 *
 * `jsdom` because the pipeline touches `File`, `Blob`, `atob` and canvas; the
 * image pipeline degrades to its main-thread path when `OffscreenCanvas` and
 * Workers are unavailable, which is exactly the branch exercised here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startImport } from "./uploadQueue";

/** A 1x1 PNG, the smallest real image the pipeline will accept. */
const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function pngFile(name = "x.png"): File {
  const bin = atob(PNG_1PX.split(",")[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type: "image/png" });
}

/**
 * Drive one import and resolve with the outcome.
 *
 * Note what is NOT asserted here: that a photo actually decodes. jsdom has no
 * canvas/`createImageBitmap`, so `prepareImage` fails for every fixture and
 * `added` is 0 — the pipeline's image work is verified on device and in Phase
 * 1's worker tests, not here. What these tests pin down is the callback
 * contract, which is pure control flow and is exactly what broke.
 */
function runOnce(callbacks: Record<string, unknown>, timeoutMs = 30000) {
  return new Promise<{ complete: boolean; added: number; errors: string[] }>((res) => {
    const errors: string[] = [];
    const to = setTimeout(() => res({ complete: false, added: -1, errors }), timeoutMs);
    startImport([{ file: pngFile(), fileName: "x.png" }], {
      ...callbacks,
      onError: (f: string, m: string) => {
        errors.push(`${f}:${m}`);
        (callbacks.onError as ((f: string, m: string) => void) | undefined)?.(f, m);
      },
      onComplete: (added: number) => {
        clearTimeout(to);
        res({ complete: true, added, errors });
      },
    } as never);
  });
}

beforeEach(() => {
  // The queue is best-effort about console noise; keep the test output clean
  // without hiding real failures.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("import callbacks are consumer-safe", () => {
  it("still calls onComplete when onProgress is OMITTED (the device bug)", async () => {
    // The exact regression: `onProgress` used to be required, and a caller
    // that left it out hung forever with the garment already imported.
    const out = await runOnce({ onItem: () => {} });
    expect(out.complete).toBe(true);
    // Exactly one terminal signal for the one file — no double-report, no
    // silent loss.
    expect(out.errors).toHaveLength(1);
    expect(out.added + out.errors.length).toBe(1);
  });

  it("still calls onComplete when onProgress THROWS", async () => {
    const out = await runOnce({
      onItem: () => {},
      onProgress: () => {
        throw new Error("bad progress bar");
      },
    });
    expect(out.complete).toBe(true);
    expect(out.added + out.errors.length).toBe(1);
  });

  it("still calls onComplete when onItem throws", async () => {
    const out = await runOnce({
      onItem: () => {
        throw new Error("bad tile render");
      },
      onProgress: () => {},
    });
    expect(out.complete).toBe(true);
  });

  it("still calls onComplete when onError throws", async () => {
    const out = await runOnce({
      onItem: () => {},
      onProgress: () => {},
      onError: () => {
        throw new Error("bad toast");
      },
    });
    expect(out.complete).toBe(true);
  });

  it("reports every file exactly once, and never strands the caller", async () => {
    // The regression in its most damaging shape: files were being imported
    // while the caller was told nothing had finished. Each of the two files
    // must produce exactly one terminal signal and the caller must be
    // released — that is what stops a spinner hanging forever.
    const seen: string[] = [];
    let completed = false;
    await new Promise<boolean>((res) => {
      const to = setTimeout(() => res(false), 30000);
      startImport(
        [
          {
            file: new File([new Uint8Array([0, 1, 2])], "bad.png", { type: "image/png" }),
            fileName: "bad.png",
          },
          { file: pngFile("good.png"), fileName: "good.png" },
        ],
        {
          onItem: (_g, _t, fileName) => seen.push(`item:${fileName}`),
          onProgress: () => {},
          onError: (f) => seen.push(`err:${f}`),
          onComplete: () => {
            completed = true;
            clearTimeout(to);
            res(true);
          },
        }
      );
    });
    expect(completed).toBe(true);
    // One signal per file, for two files.
    expect(seen).toHaveLength(2);
  });
});

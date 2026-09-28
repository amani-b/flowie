/**
 * @vitest-environment jsdom
 *
 * Phase 6 — the main-thread half of the image pipeline.
 *
 * WHY THIS SHAPE. `prepareImage` picks between two implementations: a
 * `createImageBitmap` + `OffscreenCanvas` worker, and a main-thread
 * `Image`/`<canvas>` fallback. jsdom has neither the worker path nor a real 2d
 * context, so these tests deliberately pin the environment to the FALLBACK and
 * drive it with a fake `Image`. That is not a limitation to work around — the
 * fallback is the path that runs on older Safari and the path every import
 * lands on after the worker dies, and its failure modes are exactly the ones
 * Phase 1 had to fix:
 *
 *   - a decode that fires neither `onload` nor `onerror` (HEIC, truncated
 *     files) used to pend forever and strand the upload spinner;
 *   - a missing canvas used to surface as a hang rather than an error.
 *
 * The contract these assert is therefore about *error semantics*, not pixels:
 * every failure must reject promptly with a user-presentable message, and the
 * object URL must be released on the way out.
 *
 * What is NOT covered here, and cannot be: real downscaling, JPEG quality
 * stepping and pixel sampling need a working canvas. Those are covered by the
 * Phase 7 device matrix, not by this file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_SIDE,
  prepareImage,
  previewUrl,
  resetImagePipelineForTests,
} from "./imagePipeline";

/**
 * A controllable stand-in for `HTMLImageElement`. The real one in jsdom tries
 * to fetch the (fake) object URL and settles asynchronously, which would make
 * every assertion below a race. This fires exactly when a test says so.
 */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  width = 0;
  height = 0;

  private _src = "";

  /** Per-test decode behaviour. Default: never settles (the hang case). */
  static behaviour: (img: FakeImage) => void = () => {};
  static lastSrc = "";

  get src(): string {
    return this._src;
  }

  set src(value: string) {
    this._src = value;
    FakeImage.lastSrc = value;
    // Mirrors the browser: the handler is invoked after `src` is assigned,
    // and the assignment itself is synchronous.
    FakeImage.behaviour(this);
  }
}

/** A decode that succeeds far enough to reach the canvas step. */
function decodeWithPixels(w = 800, h = 600): (img: FakeImage) => void {
  return (img) => {
    img.naturalWidth = w;
    img.naturalHeight = h;
    img.onload?.();
  };
}

const createObjectURL = vi.fn(() => "blob:flowie-test");
const revokeObjectURL = vi.fn();

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

const file = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });

beforeEach(() => {
  resetImagePipelineForTests();
  FakeImage.behaviour = () => {};
  FakeImage.lastSrc = "";
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();

  vi.stubGlobal("Image", FakeImage);
  // Pin the premise rather than inherit it: with `createImageBitmap` absent the
  // module's `supportsOffscreen()` is false, so `prepareImage` always takes the
  // main-thread branch and these tests stay deterministic.
  vi.stubGlobal("createImageBitmap", undefined);

  URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
});

afterEach(() => {
  resetImagePipelineForTests();
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("environment premise", () => {
  it("has no worker path available, so the fallback is what runs below", () => {
    expect(typeof createImageBitmap).not.toBe("function");
    expect(typeof OffscreenCanvas).toBe("undefined");
  });
});

describe("main-thread fallback — failures reject instead of hanging", () => {
  it("times out when the decoder fires neither onload nor onerror", async () => {
    // The Phase 1 defect: HEIC and truncated files fired neither handler, so
    // the promise never settled and the import spinner hung forever.
    FakeImage.behaviour = () => {};

    await expect(prepareImage(file(), { timeoutMs: 25 })).rejects.toThrow(
      /Timed out reading that image/
    );
  });

  it("reports an undecodable file with a readable message", async () => {
    FakeImage.behaviour = (img) => img.onerror?.();

    await expect(prepareImage(file(), { timeoutMs: 200 })).rejects.toThrow(
      /Could not read that image/
    );
  });

  it("rejects a zero-pixel decode rather than encoding an empty canvas", async () => {
    FakeImage.behaviour = (img) => {
      img.naturalWidth = 0;
      img.naturalHeight = 0;
      img.onload?.();
    };

    await expect(prepareImage(file(), { timeoutMs: 200 })).rejects.toThrow(
      /Image has no pixels/
    );
  });

  it("surfaces a missing 2d context as an error, not a hang", async () => {
    // jsdom returns null here without the optional `canvas` package, which is
    // precisely the "canvas unavailable" case a stripped-down WebView hits.
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(null as never);
    FakeImage.behaviour = decodeWithPixels();

    try {
      await expect(prepareImage(file(), { timeoutMs: 200 })).rejects.toThrow(
        /Canvas unavailable/
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("releases the object URL on the failure path", async () => {
    FakeImage.behaviour = decodeWithPixels();

    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, "getContext")
      .mockReturnValue(null as never);
    try {
      await expect(prepareImage(file(), { timeoutMs: 200 })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }

    // The `finally` block is the only thing that stops a bulk import from
    // leaking one object URL per failed photo.
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:flowie-test");
  });
});

describe("module contract", () => {
  it("previewUrl returns an object URL for a prepared blob", () => {
    const url = previewUrl(new Blob([new Uint8Array([9])], { type: "image/jpeg" }));
    expect(url).toBe("blob:flowie-test");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
  });

  it("keeps the documented downscale and byte budgets", () => {
    // Shared with the compress worker and the upload path; a silent change here
    // would alter upload quality and Storage cost with nothing to catch it.
    expect(DEFAULT_MAX_SIDE).toBe(1024);
    expect(DEFAULT_MAX_BYTES).toBe(1_000_000);
  });

  it("survives repeated resets (the diagnostic hook is idempotent)", () => {
    expect(() => {
      resetImagePipelineForTests();
      resetImagePipelineForTests();
    }).not.toThrow();
  });
});

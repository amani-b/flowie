/**
 * Crop-math tests (accuracy track A3a).
 *
 * `bboxToPixels` is the whole crop contract in pure form: the model answers
 * in a 1000×1000 grid (larger dimension = 1000, smaller centered), and this
 * maps that onto real pixels with clamping. It is tested without a DOM on
 * purpose — the canvas half (`cropToBbox`) is verified on device, but the
 * math that decides WHICH pixels get sent to a paid renderer must be
 * provable here.
 *
 * `cropToBbox`'s failure path is tested too: any failure must resolve to
 * null so the caller sends the full photo (the stub era's behaviour), never
 * throw into the recon job.
 */
import { describe, expect, it, vi } from "vitest";
import { bboxToPixels, cropToBbox } from "./crop";

describe("bboxToPixels — grid to pixels", () => {
  it("maps a full-frame box on a landscape image", () => {
    // 2000×1000: scale 0.5, letterboxed on y (offY = 250).
    const r = bboxToPixels({ x: 0, y: 250, width: 1000, height: 500 }, 2000, 1000);
    expect(r).toEqual({ left: 0, top: 0, width: 2000, height: 1000 });
  });

  it("maps a full-frame box on a portrait image", () => {
    // 1000×2000: scale 0.5, letterboxed on x (offX = 250).
    const r = bboxToPixels({ x: 250, y: 0, width: 500, height: 1000 }, 1000, 2000);
    expect(r).toEqual({ left: 0, top: 0, width: 1000, height: 2000 });
  });

  it("maps a centered box on a square image", () => {
    const r = bboxToPixels({ x: 100, y: 100, width: 400, height: 400 }, 1000, 1000);
    expect(r).toEqual({ left: 100, top: 100, width: 400, height: 400 });
  });

  it("clamps an out-of-range box into the image instead of erroring", () => {
    const r = bboxToPixels({ x: -50, y: -50, width: 2000, height: 2000 }, 1000, 1000);
    expect(r).toEqual({ left: 0, top: 0, width: 1000, height: 1000 });
  });

  it("keeps a small box small (the renderer gets a real crop, not the frame)", () => {
    const r = bboxToPixels({ x: 400, y: 400, width: 200, height: 200 }, 1000, 1000);
    expect(r).toEqual({ left: 400, top: 400, width: 200, height: 200 });
  });

  it("clamps a box that runs off the right/bottom edge", () => {
    const r = bboxToPixels({ x: 900, y: 900, width: 400, height: 400 }, 1000, 1000);
    expect(r).toEqual({ left: 900, top: 900, width: 100, height: 100 });
  });
});

describe("cropToBbox — failure resolves to null, never throws", () => {
  it("returns null when fetch fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    const out = await cropToBbox("data:image/jpeg;base64,AA", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(out).toBeNull();
    vi.unstubAllGlobals();
  });

  it("returns null when the response is not OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 }))
    );
    const out = await cropToBbox("https://example.com/x.jpg", {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
    expect(out).toBeNull();
    vi.unstubAllGlobals();
  });
});

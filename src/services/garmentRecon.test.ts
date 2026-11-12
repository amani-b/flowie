/**
 * Analyzer contract tests (accuracy track A3a).
 *
 * The analyzer used to be a stub: every photo got the full frame, so a worn
 * or multi-garment photo reached the renderer un-cropped. It now asks Gemini
 * for the garment's bbox in the same 1000×1000 grid — with one hard rule
 * baked in and tested here: ANY analyzer failure degrades to the full-frame
 * stub. A worse crop costs render quality; a thrown analyzer would cost the
 * whole recon job (and with it the quota accounting around it).
 *
 * These run against the REAL module, so when a VITE_GEMINI_API_KEY is
 * present (as on the dev machine) the Gemini path is exercised with a mocked
 * fetch — never the network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  STUB_BBOX,
  analyzeGarmentPhoto,
  isStubBbox,
  reconClassFor,
} from "./garmentRecon";
import { geminiReady } from "./aiStylistService";

const bboxResponse = (json: unknown) =>
  new Response(JSON.stringify(json), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

const mockFetch = (json: unknown, status = 200) => {
  const fn = vi.fn(async () =>
    status === 200
      ? bboxResponse({
          candidates: [{ content: { parts: [{ text: JSON.stringify(json) }] } }],
        })
      : new Response("nope", { status })
  );
  vi.stubGlobal("fetch", fn);
  return fn;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reconClassFor", () => {
  it("maps recon-eligible categories and rejects the rest", () => {
    expect(reconClassFor("top")).toBe("upper");
    expect(reconClassFor("outerwear")).toBe("upper");
    expect(reconClassFor("bottom")).toBe("lower");
    expect(reconClassFor("dress")).toBe("dress");
    expect(reconClassFor("shoes")).toBeNull();
    expect(reconClassFor("accessory")).toBeNull();
  });
});

describe("analyzeGarmentPhoto — the gate", () => {
  it("returns null for photo-only categories, before any analyzer call", async () => {
    const fetchFn = mockFetch({ x: 0, y: 0, width: 100, height: 100 });
    const a = await analyzeGarmentPhoto({
      garmentId: "g1",
      category: "shoes",
      name: "sneakers",
      photoDataUrl: "data:image/jpeg;base64,AA",
    });
    expect(a).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("falls back to the full-frame stub without a photo", async () => {
    const a = await analyzeGarmentPhoto({
      garmentId: "g1",
      category: "bottom",
      name: "trousers",
    });
    expect(a).not.toBeNull();
    expect(isStubBbox(a!.boundingBox)).toBe(true);
    expect(a!.analyzer).toContain("stub-v0");
  });
});

describe("analyzeGarmentPhoto — the Gemini path", () => {
  it("uses the model bbox when one comes back (key configured)", async () => {
    if (!geminiReady) return; // no key on this machine — path untestable here
    mockFetch({ x: 100, y: 200, width: 600, height: 700 });
    const a = await analyzeGarmentPhoto({
      garmentId: "g1",
      category: "bottom",
      name: "trousers",
      photoDataUrl: "data:image/jpeg;base64,AA",
    });
    expect(a).not.toBeNull();
    expect(a!.analyzer).toBe("gemini-bbox-v1");
    expect(a!.boundingBox).toEqual({ x: 100, y: 200, width: 600, height: 700 });
    expect(a!.reconClass).toBe("lower");
    expect(a!.part).toBe("lowerbody");
  });

  it("falls back to the stub when the model returns garbage", async () => {
    if (!geminiReady) return;
    mockFetch({ x: "wide", y: 10, width: -5, height: 100 });
    const a = await analyzeGarmentPhoto({
      garmentId: "g1",
      category: "top",
      name: "tee",
      photoDataUrl: "data:image/jpeg;base64,AA",
    });
    expect(a).not.toBeNull();
    expect(isStubBbox(a!.boundingBox)).toBe(true);
    expect(a!.analyzer).toContain("stub-v0");
  });

  it("falls back to the stub on a non-OK response", async () => {
    if (!geminiReady) return;
    mockFetch({}, 429);
    const a = await analyzeGarmentPhoto({
      garmentId: "g1",
      category: "dress",
      name: "dress",
      photoDataUrl: "data:image/jpeg;base64,AA",
    });
    expect(a).not.toBeNull();
    expect(isStubBbox(a!.boundingBox)).toBe(true);
  });

  it("falls back to the stub when fetch itself throws", async () => {
    if (!geminiReady) return;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      })
    );
    const a = await analyzeGarmentPhoto({
      garmentId: "g1",
      category: "bottom",
      name: "trousers",
      photoDataUrl: "data:image/jpeg;base64,AA",
    });
    expect(a).not.toBeNull();
    expect(isStubBbox(a!.boundingBox)).toBe(true);
  });
});

describe("STUB_BBOX", () => {
  it("is the documented full-frame box", () => {
    expect(STUB_BBOX).toEqual({ x: 20, y: 20, width: 960, height: 960 });
    expect(isStubBbox({ ...STUB_BBOX })).toBe(true);
    expect(isStubBbox({ x: 0, y: 0, width: 960, height: 960 })).toBe(false);
  });
});

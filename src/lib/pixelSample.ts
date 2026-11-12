/**
 * Pixel-truth sampling core, shared by every image path.
 *
 * Extracted from `aiStylistService.extractColorsFromImage` so the worker
 * (OffscreenCanvas) and the main-thread fallback run the EXACT same
 * backdrop-estimation, garment-pixel filtering and `detectPattern`
 * classification. The logic is byte-for-byte the previous inline version —
 * moving it must not shift a single color or pattern verdict, because these
 * colors and the `hasPrint` flag downstream are what the reconstruction
 * pipeline renders from.
 *
 * Like `patternDetect`, this is DOM-free: callers pass an `ImageData`-shaped
 * buffer, which is all a worker and a canvas both have.
 */

import { detectPattern, rgbToHex, type PixelSample } from "./patternDetect";

type RGB = { r: number; g: number; b: number };

const rgbDist = (a: RGB, b: RGB) =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

/** Honest fallback when there are no usable pixels at all. */
export const EMPTY_PIXEL_TRUTH: PixelTruth = {
  colors: ["#6B7280"],
  pattern: "solid",
  shares: [1],
};

export interface PixelTruth {
  colors: string[];
  pattern: "solid" | "striped" | "colorblock" | "other";
  /** Share of garment pixels per entry in `colors` (same order, sums to ~1). */
  shares: number[];
}

/**
 * Downscale factor for the sampling pass. 128px keeps narrow stripes
 * resolvable (64px blurs them into the background tone entirely).
 */
export const SAMPLE_MAX_DIM = 128;

/**
 * Build garment-only pixel samples from an RGBA buffer.
 *
 * `data` is the raw `ImageData.data`; `w`/`h` its dimensions. Returns an
 * empty array when the frame yields nothing usable — callers substitute
 * `EMPTY_PIXEL_TRUTH`.
 */
export function samplesFromImageData(
  data: Uint8ClampedArray,
  w: number,
  h: number
): PixelSample[] {
  const pixelAt = (x: number, y: number): RGB => {
    const i = (y * w + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2] };
  };

  // Estimate the backdrop from the border pixels: garment photos are
  // typically shot centered on a plain backdrop (white, gray, etc.), so
  // the frame edge is a reasonable proxy for "not the garment" — a lot
  // more reliable than assuming the backdrop is always white.
  const border: RGB[] = [];
  const xStep = Math.max(1, Math.floor(w / 12));
  const yStep = Math.max(1, Math.floor(h / 12));
  for (let x = 0; x < w; x += xStep) {
    border.push(pixelAt(x, 0));
    border.push(pixelAt(x, h - 1));
  }
  for (let y = 0; y < h; y += yStep) {
    border.push(pixelAt(0, y));
    border.push(pixelAt(w - 1, y));
  }

  let backdrop: RGB | null = null;
  if (border.length > 0) {
    const sum = border.reduce(
      (acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }),
      { r: 0, g: 0, b: 0 }
    );
    const mean: RGB = {
      r: sum.r / border.length,
      g: sum.g / border.length,
      b: sum.b / border.length,
    };
    const agree = border.filter((p) => rgbDist(p, mean) < 40).length;
    // Only trust this as a real backdrop if most border samples agree —
    // otherwise the garment likely fills the frame and there's nothing
    // to subtract (subtracting a "backdrop" here would eat the garment).
    if (agree / border.length > 0.6) backdrop = mean;
  }

  const isGarmentPx = (r: number, g: number, b: number, a: number): boolean => {
    if (a < 128) return false;
    if (backdrop && rgbDist({ r, g, b }, backdrop) < 42) return false;
    // Safety net when no clear backdrop was detected: pure white
    // studio blowout right at the edge of exposure is still almost
    // never the garment itself.
    if (!backdrop && r > 250 && g > 250 && b > 250) return false;
    return true;
  };

  // Collect garment-only samples (backdrop/transparent skipped) with
  // normalized positions, then classify with the tested pure core.
  const pos = (x: number, y: number) => ({
    x: x / Math.max(1, w - 1),
    y: y / Math.max(1, h - 1),
  });
  const samples: PixelSample[] = [];
  const unfiltered: PixelSample[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 128) continue;
      unfiltered.push({ r, g, b, ...pos(x, y) });
      if (!isGarmentPx(r, g, b, a)) continue;
      samples.push({ r, g, b, ...pos(x, y) });
    }
  }
  // Low-yield guard: white/cream garments on near-white backdrops get
  // eaten by subtraction (white stripes read as "background"). If the
  // filter kept less than ~a third of the frame, the "backdrop" is
  // probably the garment itself — analyze everything instead.
  return samples.length >= w * h * 0.35 ? samples : unfiltered;
}

/** Classify a prepared sample set into colors + pattern. */
export function analyzeSamples(samples: PixelSample[]): PixelTruth {
  if (samples.length === 0) return EMPTY_PIXEL_TRUTH;
  const analysis = detectPattern(samples);
  const colors = analysis.colors.map(rgbToHex);
  const shares = analysis.colors.map((c) => c.share);
  return {
    colors: colors.length > 0 ? colors : ["#6B7280"],
    pattern: analysis.pattern,
    shares: shares.length > 0 ? shares : [1],
  };
}

/** One-shot: RGBA buffer in, colors + pattern out. */
export function pixelTruthFromImageData(
  data: Uint8ClampedArray,
  w: number,
  h: number
): PixelTruth {
  return analyzeSamples(samplesFromImageData(data, w, h));
}

/**
 * Garment-photo cropping for reconstruction.
 *
 * The analyzer (garmentRecon.analyzeGarmentPhoto) returns where the garment
 * is; this module turns that into the pixels the renderer actually receives.
 * The renderers were measured on crops (the offline recon harness has always
 * cropped caller-side before calling a Space), so a worn or multi-garment
 * photo must be cropped to the garment before it is uploaded — the
 * "crop-first contract" the edge function documents.
 *
 * Two halves:
 *   `bboxToPixels` — pure 1000-grid → pixel math (unit-tested without a DOM).
 *   `cropToBbox`   — fetch → decode → canvas → JPEG data URL. Returns null
 *                    on ANY failure so the caller can send the full photo
 *                    instead: the stub's behaviour is the safe fallback.
 */

import type { ReconBbox } from "../services/garmentRecon";

/** Clamp helper shared by both halves. */
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/**
 * Map a 1000×1000-normalized bbox onto real image pixels.
 *
 * Grid convention (same one the model is prompted with): the image is scaled
 * so its LARGER dimension is 1000 and the smaller is centered within the
 * grid. Returns pixel rects clamped into the image, so a slightly
 * out-of-range answer degrades to a tighter crop instead of an error.
 */
export function bboxToPixels(
  bbox: ReconBbox,
  imgW: number,
  imgH: number
): { left: number; top: number; width: number; height: number } {
  const scale = 1000 / Math.max(imgW, imgH);
  const offX = (1000 - imgW * scale) / 2;
  const offY = (1000 - imgH * scale) / 2;
  const left = clamp(Math.round((bbox.x - offX) / scale), 0, Math.max(0, imgW - 1));
  const top = clamp(Math.round((bbox.y - offY) / scale), 0, Math.max(0, imgH - 1));
  const right = clamp(Math.round((bbox.x + bbox.width - offX) / scale), left + 1, imgW);
  const bottom = clamp(Math.round((bbox.y + bbox.height - offY) / scale), top + 1, imgH);
  return { left, top, width: right - left, height: bottom - top };
}

/**
 * Crop `imageUrl` (data URL or http(s)) to `bbox` and re-encode as JPEG.
 *
 * Accepts a URL rather than a Blob because the store holds `photo` as either
 * a data URL (demo/offline) or a Storage URL (live) — fetch handles both,
 * and going through a Blob keeps the canvas untainted either way.
 *
 * Returns null on any failure (network, decode, canvas, tiny result): the
 * caller then sends the full photo, which is exactly what the stub did.
 */
export async function cropToBbox(
  imageUrl: string,
  bbox: ReconBbox,
  maxDim = 1024
): Promise<string | null> {
  try {
    const res = await fetch(imageUrl);
    if (!res.ok) return null;
    const bitmap = await createImageBitmap(await res.blob());
    try {
      const { left, top, width, height } = bboxToPixels(bbox, bitmap.width, bitmap.height);
      if (width < 8 || height < 8) return null;
      // Downscale to what the Spaces expect (~512–1024) — no point uploading
      // a 12 MP crop to a 1024-px model.
      const scale = Math.min(1, maxDim / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, left, top, width, height, 0, 0, w, h);
      return canvas.toDataURL("image/jpeg", 0.92);
    } finally {
      bitmap.close?.();
    }
  } catch (e) {
    console.warn("[crop] failed — sending the full photo instead:", e);
    return null;
  }
}

import { useEffect, useState } from "react";

/**
 * Free client-side garment isolation ("product-photo" cutout).
 *
 * No paid APIs, no model downloads: garment photos are typically shot
 * centered on a fairly plain backdrop, so we estimate the backdrop color
 * from the frame border and flood-fill transparency in from the edges
 * through backdrop-like pixels. Anything not connected to the border
 * (the garment itself) is kept untouched.
 *
 * Results are cached in-memory per photo so a cutout is computed at most
 * once per session. Whenever isolation fails or looks implausible we
 * return null and callers fall back to the original photo — a bad photo
 * must never break the outfit board.
 */

type RGB = { r: number; g: number; b: number };

const dist = (a: RGB, b: RGB) =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

/** Session cache: original photo data-URL → cutout PNG data-URL (or null = keep original). */
const cutoutCache = new Map<string, string | null>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("unreadable image"));
    img.src = src;
  });
}

/**
 * Attempt to isolate the garment from its backdrop.
 * Returns a transparent PNG data-URL, or null when isolation isn't feasible.
 */
export async function makeCutout(photoDataUrl: string): Promise<string | null> {
  const cached = cutoutCache.get(photoDataUrl);
  if (cached !== undefined) return cached;

  const result = await tryCutout(photoDataUrl).catch(() => null);
  cutoutCache.set(photoDataUrl, result);
  return result;
}

async function tryCutout(photoDataUrl: string): Promise<string | null> {
  const img = await loadImage(photoDataUrl);
  const maxDim = 384;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  const frame = ctx.getImageData(0, 0, w, h);
  const px = frame.data;

  const at = (x: number, y: number): RGB => {
    const i = (y * w + x) * 4;
    return { r: px[i], g: px[i + 1], b: px[i + 2] };
  };

  // Backdrop estimate from border pixels; only trusted when most agree
  // (a garment filling the frame means there is no backdrop to remove).
  const border: RGB[] = [];
  const xStep = Math.max(1, Math.floor(w / 16));
  const yStep = Math.max(1, Math.floor(h / 16));
  for (let x = 0; x < w; x += xStep) {
    border.push(at(x, 0), at(x, h - 1));
  }
  for (let y = 0; y < h; y += yStep) {
    border.push(at(0, y), at(w - 1, y));
  }
  const mean: RGB = {
    r: border.reduce((a, p) => a + p.r, 0) / border.length,
    g: border.reduce((a, p) => a + p.g, 0) / border.length,
    b: border.reduce((a, p) => a + p.b, 0) / border.length,
  };
  const agree = border.filter((p) => dist(p, mean) < 42).length;
  if (agree / border.length < 0.6) return null;

  // Flood fill from every border pixel through backdrop-like colors.
  // Threshold is adaptive: tight around the measured backdrop spread so
  // near-white garments on white backdrops aren't eaten alive.
  const spread =
    Math.sqrt(
      border.reduce((a, p) => a + dist(p, mean) ** 2, 0) / border.length
    ) || 12;
  const T = Math.min(64, Math.max(30, spread * 2.2));

  const bg = new Uint8Array(w * h); // 1 = backdrop-connected
  const stack: number[] = [];
  for (let x = 0; x < w; x++) {
    stack.push(x, (h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    stack.push(y * w, y * w + (w - 1));
  }
  while (stack.length > 0) {
    const i = stack.pop()!;
    if (bg[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (dist(at(x, y), mean) > T) continue;
    bg[i] = 1;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }

  let cleared = 0;
  for (let i = 0; i < w * h; i++) {
    if (bg[i]) {
      px[i * 4 + 3] = 0;
      cleared++;
    }
  }
  const frac = cleared / (w * h);
  // Sanity gates: barely anything removed = no real backdrop; almost
  // everything removed = the garment itself got eaten. Either way,
  // fall back to the original photo.
  if (frac < 0.05 || frac > 0.9) return null;

  ctx.putImageData(frame, 0, 0);
  return canvas.toDataURL("image/png");
}

/** Best display source for a garment photo: cutout when ready, else original. */
export function cutoutSrc(photo: string | undefined): string | undefined {
  if (!photo) return undefined;
  const cached = cutoutCache.get(photo);
  // null (failed) and undefined (not yet computed) both fall back to photo.
  return cached || photo;
}

/**
 * React hook: returns the isolated cutout once computed (background task),
 * the original photo until then (or permanently if isolation fails).
 */
export function useCutoutSrc(photo: string | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(() => cutoutSrc(photo));

  useEffect(() => {
    let live = true;
    setSrc(cutoutSrc(photo));
    if (photo && cutoutCache.get(photo) === undefined) {
      void makeCutout(photo).then(() => {
        if (live) setSrc(cutoutSrc(photo));
      });
    }
    return () => {
      live = false;
    };
  }, [photo]);

  return src;
}

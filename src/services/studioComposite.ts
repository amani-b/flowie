/**
 * Garment studio-composite preprocessing (ADDITIVE — opt-in per garment).
 *
 * Runs at upload/import time, BEFORE any display decision:
 *   original photo (untouched, kept on `garment.photo`)
 *     → background removal (local segmentation, zero API cost)
 *     → composite onto a flat neutral studio backdrop + soft drop shadow
 *     → saved as a NEW `garment.studioComposite` data URL (never overwrites `photo`)
 *
 * The store fires this automatically for every upload carrying a photo
 * (save first, enhance right after — the upload never blocks on it) and
 * `GarmentPhoto` shows the composite whenever it is ready, with the
 * procedural SVG renderer as the instant fallback underneath.
 *
 * What this module NEVER does (by design):
 * - never touches `garment.photo` (the original upload is sacred);
 * - never replaces `garment.rendering` / `renderStatus` (the procedural SVG
 *   renderer in studioRender.ts stays the instant fallback for EVERY garment
 *   — the composite only wins display precedence when it is ready);
 * - never calls any external AI image model / paid API. Primary segmentation
 *   runs on-device via `@imgly/background-removal` (open-source U²-Net / ISNet
 *   weights, MIT licence, local ONNX inference — no key, no upload, no cost)
 *   with a fully deterministic classical fallback (GrabCut-lite + chromaticity
 *   + edge-stopped flood, 1:1 port from scripts/seg-fallback-proto.mjs) that
 *   fires automatically when the ISNet mask is ghost/near-empty (photo_2
 *   washed-out marle on white).
 *
 * Library choice — why `@imgly/background-removal` and not `rembg` (Python):
 * - Our "backend" is a static Vite SPA + Supabase Postgres/Storage. There is
 *   no Python server to host `rembg`/U²-Net, and adding one (or a GPU edge
 *   function) would be the heaviest possible integration: new service to
 *   deploy, cold starts, per-request egress, privacy regression (user photos
 *   leave the device).
 * - `@imgly/background-removal` IS the same model family (U²-Net / ISNet),
 *   packaged as WebAssembly + ONNX that runs INSIDE the browser worker. For
 *   this stack that is the easiest integration: one npm dependency, zero
 *   backend changes, zero keys, zero per-image cost, offline-capable after
 *   the first model fetch (cached in IndexedDB), and typically <2 s per
 *   garment on a phone-class CPU with the `isnet_quint8` weights.
 * - Compositing itself is plain Canvas2D (browser) — the same backdrop
 *   palette as the SVG renderer so composites sit naturally beside it.
 *
 * Performance contract: after the model is cached, `preprocessGarmentPhoto`
 * resolves in well under ~2 s for a ≤1024 px upload on typical hardware. The
 * first-ever call downloads the model (~40 MB); call `warmStudioComposite()`
 * from an idle callback to hide that cost. Any segmentation failure resolves
 * to a clearly-marked `failed` status and the caller keeps the original +
 * SVG fallback — this step is infallible by contract (it never throws for
 * mask reasons, only for unreadable input).
 */

export type StudioCompositeStatus = "pending" | "ready" | "failed";

/** 768×1024 — matches the SVG renderer's catalog aspect so grids stay uniform. */
export const STUDIO_W = 768;
export const STUDIO_H = 1024;

/** Neutral studio sweep — deliberately the same stops as studioRender.ts. */
export const STUDIO_BACKDROP = {
  top: "#F4F1EB",
  mid: "#ECE7DD",
  bottom: "#DCD5C7",
} as const;

export interface StudioCompositeOptions {
  /** Output width/height. Defaults to the 768×1024 catalog size. */
  width?: number;
  height?: number;
  /** Garment padding as a fraction of the frame (0.09 ≈ 9% each side). */
  padding?: number;
  /** JPEG quality for the composited output. */
  quality?: number;
  /** Segmentation model — smallest/fastest first. */
  model?: "isnet_quint8" | "isnet" | "u2net";
  /** Progress callback (0..1) covering segmentation + compositing. */
  onProgress?: (p: number) => void;
}

export interface StudioCompositeResult {
  /** The ORIGINAL upload, byte-identical passthrough — always preserved. */
  original: string;
  /**
   * NEW "studio_composite" version (JPEG data URL, 768×1024): isolated
   * garment centered on the neutral backdrop with a soft drop shadow.
   * Present only when `status === "ready"`.
   */
  studio_composite?: string;
  status: StudioCompositeStatus;
  /** Which segmentation ran (`none` when we fell back without a mask). */
  method: "isnet_quint8" | "isnet" | "u2net" | "none";
  /** Wall-clock ms for the whole step (segment + composite). */
  timingMs: number;
  /** Human-readable failure reason when `status === "failed"`. */
  error?: string;
}

const DEFAULTS: Required<Omit<StudioCompositeOptions, "onProgress">> = {
  width: STUDIO_W,
  height: STUDIO_H,
  padding: 0.09,
  quality: 0.88,
  model: "isnet_quint8",
};

/* ------------------------- input normalisation ------------------------ */

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",");
  const mime = /data:(.*?);base64/.exec(head)?.[1] ?? "image/png";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(new Error("Could not encode image"));
    r.readAsDataURL(blob);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Anonymous CORS so remote (Supabase Storage) photos don't taint the
    // canvas — data: URLs are unaffected by this attribute.
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode image"));
    img.src = src;
  });
}

/**
 * Resolve any image source to a Blob. `data:` URLs decode locally;
 * remote URLs (cloud-hydrated `photo` values are Supabase Storage public
 * URLs, not base64) are fetched — previously these crashed the segmenter
 * input, so post-reload garments could never (re)build a composite.
 */
async function blobFromImageSource(src: Blob | string): Promise<Blob> {
  if (src instanceof Blob) return src;
  if (src.startsWith("data:")) return dataUrlToBlob(src);
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Could not fetch image: HTTP ${res.status}`);
  return await res.blob();
}

/**
 * Downscale the segmentation input — ISNet inference cost scales with
 * pixels, but the mask is composited back at full catalog size, so a
 * ~640 px mask is visually indistinguishable while running 2–4× faster
 * than a full-upload input. Best-effort: any failure returns the
 * original blob untouched.
 */
const SEG_MASK_MAX_SIDE = 640;

async function downscaleBlobForSegmentation(blob: Blob): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(blob);
    const scale = Math.min(1, SEG_MASK_MAX_SIDE / bmp.width, SEG_MASK_MAX_SIDE / bmp.height);
    if (scale >= 1) {
      bmp.close();
      return blob;
    }
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const ctx = c.getContext("2d");
    if (!ctx) {
      bmp.close();
      return blob;
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const out = await new Promise<Blob | null>((resolve) =>
      c.toBlob((b) => resolve(b), "image/png")
    );
    return out ?? blob;
  } catch {
    return blob;
  }
}

/* --------------------------- 1 · segmentation ------------------------- */

/**
 * Isolate the garment with local U²-Net/ISNet inference. Lazy-imports the
 * heavy dependency so the main bundle stays lean — the model only loads when
 * a user actually uploads/imports a photo. Throws on failure; callers turn
 * that into a `failed` result (original + SVG fallback survive).
 */
export async function removeGarmentBackground(
  input: Blob | string,
  model: NonNullable<StudioCompositeOptions["model"]> = "isnet_quint8",
  onProgress?: (p: number) => void
): Promise<Blob> {
  const { removeBackground } = await import("@imgly/background-removal");
  // Normalise remote-URL sources (cloud-hydrated photos), then downscale:
  // the mask is composited back at full size, so ~640 px input runs
  // several times faster with no visible difference in the final.
  const raw: Blob = typeof input === "string" ? await blobFromImageSource(input) : input;
  const source = await downscaleBlobForSegmentation(raw);
  onProgress?.(0.05);
  const cutout = await removeBackground(source, {
    model,
    output: { format: "image/png", quality: 1 },
    progress: (key: string, current: number, total: number) => {
      // `fetch:...` covers the one-time model download; `compute:inference`
      // is the per-garment cost we promise to keep under ~2 s.
      if (key.startsWith("fetch:")) {
        onProgress?.(0.05 + 0.45 * (total ? current / total : 0));
      } else {
        onProgress?.(0.5 + 0.3 * (total ? current / total : 0));
      }
    },
  } as Parameters<typeof removeBackground>[1]);
  onProgress?.(0.82);
  return cutout;
}

/** Fire-and-forget model warm-up — call at boot. Idempotent: preloads once. */
let compositeWarmed = false;
let compositeWarming = false;
export function warmStudioComposite(): void {
  if (typeof window === "undefined") return;
  if (compositeWarmed || compositeWarming) return;
  compositeWarming = true;
  import("@imgly/background-removal")
    .then(({ preload }) => preload?.({ model: "isnet_quint8" })?.catch(() => {}))
    .catch(() => {})
    .finally(() => {
      compositeWarming = false;
      compositeWarmed = true;
    });
}

/* ----------------- 1b · classical fallback (zero-cost) --------------- */
/**
 * Deterministic classical segmentation fallback for cases where ISNet
 * returns a near-empty / ghost mask (e.g. washed-out gray hoodie on white).
 * Pure Canvas2D / pixel math — ports 1:1 from scripts/seg-fallback-proto.mjs
 * so Node-sharp tuning and browser inference stay in lockstep.
 *
 * Pipeline (see seg-fallback-proto.mjs header for full rationale):
 *  border-ring bg palette (8 segments → greedy-merge with support counts)
 *  + 5-box fg seeds + chromaticity-weighted RGB distance (CHROMA_W)
 *  + seed-presence touch-disambiguation (seedFrac)
 *  + 2-pass GrabCut-lite (dFg < dBg*MARGIN, re-estimate fg)
 *  + edge-stopped, depth-capped uncertainty flood (U=1.7, K=8)
 *  + close-only morphology + seed-touching largest component + hole-fill
 *  + margin sweep [0.7,0.85,1.0] picking best edge-support within 8–85% cov
 */

const CLASSICAL_MAX_SIDE = 448;
const CLASSICAL_MARGINS = [0.7, 0.85, 1.0] as const;
const CHROMA_W = 1.5e6;
const CLASSICAL_U = 1.7;
const CLASSICAL_K = 8;

function paletteOf(
  px: Uint8ClampedArray | Uint8Array,
  ch: number,
  offsets: number[],
  maxEntries = 6,
  coverFrac = 0.9
): number[][] {
  const QB = 4;
  const hist = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (const pi of offsets) {
    const key =
      ((px[pi] >> QB) << 8) | ((px[pi + 1] >> QB) << 4) | (px[pi + 2] >> QB);
    let e = hist.get(key);
    if (!e) {
      e = { n: 0, r: 0, g: 0, b: 0 };
      hist.set(key, e);
    }
    e.n++;
    e.r += px[pi];
    e.g += px[pi + 1];
    e.b += px[pi + 2];
  }
  const buckets = [...hist.values()].sort((a, b) => b.n - a.n);
  const pal: number[][] = [];
  let covered = 0;
  for (const b of buckets) {
    if (pal.length >= maxEntries || covered / offsets.length > coverFrac) break;
    pal.push([b.r / b.n, b.g / b.n, b.b / b.n]);
    covered += b.n;
  }
  return pal;
}

function distToPal(
  px: Uint8ClampedArray | Uint8Array,
  ch: number,
  o: number,
  pal: number[][]
): number {
  const pi = o * ch;
  const r = px[pi];
  const g = px[pi + 1];
  const bl = px[pi + 2];
  const s = r + g + bl;
  const cr = s > 0 ? r / s : 1 / 3;
  const cb = s > 0 ? bl / s : 1 / 3;
  let best = Infinity;
  for (let k = 0; k < pal.length; k++) {
    const e = pal[k];
    const dr = r - e[0];
    const dg = g - e[1];
    const db = bl - e[2];
    const es = e[0] + e[1] + e[2];
    const er = es > 0 ? e[0] / es : 1 / 3;
    const eb = es > 0 ? e[2] / es : 1 / 3;
    const dcr = cr - er;
    const dcb = cb - eb;
    const d =
      dr * dr + dg * dg + db * db + CHROMA_W * (dcr * dcr + dcb * dcb);
    if (d < best) best = d;
  }
  return best;
}

function computeGradients(
  px: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  ch: number
): Float32Array {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    luma[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
  }
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(w - 1, x + dx));
          const ny = Math.max(0, Math.min(h - 1, y + dy));
          s += luma[ny * w + nx];
        }
      blur[y * w + x] = s / 9;
    }
  const mag = new Float32Array(w * h);
  const at = (x: number, y: number): number => {
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    return blur[y * w + x];
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1);
      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  return mag;
}

interface SegmentResult {
  kept: Uint8Array;
  cov: number;
  edgeSupport: number;
}

function segmentClassical(
  px: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
  ch: number,
  mag: Float32Array,
  MARGIN: number
): SegmentResult {
  const N = w * h;
  const idx = (x: number, y: number): number => (y * w + x) * ch;
  // 85th percentile edge threshold (adaptive per photo)
  const samp: number[] = [];
  for (let i = 0; i < N; i += 7) samp.push(mag[i]);
  samp.sort((a, b) => a - b);
  const edgeT = samp[Math.min(samp.length - 1, Math.floor(samp.length * 0.85))];

  // Border ring → 8 segments → top-3 each → greedy merge
  const ring: number[] = [];
  for (let x = 0; x < w; x++) ring.push(idx(x, 0));
  for (let y = 1; y < h; y++) ring.push(idx(w - 1, y));
  for (let x = w - 2; x >= 0; x--) ring.push(idx(x, h - 1));
  for (let y = h - 2; y >= 1; y--) ring.push(idx(0, y));
  const bgCandidates: number[][] = [];
  const SEGS = 8;
  for (let s = 0; s < SEGS; s++) {
    const chunk = ring.slice(
      Math.floor((s * ring.length) / SEGS),
      Math.floor(((s + 1) * ring.length) / SEGS)
    );
    for (const e of paletteOf(px, ch, chunk, 3, 0.8)) bgCandidates.push(e);
  }
  const MERGE2 = 28 * 28;
  const bgPal: Array<{ c: number[]; support: number }> = [];
  for (const c of bgCandidates) {
    let host: (typeof bgPal)[number] | null = null;
    for (const e of bgPal) {
      const dr = c[0] - e.c[0];
      const dg = c[1] - e.c[1];
      const db = c[2] - e.c[2];
      if (dr * dr + dg * dg + db * db < MERGE2) {
        host = e;
        break;
      }
    }
    if (host) host.support += 1;
    else {
      if (bgPal.length >= 12) continue;
      bgPal.push({ c, support: 1 });
    }
  }

  // 5 seed boxes (center + 4 flanks)
  const seedBoxes: Array<[number, number, number, number]> = [
    [0.3, 0.3, 0.7, 0.7],
    [0.15, 0.35, 0.4, 0.65],
    [0.6, 0.35, 0.85, 0.65],
    [0.35, 0.08, 0.65, 0.35],
    [0.35, 0.65, 0.65, 0.92],
  ];
  const seedIdx: number[] = [];
  for (const [x0, y0, x1, y1] of seedBoxes) {
    for (let y = Math.round(h * y0); y < Math.round(h * y1); y++)
      for (let x = Math.round(w * x0); x < Math.round(w * x1); x++)
        seedIdx.push(idx(x, y));
  }

  // Touch-disambiguation via seedFrac
  const SEED_MATCH2 = 40 * 40;
  const seedSub = seedIdx.filter((_, k) => k % 6 === 0);
  const seedFrac = (e: number[]): number => {
    let hit = 0;
    for (const o of seedSub) {
      const dr = px[o] - e[0];
      const dg = px[o + 1] - e[1];
      const db = px[o + 2] - e[2];
      if (dr * dr + dg * dg + db * db < SEED_MATCH2) hit++;
    }
    return hit / seedSub.length;
  };
  const lumaOf = (e: number[]): number =>
    0.299 * e[0] + 0.587 * e[1] + 0.114 * e[2];
  const nearAny = (e: number[], pal: number[][], t2: number): boolean => {
    for (const q of pal) {
      const dr = e[0] - q[0];
      const dg = e[1] - q[1];
      const db = e[2] - q[2];
      if (dr * dr + dg * dg + db * db < t2) return true;
    }
    return false;
  };
  const pruned = bgPal.filter((e) => {
    if (e.support > 2) return true;
    const sf = seedFrac(e.c);
    if (sf >= 0.15) return false;
    if (lumaOf(e.c) >= 100 && sf > 0.005) return false;
    return true;
  });
  const prunedObjs = pruned.length > 0 ? pruned : bgPal;
  const bgCols = prunedObjs.map((e) => e.c);

  const fgRaw = paletteOf(px, ch, seedIdx, 24, 0.99);
  const FG_BG_GAP2 = 32 * 32;
  const sharpFg = fgRaw.filter((e) => !nearAny(e, bgCols, FG_BG_GAP2));
  let fgPal: number[][] = sharpFg.length > 0 ? sharpFg : fgRaw;

  const isBg = new Uint8Array(N);
  const dFgArr = new Float32Array(N);
  const dBgArr = new Float32Array(N);
  for (let pass = 0; pass < 2; pass++) {
    for (let o = 0; o < N; o++) {
      const dFg = distToPal(px, ch, o, fgPal);
      const dBg = distToPal(px, ch, o, bgCols);
      if (pass === 1) {
        dFgArr[o] = dFg;
        dBgArr[o] = dBg;
      }
      isBg[o] = dFg < dBg * MARGIN ? 0 : 1;
    }
    if (pass === 0) {
      const fgIdx: number[] = [];
      for (let o = 0; o < N; o++) if (!isBg[o]) fgIdx.push(o * ch);
      if (fgIdx.length > N * 0.02) fgPal = paletteOf(px, ch, fgIdx);
    }
  }

  // Uncertainty flood: edge-stopped + depth-capped
  const fgGrow = new Uint8Array(N);
  const gdepth = new Int16Array(N).fill(-1);
  const gstack: number[] = [];
  for (let o = 0; o < N; o++)
    if (!isBg[o]) {
      fgGrow[o] = 1;
      gdepth[o] = 0;
      gstack.push(o);
    }
  const gtmp = [0, 0, 0, 0];
  while (gstack.length) {
    const o = gstack.pop()!;
    const x = o % w;
    const y = (o / w) | 0;
    let n = 0;
    if (x > 0) gtmp[n++] = o - 1;
    if (x < w - 1) gtmp[n++] = o + 1;
    if (y > 0) gtmp[n++] = o - w;
    if (y < h - 1) gtmp[n++] = o + w;
    for (let k = 0; k < n; k++) {
      const m = gtmp[k];
      if (
        !fgGrow[m] &&
        gdepth[o] + 1 <= CLASSICAL_K &&
        mag[m] < edgeT &&
        dFgArr[m] < dBgArr[m] * CLASSICAL_U
      ) {
        fgGrow[m] = 1;
        gdepth[m] = gdepth[o] + 1;
        gstack.push(m);
      }
    }
  }

  // Explicit garment mask (not background complement)
  let fg: Uint8Array = fgGrow.slice();
  const morph = (src: Uint8Array, isErode: boolean): Uint8Array => {
    const out = new Uint8Array(N);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (isErode) {
          let v = 1;
          outer: for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (
                nx < 0 ||
                ny < 0 ||
                nx >= w ||
                ny >= h ||
                !src[ny * w + nx]
              ) {
                v = 0;
                break outer;
              }
            }
          out[y * w + x] = v;
        } else {
          let v = 0;
          outer: for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < w && ny < h && src[ny * w + nx]) {
                v = 1;
                break outer;
              }
            }
          out[y * w + x] = v;
        }
      }
    return out;
  };
  // close only (no open — would shatter knit-lace)
  fg = morph(morph(fg, false), true);

  const comp = new Int32Array(N).fill(-1);
  let best = -1;
  let bestSize = 0;
  let nComp = 0;
  for (let i = 0; i < N; i++) {
    if (!fg[i] || comp[i] !== -1) continue;
    let size = 0;
    const st: number[] = [i];
    comp[i] = nComp;
    while (st.length) {
      const o = st.pop()!;
      size++;
      const x = o % w;
      const y = (o / w) | 0;
      if (x > 0 && fg[o - 1] && comp[o - 1] === -1) {
        comp[o - 1] = nComp;
        st.push(o - 1);
      }
      if (x < w - 1 && fg[o + 1] && comp[o + 1] === -1) {
        comp[o + 1] = nComp;
        st.push(o + 1);
      }
      if (y > 0 && fg[o - w] && comp[o - w] === -1) {
        comp[o - w] = nComp;
        st.push(o - w);
      }
      if (y < h - 1 && fg[o + w] && comp[o + w] === -1) {
        comp[o + w] = nComp;
        st.push(o + w);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = nComp;
    }
    nComp++;
  }
  const seedTouch = new Uint8Array(nComp);
  for (const b of seedIdx) {
    const o = Math.round(b / ch);
    if (o >= 0 && o < N && fg[o] && comp[o] !== -1) seedTouch[comp[o]] = 1;
  }
  let bestSeed = -1;
  let bestSeedSize = 0;
  const compSize = new Int32Array(nComp);
  for (let i = 0; i < N; i++) if (fg[i] && comp[i] !== -1) compSize[comp[i]]++;
  for (let c = 0; c < nComp; c++)
    if (seedTouch[c] && compSize[c] > bestSeedSize) {
      bestSeedSize = compSize[c];
      bestSeed = c;
    }
  const keepComp = bestSeed !== -1 ? bestSeed : best;
  const keepSize = bestSeed !== -1 ? bestSeedSize : bestSize;
  const kept = new Uint8Array(N);
  if (keepSize >= Math.round(N * 0.005))
    for (let i = 0; i < N; i++) kept[i] = comp[i] === keepComp ? 1 : 0;

  // hole-fill (border flood of background)
  const seen = new Uint8Array(N);
  const q: number[] = [];
  const holeSeed = (o: number): void => {
    if (!kept[o] && !seen[o]) {
      seen[o] = 1;
      q.push(o);
    }
  };
  for (let x = 0; x < w; x++) {
    holeSeed(x);
    holeSeed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    holeSeed(y * w);
    holeSeed(y * w + w - 1);
  }
  while (q.length) {
    const o = q.pop()!;
    const x = o % w;
    const y = (o / w) | 0;
    if (x > 0) holeSeed(o - 1);
    if (x < w - 1) holeSeed(o + 1);
    if (y > 0) holeSeed(o - w);
    if (y < h - 1) holeSeed(o + w);
  }
  for (let i = 0; i < N; i++) if (!seen[i]) kept[i] = 1;

  let cov = 0;
  for (let i = 0; i < N; i++) cov += kept[i];
  let edgeSum = 0;
  let edgeN = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * w + x;
      if (!kept[o]) continue;
      if (
        (x > 0 && !kept[o - 1]) ||
        (x < w - 1 && !kept[o + 1]) ||
        (y > 0 && !kept[o - w]) ||
        (y < h - 1 && !kept[o + w])
      ) {
        edgeSum += mag[o];
        edgeN++;
      }
    }
  return {
    kept,
    cov: cov / N,
    edgeSupport: edgeN ? edgeSum / edgeN : 0,
  };
}

function createWorkingImageData(
  img: HTMLImageElement,
  maxSide: number
): { px: Uint8ClampedArray; w: number; h: number; ch: number } {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  const scale = Math.min(1, maxSide / iw, maxSide / ih);
  const w = Math.max(1, Math.round(iw * scale));
  const h = Math.max(1, Math.round(ih * scale));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas unavailable");
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  return { px: d, w, h, ch: 4 };
}

/**
 * Classical cutout: returns a transparent PNG Blob of the garment
 * isolated via the deterministic fallback (no model, no network).
 */
export async function classicalFallbackCutout(
  input: Blob | string
): Promise<Blob> {
  // Normalise remote URLs to blobs first (fetch); data: URLs and blobs
  // take the zero-copy object-URL path as before.
  const blob = typeof input === "string" ? await blobFromImageSource(input) : input;
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const origW = img.naturalWidth || img.width;
    const origH = img.naturalHeight || img.height;
    const { px, w, h, ch } = createWorkingImageData(img, CLASSICAL_MAX_SIDE);
    const mag = computeGradients(px, w, h, ch);

    let winner: SegmentResult | null = null;
    for (const MARGIN of CLASSICAL_MARGINS) {
      const r = segmentClassical(px, w, h, ch, mag, MARGIN);
      const ok = r.cov >= 0.08 && r.cov <= 0.85;
      if (ok && (!winner || r.edgeSupport > winner.edgeSupport)) winner = r;
    }
    if (!winner) throw new Error("Classical fallback: all margins rejected");

    // Upscale mask → full-res with 2px blur
    const workMask = document.createElement("canvas");
    workMask.width = w;
    workMask.height = h;
    const wctx = workMask.getContext("2d");
    if (!wctx) throw new Error("Canvas unavailable");
    const wImg = wctx.createImageData(w, h);
    for (let i = 0; i < winner.kept.length; i++) {
      wImg.data[i * 4 + 3] = winner.kept[i] ? 255 : 0;
    }
    wctx.putImageData(wImg, 0, 0);

    const fullMask = document.createElement("canvas");
    fullMask.width = origW;
    fullMask.height = origH;
    const fctx = fullMask.getContext("2d");
    if (!fctx) throw new Error("Canvas unavailable");
    // blur(2px) feather mimics sharp blur(2) in prototype
    try {
      (fctx as CanvasRenderingContext2D & { filter?: string }).filter =
        "blur(2px)";
    } catch {
      /* ignore */
    }
    fctx.imageSmoothingEnabled = true;
    fctx.imageSmoothingQuality = "high";
    fctx.drawImage(workMask, 0, 0, origW, origH);
    try {
      (fctx as CanvasRenderingContext2D & { filter?: string }).filter = "none";
    } catch {
      /* ignore */
    }

    const out = document.createElement("canvas");
    out.width = origW;
    out.height = origH;
    const octx = out.getContext("2d");
    if (!octx) throw new Error("Canvas unavailable");
    octx.drawImage(img, 0, 0);
    octx.globalCompositeOperation = "destination-in";
    octx.drawImage(fullMask, 0, 0);

    const blob: Blob | null = await new Promise((resolve) =>
      out.toBlob((b) => resolve(b), "image/png")
    );
    if (!blob) throw new Error("Failed to encode classical cutout");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Heuristic mask quality gate for ISNet.
 * Ghost / near-empty masks (photo_2: strong alpha <1%) are rejected
 * so the classical fallback can take over deterministically.
 */
export async function isIsnetCutoutUsable(
  cutout: Blob
): Promise<{ usable: boolean; strongCov: number; anyCov: number }> {
  const url = URL.createObjectURL(cutout);
  try {
    const img = await loadImage(url);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return { usable: false, strongCov: 0, anyCov: 0 };
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const N = c.width * c.height;
    let strong = 0;
    let any = 0;
    let border = 0;
    let borderKept = 0;
    for (let i = 0; i < N; i++) {
      const a = d[i * 4 + 3];
      if (a > 64) strong++;
      if (a > 10) any++;
    }
    // border bleed check (garment should not touch >15% of border with strong alpha)
    const w = c.width;
    const h = c.height;
    for (let x = 0; x < w; x++) {
      if (d[(0 * w + x) * 4 + 3] > 64) borderKept++;
      if (d[((h - 1) * w + x) * 4 + 3] > 64) borderKept++;
      border += 2;
    }
    for (let y = 1; y < h - 1; y++) {
      if (d[(y * w + 0) * 4 + 3] > 64) borderKept++;
      if (d[(y * w + w - 1) * 4 + 3] > 64) borderKept++;
      border += 2;
    }
    const strongCov = strong / N;
    const anyCov = any / N;
    const borderFrac = border ? borderKept / border : 0;
    // Usable iff it has a non-trivial strong mask footprint, not absurdly
    // empty/large, and not predominantly a border slab.
    const usable =
      strongCov >= 0.06 && strongCov <= 0.88 && anyCov >= 0.08 && borderFrac < 0.15;
    return { usable, strongCov, anyCov };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* --------------------------- 2 · compositing -------------------------- */

/** Tight bounding box of non-transparent pixels (with 2 px feather margin). */
function alphaBBox(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  threshold = 10
): { x: number; y: number; w: number; h: number } | null {
  const data = ctx.getImageData(0, 0, w, h).data;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (data[(y * w + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const m = 2;
  x0 = Math.max(0, x0 - m);
  y0 = Math.max(0, y0 - m);
  x1 = Math.min(w - 1, x1 + m);
  y1 = Math.min(h - 1, y1 + m);
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Composite a transparent cutout onto the flat neutral studio backdrop:
 * vertical warm-gray sweep + catalog glow, garment centered with consistent
 * padding, synthetic soft drop shadow beneath so it sits IN the scene.
 * Pure Canvas2D — zero APIs, zero cost, synchronous after decode.
 */
export async function compositeCutoutOntoStudio(
  cutout: Blob | string,
  opts: StudioCompositeOptions = {}
): Promise<string> {
  const { width: W, height: H, padding, quality } = { ...DEFAULTS, ...opts };
  const cutoutUrl =
    typeof cutout === "string" ? cutout : URL.createObjectURL(cutout);
  try {
    const img = await loadImage(cutoutUrl);

    // Measure the garment's tight bounds on an offscreen canvas so empty
    // transparent margins never throw off centering/padding.
    const measure = document.createElement("canvas");
    measure.width = img.naturalWidth || img.width;
    measure.height = img.naturalHeight || img.height;
    const mctx = measure.getContext("2d", { willReadFrequently: true });
    if (!mctx) throw new Error("Canvas unavailable");
    mctx.clearRect(0, 0, measure.width, measure.height);
    mctx.drawImage(img, 0, 0, measure.width, measure.height);
    const box = alphaBBox(mctx, measure.width, measure.height);
    if (!box) throw new Error("Empty cutout — nothing to composite");

    // Frame.
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");

    // 1 · flat neutral studio backdrop (same stops as the SVG renderer).
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, STUDIO_BACKDROP.top);
    bg.addColorStop(0.62, STUDIO_BACKDROP.mid);
    bg.addColorStop(1, STUDIO_BACKDROP.bottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const glow = ctx.createRadialGradient(
      W / 2,
      H * 0.42,
      10,
      W / 2,
      H * 0.42,
      W * 0.75
    );
    glow.addColorStop(0, "rgba(255,255,255,0.85)");
    glow.addColorStop(0.55, "rgba(255,255,255,0.25)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, H);

    // 2 · fit the garment with consistent padding, centered.
    const maxW = W * (1 - padding * 2);
    const maxH = H * (1 - padding * 2);
    const scale = Math.min(maxW / box.w, maxH / box.h);
    const dw = Math.max(1, Math.round(box.w * scale));
    const dh = Math.max(1, Math.round(box.h * scale));
    const dx = Math.round((W - dw) / 2);
    const dy = Math.round((H - dh) / 2);

    // 3 · synthetic soft drop shadow: a blurred ellipse UNDER the garment
    // (drawn first so the garment overlaps it), sized to the garment's
    // footprint. ctx.filter blur with a layered-ellipse fallback for
    // browsers without filter support.
    const shadowW = dw * 0.62;
    const shadowH = Math.max(14, dh * 0.045);
    const shadowX = W / 2;
    const shadowY = Math.min(H - shadowH, dy + dh + shadowH * 0.4);
    ctx.save();
    try {
      (ctx as CanvasRenderingContext2D & { filter?: string }).filter =
        "blur(16px)";
      ctx.fillStyle = "rgba(58,52,40,0.34)";
      ctx.beginPath();
      ctx.ellipse(shadowX, shadowY, shadowW / 2, shadowH / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } finally {
      ctx.restore();
    }
    // Layered fallback/augmentation — guarantees softness even where
    // ctx.filter is unsupported, deepens it where it is.
    ctx.save();
    for (const [s, a] of [
      [1.0, 0.1],
      [0.8, 0.12],
      [0.6, 0.14],
    ] as Array<[number, number]>) {
      ctx.fillStyle = `rgba(58,52,40,${a})`;
      ctx.beginPath();
      ctx.ellipse(
        shadowX,
        shadowY,
        (shadowW / 2) * s,
        (shadowH / 2) * s,
        0,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
    ctx.restore();

    // 4 · the garment itself, drawn from the tight crop (no stray margins).
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(
      measure,
      box.x,
      box.y,
      box.w,
      box.h,
      dx,
      dy,
      dw,
      dh
    );

    opts.onProgress?.(1);
    return canvas.toDataURL("image/jpeg", quality);
  } finally {
    if (typeof cutout !== "string") URL.revokeObjectURL(cutoutUrl);
  }
}

/* --------------------- 3 · the upload-time pipeline ------------------- */

/**
 * Full preprocessing for one upload/import. Input may be a File/Blob or an
 * already-compressed data URL (the `compressImage` output). Returns the
 * original (passthrough, untouched) PLUS the new `studio_composite` version.
 * Never throws for mask reasons — failures come back as `{ status: "failed"
 * }` so the caller can keep the original photo + SVG fallback.
 */
export async function preprocessGarmentPhoto(
  input: File | Blob | string,
  opts: StudioCompositeOptions = {}
): Promise<StudioCompositeResult> {
  const t0 = performance.now();
  const model = opts.model ?? DEFAULTS.model;

  // Preserve the original FIRST — whatever happens below, it survives.
  let original: string;
  let sourceBlob: Blob;
  if (typeof input === "string") {
    original = input;
    // Remote-URL photos (cloud-hydrated) are fetched; data: URLs decode.
    sourceBlob = await blobFromImageSource(input);
  } else {
    sourceBlob = input;
    original = await blobToDataUrl(input);
  }

  // Try ISNet first; gate its mask, then fall back to the
  // deterministic classical path (zero API, local Canvas2D).
  try {
    const cutout = await removeGarmentBackground(
      sourceBlob,
      model,
      opts.onProgress
    );
    const gate = await isIsnetCutoutUsable(cutout);
    if (gate.usable) {
      const studio_composite = await compositeCutoutOntoStudio(cutout, opts);
      return {
        original,
        studio_composite,
        status: "ready",
        method: model,
        timingMs: performance.now() - t0,
      };
    }
    // Ghost / near-empty ISNet mask — classical takes over.
    // Console warn is intentional: lets us spot fallback rate in prod logs.
    console.warn(
      `[studioComposite] ISNet mask weak (strong=${(100 * gate.strongCov).toFixed(1)}% any=${(100 * gate.anyCov).toFixed(1)}%) — classical fallback`
    );
    opts.onProgress?.(0.82);
    const classical = await classicalFallbackCutout(sourceBlob);
    opts.onProgress?.(0.9);
    const studio_composite = await compositeCutoutOntoStudio(classical, opts);
    return {
      original,
      studio_composite,
      status: "ready",
      method: "none",
      timingMs: performance.now() - t0,
    };
  } catch (eIsnet) {
    // ISNet threw (model not cached, WASM failure, etc.) — try classical.
    try {
      opts.onProgress?.(0.82);
      const classical = await classicalFallbackCutout(sourceBlob);
      opts.onProgress?.(0.9);
      const studio_composite = await compositeCutoutOntoStudio(classical, opts);
      return {
        original,
        studio_composite,
        status: "ready",
        method: "none",
        timingMs: performance.now() - t0,
      };
    } catch (eClassical) {
      const msg =
        eClassical instanceof Error
          ? eClassical.message
          : eIsnet instanceof Error
            ? eIsnet.message
            : "Background removal failed";
      return {
        original,
        status: "failed",
        method: "none",
        timingMs: performance.now() - t0,
        error: msg,
      };
    }
  }
}

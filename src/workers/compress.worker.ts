/**
 * Image pipeline worker (Phase 1).
 *
 * Everything expensive about importing a garment photo happens here so the
 * main thread stays responsive: JPEG/PNG decode, the downscale to
 * `maxSide`, the quality/scale search that hits `maxBytes`, and the 128px
 * pixel sample used for color + pattern truth.
 *
 * Why a worker (measured, see docs/BASELINE.md): `Image` + canvas
 * `toDataURL` on a phone photo ran 200ms+ on the main thread per file, so a
 * 5-photo import froze the UI in visible chunks. A worker has no DOM, so it
 * uses `createImageBitmap` + `OffscreenCanvas.convertToBlob` instead —
 * `convertToBlob` is also *asynchronous*, which no `toDataURL` equivalent is,
 * and it returns a real `Blob` rather than a base64 string. Both matter:
 * the Blob goes straight to the uploader (Phase 1 requirement) and the
 * content hash is what Phase 2's recon cache keys on.
 *
 * The fallback for browsers without these (see `imagePipeline.ts`) runs the
 * same steps on the main thread, so no capability is ever lost.
 */

/// <reference lib="webworker" />

import { pixelTruthFromImageData, SAMPLE_MAX_DIM } from "../lib/pixelSample";

export interface PrepareRequest {
  id: string;
  file: Blob;
  maxSide: number;
  maxBytes: number;
}

export interface PreparedImage {
  id: string;
  /** Re-encoded JPEG. The canonical artifact for upload + storage. */
  blob: Blob;
  /** Base64 SHA-256 of the OUTPUT bytes — Phase 2's recon cache key input. */
  sha256: string;
  width: number;
  height: number;
  /** Pixel-truth read from the same decode, so no second decode is needed. */
  colors: string[];
  pattern: "solid" | "striped" | "colorblock" | "other";
  shares: number[];
}

export type PrepareResponse =
  | ({ ok: true } & PreparedImage)
  | { id: string; ok: false; error: string };

/** Flatten onto white before encoding: JPEG has no alpha channel, and an
 *  untouched canvas defaults transparent pixels to black. Without this, a
 *  cutout garment photo (transparent PNG background) bakes in a black
 *  backdrop that later throws off color/pattern detection. */
function paintOntoWhite(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  w: number,
  h: number
): void {
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  if (typeof crypto === "undefined" || !crypto.subtle) {
    // Non-secure context (plain http on a LAN IP): SubtleCrypto is absent.
    // Return a stable non-crypto marker rather than throwing — Phase 2
    // treats an unavailable digest as "cannot cache", never as a wrong hit.
    return "no-subtlecrypto";
  }
  return toHex(await crypto.subtle.digest("SHA-256", buf));
}

async function prepare(req: PrepareRequest): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(req.file);
  const srcW = bitmap.width;
  const srcH = bitmap.height;
  if (srcW < 1 || srcH < 1) {
    bitmap.close();
    throw new Error("Image has no pixels");
  }

  const canvas = new OffscreenCanvas(srcW, srcH);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    throw new Error("Canvas unavailable");
  }

  // Scale so the long edge is at most maxSide; never upscale.
  const baseScale = Math.min(1, req.maxSide / Math.max(srcW, srcH));
  let scale = baseScale;
  let quality = 0.85;

  // Quality first, then resolution, mirroring the previous main-thread
  // ladder so imported photos stay visually equivalent to the baseline
  // (DoD #9) — this is not a free place to "improve" the encoder.
  const step = async (): Promise<Blob> => {
    canvas.width = Math.max(1, Math.round(srcW * scale));
    canvas.height = Math.max(1, Math.round(srcH * scale));
    paintOntoWhite(ctx, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality });
    if (blob.size > req.maxBytes && (quality > 0.5 || scale > 0.35)) {
      if (quality > 0.5) quality -= 0.12;
      else scale *= 0.78;
      return step();
    }
    return blob;
  };

  const blob = await step();

  // Pixel truth from a second, small draw of the SAME bitmap. 128px is
  // the resolution `extractColorsFromImage` used, and reusing the decode
  // means the sample and the stored photo can never disagree.
  const sScale = Math.min(1, SAMPLE_MAX_DIM / Math.max(srcW, srcH));
  const sw = Math.max(1, Math.round(srcW * sScale));
  const sh = Math.max(1, Math.round(srcH * sScale));
  let colors = ["#6B7280"];
  let pattern: PreparedImage["pattern"] = "solid";
  let shares = [1];
  try {
    const sc = new OffscreenCanvas(sw, sh);
    const sctx = sc.getContext("2d", { willReadFrequently: true });
    if (sctx) {
      paintOntoWhite(sctx, sw, sh);
      sctx.drawImage(bitmap, 0, 0, sw, sh);
      const img = sctx.getImageData(0, 0, sw, sh);
      const truth = pixelTruthFromImageData(img.data, sw, sh);
      colors = truth.colors;
      pattern = truth.pattern;
      shares = truth.shares;
    }
  } catch {
    // Sampling is an enhancement; keep the compress result if it fails.
  }

  bitmap.close();
  canvas.width = 0;
  canvas.height = 0;

  return {
    id: req.id,
    blob,
    sha256: await sha256Hex(blob),
    width: srcW,
    height: srcH,
    colors,
    pattern,
    shares,
  };
}

self.addEventListener("message", (ev: MessageEvent<PrepareRequest>) => {
  const req = ev.data;
  if (!req || typeof req.id !== "string") return;
  prepare(req).then(
    (out) => self.postMessage({ ok: true, ...out } satisfies PrepareResponse),
    (err: unknown) =>
      self.postMessage({
        id: req.id,
        ok: false,
        error: err instanceof Error ? err.message : "Could not read that image",
      } satisfies PrepareResponse)
  );
});

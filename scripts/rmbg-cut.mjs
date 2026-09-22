/**
 * RMBG cutout driver — free, local, no native segregation faults (hopefully).
 *
 * Uses @huggingface/transformers (ONNX via WASM/CPU, pure JS install — no
 * native binding like the segfaulting onnxruntime-node 1.17.3) with an
 * RMBG/BiRefNet-class background-removal model, then composites through the
 * repo's own studio math (scripts/lib/seg-metrics.mjs) so outputs are
 * directly comparable with every other Phase 1/3 artifact.
 *
 * Usage: node scripts/rmbg-cut.mjs [stem ...] [--out=rmbg]
 *        [--model=briaai/RMBG-1.4]
 * Stems resolve to references/raw-samples/<stem>.jpg.
 * Writes out/<out>/<stem>-{cutout.png,studio.jpg}.
 *
 * Deps: @huggingface/transformers, sharp (both installed). Model weights
 * download once from the HF hub (~170MB) into the HF cache, then run offline.
 */
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { pipeline } from "@huggingface/transformers";
import { studioComposite } from "./lib/seg-metrics.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const argv = process.argv.slice(2);
const outArg = argv.find((a) => a.startsWith("--out="));
const modelArg = argv.find((a) => a.startsWith("--model="));
const OUT = outArg ? outArg.slice(6) : "rmbg";
const MODEL = modelArg ? modelArg.slice(8) : "briaai/RMBG-1.4";
const outDir = join(root, "out", OUT);
mkdirSync(outDir, { recursive: true });

const stems = argv.filter((a) => !a.startsWith("--")).map((s) => s.replace(/\.[^.]+$/, ""));
if (stems.length === 0) stems.push("photo_7_2026-09-18_07-49-17");

console.log(`loading ${MODEL} (first run downloads weights, then caches) …`);
const tLoad = Date.now();
// fp16 halves arena memory (the full-fp32 build OOMs its second consecutive
// inference on this box) and is visually identical for a soft alpha mask.
const segmenter = await pipeline("image-segmentation", MODEL, { dtype: "fp16" });
console.log(`model ready in ${((Date.now() - tLoad) / 1000).toFixed(0)}s`);

for (const stem of stems) {
  const srcPath = join(srcDir, stem + ".jpg");
  if (!existsSync(srcPath)) {
    console.log(`SKIP ${stem}`);
    continue;
  }
  const t0 = Date.now();
  const result = await segmenter(srcPath);
  // Pipeline returns either a single mask Image or [{ mask }] — handle both.
  const first = Array.isArray(result) ? result[0] : result;
  const mask = first?.mask ?? first;
  if (!mask?.data || !mask?.width) throw new Error(`unexpected segmenter output for ${stem}`);

  // Mask is already soft (BiRefNet 0-255). Resize to source dims, join as
  // alpha channel via sharp — no manual interleave, no extra blur.
  const mw = mask.width;
  const mh = mask.height;
  const { width: iw, height: ih } = await sharp(srcPath).metadata();
  const maskPng = await sharp(Buffer.from(mask.data), {
    raw: { width: mw, height: mh, channels: 1 },
  })
    .resize(iw, ih, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const cutout = await sharp(srcPath)
    .removeAlpha()
    .joinChannel(maskPng)
    .png()
    .toBuffer();
  await sharp(cutout).toFile(join(outDir, `${stem}-cutout.png`));
  await studioComposite(cutout, join(outDir, `${stem}-studio.jpg`));
  console.log(`${stem}: segmented in ${Date.now() - t0} ms -> ${OUT}/${stem}-studio.jpg`);
}
console.log("done ->", outDir);

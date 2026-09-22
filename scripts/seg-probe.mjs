/**
 * Debug overlay + numeric probes for the StudioCut prototype.
 *
 * Writes out/seg-cut/<stem>-overlay.png: the original photo with the mask
 * tinted (green = foreground, red = background) so there is no ambiguity
 * about orientation, and prints the intermediate values at named probe points.
 *
 * Usage: node scripts/seg-probe.mjs <stem> [--side=384]
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const outDir = join(root, "out", "seg-cut");
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const stem = argv.find((a) => !a.startsWith("--")) ?? "photo_2_2026-09-08_10-59-52";
const sideArg = argv.find((a) => a.startsWith("--side="));
const SIDE = sideArg ? parseInt(sideArg.slice(7), 10) : 384;

const { default: mod } = await import("./seg-cut.mjs").catch(() => ({ default: null }));
void mod;

// Re-implement the minimal load so this script is standalone-usable.
const srcPath = join(srcDir, stem.replace(/\.[^.]+$/, "") + ".jpg");
const meta = await sharp(srcPath).metadata();
console.log(`${stem}: ${meta.width}x${meta.height}`);

// Overlay: tint the alpha mask over the original at the same working size.
const { data: maskPx, info: mi } = await sharp(join(outDir, `${stem}-alpha.png`))
  .resize(SIDE, SIDE, { fit: "inside" })
  .greyscale()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { data: imgPx, info: ii } = await sharp(srcPath)
  .resize(SIDE, SIDE, { fit: "inside" })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const w = ii.width;
const h = ii.height;
const ch = ii.channels;
const out = Buffer.alloc(w * h * 3);
let fg = 0;
for (let i = 0; i < w * h; i++) {
  const m = maskPx[i] > 128 ? 1 : 0;
  if (m) fg++;
  // Greyscale base + a saturated tint, so the mask reads unambiguously
  // (an earlier version tinted the colour image and the two states were
  // nearly indistinguishable on dark pixels).
  const g0 = (0.299 * imgPx[i * ch] + 0.587 * imgPx[i * ch + 1] + 0.114 * imgPx[i * ch + 2]) * 0.55;
  const tint = m ? [0, 190, 0] : [200, 20, 20];
  out[i * 3] = Math.min(255, g0 + tint[0] * 0.6);
  out[i * 3 + 1] = Math.min(255, g0 + tint[1] * 0.6);
  out[i * 3 + 2] = Math.min(255, g0 + tint[2] * 0.6);
}
await sharp(out, { raw: { width: w, height: h, channels: 3 } })
  .png()
  .toFile(join(outDir, `${stem}-overlay.png`));
console.log(`mask covers ${((100 * fg) / (w * h)).toFixed(1)}% — green = foreground, red = background`);
console.log(`wrote ${join(outDir, stem + "-overlay.png")}`);

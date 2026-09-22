/**
 * Characterise a raw sample numerically so the segmentation design is driven
 * by the actual pixels. Writes diagnostic maps (luma / local-std / gradient)
 * and prints coarse statistics.
 *
 * Usage: node scripts/seg-analyze.mjs [stem] [--side=448]
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const outDir = join(root, "out", "seg-analyze");
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const stem = (argv.find((a) => !a.startsWith("--")) ?? "photo_2_2026-09-08_10-59-52").replace(
  /\.[^.]+$/,
  ""
);
const sideArg = argv.find((a) => a.startsWith("--side="));
const SIDE = sideArg ? parseInt(sideArg.slice(7), 10) : 448;

const { data: px, info } = await sharp(join(srcDir, stem + ".jpg"))
  .resize(SIDE, SIDE, { fit: "inside" })
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width: w, height: h, channels: ch } = info;
const N = w * h;
console.log(`${stem}: ${w}x${h} ch=${ch}`);

const luma = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const o = i * ch;
  luma[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
}

/** Local standard deviation of luma in a (2r+1) box, via integral images. */
function localStd(r) {
  const s1 = new Float64Array((w + 1) * (h + 1));
  const s2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let r1 = 0;
    let r2 = 0;
    for (let x = 0; x < w; x++) {
      const v = luma[y * w + x];
      r1 += v;
      r2 += v * v;
      s1[(y + 1) * (w + 1) + x + 1] = s1[y * (w + 1) + x + 1] + r1;
      s2[(y + 1) * (w + 1) + x + 1] = s2[y * (w + 1) + x + 1] + r2;
    }
  }
  const box = (S, x0, y0, x1, y1) =>
    S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
  const out = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const m = box(s1, x0, y0, x1, y1) / n;
      const m2 = box(s2, x0, y0, x1, y1) / n;
      out[y * w + x] = Math.sqrt(Math.max(0, m2 - m * m));
    }
  }
  return out;
}

/** Sobel magnitude on the 3x3-blurred luma. */
function gradients() {
  const blur = new Float32Array(N);
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
  const at = (x, y) =>
    blur[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  const mag = new Float32Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx = -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) + at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy = -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) + at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  return mag;
}

const std3 = localStd(3);
const std7 = localStd(7);
const mag = gradients();

const pct = (arr, p) => {
  const a = Float32Array.from(arr);
  a.sort();
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
};

console.log(
  `luma  p5=${pct(luma, 0.05).toFixed(0)} p50=${pct(luma, 0.5).toFixed(0)} p95=${pct(luma, 0.95).toFixed(0)}`
);
console.log(
  `std7  p5=${pct(std7, 0.05).toFixed(2)} p50=${pct(std7, 0.5).toFixed(2)} p95=${pct(std7, 0.95).toFixed(2)}`
);
console.log(
  `sobel p50=${pct(mag, 0.5).toFixed(2)} p85=${pct(mag, 0.85).toFixed(2)} p95=${pct(mag, 0.95).toFixed(2)}`
);

// Regional probes: 3x3 grid of mean luma / std7 / sobel
console.log("\nregion grid (meanLuma / meanStd7 / meanSobel):");
for (let gy = 0; gy < 3; gy++) {
  const row = [];
  for (let gx = 0; gx < 3; gx++) {
    let l = 0;
    let s = 0;
    let m = 0;
    let n = 0;
    for (let y = Math.floor((gy * h) / 3); y < Math.floor(((gy + 1) * h) / 3); y++)
      for (let x = Math.floor((gx * w) / 3); x < Math.floor(((gx + 1) * w) / 3); x++) {
        l += luma[y * w + x];
        s += std7[y * w + x];
        m += mag[y * w + x];
        n++;
      }
    row.push(
      `${(l / n).toFixed(0).padStart(3)}/${(s / n).toFixed(1).padStart(4)}/${(m / n).toFixed(1).padStart(4)}`
    );
  }
  console.log("  " + row.join("  "));
}

// Write visual maps
const toPng = async (arr, scale, name) => {
  const buf = Buffer.alloc(N);
  for (let i = 0; i < N; i++) buf[i] = Math.max(0, Math.min(255, arr[i] * scale));
  await sharp(buf, { raw: { width: w, height: h, channels: 1 } }).png().toFile(join(outDir, name));
};
await toPng(luma, 1, `${stem}-luma.png`);
await toPng(std7, 12, `${stem}-std7.png`);
await toPng(mag, 4, `${stem}-sobel.png`);
console.log("\nwrote maps ->", outDir);

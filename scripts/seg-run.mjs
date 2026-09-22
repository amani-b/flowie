/**
 * Driver for the StudioCut prototype (scripts/lib/studio-cut.mjs).
 *
 * Usage: node scripts/seg-run.mjs [stem ...] [--side=384] [--debug] [--out=seg-cut]
 *
 * Writes out/<out>/<stem>-{alpha,cutout,studio,overlay}.* and prints the
 * alpha metrics plus region-label diagnostics.
 */
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { alphaMetrics, fmtMetrics, studioComposite } from "./lib/seg-metrics.mjs";
import { studioCut, minDistToPal, colourDist } from "./lib/studio-cut.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const argv = process.argv.slice(2);
const DEBUG = argv.includes("--debug");
const sideArg = argv.find((a) => a.startsWith("--side="));
const outArg = argv.find((a) => a.startsWith("--out="));
const SIDE = sideArg ? parseInt(sideArg.slice(7), 10) : 384;
const OUT = outArg ? outArg.slice(6) : "seg-cut";
const numArg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? parseFloat(hit.slice(name.length + 3)) : dflt;
};
const SEG_OPTS = {
  regionK: numArg("k", 220),
  regionMin: numArg("min", 0.004),
  lambdaData: numArg("data", 30),
  lambdaSmooth: numArg("smooth", 14),
  sigma: numArg("sigma", 2500),
  bgSeedColour: numArg("bgseed", 2600),
  simT: numArg("sim", 5000),
  refineLabels: numArg("refine", 1),
  soft: numArg("soft", 1),
  softBlur: numArg("softblur", 2),
  softBand: numArg("softband", 0.22),
  softMix: numArg("softmix", 0.45),
};
const outDir = join(root, "out", OUT);
mkdirSync(outDir, { recursive: true });

const stems = argv.filter((a) => !a.startsWith("--"));
if (stems.length === 0) {
  stems.push(
    "photo_1_2026-09-08_10-59-52",
    "photo_2_2026-09-08_10-59-52",
    "photo_3_2026-09-08_10-59-52"
  );
}

for (const raw of stems) {
  const stem = raw.replace(/\.[^.]+$/, "");
  const srcPath = join(srcDir, stem + ".jpg");
  if (!existsSync(srcPath)) {
    console.log(`SKIP ${stem}`);
    continue;
  }
  const { data: px, info } = await sharp(srcPath)
    .resize(SIDE, SIDE, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  console.log(`\n== ${stem} (${w}x${h})`);

  const t0 = Date.now();
  const r = studioCut(px, w, h, ch, SEG_OPTS);
  const ms = Date.now() - t0;
  const N = w * h;

  const m = alphaMetrics(Array.from(r.mask, (v) => v * 255), w, h);
  const mSoft = alphaMetrics(Array.from(r.alpha, (v) => v * 255), w, h);
  console.log(`   ${ms} ms · regions=${r.regions.nComp} bgRegions=${r.stats.bgSeedRegions} fgRegions=${r.stats.fgSeedRegions}`);
  console.log(`   hard ${fmtMetrics(m)}`);
  console.log(`   soft ${fmtMetrics(mSoft)}`);
  if (DEBUG) {
    console.log(`   bgCols=${r.regions.bgCols.map((c) => "[" + c.map((v) => v.toFixed(0)).join(",") + "]").join(" ")}`);
    console.log(`   weakEdge=${r.stats.weakEdge.toFixed(2)} gRef=${r.stats.gRef.toFixed(2)}`);
    // largest regions with their mean colour and distance to the background
    const order = Array.from({ length: r.regions.nComp }, (_, i) => i).sort(
      (a, b) => r.regions.area[b] - r.regions.area[a]
    );
    console.log("   top regions (idx area% meanRGB luma dToBg label):");
    for (const c of order.slice(0, 30)) {
      const mc = r.regions.meanCol[c];
      const d = minDistToPal(mc, r.regions.bgCols);
      const luma = 0.299 * mc[0] + 0.587 * mc[1] + 0.114 * mc[2];
      console.log(
        `     ${String(c).padStart(3)} ${((100 * r.regions.area[c]) / (w * h)).toFixed(1).padStart(5)}% ` +
          `[${mc.map((v) => v.toFixed(0).padStart(3)).join(",")}] luma=${luma.toFixed(0).padStart(3)} ` +
          `dToBg=${d.toFixed(0).padStart(7)} label=${r.regions.labels[c]}`
      );
    }
  }

  // The mask must be RGBA with alpha = mask: a 1-channel greyscale PNG has no
  // alpha channel, so `dest-in` composites it as fully opaque and the cutout
  // silently comes back as the untouched original.
  // The SOFT alpha is what ships — the hard mask is kept only for diagnostics.
  const maskRgba = Buffer.alloc(N * 4);
  for (let i = 0; i < N; i++) {
    maskRgba[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, r.alpha[i])) * 255);
  }
  const maskPng = await sharp(maskRgba, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
  await sharp(maskPng).toFile(join(outDir, `${stem}-alpha.png`));

  const meta = await sharp(srcPath).metadata();
  const maskFull = await sharp(maskRgba, { raw: { width: w, height: h, channels: 4 } })
    .resize(meta.width, meta.height, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const cut = await sharp(srcPath)
    .ensureAlpha()
    .composite([{ input: maskFull, blend: "dest-in" }])
    .png()
    .toBuffer();
  await sharp(cut).toFile(join(outDir, `${stem}-cutout.png`));
  await studioComposite(cut, join(outDir, `${stem}-studio.jpg`));

  // overlay: greyscale base + saturated tint (green = foreground)
  const { data: basePx } = await sharp(srcPath)
    .resize(SIDE, SIDE, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ov = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const g0 =
      (0.299 * basePx[i * ch] + 0.587 * basePx[i * ch + 1] + 0.114 * basePx[i * ch + 2]) * 0.55;
    const tint = r.mask[i] ? [0, 190, 0] : [200, 20, 20];
    ov[i * 3] = Math.min(255, g0 + tint[0] * 0.6);
    ov[i * 3 + 1] = Math.min(255, g0 + tint[1] * 0.6);
    ov[i * 3 + 2] = Math.min(255, g0 + tint[2] * 0.6);
  }
  await sharp(ov, { raw: { width: w, height: h, channels: 3 } })
    .png()
    .toFile(join(outDir, `${stem}-overlay.png`));
}
console.log("\ndone ->", outDir);

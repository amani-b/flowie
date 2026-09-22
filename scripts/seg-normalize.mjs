/**
 * Input-normalisation sweep for the ISNet (U²-Net) background remover.
 *
 * WHY THIS EXISTS
 * ---------------
 * photo_2 is an underexposed flash photo shot at night: grey-marle garment on
 * a white table, near-black walls, blown specular patch. ISNet returns a
 * ghost mask on it (strong≈1%) — it latches onto the only high-contrast
 * edges in the frame (the navy hood outline and the black zipper) and
 * ignores the garment body. That is an out-of-distribution input, not a
 * broken harness: the same call produces a crisp 34.6% mask on photo_1.
 *
 * The cheap, principled fix is to normalise the exposure BEFORE inference.
 * The model only needs a readable frame; the mask it returns is applied to
 * the ORIGINAL pixels, so the garment keeps its true colour.
 *
 * The earlier attempts (`stretch`, `clahe`) used a global 1..99 percentile
 * stretch, which on this frame is dominated by the near-black walls — it
 * stretches noise, not the garment. This script sweeps better-behaved
 * curves (gamma, histogram equalisation, grey-world white balance, a
 * shadow-lifting filmic curve) and judges each by the same alpha metrics.
 *
 * Usage:
 *   node scripts/seg-normalize.mjs [--photos=stem] [--modes=a,b] [--model=isnet_fp16]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { alphaMetrics, fmtMetrics, studioComposite, serveStatic } from "./lib/seg-metrics.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const outDir = join(root, "out", "seg-norm");
const normDir = join(outDir, "input");
mkdirSync(normDir, { recursive: true });

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".map": "application/json", ".jpg": "image/jpeg", ".png": "image/png",
  ".wasm": "application/wasm", ".json": "application/json",
};

const argv = process.argv.slice(2);
const opt = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3).split(",") : d;
};
const PHOTOS = opt("photos", ["photo_2_2026-09-08_10-59-52"]);
const MODEL = (opt("model", ["isnet_fp16"]))[0];
const MODES = opt("modes", ["none", "gamma45", "gamma60", "histeq", "grayworld", "shadowlift"]);

/* ------------------------------------------------------------------ *
 * Normalisation operators. All are pure per-pixel maths over RGBA
 * buffers — they port to Canvas2D one-for-one.
 * ------------------------------------------------------------------ */

/** Per-channel power curve. g<1 brightens, g>1 darkens. */
function gamma(data, g) {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(v / 255, g);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
}

/**
 * Global histogram equalisation on luma, applied as a single monotone LUT to
 * all three channels (so hue is preserved and noise is not differentially
 * amplified per channel).
 */
function histeq(data) {
  const hist = new Uint32Array(256);
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    hist[(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]) | 0]++;
  }
  const lut = new Uint8ClampedArray(256);
  let acc = 0;
  let firstNonZero = 0;
  for (let v = 0; v < 256; v++) { if (hist[v]) { firstNonZero = v; break; } }
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    // map the darkest present level to 0, not the whole ramp's floor
    const t = v <= firstNonZero ? 0 : (acc - hist[firstNonZero]) / Math.max(1, n - hist[firstNonZero]);
    lut[v] = 255 * Math.min(1, Math.max(0, t));
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
}

/**
 * Grey-world white balance: scale each channel so its mean matches the
 * overall mean. Underexposed flash shots are strongly colour-cast, and the
 * cast is what makes a neutral garment look like the neutral table.
 */
function grayworld(data) {
  let sr = 0, sg = 0, sb = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; }
  const m = (sr + sg + sb) / (3 * n);
  const kr = m / Math.max(1, sr / n);
  const kg = m / Math.max(1, sg / n);
  const kb = m / Math.max(1, sb / n);
  // clamp the correction so a genuinely coloured frame is not destroyed
  const clamp = (k) => Math.min(1.9, Math.max(0.55, k));
  const [cr, cg, cb] = [clamp(kr), clamp(kg), clamp(kb)];
  for (let i = 0; i < data.length; i += 4) {
    data[i] = data[i] * cr;
    data[i + 1] = data[i + 1] * cg;
    data[i + 2] = data[i + 2] * cb;
  }
}

/**
 * Shadow-lifting curve: a smooth monotone map that raises the bottom end
 * hard, leaves midtones roughly in place and never clips the top. Unlike a
 * percentile stretch it cannot be hijacked by a large near-black region.
 */
function shadowlift(data, lift = 0.55) {
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    // f(x) = 1 - (1-x)^(1+lift*2) ... raises shadows, keeps 1 -> 1
    lut[v] = 255 * (1 - Math.pow(1 - x, 1 + lift * 2));
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = lut[data[i]];
    data[i + 1] = lut[data[i + 1]];
    data[i + 2] = lut[data[i + 2]];
  }
}

const MODE_FN = {
  none: () => {},
  gamma45: (d) => gamma(d, 0.45),
  gamma60: (d) => gamma(d, 0.6),
  histeq: (d) => histeq(d),
  grayworld: (d) => { grayworld(d); gamma(d, 0.55); },
  shadowlift: (d) => shadowlift(d, 0.55),
};

async function loadRaw(p) {
  const { data, info } = await sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
}

/* ------------------------------------------------------------------ */

const { server, port } = await serveStatic(root, MIME);
const browser = await puppeteer.launch({
  executablePath: EDGE, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("   [pageerror]", String(e).slice(0, 300)));
await page.goto(`http://127.0.0.1:${port}/scripts/bg-tool-page.html`, {
  waitUntil: "networkidle0", timeout: 120000,
});
await page.waitForFunction("window.__toolReady === true", { timeout: 120000 });
console.log(`tool page up on :${port}, model=${MODEL}\n`);

const results = [];

for (const stem of PHOTOS) {
  const src = join(srcDir, `${stem}.jpg`);
  const orig = await loadRaw(src);
  console.log(`########## ${stem} (${orig.w}x${orig.h})`);

  for (const mode of MODES) {
    const fn = MODE_FN[mode];
    if (!fn) { console.log(`   ?? unknown mode ${mode}`); continue; }

    // 1 · build the normalised copy the MODEL will see
    const view = { data: Buffer.from(orig.data), w: orig.w, h: orig.h };
    fn(view.data);
    const viewPath = join(normDir, `${stem}__${mode}.png`);
    await sharp(view.data, { raw: { width: view.w, height: view.h, channels: 4 } }).png().toFile(viewPath);

    // 2 · run ISNet on the normalised copy
    const url = `http://127.0.0.1:${port}/out/seg-norm/input/${stem}__${mode}.png`;
    let r;
    try {
      r = await page.evaluate((u, m) => window.__runBgRemoval(u, m), url, MODEL);
    } catch (e) {
      console.log(`   !! ${mode} FAILED: ${String(e).slice(0, 200)}`);
      continue;
    }
    const alpha = new Uint8Array(Buffer.from(r.alphaB64, "base64"));
    const m = alphaMetrics(alpha, r.w, r.h);

    // 3 · apply that alpha to the ORIGINAL pixels — this is what ships
    const cut = { data: Buffer.from(orig.data), w: orig.w, h: orig.h };
    for (let i = 0; i < r.w * r.h; i++) cut.data[i * 4 + 3] = alpha[i];
    const cutPath = join(outDir, `${stem}__${mode}-cutout.png`);
    await sharp(cut.data, { raw: { width: cut.w, height: cut.h, channels: 4 } }).png().toFile(cutPath);

    await sharp(Buffer.from(alpha), { raw: { width: r.w, height: r.h, channels: 1 } })
      .png().toFile(join(outDir, `${stem}__${mode}-alpha.png`));
    await studioComposite(cutPath, join(outDir, `${stem}__${mode}-studio.jpg`));

    console.log(`   ${mode.padEnd(11)} ${fmtMetrics(m)}  seg=${r.ms}ms`);
    results.push({ stem, mode, model: MODEL, ...m, ms: r.ms });
  }
  console.log("");
}

writeFileSync(join(outDir, "normalize.json"), JSON.stringify(results, null, 2));

// contact sheet of the studio composites, one row per mode
const rows = MODES.filter((mo) => results.some((x) => x.mode === mo));
if (rows.length) {
  const tiles = [];
  for (const mo of rows) {
    const p = join(outDir, `${PHOTOS[0]}__${mo}-studio.jpg`);
    const buf = await sharp(p).resize(230, 307, { fit: "cover" }).toBuffer();
    tiles.push(buf);
  }
  await sharp({
    create: { width: 230 * tiles.length, height: 307, channels: 3, background: "#101010" },
  })
    .composite(tiles.map((b, i) => ({ input: b, left: i * 230, top: 0 })))
    .png()
    .toFile(join(outDir, "sheet.png"));
  console.log(`contact sheet (${rows.join(" | ")}) -> out/seg-norm/sheet.png`);
}

console.log("\ndone ->", outDir);
await browser.close();
server.close();

/**
 * Segmentation run-matrix: model × device × preprocessing.
 *
 * Usage:
 *   node scripts/seg-matrix.mjs --runs="isnet_fp16:cpu:none,isnet_fp16:cpu:stretch,isnet_fp16:gpu:none" \
 *        --photos=photo_2_2026-09-08_10-59-52 --tag=contrast
 *
 * Writes out/seg-matrix/<stem>__<tag>-<label>-{cutout.png,alpha.png,studio.jpg}
 * and prints alpha metrics per run so variants are comparable numerically.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import sharp from "sharp";
import { alphaMetrics, fmtMetrics, studioComposite, serveStatic } from "./lib/seg-metrics.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const outDir = join(root, "out", "seg-matrix");
mkdirSync(outDir, { recursive: true });

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".map": "application/json", ".jpg": "image/jpeg", ".png": "image/png",
  ".wasm": "application/wasm", ".json": "application/json",
};

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const RUNS = arg("runs", "isnet_fp16:cpu:none").split(",");
const PHOTOS = arg("photos", "photo_2_2026-09-08_10-59-52").split(",");
const TAG = arg("tag", "matrix");

const { server, port } = await serveStatic(root, MIME);
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-unsafe-webgpu"],
});
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (!/GET|Failed to load resource/.test(t)) console.log("   [page]", t.slice(0, 220));
});
page.on("pageerror", (e) => console.log("   [pageerror]", String(e).slice(0, 300)));

await page.goto(`http://127.0.0.1:${port}/scripts/bg-tool-page.html`, {
  waitUntil: "networkidle0",
  timeout: 120000,
});
await page.waitForFunction("window.__toolReady === true", { timeout: 120000 });

const gpuInfo = await page.evaluate(() => (navigator.gpu ? "webgpu-present" : "no-webgpu"));
console.log(`webgpu: ${gpuInfo}`);

const rows = [];
for (const run of RUNS) {
  const [model, device, preprocess] = run.split(":");
  const label = `${model}-${device}-${preprocess}`;
  for (const stem of PHOTOS) {
    const url = `http://127.0.0.1:${port}/references/raw-samples/${stem}.jpg`;
    try {
      const t0 = Date.now();
      const r = await page.evaluate(
        (u, o) => window.__runBgRemoval(u, o),
        url,
        { model, device, preprocess }
      );
      const cutBuf = Buffer.from(r.b64, "base64");
      const alpha = new Uint8Array(Buffer.from(r.alphaB64, "base64"));
      const m = alphaMetrics(alpha, r.w, r.h);
      const base = join(outDir, `${stem}__${TAG}-${label}`);
      writeFileSync(`${base}-cutout.png`, cutBuf);
      const gray = Buffer.alloc(alpha.length);
      for (let i = 0; i < alpha.length; i++) gray[i] = alpha[i];
      await sharp(gray, { raw: { width: r.w, height: r.h, channels: 1 } }).png().toFile(`${base}-alpha.png`);
      await studioComposite(cutBuf, `${base}-studio.jpg`);
      console.log(`  ${stem} @ ${label}: ${fmtMetrics(m)}  seg=${r.ms}ms wall=${Date.now() - t0}ms`);
      rows.push({ stem, label, model, device, preprocess, ms: r.ms, ...m });
    } catch (e) {
      console.error(`  !! ${stem} @ ${label} FAILED: ${String(e).slice(0, 240)}`);
      rows.push({ stem, label, model, device, preprocess, error: String(e).slice(0, 240) });
    }
  }
}

writeFileSync(join(outDir, `${TAG}.json`), JSON.stringify(rows, null, 2));
console.log("\ndone ->", outDir);
await browser.close();
server.close();

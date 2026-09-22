/**
 * ISNet model-tier sweep for the studio-composite pipeline.
 *
 * Runs the EXACT browser pipeline (@imgly/background-removal 1.7.0 web build,
 * local ONNX inference in headless Edge) over references/raw-samples/*, once
 * per model tier, and writes per-run artifacts so quality can be judged from
 * the pixels rather than from a claim:
 *
 *   out/seg-sweep/<stem>__<model>-cutout.png  RGBA cutout (exact step output)
 *   out/seg-sweep/<stem>__<model>-alpha.png   raw alpha plane, grayscale
 *   out/seg-sweep/<stem>__<model>-studio.jpg  composite on the neutral backdrop
 *
 * Metrics printed per run (computed from the alpha plane, no visual judging):
 *   strong%  alpha > 64   — confident garment footprint
 *   any%     alpha > 10   — mask footprint including soft edge
 *   edge%    alpha in 10..64 — soft-edge share (healthy matte ≈ 2-12%)
 *   bleed%   strong alpha on the 1px frame border (a cutout should not touch it)
 *   frags    connected components of strong alpha (garment should be 1-3)
 *   holes%   strong-alpha holes fully enclosed by garment
 *
 * Usage: node scripts/seg-sweep.mjs [--models=a,b] [--photos=c,d] [--label=x]
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const outDir = join(root, "out", "seg-sweep");
mkdirSync(outDir, { recursive: true });

const W = 768;
const H = 1024;
const PAD = 0.09;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3).split(",") : dflt;
};
const MODELS = opt("models", ["isnet_quint8", "isnet_fp16", "isnet"]);
const PHOTOS = opt("photos", [
  "photo_1_2026-09-08_10-59-52",
  "photo_2_2026-09-08_10-59-52",
  "photo_3_2026-09-08_10-59-52",
]);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".map": "application/json",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

const server = createServer((req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("nf");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(500);
    res.end("err");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
page.on("console", (m) => {
  const t = m.text();
  if (!/GET|Failed to load resource/.test(t)) console.log("   [page]", t.slice(0, 200));
});
page.on("pageerror", (e) => console.log("   [pageerror]", String(e).slice(0, 300)));

console.log(`loading tool page (port ${port}) …`);
await page.goto(`http://127.0.0.1:${port}/scripts/bg-tool-page.html`, {
  waitUntil: "networkidle0",
  timeout: 120000,
});
await page.waitForFunction("window.__toolReady === true", { timeout: 120000 });

/** Alpha-plane metrics + the studio composite. */
async function measureAndComposite(alpha, w, h, cutoutBuf, stem, model) {
  const N = w * h;
  let strong = 0;
  let any = 0;
  let edge = 0;
  for (let i = 0; i < N; i++) {
    const a = alpha[i];
    if (a > 64) strong++;
    else if (a > 10) any++;
    if (a > 10 && a <= 64) edge++;
  }
  // border bleed on the 1px frame
  let borderN = 0;
  let borderKept = 0;
  for (let x = 0; x < w; x++) {
    if (alpha[x] > 64) borderKept++;
    if (alpha[(h - 1) * w + x] > 64) borderKept++;
    borderN += 2;
  }
  for (let y = 1; y < h - 1; y++) {
    if (alpha[y * w] > 64) borderKept++;
    if (alpha[y * w + w - 1] > 64) borderKept++;
    borderN += 2;
  }
  // connected components of strong alpha (4-neighbour) + enclosed holes
  const seen = new Uint8Array(N);
  const stack = [];
  let frags = 0;
  let biggest = 0;
  for (let i = 0; i < N; i++) {
    if (alpha[i] <= 64 || seen[i]) continue;
    frags++;
    let size = 0;
    seen[i] = 1;
    stack.push(i);
    while (stack.length) {
      const o = stack.pop();
      size++;
      const x = o % w;
      const y = (o / w) | 0;
      if (x > 0 && !seen[o - 1] && alpha[o - 1] > 64) { seen[o - 1] = 1; stack.push(o - 1); }
      if (x < w - 1 && !seen[o + 1] && alpha[o + 1] > 64) { seen[o + 1] = 1; stack.push(o + 1); }
      if (y > 0 && !seen[o - w] && alpha[o - w] > 64) { seen[o - w] = 1; stack.push(o - w); }
      if (y < h - 1 && !seen[o + w] && alpha[o + w] > 64) { seen[o + w] = 1; stack.push(o + w); }
    }
    if (size > biggest) biggest = size;
  }
  const fragsMain = frags;
  // holes: background pixels not reachable from the frame
  const bgSeen = new Uint8Array(N);
  const q = [];
  const push = (o) => { if (alpha[o] <= 64 && !bgSeen[o]) { bgSeen[o] = 1; q.push(o); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (q.length) {
    const o = q.pop();
    const x = o % w;
    const y = (o / w) | 0;
    if (x > 0) push(o - 1);
    if (x < w - 1) push(o + 1);
    if (y > 0) push(o - w);
    if (y < h - 1) push(o + w);
  }
  let holes = 0;
  for (let i = 0; i < N; i++) if (alpha[i] <= 64 && !bgSeen[i]) holes++;

  const m = {
    strong: strong / N,
    any: any / N,
    edge: edge / N,
    bleed: borderN ? borderKept / borderN : 0,
    frags: fragsMain,
    fragMainFrac: biggest / N,
    holes: holes / N,
  };
  console.log(
    `   ${stem} @ ${model}: strong=${(100 * m.strong).toFixed(1)}% any=${(100 * m.any).toFixed(1)}% ` +
      `edge=${(100 * m.edge).toFixed(1)}% bleed=${(100 * m.bleed).toFixed(1)}% ` +
      `frags=${m.frags} main=${(100 * m.fragMainFrac).toFixed(1)}% holes=${(100 * m.holes).toFixed(1)}%`
  );

  // alpha plane → grayscale png
  const alphaGray = Buffer.alloc(N);
  for (let i = 0; i < N; i++) alphaGray[i] = alpha[i];
  await sharp(alphaGray, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toFile(join(outDir, `${stem}__${model}-alpha.png`));

  // studio composite (same math as the Canvas2D path)
  const trimmed = await sharp(cutoutBuf).trim({ threshold: 10 }).toBuffer();
  const ti = await sharp(trimmed).toBuffer({ resolveWithObject: true });
  const maxW = Math.round(W * (1 - PAD * 2));
  const maxH = Math.round(H * (1 - PAD * 2));
  const scale = Math.min(maxW / ti.info.width, maxH / ti.info.height);
  const dw = Math.max(1, Math.round(ti.info.width * scale));
  const dh = Math.max(1, Math.round(ti.info.height * scale));
  const dx = Math.round((W - dw) / 2);
  const dy = Math.round((H - dh) / 2);
  const fitted = await sharp(trimmed).resize(dw, dh, { fit: "fill" }).toBuffer();
  const shW = Math.round(dw * 0.62);
  const shH = Math.max(16, Math.round(dh * 0.045));
  const shY = Math.min(H - shH, dy + dh + Math.round(shH * 0.4));
  const shadow = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><ellipse cx="${W / 2}" cy="${shY}" rx="${Math.round(shW / 2)}" ry="${Math.round(shH / 2)}" fill="#3A3428" fill-opacity="0.34"/></svg>`
    )
  )
    .blur(16)
    .toBuffer();
  const backdrop = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4F1EB"/><stop offset="0.62" stop-color="#ECE7DD"/><stop offset="1" stop-color="#DCD5C7"/></linearGradient><radialGradient id="gl" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.85"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.25"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#gl)"/></svg>`
  );
  await sharp(backdrop)
    .composite([{ input: shadow, left: 0, top: 0 }, { input: fitted, left: dx, top: dy }])
    .jpeg({ quality: 88 })
    .toFile(join(outDir, `${stem}__${model}-studio.jpg`));
  return m;
}

const results = [];
for (const model of MODELS) {
  console.log(`\n########## model ${model}`);
  for (const stem of PHOTOS) {
    const url = `http://127.0.0.1:${port}/references/raw-samples/${stem}.jpg`;
    try {
      const t0 = Date.now();
      const r = await page.evaluate((u, m) => window.__runBgRemoval(u, m), url, model);
      const cutBuf = Buffer.from(r.b64, "base64");
      writeFileSync(join(outDir, `${stem}__${model}-cutout.png`), cutBuf);
      const alpha = new Uint8Array(Buffer.from(r.alphaB64, "base64"));
      const m = await measureAndComposite(alpha, r.w, r.h, cutBuf, stem, model);
      results.push({ stem, model, ...m, ms: r.ms, bytes: r.bytes });
      console.log(`      ${r.w}x${r.h}, ${(r.bytes / 1024).toFixed(0)} KB, seg ${r.ms} ms, wall ${Date.now() - t0} ms`);
    } catch (e) {
      console.error(`   !! ${stem} @ ${model} FAILED: ${String(e).slice(0, 300)}`);
      results.push({ stem, model, error: String(e).slice(0, 300) });
    }
  }
}

writeFileSync(join(outDir, "sweep.json"), JSON.stringify(results, null, 2));
console.log("\ndone ->", outDir);
await browser.close();
server.close();

/**
 * REAL background removal via the EXACT browser pipeline (Edge headless +
 * @imgly/background-removal 1.7.0 web build, isnet_quint8, local inference).
 *
 * For each references/raw-samples file given on the CLI (default: photo_1):
 *   1. serves the repo over local HTTP,
 *   2. segments the photo in-page (no external AI API — model runs locally),
 *   3. saves out/studio-composite-real/cutout-<stem>.png  (exact step output)
 *   4. saves out/studio-composite-real/studio-<stem>.jpg  (studio composite)
 *
 * Failure contract: on ANY error a FAILED-<stem>.txt is written and NO image
 * (and never a generic icon) is substituted.
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const outDir = join(root, "out", "studio-composite-real");
mkdirSync(outDir, { recursive: true });

const W = 768;
const H = 1024;
const PAD = 0.09;
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json", ".jpg": "image/jpeg", ".png": "image/png", ".wasm": "application/wasm", ".json": "application/json" };

const server = createServer((req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    const file = join(root, path);
    if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404); res.end("nf"); return;
    }
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(500); res.end("err");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log("static server on", port);

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
page.on("console", (m) => { const t = m.text(); if (!/GET|Failed to load resource/.test(t)) console.log("   [page]", t.slice(0, 200)); });
page.on("pageerror", (e) => console.log("   [pageerror]", String(e).slice(0, 300)));

console.log("loading tool page …");
await page.goto(`http://127.0.0.1:${port}/scripts/tool-page.html`, { waitUntil: "networkidle0", timeout: 120000 });
await page.waitForFunction("window.__toolReady === true", { timeout: 120000 });
console.log("tool ready");

const targets = process.argv.slice(2);
const list = targets.length ? targets : ["photo_1_2026-09-08_10-59-52.jpg"];

for (const name of list) {
  const stem = basename(name).replace(/\.[^.]+$/, "");
  const failPath = join(outDir, `FAILED-${stem}.txt`);
  try {
    console.log(`\n== ${name}`);
    const url = `http://127.0.0.1:${port}/references/raw-samples/${basename(name)}`;
    const t0 = Date.now();
    const result = await page.evaluate((u) => window.__runBgRemoval(u), url);
    console.log(`   segmented in-page in ${result.ms} ms (${result.bytes} bytes, wall ${Date.now() - t0} ms)`);
    const cutBuf = Buffer.from(result.b64, "base64");
    const cutPath = join(outDir, `cutout-${stem}.png`);
    writeFileSync(cutPath, cutBuf);
    console.log(`   wrote ${cutPath}`);

    // Studio composite (same math as Canvas2D path) via sharp.
    const trimmed = await sharp(cutBuf).trim({ threshold: 10 }).toBuffer();
    const { data: tdata, info: tinfo } = await sharp(trimmed).toBuffer({ resolveWithObject: true });
    void tdata;
    const maxW = Math.round(W * (1 - PAD * 2));
    const maxH = Math.round(H * (1 - PAD * 2));
    const scale = Math.min(maxW / tinfo.width, maxH / tinfo.height);
    const dw = Math.max(1, Math.round(tinfo.width * scale));
    const dh = Math.max(1, Math.round(tinfo.height * scale));
    const dx = Math.round((W - dw) / 2);
    const dy = Math.round((H - dh) / 2);
    const fitted = await sharp(trimmed).resize(dw, dh, { fit: "fill" }).toBuffer();
    const shW = Math.round(dw * 0.62);
    const shH = Math.max(16, Math.round(dh * 0.045));
    const shY = Math.min(H - shH, dy + dh + Math.round(shH * 0.4));
    const shadow = await sharp(Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><ellipse cx="${W / 2}" cy="${shY}" rx="${Math.round(shW / 2)}" ry="${Math.round(shH / 2)}" fill="#3A3428" fill-opacity="0.34"/></svg>`)).blur(16).toBuffer();
    const backdrop = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4F1EB"/><stop offset="0.62" stop-color="#ECE7DD"/><stop offset="1" stop-color="#DCD5C7"/></linearGradient><radialGradient id="gl" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.85"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.25"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#gl)"/></svg>`);
    const studioPath = join(outDir, `studio-${stem}.jpg`);
    await sharp(backdrop).composite([{ input: shadow, left: 0, top: 0 }, { input: fitted, left: dx, top: dy }]).jpeg({ quality: 88 }).toFile(studioPath);
    console.log(`   wrote ${studioPath} (fitted ${dw}x${dh})`);
  } catch (e) {
    const msg = `BACKGROUND REMOVAL FAILED for ${name}\n${new Date().toISOString()}\n${String((e && e.stack) || e)}\n`;
    writeFileSync(failPath, msg);
    console.error(`   !! FAILED — wrote ${failPath}, NO placeholder generated`);
  }
}

await browser.close();
server.close();
console.log("\ndone ->", outDir);

/**
 * REAL background removal on the actual upload files — no synthetic icons.
 *
 * Runs the same model the browser pipeline uses (@imgly/background-removal,
 * ISNet-quint8, local ONNX, zero API cost) in Node, directly on
 * references/raw-samples/*.jpg, and saves each step as its own openable file:
 *
 *   out/studio-composite-real/cutout-<name>.png  = exact bg-removal output (RGBA, transparent bg)
 *   out/studio-composite-real/studio-<name>.jpg  = cutout composited on neutral backdrop + shadow
 *
 * Failure contract: if segmentation errors for a file, NO placeholder or
 * generic icon is substituted. The script writes FAILED-<name>.txt with the
 * exact error and moves on. Check the folder: a missing cutout + a FAILED
 * file means "it errored, explicitly".
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Blob } from "node:buffer";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const outDir = join(root, "out", "studio-composite-real");
mkdirSync(outDir, { recursive: true });

const W = 768;
const H = 1024;
const PAD = 0.09;

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
// Node build names: 'small' (fastest, ≈ isnet_quint8 class) | 'medium' | 'large'.
// Override via MODEL env (e.g. MODEL=medium). Non-small runs get a -<model>
// filename suffix so the small baseline is never overwritten.
const MODEL = process.env.MODEL || "small";
const suffix = MODEL === "small" ? "" : `-${MODEL}`;
const targets = files.length > 0 ? files : ["photo_1_2026-09-08_10-59-52.jpg"];

console.log("loading @imgly/background-removal-node (Node/onnxruntime build) …");
const { removeBackground } = await import("@imgly/background-removal-node");

for (const name of targets) {
  const srcPath = join(srcDir, basename(name));
  const stem = basename(name).replace(/\.[^.]+$/, "");
  const failPath = join(outDir, `FAILED-${stem}.txt`);
  const cutPath = join(outDir, `cutout-${stem}.png`);
  const studioPath = join(outDir, `studio-${stem}.jpg`);
  try {
    const buf = readFileSync(srcPath);
    console.log(`\n== ${name} (${(buf.length / 1024).toFixed(0)} KB)`);
    const blob = new Blob([buf], { type: "image/jpeg" });

    const t0 = Date.now();
    const cutout = await removeBackground(blob, {
      // Node build names: 'small' (fastest, ≈ isnet_quint8 class) | 'medium' | 'large'.
      model: "small",
      output: { format: "image/png", quality: 1 },
      progress: (key, cur, total) =>
        console.log(`   [${key}] ${cur}/${total}`),
    });
    const segMs = Date.now() - t0;
    console.log(`   segmented in ${segMs} ms -> ${cutout.size} bytes`);

    const cutBuf = Buffer.from(await cutout.arrayBuffer());
    writeFileSync(cutPath, cutBuf);
    console.log(`   wrote ${cutPath}`);

    // Studio composite via sharp (same math as the Canvas2D path: tight bbox,
    // 9% padding, neutral sweep, blurred-ellipse shadow).
    const trimmed = await sharp(cutBuf).trim({ threshold: 10 }).toBuffer();
    const tm = await sharp(trimmed)
      .toBuffer({ resolveWithObject: true })
      .then(({ data, info }) => ({ data, w: info.width, h: info.height }));
    const maxW = Math.round(W * (1 - PAD * 2));
    const maxH = Math.round(H * (1 - PAD * 2));
    const scale = Math.min(maxW / tm.w, maxH / tm.h);
    const dw = Math.max(1, Math.round(tm.w * scale));
    const dh = Math.max(1, Math.round(tm.h * scale));
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
      .composite([
        { input: shadow, left: 0, top: 0 },
        { input: fitted, left: dx, top: dy },
      ])
      .jpeg({ quality: 88 })
      .toFile(studioPath);
    console.log(`   wrote ${studioPath} (${dw}x${dh}, total ${Date.now() - t0} ms)`);
  } catch (e) {
    const msg = `BACKGROUND REMOVAL FAILED for ${name}\n${new Date().toISOString()}\n${String((e && e.stack) || e)}\n`;
    writeFileSync(failPath, msg);
    console.error(`   !! ${msg.split("\n")[0]} — wrote ${failPath}, NO placeholder generated`);
  }
}
console.log("\ndone ->", outDir);

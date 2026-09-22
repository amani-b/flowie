/**
 * Shared alpha-plane metrics + studio compositing for the segmentation
 * harnesses. Kept in one place so every experiment is judged by the same
 * numbers (and so the numbers can be compared across scripts).
 */
import sharp from "sharp";

export const STUDIO_W = 768;
export const STUDIO_H = 1024;
export const STUDIO_PAD = 0.09;

/**
 * Objective quality metrics from an 8-bit alpha plane.
 * All returned as fractions of the frame except `frags`.
 */
export function alphaMetrics(alpha, w, h) {
  const N = w * h;
  let strong = 0;
  let mid = 0;
  for (let i = 0; i < N; i++) {
    const a = alpha[i];
    if (a > 64) strong++;
    else if (a > 10) mid++;
  }
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

  return {
    strong: strong / N,
    any: (strong + mid) / N,
    edge: mid / N,
    bleed: borderN ? borderKept / borderN : 0,
    frags,
    mainFrac: biggest / N,
    holes: holes / N,
  };
}

export const fmtMetrics = (m) =>
  `strong=${(100 * m.strong).toFixed(1)}% any=${(100 * m.any).toFixed(1)}% ` +
  `edge=${(100 * m.edge).toFixed(1)}% bleed=${(100 * m.bleed).toFixed(1)}% ` +
  `frags=${m.frags} main=${(100 * m.mainFrac).toFixed(1)}% holes=${(100 * m.holes).toFixed(1)}%`;

/** Same neutral sweep as studioRender.ts / studioComposite.ts. */
export function backdropSvg(W = STUDIO_W, H = STUDIO_H) {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4F1EB"/><stop offset="0.62" stop-color="#ECE7DD"/><stop offset="1" stop-color="#DCD5C7"/></linearGradient><radialGradient id="gl" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.85"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.25"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#gl)"/></svg>`
  );
}

/** Tight-crop the cutout, centre it with 9% padding, add a soft ellipse shadow. */
export async function studioComposite(cutoutBuf, outPath, opts = {}) {
  const W = opts.width ?? STUDIO_W;
  const H = opts.height ?? STUDIO_H;
  const PAD = opts.padding ?? STUDIO_PAD;
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
  await sharp(backdropSvg(W, H))
    .composite([{ input: shadow, left: 0, top: 0 }, { input: fitted, left: dx, top: dy }])
    .jpeg({ quality: 88 })
    .toFile(outPath);
  return { dw, dh };
}

/** Serve a directory tree over local HTTP (for the headless browser). */
export async function serveStatic(root, mime) {
  const { createServer } = await import("node:http");
  const { readFileSync, existsSync, statSync } = await import("node:fs");
  const { join, extname } = await import("node:path");
  const server = createServer((req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
      const file = join(root, path);
      if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) {
        res.writeHead(404);
        res.end("nf");
        return;
      }
      res.writeHead(200, { "Content-Type": mime[extname(file)] ?? "application/octet-stream" });
      res.end(readFileSync(file));
    } catch {
      res.writeHead(500);
      res.end("err");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, port: server.address().port };
}

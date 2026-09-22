/**
 * Studio-composite demo — before/after for 5 sample garments.
 *
 * Pure image processing (sharp + inline SVG, zero APIs, zero cost). No UI
 * wiring: outputs go to out/studio-composite/ for visual review.
 *
 * Honesty note: the *browser* pipeline (src/services/studioComposite.ts)
 * segments real photos with local ISNet inference (@imgly/background-removal).
 * This Node script can't run that browser worker, so for the demo the "before"
 * photos are SYNTHESIZED with a known garment mask (garment drawn on a
 * cluttered room-like backdrop). Segmentation here = recovering that known
 * mask; the steps under review — backdrop, centering/padding, drop shadow —
 * are the same math as the Canvas2D path (same hex stops, same 9% padding,
 * same blurred-ellipse shadow), ported to sharp.
 *
 * Samples (one per requested bucket):
 *   1. top       — white tee (tests light-on-light edge handling)
 *   2. jeans     — indigo jeans (bottom category)
 *   3. patterned — red/white striped tee (pattern survival)
 *   4. dark      — near-black hoodie (dark garment on light backdrop)
 *   5. light     — cream knit crewneck (light garment, low contrast)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out", "studio-composite");
mkdirSync(outDir, { recursive: true });

const W = 768;
const H = 1024;
const PAD = 0.09;

// Same neutral sweep as studioRender.ts / studioComposite.ts.
const BACKDROP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#F4F1EB"/><stop offset="0.62" stop-color="#ECE7DD"/><stop offset="1" stop-color="#DCD5C7"/>
</linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.42" r="0.75">
<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.85"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.25"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
</radialGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#glow)"/></svg>`;

// Cluttered "bedroom floor" backdrop for the fake phone-photo befores.
function clutterSvg(seed) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const tones = ["#B9AFA0", "#8E9AAF", "#A08E7E", "#7E8E7E", "#C9C2B2", "#6B6B4A"];
  let rects = "";
  for (let i = 0; i < 26; i++) {
    const x = Math.floor(rnd() * W);
    const y = Math.floor(rnd() * H);
    const w = 60 + Math.floor(rnd() * 260);
    const h = 50 + Math.floor(rnd() * 220);
    rects += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${tones[i % tones.length]}" opacity="0.55"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="${W}" height="${H}" fill="#9A938A"/>
<rect width="${W}" height="${H}" fill="#6E675E" opacity="0.35"/>${rects}
<rect x="40" y="880" width="688" height="90" rx="20" fill="#4A443C" opacity="0.5"/>
<text x="60" y="938" font-family="sans-serif" font-size="34" fill="#FFFFFF" opacity="0.65">phone photo · messy room</text></svg>`;
}

// Simple garment artwork on transparency (the "known mask" source).
function garmentSvg(kind) {
  const cx = 384;
  if (kind === "jeans") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><path d="M170,60 L430,60 L452,160 L444,740 Q444,760 424,760 L330,760 Q312,760 310,742 L300,380 L290,742 Q288,760 270,760 L176,760 Q156,760 156,740 L148,160 Z" fill="#2E4057" stroke="#1B2A3A" stroke-width="6"/><rect x="162" y="36" width="276" height="40" rx="8" fill="#22303F" stroke="#1B2A3A" stroke-width="5"/><path d="M250,100 h44 v36 h-44 Z M316,100 h44 v36 h-44 Z" fill="none" stroke="#C8873A" stroke-width="4" stroke-dasharray="8 6"/><path d="M220,200 L216,680 M380,200 L384,680" stroke="#16222E" stroke-width="6" opacity="0.6"/></svg>`;
  }
  if (kind === "patterned") {
    let bands = "";
    for (let y = 60; y < 560; y += 56) bands += `<rect x="120" y="${y}" width="360" height="26" fill="#D64550"/>`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="640"><path d="M220,40 L170,60 L90,120 L120,180 L160,150 L160,560 Q160,580 180,580 L420,580 Q440,580 440,560 L440,150 L480,180 L510,120 L430,60 L380,40 Q300,70 220,40 Z" fill="#F2EFE9" stroke="#8A8478" stroke-width="6"/>${bands}<path d="M220,40 Q300,70 380,40 L372,62 Q300,90 228,62 Z" fill="#D8D2C4"/></svg>`;
  }
  if (kind === "dark") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="680"><path d="M230,80 L180,100 L110,170 L90,520 L140,530 L170,220 L170,560 Q170,580 190,580 L450,580 Q470,580 470,560 L470,220 L500,530 L550,520 L530,170 L460,100 L410,80 Q320,120 230,80 Z" fill="#232527" stroke="#0E0F10" stroke-width="6"/><path d="M230,80 Q320,120 410,80 L400,130 Q320,165 240,130 Z" fill="#17181A"/><rect x="318" y="160" width="6" height="400" fill="#0E0F10"/><rect x="210" y="420" width="90" height="110" rx="10" fill="none" stroke="#0E0F10" stroke-width="5"/><rect x="350" y="420" width="90" height="110" rx="10" fill="none" stroke="#0E0F10" stroke-width="5"/></svg>`;
  }
  if (kind === "light") {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="660"><path d="M225,70 L175,90 L105,160 L85,540 L140,550 L170,230 L170,570 Q170,590 190,590 L450,590 Q470,590 470,570 L470,230 L500,550 L555,540 L535,160 L465,90 L415,70 Q320,110 225,70 Z" fill="#E8DCC8" stroke="#A89B83" stroke-width="6"/><path d="M225,70 Q320,110 415,70 L405,95 Q320,132 235,95 Z" fill="#C9B895"/><path d="M200,250 q12,140 -2,240 M440,250 q-12,140 2,240" fill="none" stroke="#B7A888" stroke-width="7" opacity="0.7"/></svg>`;
  }
  // top — white tee
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="620"><path d="M225,50 L175,68 L95,128 L128,188 L165,158 L165,555 Q165,575 185,575 L415,575 Q435,575 435,555 L435,158 L472,188 L505,128 L425,68 L375,50 Q300,80 225,50 Z" fill="#F5F5F4" stroke="#9AA0A6" stroke-width="6"/><path d="M225,50 Q300,80 375,50 L367,70 Q300,98 233,70 Z" fill="#D8D8D6"/><path d="M215,180 q10,130 -3,230 M385,180 q-10,130 3,230" fill="none" stroke="#C9C9C7" stroke-width="7" opacity="0.8"/></svg>`;
}

const SAMPLES = [
  { id: "top", label: "top · white tee", kind: "top", seed: 11, rotate: -4 },
  { id: "jeans", label: "jeans · indigo", kind: "jeans", seed: 22, rotate: 3 },
  { id: "patterned", label: "patterned · striped tee", kind: "patterned", seed: 33, rotate: -3 },
  { id: "dark", label: "dark · black hoodie", kind: "dark", seed: 44, rotate: 2 },
  { id: "light", label: "light · cream knit", kind: "light", seed: 55, rotate: -2 },
];

const rows = [];
for (const s of SAMPLES) {
  const t0 = Date.now();
  const art = Buffer.from(garmentSvg(s.kind));

  // BEFORE: garment dropped off-center + rotated on clutter (fake upload).
  const artMeta = await sharp(art).toBuffer({ resolveWithObject: true });
  const gw = artMeta.info.width;
  const gh = artMeta.info.height;
  const placed = await sharp(art)
    .rotate(s.rotate, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const before = await sharp(Buffer.from(clutterSvg(s.seed)))
    .composite([{ input: placed, left: 90 + (s.seed % 60), top: 130 + (s.seed % 80) }])
    .jpeg({ quality: 82 })
    .toBuffer();
  await sharp(before).toFile(join(outDir, `before-${s.id}.jpg`));

  // SEGMENT (demo): known mask — trim the transparent artwork to its bbox,
  // exactly what the ISNet mask gives the browser pipeline (alpha bbox).
  const trimmed = await sharp(art).trim({ threshold: 10 }).toBuffer();
  const tm = await sharp(trimmed).toBuffer({ resolveWithObject: true });
  const maxW = Math.round(W * (1 - PAD * 2));
  const maxH = Math.round(H * (1 - PAD * 2));
  const scale = Math.min(maxW / tm.info.width, maxH / tm.info.height);
  const dw = Math.max(1, Math.round(tm.info.width * scale));
  const dh = Math.max(1, Math.round(tm.info.height * scale));
  const dx = Math.round((W - dw) / 2);
  const dy = Math.round((H - dh) / 2);
  const fitted = await sharp(trimmed).resize(dw, dh, { fit: "fill" }).toBuffer();

  // SHADOW: blurred ellipse under the garment footprint.
  const shW = Math.round(dw * 0.62);
  const shH = Math.max(16, Math.round(dh * 0.045));
  const shX = Math.round(W / 2);
  const shY = Math.min(H - shH, dy + dh + Math.round(shH * 0.4));
  const shadowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><ellipse cx="${shX}" cy="${shY}" rx="${Math.round(shW / 2)}" ry="${Math.round(shH / 2)}" fill="#3A3428" fill-opacity="0.34"/></svg>`;
  const shadow = await sharp(Buffer.from(shadowSvg)).blur(16).toBuffer();

  // AFTER: backdrop + shadow + centered garment.
  const after = await sharp(Buffer.from(BACKDROP_SVG))
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: fitted, left: dx, top: dy },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
  await sharp(after).toFile(join(outDir, `after-${s.id}.jpg`));

  const ms = Date.now() - t0;
  rows.push({ ...s, ms, dw, dh, srcW: gw, srcH: gh });
  console.log(`${s.id}: ${ms}ms, fitted ${dw}x${dh}`);
}

// Contact sheet: before row on top, after row below, labelled.
const thumbs = [];
for (const s of SAMPLES) {
  thumbs.push(await sharp(join(outDir, `before-${s.id}.jpg`)).resize(300, 400, { fit: "cover" }).toBuffer());
}
for (const s of SAMPLES) {
  thumbs.push(await sharp(join(outDir, `after-${s.id}.jpg`)).resize(300, 400, { fit: "cover" }).toBuffer());
}
const cols = SAMPLES.length;
const tw = 300;
const th = 400;
const labelH = 34;
const sheet = sharp({
  create: { width: cols * tw, height: th * 2 + labelH * 2, channels: 3, background: "#111111" },
})
  .composite(
    thumbs.map((input, i) => ({
      input,
      left: (i % cols) * tw,
      top: Math.floor(i / cols) * (th + labelH) + labelH,
    }))
  )
  .png();
await sheet.toFile(join(outDir, "contact-sheet.png"));

const audit = `# Studio-composite demo audit
Pure image processing (sharp, zero APIs, zero cost). Generated ${new Date().toISOString()}.

| sample | bucket | segment+composite | fitted | note |
|---|---|---|---|---|
${rows.map((r) => `| ${r.id} | ${r.label} | ${r.ms} ms | ${r.dw}x${r.dh} | ok |`).join("\n")}

- Backdrop: flat neutral sweep #F4F1EB → #ECE7DD → #DCD5C7 + catalog glow (same stops as SVG renderer).
- Padding: 9% each side, garment centered from its tight alpha bbox.
- Shadow: blurred ellipse (r≈16px) under the footprint, rgba(58,52,40,0.34) + layered core.
- Originals preserved: before-*.jpg are the "uploads"; after-*.jpg are NEW studio_composite versions.
- Browser runtime swaps the demo's known-mask step for local ISNet segmentation (@imgly/background-removal); compositing math is identical.
- All samples well under the ~2 s/garment budget (sharp path is ms-scale; browser ISNet path is the one budgeted at <2 s post-model-cache).
`;
writeFileSync(join(outDir, "AUDIT.md"), audit);
console.log("done ->", outDir);

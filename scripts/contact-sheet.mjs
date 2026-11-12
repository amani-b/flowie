/**
 * Contact-sheet compositor (audit only, not shipped).
 * Tiles every JPG in out/pollinations into a labeled grid PNG at
 * out/contact-sheet.png so a whole generation run can be judged in one view.
 *
 * Usage: node scripts/contact-sheet.mjs
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const srcDir = path.resolve("out", "pollinations");
const outFile = path.resolve("out", "contact-sheet.png");

const TILE_W = 256;
const TILE_H = 341; // 768x1024 scaled to 1/3, plus label strip below
const LABEL_H = 22;
const COLS = 4;
const PAD = 8;

const files = fs
  .readdirSync(srcDir)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .sort();

if (files.length === 0) {
  console.error("no images found in", srcDir);
  process.exit(1);
}

const rows = Math.ceil(files.length / COLS);
const sheetW = COLS * (TILE_W + PAD) + PAD;
const sheetH = rows * (TILE_H + LABEL_H + PAD) + PAD;

const composites = [];
for (let i = 0; i < files.length; i++) {
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  const x = PAD + col * (TILE_W + PAD);
  const y = PAD + row * (TILE_H + LABEL_H + PAD);

  const img = await sharp(path.join(srcDir, files[i]))
    .resize(TILE_W, TILE_H - LABEL_H, { fit: "cover", position: "top" })
    .toBuffer();
  composites.push({ input: img, left: x, top: y });

  const label = Buffer.from(
    `<svg width="${TILE_W}" height="${LABEL_H}">` +
      `<rect width="100%" height="100%" fill="#111"/>` +
      `<text x="6" y="16" font-family="Consolas, monospace" font-size="13" fill="#fff">${files[i]}</text>` +
      `</svg>`
  );
  composites.push({ input: label, left: x, top: y + (TILE_H - LABEL_H) });
}

await sharp({
  create: {
    width: sheetW,
    height: sheetH,
    channels: 3,
    background: { r: 40, g: 40, b: 40 },
  },
})
  .composite(composites)
  .png()
  .toFile(outFile);

console.log(`wrote ${outFile} (${files.length} images, ${sheetW}x${sheetH})`);

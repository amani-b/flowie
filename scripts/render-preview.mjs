/**
 * Render the seed-closet garments through studioRender and composite a
 * contact sheet (out/render-sheet.png) for side-by-side visual audit.
 *
 * Usage: node scripts/render-preview.mjs
 * Requires: npx tsc src/lib/mock.ts --outDir .tmp --module commonjs --target es2020 --skipLibCheck --esModuleInterop
 */
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const require = createRequire(import.meta.url);
const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
// Compiled mock.js lives OUTSIDE the project (temp dir) because this package
// is "type": "module" and would misread CommonJS output as ESM.
const tmpLib = path.join(os.tmpdir(), "flowie-render-audit", "lib");
const { DEMO_WARDROBE } = require(path.join(tmpLib, "mock.js"));
const sharp = require(path.join(root, "node_modules", "sharp"));

const CELL_W = 300;
const CELL_H = 400;
const COLS = 4;

const tiles = [];
for (let i = 0; i < DEMO_WARDROBE.length; i++) {
  const g = DEMO_WARDROBE[i];
  if (!g.rendering) throw new Error(`no rendering cached for ${g.id}`);
  const svg = decodeURIComponent(g.rendering.replace("data:image/svg+xml,", ""));
  const png = await sharp(Buffer.from(svg))
    .resize(CELL_W, CELL_H, { fit: "fill" })
    .png()
    .toBuffer();
  tiles.push({ input: png, left: (i % COLS) * CELL_W, top: Math.floor(i / COLS) * CELL_H });
  console.log(`${i}: ${g.id} — ${g.name} (${g.category})`);
}

const rows = Math.ceil(DEMO_WARDROBE.length / COLS);
await sharp({
  create: {
    width: COLS * CELL_W,
    height: rows * CELL_H,
    channels: 3,
    background: { r: 255, g: 255, b: 255 },
  },
})
  .composite(tiles)
  .png()
  .toFile(path.join(root, "out", "render-sheet.png"));

console.log(`wrote out/render-sheet.png (${DEMO_WARDROBE.length} garments, ${COLS}x${rows} grid)`);

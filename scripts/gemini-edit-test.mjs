/**
 * Phase 3 pilot — Gemini image-edit smoke test (STANDALONE, not app-wired).
 *
 * Why Gemini: Cloudflare free gates its only img2img model (403/5018), and
 * the Hugging Face free credits depleted after the single Phase 2 success
 * call. Gemini AI Studio keeps a free tier for `gemini-2.5-flash-image`, and
 * the repo already calls `generateContent` the same REST way (see
 * src/services/aiStylistService.ts) with the same key — zero new vendors,
 * zero new secrets.
 *
 * Design mirrors scripts/hf-edit-test.mjs: 3 instruction intensities stand in
 * for the strength sweep the Phase 3 brief asked for (no strength knob exists
 * on any working free path — documented in phase2-review/README.md).
 *
 * Secrets: VITE_GEMINI_API_KEY from the process environment, zero-dependency
 * `.env` fallback (repo `.env` is gitignored — never committed, never logged).
 * Reuses the existing repo key; nothing new to create.
 *
 * Usage:
 *   node scripts/gemini-edit-test.mjs [--input=phase1-review/photo-1-after.jpg]
 *     [--instruction="..."] [--model=gemini-2.5-flash-image]
 *     [--out=phase3-review/p1-v1-light.png]
 *
 * Deps: none (global fetch only).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/* Minimal .env loader (no dependency): KEY="val" / KEY=val, # comments.
 * Only fills keys missing from the real environment — exported vars win. */
for (const p of [join(root, ".env"), join(root, ".env.local")]) {
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2] ?? m[3] ?? m[4] ?? "";
  }
}

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const MODEL = arg("model", "gemini-2.5-flash-image");
const INPUT = arg("input", "phase1-review/photo-1-after.jpg");
const OUT = arg("out", "phase3-review/p1-v1-light.png");
const INSTRUCTION = arg(
  "instruction",
  "Subtly clean up this garment photo: even out the lighting and reduce harsh shadows, keep the exact same garment - same colors, pattern, shape and small details. Do not restyle anything. No person, no mannequin, no face, no hands."
);

const key = (process.env.VITE_GEMINI_API_KEY ?? "").trim();
if (!key) {
  console.error("error: set VITE_GEMINI_API_KEY in the environment or repo .env (existing repo key — nothing new to create).");
  process.exit(1);
}

const inputPath = join(root, INPUT);
let inputBuf;
try {
  inputBuf = readFileSync(inputPath);
} catch {
  console.error(`error: cannot read input image: ${inputPath}`);
  process.exit(1);
}

console.log(`input: ${INPUT} (${(inputBuf.length / 1024).toFixed(0)} KB)`);
console.log(`model: ${MODEL}`);

const t0 = Date.now();
// Heartbeat keeps the event loop alive on Node/Windows builds where a lone
// in-flight fetch can otherwise let the process exit with code 13.
const keepAlive = setInterval(() => {}, 1000);
let res;
try {
  res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: INSTRUCTION },
              { inlineData: { mimeType: "image/jpeg", data: inputBuf.toString("base64") } },
            ],
          },
        ],
        generationConfig: { temperature: 0.4 },
      }),
    }
  );
} catch (e) {
  clearInterval(keepAlive);
  console.error(`error: network call failed: ${String(e)}`);
  process.exit(1);
}
clearInterval(keepAlive);
const ms = Date.now() - t0;

if (!res.ok) {
  const text = await res.text();
  console.error(`API responded HTTP ${res.status} in ${ms} ms`);
  console.error(text.slice(0, 1200));
  process.exit(1);
}

const json = await res.json();
const parts = json.candidates?.[0]?.content?.parts ?? [];
const imgPart = parts.find((p) => p.inlineData?.data);
if (!imgPart) {
  console.error("no image in response; text parts:");
  for (const p of parts) console.error(" - " + String(p.text ?? "?").slice(0, 300));
  process.exit(1);
}

const outBuf = Buffer.from(imgPart.inlineData.data, "base64");
const outPath = join(root, OUT);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, outBuf);
console.log(`saved: ${OUT} (${(outBuf.length / 1024).toFixed(0)} KB, ${imgPart.inlineData.mimeType || "image"}, ${ms} ms)`);
const txt = parts.map((p) => p.text).find(Boolean);
if (txt) console.log("model text: " + String(txt).slice(0, 200));
console.log(`source image (untouched): ${INPUT}`);
console.log(`note: ${basename(outPath)} is a NEW file — the Phase 1 studio_composite was not modified.`);

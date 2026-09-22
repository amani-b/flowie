/**
 * AI flat-lay spike — Gemini image-edit smoke test (STANDALONE, not app-wired).
 *
 * Mirrors scripts/gemini-edit-test.mjs: same key (VITE_GEMINI_API_KEY), same
 * REST shape, but the instruction rebuilds the garment as a top-down
 * e-commerce flat-lay instead of a lighting cleanup. Targets
 * `gemini-3.1-flash-image` (Nano Banana 2) — `gemini-2.5-flash-image` sunsets
 * Oct 2, 2026, so don't point this at 2.5.
 *
 * COST WARNING: image output has NO free tier (~$0.03-0.06/call). Each run
 * below costs real money. Run once or twice on a representative sample,
 * judge the contact sheet, then stop. The app itself gates all calls behind
 * VITE_ENABLE_FLATLAY_AI=true + a 2/day local budget (see
 * src/services/studioFlatlay.ts).
 *
 * Usage:
 *   node scripts/gemini-flatlay-test.mjs [--input=phase1-review/photo-1-after.jpg]
 *     [--model=gemini-3.1-flash-image] [--out=flatlay-review/p1-flatlay.png]
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

const MODEL = arg("model", "gemini-3.1-flash-image");
const INPUT = arg("input", "phase1-review/photo-1-after.jpg");
const OUT = arg("out", "flatlay-review/p1-flatlay.png");
const INSTRUCTION = arg(
  "instruction",
  "Rebuild this as a top-down e-commerce flat-lay product photo: the same garment lying flat on a neutral warm-gray studio sweep, spread neatly and centered, soft diffused lighting with a soft drop shadow. " +
    "Keep the EXACT same garment — same colors, pattern, prints, logos, stitching, buttons and shape. Do not restyle, recolor or redesign anything. " +
    "No person, no model, no mannequin, no face, no hands, no hanger."
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
console.log("COST: this call is billable (image output has no free tier).");

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
        generationConfig: { responseModalities: ["IMAGE"] },
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
console.log(`note: ${basename(outPath)} is a NEW file — the source photo/composite was not modified.`);

/**
 * Phase 2 (HF path) — instruction-edit smoke test (STANDALONE, not app-wired).
 *
 * Why this instead of scripts/hf-img2img-test.mjs: Hugging Face retired the
 * classic serverless host (DNS NXDOMAIN) and its `hf-inference` provider no
 * longer serves strength-based SDEdit models (v1.5 "not supported", SDXL-base
 * "deprecated"). What IS live is instruction-driven editing
 * (FLUX.1-Kontext-dev, inference=warm). Same Phase 2 goal — free img2img
 * end-to-end with the garment preserved — driven by an edit instruction
 * instead of a strength knob. Strength tuning moves to Phase 3 if needed.
 *
 * Secrets: HF_TOKEN from the process environment, zero-dependency `.env`
 * fallback (repo `.env` is gitignored — never committed, never logged).
 * Free token: https://huggingface.co/settings/tokens ("Inference Providers"
 * permission) — no card; free credits cover test calls.
 *
 * Usage:
 *   node scripts/hf-edit-test.mjs [--input=phase1-review/photo-1-after.jpg]
 *     [--model=black-forest-labs/FLUX.1-Kontext-dev] [--provider=auto]
 *     [--out=phase2-review/edit-hf-kontext.png]
 *
 * Deps: @huggingface/inference (official client — raw REST provider paths are
 * provider-specific and undocumented; the client handles routing + failover).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { InferenceClient } from "@huggingface/inference";

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

const MODEL = arg("model", "black-forest-labs/FLUX.1-Kontext-dev");
const PROVIDER = arg("provider", "auto");
const INPUT = arg("input", "phase1-review/photo-1-after.jpg");
const OUT = arg("out", "phase2-review/edit-hf-kontext.png");
const INSTRUCTION = arg(
  "instruction",
  "Turn this into professional studio product photography: soft diffused lighting, crisp fabric texture, clean e-commerce catalog shot, photorealistic. Keep the exact same garment — same colors, pattern, shape and small details. No person, no model, no mannequin, no face, no hands."
);

const token = process.env.HF_TOKEN;
if (!token) {
  console.error(
    "error: set HF_TOKEN in the environment or repo .env.\n" +
      "Create a FREE token at https://huggingface.co/settings/tokens " +
      '(fine-grained, "Inference Providers" permission — no card required).'
  );
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
console.log(`model: ${MODEL} | provider=${PROVIDER}`);

const client = new InferenceClient(token);
const t0 = Date.now();
// Heartbeat keeps the event loop alive on Node/Windows builds where a lone
// in-flight fetch can otherwise let the process exit with code 13
// ("unsettled top-level await"). Cleared as soon as the call settles.
const keepAlive = setInterval(() => {}, 1000);
let blob;
try {
  blob = await client.imageToImage({
    inputs: new Blob([inputBuf], { type: "image/jpeg" }),
    parameters: { prompt: INSTRUCTION },
    model: MODEL,
    provider: PROVIDER,
  });
} catch (e) {
  clearInterval(keepAlive);
  console.error(`API call failed in ${Date.now() - t0} ms: ${String(e?.message ?? e).slice(0, 1200)}`);
  process.exit(1);
}
clearInterval(keepAlive);
const ms = Date.now() - t0;

const outBuf = Buffer.from(await blob.arrayBuffer());
const outPath = join(root, OUT);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, outBuf);
console.log(`saved: ${OUT} (${(outBuf.length / 1024).toFixed(0)} KB, ${blob.type || "image"}, ${ms} ms)`);
console.log(`source image (untouched): ${INPUT}`);
console.log(`note: ${basename(outPath)} is a NEW file — the Phase 1 studio_composite was not modified.`);

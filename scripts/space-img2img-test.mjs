/**
 * Phase 2/3 (Spaces + ZeroGPU path) — img2img smoke test (STANDALONE, not app-wired).
 *
 * Calls YOUR Space (hf-space/app.py, SDXL-Turbo, @spaces.GPU) as an API and saves
 * the output as a NEW file. Phase 1 composites are never modified.
 *
 * STACK NOTE — why @gradio/client and not gradio_client:
 *   `gradio_client` is the PYTHON package (`pip install gradio_client`,
 *   `from gradio_client import Client`). This repo's backend/test harness is
 *   NODE (`scripts/*.mjs`, React+Vite, no Python server), so the correct
 *   same-protocol client is the official JS port `@gradio/client`
 *   (`npm i @gradio/client`, `Client.connect(space, { token })` +
 *   `predict("/predict", ...)` + `handle_file`). Same Gradio wire protocol,
 *   same ZeroGPU quota accounting (authenticated calls burn YOUR 5-min free
 *   quota). A Python `gradio_client` equivalent is shown below for reference:
 *
 *   ```python
 *   # pip install gradio_client
 *   from gradio_client import Client
 *   import os
 *   c = Client(os.environ["HF_SPACE_ID"], hf_token=os.environ["HF_TOKEN"])
 *   out = c.predict(image_path, prompt, neg, strength, steps, seed, api_name="/predict")
 *   ```
 *
 * Secrets: HF_TOKEN + HF_SPACE_ID from the environment, zero-dependency `.env`
 * fallback (repo `.env` is gitignored — never committed, never logged).
 * HF_TOKEN is passed as `Client.connect(space, { token: HF_TOKEN })` — never
 * hardcoded, never printed. No VITE_ prefix: local Node scripts only, never
 * bundled into client code.
 *
 * Usage:
 *   npm i @gradio/client
 *   node scripts/space-img2img-test.mjs [--space=<owner/name>]
 *     [--input=phase1-review/photo-1-after.jpg] [--strength=0.3] [--steps=2]
 *     [--seed=42] [--out=phase2-review/space-s03.png]
 *
 * Deps: @gradio/client (official JS client), sharp (already a devDependency).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

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

const SPACE = arg("space", process.env.HF_SPACE_ID || "");
const INPUT = arg("input", "phase1-review/photo-1-after.jpg");
const STRENGTH = parseFloat(arg("strength", "0.3"));
const STEPS = parseInt(arg("steps", "2"), 10);
const SEED = parseInt(arg("seed", "42"), 10);
const OUT = arg("out", `phase2-review/space-s${String(STRENGTH).replace(".", "")}.png`);

const PROMPT = arg(
  "prompt",
  "professional studio product photography of a garment, soft diffused lighting, crisp fabric texture, clean e-commerce catalog shot, photorealistic"
);
const NEGATIVE_PROMPT = arg(
  "negative",
  "person, human, model, mannequin, face, hands, blurry, distorted, extra limbs"
);

if (!SPACE || !SPACE.includes("/")) {
  console.error(
    "error: set HF_SPACE_ID to your deployed Space (<owner>/<name>).\n" +
      "Deploy first: see hf-space/README.md (2 min: new Space → Gradio SDK → ZeroGPU hardware → paste app.py + requirements.txt).\n" +
      "Then: node scripts/space-img2img-test.mjs --space=<owner>/<name> [...]"
  );
  process.exit(1);
}
if (Number.isNaN(STRENGTH) || STRENGTH < 0.05 || STRENGTH > 1) {
  console.error(`error: --strength must be 0.05-1.0 (got "${arg("strength", "0.3")}")`);
  process.exit(1);
}
if (Number.isNaN(STEPS) || STEPS < 1 || STEPS > 4) {
  console.error(`error: --steps must be 1-4 for SDXL-Turbo (got "${arg("steps", "2")}")`);
  process.exit(1);
}

const token = process.env.HF_TOKEN;
if (!token) {
  console.error("error: set HF_TOKEN in the environment or repo .env (https://huggingface.co/settings/tokens).");
  process.exit(1);
}

const inputPath = resolve(root, INPUT);
if (!existsSync(inputPath)) {
  console.error(`error: cannot read input image: ${inputPath}`);
  process.exit(1);
}

// Downscale to 512 longest side — matches the Space's own prep; keeps the
// upload small. Garment detail survives; ZeroGPU seconds stay minimal.
const resizedBuf = await sharp(readFileSync(inputPath)).resize(512, 512, { fit: "inside" }).toBuffer();
console.log(`input: ${INPUT} -> ${(resizedBuf.length / 1024).toFixed(0)} KB upload payload`);
console.log(`space: ${SPACE} | strength=${STRENGTH} steps=${STEPS} seed=${SEED}`);

const { Client, handle_file } = await import("@gradio/client");

const t0 = Date.now();
const keepAlive = setInterval(() => {}, 1000); // env quirk: hold loop (see phase2-review/README.md)
let result;
try {
  const app = await Client.connect(SPACE, { token });
  result = await app.predict("/predict", [
    handle_file(inputPath),
    PROMPT,
    NEGATIVE_PROMPT,
    STRENGTH,
    STEPS,
    SEED,
  ]);
} catch (e) {
  clearInterval(keepAlive);
  console.error(`API call failed in ${Date.now() - t0} ms: ${String(e?.message ?? e).slice(0, 1500)}`);
  process.exit(1);
}
clearInterval(keepAlive);
const ms = Date.now() - t0;

// Gradio file output arrives as { url } (or { path }) — download the bytes.
const first = result?.data?.[0];
let outBuf = null;
const ref = typeof first === "string" ? first : first?.url ?? first?.path ?? null;
if (!ref) {
  console.error(`error: unexpected result shape: ${JSON.stringify(result?.data ?? result).slice(0, 500)}`);
  process.exit(1);
}
if (Buffer.isBuffer(first)) outBuf = first;
else if (typeof ref === "string" && ref.startsWith("data:")) outBuf = Buffer.from(ref.split(",")[1], "base64");
else {
  const url = ref.startsWith("http") ? ref : `https://${SPACE.replace("/", "-")}.hf.space/gradio_api/file=${ref}`;
  const r = await fetch(ref.startsWith("http") ? ref : url, { headers: { Authorization: `Bearer ${token}` } });
  outBuf = Buffer.from(await r.arrayBuffer());
}

const outPath = join(root, OUT);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, outBuf);
console.log(`saved: ${OUT} (${(outBuf.length / 1024).toFixed(0)} KB, wall ${ms} ms / ${(ms / 1000).toFixed(1)} s)`);
console.log(`source image (untouched): ${INPUT}`);
console.log(`note: ${basename(outPath)} is a NEW file — the Phase 1 studio_composite was not modified.`);
console.log("quota: the Gradio file response carries no per-call GPU-seconds field.");
console.log("  Authenticated ZeroGPU calls burn YOUR account quota: free = 5 min/day,");
console.log("  reset 24 h after first GPU use (PRO = 40 min). Read the remainder at");
console.log("  https://huggingface.co/settings/billing — quota burns per reserved");
console.log("  @spaces.GPU slot (currently 60 s/call = ~5 garments/day free).");

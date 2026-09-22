/**
 * Phase 2 (alt) — Hugging Face img2img smoke test (STANDALONE, not app-wired).
 *
 * Same brief as scripts/cf-img2img-test.mjs, different vendor: Cloudflare's
 * free plan gates the only REST img2img model (403/5018), so this script
 * targets Hugging Face's serverless Inference API, whose free tier needs no
 * credit card (rate-limited; a free account token is enough).
 *
 * Model choice: `runwayml/stable-diffusion-v1-5`, exactly the v1.5 family the
 * Phase 2 brief names. SDXL (`stabilityai/stable-diffusion-xl-base-1.0`) can
 * be tried via --model= — report back which one I used after the first run.
 *
 * Secrets: HF_TOKEN from the process environment, with a zero-dependency
 * `.env` fallback (repo `.env` is gitignored — never committed, never logged).
 * Create a FREE token at https://huggingface.co/settings/tokens (fine-grained,
 * "Inference Providers" permission) — no payment method required.
 *
 * Usage:
 *   1. copy .env.example to .env and set HF_TOKEN=hf_... (no VITE_ prefix —
 *      local Node scripts only, never bundled into client code), then
 *   2. node scripts/hf-img2img-test.mjs [--input=phase1-review/photo-1-after.jpg]
 *      [--strength=0.3] [--steps=20] [--seed=42] [--model=runwayml/stable-diffusion-v1-5]
 *      [--out=phase2-review/img2img-hf-s03.png]
 *
 * Deps: none beyond the repo (global fetch + sharp, already a devDependency).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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

const MODEL = arg("model", "runwayml/stable-diffusion-v1-5");
// Default route: Hugging Face's own serverless provider on the new router
// (the classic api-inference.huggingface.co host was retired — DNS NXDOMAIN).
// Override with --endpoint= for any provider-specific path.
const ENDPOINT = arg("endpoint", `https://router.huggingface.co/hf-inference/models/${MODEL}`);
const INPUT = arg("input", "phase1-review/photo-1-after.jpg");
const STRENGTH = parseFloat(arg("strength", "0.3"));
const STEPS = parseInt(arg("steps", "20"), 10);
const SEED = parseInt(arg("seed", "42"), 10);
const OUT = arg("out", `phase2-review/img2img-hf-s${String(STRENGTH).replace(".", "")}.png`);

const PROMPT =
  "professional studio product photography of a garment, soft diffused lighting, crisp fabric texture, clean e-commerce catalog shot, photorealistic";
const NEGATIVE_PROMPT = "person, human, model, mannequin, face, hands, blurry, distorted, extra limbs";

if (Number.isNaN(STRENGTH) || STRENGTH < 0 || STRENGTH > 1) {
  console.error(`error: --strength must be a number between 0 and 1 (got "${arg("strength", "0.3")}")`);
  process.exit(1);
}

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

// Downscale to width 512 (aspect preserved) — keeps the payload small while
// retaining garment detail. SD v1.5's native regime is ~512px.
const resized = await sharp(inputBuf).resize({ width: 512 }).toBuffer();
const image_b64 = resized.toString("base64");
console.log(`input: ${INPUT} -> ${(resized.length / 1024).toFixed(0)} KB base64 payload`);

const body = {
  inputs: image_b64,
  parameters: {
    prompt: PROMPT,
    negative_prompt: NEGATIVE_PROMPT,
    strength: STRENGTH,
    num_inference_steps: STEPS,
    guidance_scale: 7.5,
    seed: SEED,
  },
};

console.log(`model: ${MODEL} | strength=${STRENGTH} steps=${STEPS} seed=${SEED}`);

async function callOnce() {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, ms: Date.now() - t0 };
}

let res, ms;
try {
  ({ res, ms } = await callOnce());
} catch (e) {
  console.error(`error: network call failed: ${String(e)}`);
  process.exit(1);
}
const contentType = res.headers.get("content-type") ?? "";

// Cold model (503 + estimated_time): wait once, retry once — free-tier
// serverless models sleep when idle; this is normal, not a failure.
if (res.status === 503) {
  let waitMs = 20000;
  try {
    const j = await res.json();
    if (j.estimated_time) waitMs = Math.min(90000, Math.ceil(j.estimated_time * 1000) + 5000);
    console.log(`model loading (503), waiting ${(waitMs / 1000).toFixed(0)}s then retrying once…`);
  } catch {
    console.log("model loading (503), waiting 20s then retrying once…");
  }
  await new Promise((r) => setTimeout(r, waitMs));
  try {
    ({ res, ms } = await callOnce());
  } catch (e) {
    console.error(`error: network call failed on retry: ${String(e)}`);
    process.exit(1);
  }
}

if (!res.ok || contentType.includes("application/json")) {
  const text = await res.text();
  console.error(`API responded HTTP ${res.status} in ${ms} ms (content-type: ${contentType || "?"})`);
  try {
    console.error(JSON.stringify(JSON.parse(text), null, 2).slice(0, 2000));
  } catch {
    console.error(text.slice(0, 2000));
  }
  process.exit(1);
}

const outBuf = Buffer.from(await res.arrayBuffer());
const outPath = join(root, OUT);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, outBuf);
console.log(`saved: ${OUT} (${(outBuf.length / 1024).toFixed(0)} KB, ${contentType || "image"}, ${ms} ms)`);

// Usage accounting: HF's image response carries no credit/usage field —
// report every compute-related signal present so this stays honest.
console.log("response signals:");
let sawUsage = false;
for (const [k, v] of res.headers) {
  if (/compute|usage|credit|bill|request|ratelimit|remaining/i.test(k)) {
    console.log(`  header ${k}: ${v}`);
    if (/usage|credit|remaining/i.test(k)) sawUsage = true;
  }
}
if (!sawUsage) {
  console.log("  (no per-call credit/usage field in response headers — usage lives in your HF account billing/metrics page)");
}
console.log(`source image (untouched): ${INPUT}`);
console.log(`note: ${basename(outPath)} is a NEW file — the Phase 1 studio_composite was not modified.`);

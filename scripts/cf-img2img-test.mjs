/**
 * Phase 2 — Cloudflare Workers AI img2img smoke test (STANDALONE, not app-wired).
 *
 * Takes one Phase 1 `studio_composite` image, sends it to Workers AI
 * `@cf/runwayml/stable-diffusion-v1-5-img2img` via REST, saves the output
 * locally. One call, one image — no strength tuning yet (that's Phase 3).
 *
 * Model choice: SD v1.5 img2img, exactly as the Phase 2 brief names it.
 * `@cf/stabilityai/stable-diffusion-xl-base-1.0` also accepts img2img input
 * and can be tried via --model= if v1.5 ever misbehaves, but v1.5 is the
 * default because it is the lighter, faster model and strength=0.3 keeps the
 * output close to the input garment by construction.
 *
 * Secrets: read from the process environment, with a zero-dependency `.env`
 * fallback (repo `.env` is gitignored — never committed, never logged).
 * `.env` NEVER takes precedence over real environment variables.
 *
 * Usage:
 *   1. copy .env.example to .env and fill in CLOUDFLARE_API_TOKEN and
 *      CLOUDFLARE_ACCOUNT_ID (no VITE_ prefix — never client-exposed), then
 *   2. node scripts/cf-img2img-test.mjs [--input=phase1-review/photo-1-after.jpg]
 *     [--strength=0.3] [--steps=20] [--seed=42] [--model=@cf/runwayml/stable-diffusion-v1-5-img2img]
 *     [--out=phase2-review/img2img-s03.png]
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

const MODEL = arg("model", "@cf/runwayml/stable-diffusion-v1-5-img2img");
const INPUT = arg("input", "phase1-review/photo-1-after.jpg");
const STRENGTH = parseFloat(arg("strength", "0.3"));
const STEPS = parseInt(arg("steps", "20"), 10);
const SEED = parseInt(arg("seed", "42"), 10);
const OUT = arg("out", `phase2-review/img2img-s${String(STRENGTH).replace(".", "")}.png`);

const PROMPT =
  "professional studio product photography of a garment, soft diffused lighting, crisp fabric texture, clean e-commerce catalog shot, photorealistic";
const NEGATIVE_PROMPT = "person, human, model, mannequin, face, hands, blurry, distorted, extra limbs";

if (Number.isNaN(STRENGTH) || STRENGTH < 0 || STRENGTH > 1) {
  console.error(`error: --strength must be a number between 0 and 1 (got "${arg("strength", "0.3")}")`);
  process.exit(1);
}

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) {
  console.error(
    "error: set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment.\n" +
      "Copy .env.example to .env and fill in your values (never commit .env)."
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

// Downscale to width 512 (aspect preserved) — keeps the REST payload small
// while retaining garment detail. SD v1.5's native regime is ~512px.
const resized = await sharp(inputBuf).resize({ width: 512 }).toBuffer();
const meta = await sharp(resized).metadata();
const image_b64 = resized.toString("base64");
console.log(`input: ${INPUT} -> ${meta.width}x${meta.height}, ${(resized.length / 1024).toFixed(0)} KB base64 payload`);

const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;
const body = {
  prompt: PROMPT,
  negative_prompt: NEGATIVE_PROMPT,
  image_b64,
  width: meta.width,
  height: meta.height,
  num_steps: STEPS,
  strength: STRENGTH,
  guidance: 7.5,
  seed: SEED,
};

console.log(`model: ${MODEL} | strength=${STRENGTH} steps=${STEPS} seed=${SEED}`);
const t0 = Date.now();
let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
} catch (e) {
  console.error(`error: network call failed: ${String(e)}`);
  process.exit(1);
}
const ms = Date.now() - t0;
const contentType = res.headers.get("content-type") ?? "";

if (!res.ok || contentType.includes("application/json")) {
  // Error envelope (or an unexpected JSON envelope) — print it, save nothing.
  const text = await res.text();
  console.error(`API responded HTTP ${res.status} in ${ms} ms (content-type: ${contentType})`);
  try {
    const parsed = JSON.parse(text);
    console.error(JSON.stringify(parsed, null, 2).slice(0, 2000));
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

// Neuron accounting: the Workers AI REST API returns binary PNG bytes for
// image models, with no per-call usage/Neurons field in the response.
// Report every signal the response DID carry so this stays honest.
console.log("response signals:");
let reportedUsage = false;
for (const [k, v] of res.headers) {
  if (/neuron|usage|ai|step|bill|request|ray|cf-/i.test(k)) {
    console.log(`  header ${k}: ${v}`);
    if (/neuron|usage/i.test(k)) reportedUsage = true;
  }
}
if (!reportedUsage) {
  console.log("  (no per-call Neurons/usage field exposed by the API for binary image output — check Workers AI dashboard analytics for the call count)");
}
console.log(`source image (untouched): ${INPUT}`);
console.log(`note: ${basename(outPath)} is a NEW file — the Phase 1 studio_composite was not modified.`);

/**
 * Phase 3 — controlled strength experiment, now vs the ZeroGPU Space endpoint
 * (replaces the Cloudflare target; everything else in the plan is unchanged).
 *
 * For each strength in --strengths, calls scripts/space-img2img-test.mjs once
 * (fixed steps + seed, so strength is the only variable) and saves each output
 * as a NEW file in --outdir. Grade each output on the Phase 3 criteria:
 *   (a) same garment (shape/color/pattern/logo)
 *   (b) more "studio" than Phase 1 alone
 *   (c) no person/face/hands/mannequin
 *   (d) artifacts (note garbled lettering on zoom, color drift)
 *
 * NOTE on negative_prompt: SDXL-Turbo runs at guidance_scale=0.0, so the
 * negative prompt is inert by design (accepted for API stability). The
 * experiment dial here is strength (and optionally --steps 1-4), not wording.
 *
 * Requires: deployed Space (hf-space/README.md) + HF_SPACE_ID + HF_TOKEN.
 * Usage:
 *   node scripts/space-strength-sweep.mjs [--space=<owner/name>]
 *     [--input=phase1-review/photo-1-after.jpg] [--strengths=0.2,0.3,0.4,0.5,0.6]
 *     [--steps=2] [--seed=42] [--outdir=phase3-review/space-sweep]
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const p of [join(root, ".env"), join(root, ".env.local")]) {
  if (!existsSync(p)) continue;
  const { readFileSync } = await import("node:fs");
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
const STEPS = arg("steps", "2");
const SEED = arg("seed", "42");
const OUTDIR = arg("outdir", "phase3-review/space-sweep");
const strengths = arg("strengths", "0.2,0.3,0.4,0.5,0.6").split(",").map((s) => s.trim());

if (!SPACE || !SPACE.includes("/")) {
  console.error("error: set HF_SPACE_ID (or --space=<owner/name>). Deploy first: hf-space/README.md.");
  process.exit(1);
}

console.log(`space: ${SPACE} | input: ${INPUT} | steps=${STEPS} seed=${SEED}`);
console.log("strength | wall time | output");
for (const s of strengths) {
  const out = `${OUTDIR}/s${s.replace(".", "")}.png`;
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    ["scripts/space-img2img-test.mjs", `--space=${SPACE}`, `--input=${INPUT}`, `--strength=${s}`, `--steps=${STEPS}`, `--seed=${SEED}`, `--out=${out}`],
    { cwd: root, stdio: "inherit", env: process.env }
  );
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${s.padEnd(8)} | ${String(secs).padEnd(9)} | ${out} ${r.status === 0 ? "" : "(FAILED)"}`);
  if (r.status !== 0) process.exit(r.status);
}
console.log("done. Grade each output on criteria (a)-(d) before any app wiring.");

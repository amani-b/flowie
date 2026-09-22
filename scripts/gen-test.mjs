/**
 * Pollinations generation test harness (audit only, not shipped).
 * Fetches a fixed list of test prompts with 16s spacing (anonymous tier:
 * 1 req / 15 s) and saves JPEGs to out/pollinations/ for visual judgment.
 *
 * Round 2 — scene-constrained prompts, zero negative prompts. Round 1 showed
 * flux ignores "no person / no mannequin" negations (people appeared anyway).
 * Instead, each prompt here describes a top-down flat-lay scene, a stock-photo
 * genre whose composition structurally excludes torsos and faces.
 *
 * Usage: node scripts/gen-test.mjs <run-name> [style E|F|all] [seed-base]
 *   style defaults to "all" (both E and F per item); seed-base defaults to 100.
 */
import fs from "node:fs";
import path from "node:path";

const outDir = path.resolve("out", "pollinations");
fs.mkdirSync(outDir, { recursive: true });

const logLines = [];
const log = (s) => {
  logLines.push(s);
  // Retry briefly — a concurrent reader (Get-Content) can transiently lock the file.
  for (let a = 0; a < 5; a++) {
    try {
      fs.writeFileSync(path.resolve("out", "gen-test.log"), logLines.join("\n") + "\n");
      return;
    } catch (e) {
      if (a === 4) console.error("log write failed:", e.code ?? e.message);
      else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
    }
  }
};

const runName = process.argv[2] ?? "run1";
const styleArg = (process.argv[3] ?? "all").toLowerCase();
const seedBase = Number(process.argv[4] ?? 100);

/** Prompt style E — spread flat lay shot from directly above (no negatives). */
const E = (color, item) =>
  `Flat lay product photograph for an online store catalog, shot from directly ` +
  `above: a ${color} ${item} lying flat on a plain white surface, spread out ` +
  `neatly and centered, filling most of the frame with visible folds and ` +
  `natural drape wrinkles. Soft diffused studio lighting, subtle shadows ` +
  `under the fabric, crisp photorealistic fabric texture, clean minimal ` +
  `composition.`;

/** Prompt style F — neatly folded flat lay; "stitching" alone pulled hands in round 2. */
const F = (color, item) =>
  `Minimalist flat lay product photo shot from directly above: a neatly folded ` +
  `${color} ${item} centered on a plain white background, filling most of the ` +
  `frame. Soft even studio lighting, photorealistic fabric texture with ` +
  `visible stitching and folded edges, online store catalog quality.`;

const ITEMS = [
  { key: "1-hoodie", color: "black", item: "zip-up hoodie with the hood lying flat" },
  { key: "2-shorts", color: "black", item: "pair of athletic drawstring shorts" },
  { key: "3-joggers", color: "black", item: "pair of cuffed sweatpants" },
  { key: "4-olive-tee", color: "olive green", item: "crew-neck t-shirt" },
];

const allTests = ITEMS.flatMap((it) => [
  { name: `${it.key}-flat`, prompt: E(it.color, it.item) },
  { name: `${it.key}-folded`, prompt: F(it.color, it.item) },
]);
const TESTS =
  styleArg === "e"
    ? allTests.filter((t) => t.name.endsWith("-flat"))
    : styleArg === "f"
      ? allTests.filter((t) => t.name.endsWith("-folded"))
      : allTests;

const params = (seed) =>
  new URLSearchParams({
    width: "768",
    height: "1024",
    seed: String(seed),
    nologo: "true",
    model: "flux",
    referrer: "flowie-app",
  }).toString();

for (let i = 0; i < TESTS.length; i++) {
  const t = TESTS[i];
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(t.prompt)}?${params(seedBase + i)}`;
  const file = path.join(outDir, `${runName}-${t.name}.jpg`);
  const started = Date.now();
  try {
    log(`${t.name}: request ${i + 1}/${TESTS.length} started`);
    const res = await fetch(url);
    if (!res.ok) {
      log(`${t.name}: HTTP ${res.status} after ${((Date.now() - started) / 1000).toFixed(1)}s`);
    } else {
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(file, buf);
      log(
        `${t.name}: HTTP ${res.status}, ${(buf.length / 1024).toFixed(0)}KB, ${((Date.now() - started) / 1000).toFixed(1)}s -> ${path.basename(file)}`
      );
    }
  } catch (e) {
    log(`${t.name}: FAILED ${e.message}`);
  }
  if (i < TESTS.length - 1) await new Promise((r) => setTimeout(r, 16_000));
}
log("done");

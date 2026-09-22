/**
 * Free flat-lay spike — TryOffDiffv2-MGT Space smoke test (STANDALONE).
 *
 * Hits YOUR deployed hf-tryoff Space directly (no Supabase, no app):
 * upload → queue/join → SSE poll → save PNG. Same Gradio protocol the
 * `flatlay-tryoff` edge function speaks, so a pass here means the edge
 * path will pass too.
 *
 * COST: $0 inside the ZeroGPU free quota (~10 s reserved/call). Each run
 * burns one slot from the pool shared with the schnell Space.
 *
 * Setup:
 *   1. Deploy hf-tryoff/ as a Gradio + ZeroGPU Space.
 *   2. Set HF_TRYOFF_SPACE_ID in the environment or repo .env, e.g.
 *      HF_TRYOFF_SPACE_ID=your-user/flowie-garment-tryoff
 *   3. HF_TOKEN from https://huggingface.co/settings/tokens (read).
 *
 * Usage:
 *   node scripts/tryoff-test.mjs [--input=references/ref1.jpg]
 *     [--class=upper] [--seed=42] [--out=flatlay-review/r1-upper.png]
 *   class: upper (tops/outerwear) | lower (bottoms) | dress
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

const SPACE_ID = (process.env.HF_TRYOFF_SPACE_ID ?? "").trim();
const TOKEN = (process.env.HF_TOKEN ?? "").trim();
const INPUT = arg("input", "references/ref1.jpg");
const CLASS = arg("class", "upper");
const SEED = Number(arg("seed", "42"));
const OUT = arg("out", "flatlay-review/spike-upper.png");

if (!SPACE_ID || !TOKEN) {
  console.error(
    "error: set HF_TRYOFF_SPACE_ID and HF_TOKEN in the environment or repo .env.\n" +
      "Deploy hf-tryoff/ first (see hf-tryoff/README.md) — this script tests YOUR Space."
  );
  process.exit(1);
}
if (!["upper", "lower", "dress"].includes(CLASS)) {
  console.error("error: --class must be upper|lower|dress");
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

console.log(`space: ${SPACE_ID} | input: ${INPUT} (${(inputBuf.length / 1024).toFixed(0)} KB) | class=${CLASS} seed=${SEED}`);
console.log("COST: $0 (one ZeroGPU slot from the shared free pool).");

const t0 = Date.now();
const keepAlive = setInterval(() => {}, 1000);
const apiBase = `https://${SPACE_ID.replace("/", "-")}.hf.space/gradio_api`;
const auth = { Authorization: `Bearer ${TOKEN}` };

try {
  // 1 · upload
  const form = new FormData();
  form.append("files", new Blob([inputBuf], { type: "image/jpeg" }), "source.jpg");
  const up = await fetch(`${apiBase}/upload`, { method: "POST", headers: auth, body: form });
  if (!up.ok) throw new Error(`upload failed: HTTP ${up.status}`);
  const upJson = await up.json();
  const filePath = upJson?.[0] ?? upJson?.files?.[0];
  if (!filePath) throw new Error("upload returned no path");

  // 2 · join /predict queue (single-endpoint Space: fn_index 0).
  // NOTE: poll with the CLIENT-GENERATED session_hash (not the join
  // event_id) — polling event_id hangs with zero SSE events on this
  // Gradio version (verified live: official client returns in ~8 s).
  const sessionHash = crypto.randomUUID();
  const joinRes = await fetch(`${apiBase}/queue/join`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [
        { path: filePath, url: null, orig_name: "source.jpg", mime_type: "image/jpeg" },
        CLASS,
        SEED,
      ],
      event_data: null,
      fn_index: 0,
      trigger_id: null,
      session_hash: sessionHash,
    }),
  });
  if (!joinRes.ok) throw new Error(`queue join failed: HTTP ${joinRes.status}`);
  await joinRes.json();

  // 3 · poll SSE
  const stream = await fetch(`${apiBase}/queue/data?session_hash=${sessionHash}`, { headers: auth });
  if (!stream.body) throw new Error("queue stream empty");
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let fileUrl = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n\n");
    buf = parts.pop() ?? "";
    for (const part of parts) {
      const line = part.split("\n").find((l) => l.startsWith("data: "));
      if (!line) continue;
      try {
        const msg = JSON.parse(line.slice(6));
        if (msg.msg === "process_completed" && msg.output?.data?.[0]?.url) {
          fileUrl = msg.output.data[0].url;
          break;
        }
        if (msg.msg === "process_failed" || msg.msg === "error") {
          throw new Error(`space job failed: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        if (msg.msg === "estimation" || msg.msg === "progress") {
          process.stdout.write(`\rqueue: ${JSON.stringify(msg).slice(0, 100)}   `);
        }
      } catch (e) {
        if (String(e?.message ?? e).startsWith("space job failed")) throw e;
      }
    }
    if (fileUrl) break;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  if (!fileUrl) throw new Error("timed out waiting for result (120 s)");
  process.stdout.write("\n");

  const fileRes = await fetch(fileUrl.startsWith("http") ? fileUrl : `${apiBase}/file=${fileUrl}`, { headers: auth });
  if (!fileRes.ok) throw new Error(`result fetch failed: HTTP ${fileRes.status}`);
  const outBuf = Buffer.from(await fileRes.arrayBuffer());
  const outPath = join(root, OUT);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, outBuf);
  console.log(`saved: ${OUT} (${(outBuf.length / 1024).toFixed(0)} KB, ${Date.now() - t0} ms)`);
  console.log(`source image (untouched): ${INPUT}`);
  console.log(`note: ${basename(outPath)} is a NEW file — judge garment fidelity at tile size before wiring further.`);
} catch (e) {
  console.error(`error: ${String(e?.message ?? e)}`);
  process.exit(1);
} finally {
  clearInterval(keepAlive);
}

/**
 * Recon harness — new garment-rendering pipeline, single-garment test rig.
 *
 * Chain under test:
 *   original photo (untouched)
 *     → analysis.json (STUB analyzer until the Qwen3-VL Space lands)
 *     → bbox → padded crop (sharp, CPU-only)
 *     → TryOffDiff reconstruction (--tryoff, remote ZeroGPU, optional)
 *     → deterministic chroma extraction (border-sampled, CPU-only)
 *     → studio composite → final.png + qa.json
 *
 * Every intermediate is saved under --out so failures can be attributed to
 * exactly one stage (detection / crop / reconstruction / chroma / QA).
 *
 * Usage:
 *   node scripts/recon-harness.mjs \
 *     --input=references/raw-samples/<your-photo>.jpg \
 *     --slug=navy-trousers --class=lower --out=recon-work/navy-trousers
 *   Optional: --bbox=x,y,w,h (1000-scale, default full-frame stub)
 *             --tryoff (call the TryOffDiff Space; needs HF_TRYOFF_SPACE_ID + HF_TOKEN)
 *             --seed=42
 *
 * Default run is CPU-only and burns zero quota. --tryoff burns one shared
 * ZeroGPU slot (~30 s reserved). Never throws away the source: the input
 * file is only ever read.
 *
 * Deps: sharp (already in devDependencies). Remote step uses global fetch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
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
const flag = (name) => process.argv.includes(`--${name}`);

const INPUT = arg("input", "");
const SLUG = arg("slug", "test-garment");
const CLASS = arg("class", "upper");
const OUT = arg("out", `recon-work/${SLUG}`);
const SEED = Number(arg("seed", "42"));
const BBOX_ARG = arg("bbox", "");
const WANT_TRYOFF = flag("tryoff");
const WANT_QWEN = flag("qwen");
const QWEN_PROBE = flag("qwen-probe");
const WANT_KLEIN = flag("klein");
const SELFTEST = flag("selftest");

if (!INPUT) {
  console.error("error: --input=<path> is required (an ORIGINAL source photo, never a processed output)");
  process.exit(1);
}
if (!["upper", "lower", "dress"].includes(CLASS)) {
  console.error("error: --class must be upper|lower|dress (shoes/accessories are photo-only, no recon)");
  process.exit(1);
}

const outDir = join(root, OUT);
mkdirSync(outDir, { recursive: true });
const save = (name, buf) => {
  const p = join(outDir, name);
  writeFileSync(p, buf);
  return p;
};
const saveJson = (name, obj) => save(name, Buffer.from(JSON.stringify(obj, null, 2) + "\n"));

const inputPath = join(root, INPUT);
if (!existsSync(inputPath)) {
  console.error(`error: cannot read input image: ${inputPath}`);
  process.exit(1);
}

/* ---------------- 1 · original (passthrough, untouched) ---------------- */
const ext = extname(inputPath) || ".jpg";
const originalName = `original${ext}`;
copyFileSync(inputPath, join(outDir, originalName));
const meta = await sharp(inputPath).metadata();
const W = meta.width ?? 0;
const H = meta.height ?? 0;
if (!W || !H) {
  console.error("error: could not decode input dimensions");
  process.exit(1);
}
console.log(`[1/6] original: ${INPUT} (${W}x${H}, copied byte-identical)`);

/* ---------------- 2 · analysis.json (STUB analyzer) ----------------
 * Shape matches the future Qwen3-VL contract exactly so the stub can be
 * swapped without touching downstream stages. Default bbox is full-frame:
 * these raw-sample photos are single-garment flat-lays, so detection is
 * trivially the whole frame minus a margin. For worn multi-garment photos
 * pass --bbox=x,y,w,h (1000-scale) explicitly. */
function parseBbox() {
  if (!BBOX_ARG) return { x: 20, y: 20, width: 960, height: 960 };
  const parts = BBOX_ARG.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
    console.error("error: --bbox must be x,y,w,h in 1000-scale integers");
    process.exit(1);
  }
  const [x, y, width, height] = parts.map((n) => Math.round(n));
  return {
    x: Math.max(0, Math.min(999, x)),
    y: Math.max(0, Math.min(999, y)),
    width: Math.max(1, Math.min(1000 - x, width)),
    height: Math.max(1, Math.min(1000 - y, height)),
  };
}
const bbox = parseBbox();
const analysis = {
  analyzer: "stub-v0 (Qwen3-VL-8B pending — hand-verified bbox)",
  items: [
    {
      name: SLUG,
      part:
        CLASS === "upper" ? "upperbody" : CLASS === "lower" ? "lowerbody" : "dress",
      color: null,
      secondaryColor: null,
      tags: [],
      boundingBox: bbox,
    },
  ],
};
saveJson("analysis.json", analysis);
saveJson("bbox.json", { bbox1000: bbox, imageDims: { width: W, height: H } });
console.log(`[2/6] analysis.json: stub bbox ${JSON.stringify(bbox)}`);

/* ---------------- 3 · padded crop (Wardrobe: ~8% pad, clamped) ---------------- */
const rawLeft = (bbox.x / 1000) * W;
const rawTop = (bbox.y / 1000) * H;
const rawWidth = (bbox.width / 1000) * W;
const rawHeight = (bbox.height / 1000) * H;
const pad = Math.max(12, Math.round(Math.max(rawWidth, rawHeight) * 0.08));
const left = Math.max(0, Math.floor(rawLeft - pad));
const top = Math.max(0, Math.floor(rawTop - pad));
const right = Math.min(W, Math.ceil(rawLeft + rawWidth + pad));
const bottom = Math.min(H, Math.ceil(rawTop + rawHeight + pad));
const cropRect = { left, top, width: right - left, height: bottom - top };
const cropBuf = await sharp(inputPath)
  .extract(cropRect)
  .jpeg({ quality: 92 })
  .toBuffer();
save("crop.jpg", cropBuf);
saveJson("bbox.json", {
  bbox1000: bbox,
  imageDims: { width: W, height: H },
  padPx: pad,
  cropRect,
  cropDims: { width: cropRect.width, height: cropRect.height },
});
console.log(
  `[3/6] crop.jpg: ${cropRect.width}x${cropRect.height} @ (${left},${top}) pad=${pad}px`
);

/* ---------------- 4 · TryOffDiff reconstruction (remote, optional) ---------------- */
const SPACE_ID = (process.env.HF_TRYOFF_SPACE_ID ?? "").trim();
const TOKEN = (process.env.HF_TOKEN ?? "").trim();
let reconStatus = "skipped";
let reconNote = "";
let reconBuf = null;

if (SELFTEST) {
  /* Synthetic generator stand-in: navy proxy "garment" on solid green
   * chroma + slight edge fringe. Proves extractor + composite + QA
   * end-to-end with zero quota. Labeled synthetic — never a fidelity claim. */
  const SW = 512;
  const SH = 512;
  const garment = await sharp({
    create: { width: 300, height: 380, channels: 4, background: { r: 30, g: 45, b: 80, alpha: 1 } },
  })
    .png()
    .toBuffer();
  reconBuf = await sharp({
    create: { width: SW, height: SH, channels: 3, background: { r: 0, g: 255, b: 0 } },
  })
    .composite([{ input: garment, left: 106, top: 66 }])
    .blur(0.6) // faint fringe like a real generator edge
    .png()
    .toBuffer();
  save("recon-raw.png", reconBuf);
  reconStatus = "ready";
  reconNote = "selftest synthetic fixture (solid chroma + proxy garment)";
  console.log("[4/6] recon: SELFTEST synthetic fixture written");
}

/* Qwen-Image-Edit-2511 spike via the OFFICIAL public Space (no hosting needed).
 * quota: 180 s reserved/call — at most ONE call/day on the free tier.
 * rewrite_prompt=false (their DashScope polisher is server-side; we send the
 * final Wardrobe-style prompt verbatim). Steps kept low (12) for speed;
 * reservation cost is fixed regardless. Input order mirrors app.py infer():
 * [gallery, prompt, seed, randomize, guidance, steps, h, w, rewrite]. */
const QWEN_SPACE_HOST = "qwen-qwen-image-edit-2511.hf.space";
const QWEN_STEPS = Number(arg("qwen-steps", "8"));

function buildReconPrompt(itemName, itemClass) {
  return (
    `Reconstruct ONLY the complete empty ${itemName} (${itemClass}) shown in the reference ` +
    `photograph as a clean front-facing ecommerce catalog product photograph. ` +
    `Remove the wearer, background scene, and every other object entirely. Show the complete ` +
    `garment naturally arranged and symmetrical, fully inside the frame with generous even ` +
    `padding. Preserve the exact dominant color, material and texture, silhouette, waistband, ` +
    `fastenings, pattern, hems, side stripes, and every clearly legible graphic, logo, or text ` +
    `exactly as shown. Do not invent or reinterpret uncertain logos, text, pockets, seams, or ` +
    `decoration. Background: perfectly flat, absolutely uniform solid #00FF00 chroma-key ` +
    `color, edge-to-edge, no shadow, gradient, texture, floor, or lighting variation. Use no ` +
    `#00FF00 anywhere in the garment. Neutral diffuse product lighting on the garment only. ` +
    `No person, body, mannequin, hanger, props, watermark, caption, or border.`
  );
}

async function callQwenSpace(cropBytes, prompt) {
  // Preferred: OUR Space (HF_QWEN_SPACE_ID) via the stable /predict protocol
  // (input_image, prompt, seed, num_steps → PIL), same shape as the tryoff
  // Space. Fallback: official Space via @gradio/client (currently
  // scheduler-blocked — kept for re-testing if their caps change).
  const QWEN_SPACE_ID = (process.env.HF_QWEN_SPACE_ID ?? "").trim();
  if (QWEN_SPACE_ID) return callQwenOursSpace(QWEN_SPACE_ID, cropBytes, prompt);
  return callQwenOfficialSpace(cropBytes, prompt);
}

/* Ours: tryoff-style raw protocol against a self-hosted single-endpoint
 * Space (/predict: input_image, prompt, seed, num_steps → PIL). Shared by
 * the qwen-vision and klein spike Spaces — `tag` only labels log lines. */
async function callOursSpace(tag, spaceId, cropBytes, prompt, steps) {
  const apiBase = `https://${spaceId.replace("/", "-")}.hf.space/gradio_api`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const form = new FormData();
  form.append("files", new Blob([cropBytes], { type: "image/jpeg" }), "crop.jpg");
  const up = await fetch(`${apiBase}/upload`, { method: "POST", headers: auth, body: form });
  if (!up.ok) throw new Error(`${tag} upload failed: HTTP ${up.status}`);
  const upJson = await up.json();
  const filePath = upJson?.[0] ?? upJson?.files?.[0];
  if (!filePath) throw new Error(`${tag} upload returned no path`);
  const sessionHash = crypto.randomUUID();
  const joinRes = await fetch(`${apiBase}/queue/join`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [
        { path: filePath, url: null, orig_name: "crop.jpg", mime_type: "image/jpeg" },
        prompt,
        SEED,
        steps,
      ],
      event_data: null,
      fn_index: 0,
      trigger_id: null,
      session_hash: sessionHash,
    }),
  });
  if (!joinRes.ok) throw new Error(`${tag} queue join failed: HTTP ${joinRes.status}`);
  await joinRes.json();
  const stream = await fetch(`${apiBase}/queue/data?session_hash=${sessionHash}`, {
    headers: auth,
  });
  if (!stream.body) throw new Error(`${tag} queue stream empty`);
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let fileUrl = null;
  // 300 s poll ceiling absorbs queue contention without masking a
  // genuinely stuck job.
  const deadline = Date.now() + 300_000;
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
          throw new Error(`${tag} job failed: ${JSON.stringify(msg).slice(0, 300)}`);
        }
        if (msg.msg === "estimation" || msg.msg === "progress") {
          process.stdout.write(`\r[${tag}] queue: ${JSON.stringify(msg).slice(0, 90)}   `);
        }
      } catch (e) {
        if (String(e?.message ?? e).startsWith(`${tag} job failed`)) throw e;
      }
    }
    if (fileUrl) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  process.stdout.write("\n");
  if (!fileUrl) throw new Error(`${tag} timed out waiting for result (300 s)`);
  const fileRes = await fetch(
    fileUrl.startsWith("http") ? fileUrl : `${apiBase}/file=${fileUrl}`,
    { headers: auth }
  );
  if (!fileRes.ok) throw new Error(`${tag} result fetch failed: HTTP ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
}

/* Qwen-vision Space: 4–10 steps clamp (60 s reservation era). */
async function callQwenOursSpace(spaceId, cropBytes, prompt) {
  return callOursSpace(
    "qwen-ours",
    spaceId,
    cropBytes,
    prompt,
    Math.max(4, Math.min(10, Math.round(QWEN_STEPS)))
  );
}

async function callQwenOfficialSpace(cropBytes, prompt) {
  // Sanctioned path: @gradio/client resolves the named /infer endpoint and
  // serializes the Gallery input (raw queue protocol hangs: fn_index 0 is
  // not a real endpoint on this Space — verified via /gradio_api/info).
  const { Client } = await import("@gradio/client");
  const app = await Client.connect(`https://${QWEN_SPACE_HOST}`, { token: TOKEN });
  const file = new File([cropBytes], "crop.jpg", { type: "image/jpeg" });
  const payload = [
    [{ image: file, caption: null }],
    prompt,
    SEED,
    false,
    4.0,
    QWEN_STEPS,
    1024,
    1024,
    false,
  ];
  if (QWEN_PROBE) {
    // Streaming diagnostics: surfaces queue/model errors the one-shot
    // predict() collapses into "An error occurred". Burns quota like a call.
    const job = app.submit("/infer", payload);
    for await (const msg of job) {
      console.log("[qwen-probe]", msg.type, JSON.stringify(msg).slice(0, 400));
    }
    throw new Error("qwen-probe complete (see event log above)");
  }
  const res = await app.predict("/infer", payload);
  const gallery = res?.data?.[0];
  const first = Array.isArray(gallery) ? gallery[0] : null;
  const img = first?.image ?? first;
  const url = img?.url ?? null;
  if (!url) throw new Error(`qwen returned no image url: ${JSON.stringify(res?.data).slice(0, 200)}`);
  const fileRes = await fetch(url.startsWith("http") ? url : `https://${QWEN_SPACE_HOST}${url}`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!fileRes.ok) throw new Error(`qwen result fetch failed: HTTP ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
}

async function callTryoffSpace(cropBytes) {
  const apiBase = `https://${SPACE_ID.replace("/", "-")}.hf.space/gradio_api`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const form = new FormData();
  form.append("files", new Blob([cropBytes], { type: "image/jpeg" }), "crop.jpg");
  const up = await fetch(`${apiBase}/upload`, { method: "POST", headers: auth, body: form });
  if (!up.ok) throw new Error(`space upload failed: HTTP ${up.status}`);
  const upJson = await up.json();
  const filePath = upJson?.[0] ?? upJson?.files?.[0];
  if (!filePath) throw new Error("space upload returned no path");
  const sessionHash = crypto.randomUUID();
  const joinRes = await fetch(`${apiBase}/queue/join`, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json" },
    body: JSON.stringify({
      data: [
        { path: filePath, url: null, orig_name: "crop.jpg", mime_type: "image/jpeg" },
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
  const stream = await fetch(`${apiBase}/queue/data?session_hash=${sessionHash}`, {
    headers: auth,
  });
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
      } catch (e) {
        if (String(e?.message ?? e).startsWith("space job failed")) throw e;
      }
    }
    if (fileUrl) break;
  }
  try {
    await reader.cancel();
  } catch {
    /* ignore */
  }
  if (!fileUrl) throw new Error("timed out waiting for result (120 s)");
  const fileRes = await fetch(
    fileUrl.startsWith("http") ? fileUrl : `${apiBase}/file=${fileUrl}`,
    { headers: auth }
  );
  if (!fileRes.ok) throw new Error(`result fetch failed: HTTP ${fileRes.status}`);
  return Buffer.from(await fileRes.arrayBuffer());
}

if (WANT_KLEIN && !SELFTEST) {
  const KLEIN_SPACE_ID = (process.env.HF_KLEIN_SPACE_ID ?? "").trim();
  const KLEIN_STEPS = Number(arg("klein-steps", "20"));
  if (!KLEIN_SPACE_ID || !TOKEN) {
    reconStatus = "skipped";
    reconNote = "no-credentials: set HF_KLEIN_SPACE_ID + HF_TOKEN (see hf-klein/README.md)";
    console.log("[4/6] recon(klein): SKIPPED (Space not deployed yet)");
  } else {
    const prompt = buildReconPrompt(SLUG, CLASS);
    save("klein-prompt.txt", Buffer.from(prompt + "\n"));
    console.log(
      `[4/6] recon(klein): ${KLEIN_SPACE_ID}, ${KLEIN_STEPS} steps, seed=${SEED} (ONE 60 s slot, bounded spike)…`
    );
    const t0 = Date.now();
    try {
      reconBuf = await callOursSpace(
        "klein",
        KLEIN_SPACE_ID,
        cropBuf,
        prompt,
        Math.max(8, Math.min(28, Math.round(KLEIN_STEPS)))
      );
      save("recon-raw.png", reconBuf);
      reconStatus = "ready";
      reconNote = `klein wall_ms=${Date.now() - t0} bytes=${reconBuf.length}`;
      console.log(`[4/6] recon(klein): ready (${reconNote})`);
    } catch (e) {
      reconStatus = "failed";
      reconNote = String(e?.message ?? e).slice(0, 300);
      console.log(`[4/6] recon(klein): FAILED — ${reconNote}`);
    }
  }
} else if (WANT_QWEN && !SELFTEST) {
  if (!TOKEN) {
    reconStatus = "skipped";
    reconNote = "no-credentials: HF_TOKEN required (quota burns the CALLER account)";
    console.log("[4/6] recon(qwen): SKIPPED (no HF_TOKEN)");
  } else {
    const prompt = buildReconPrompt(SLUG, CLASS);
    save("qwen-prompt.txt", Buffer.from(prompt + "\n"));
    console.log(
      `[4/6] recon(qwen): ${(process.env.HF_QWEN_SPACE_ID ?? "").trim() ? "own Space" : "official Space (likely scheduler-blocked)"}, ` +
        `${QWEN_STEPS} steps, seed=${SEED}…`
    );
    const t0 = Date.now();
    try {
      reconBuf = await callQwenSpace(cropBuf, prompt);
      save("recon-raw.png", reconBuf);
      reconStatus = "ready";
      reconNote = `qwen-edit wall_ms=${Date.now() - t0} bytes=${reconBuf.length}`;
      console.log(`[4/6] recon(qwen): ready (${reconNote})`);
    } catch (e) {
      reconStatus = "failed";
      reconNote = String(e?.message ?? e).slice(0, 300);
      console.log(`[4/6] recon(qwen): FAILED — ${reconNote}`);
      if (process.env.QWEN_DEBUG) {
        console.log("[qwen-debug]", e?.stack ?? e);
        try {
          console.log("[qwen-debug] cause:", JSON.stringify(e?.cause ?? null).slice(0, 2000));
        } catch {
          /* ignore */
        }
      }
    }
  }
} else if (WANT_TRYOFF && !SELFTEST) {
  if (!SPACE_ID || !TOKEN) {
    reconStatus = "skipped";
    reconNote = "no-credentials: set HF_TRYOFF_SPACE_ID + HF_TOKEN to run the remote step";
    console.log("[4/6] recon: SKIPPED (no HF credentials — CPU-only stages continue)");
  } else {
    console.log(`[4/6] recon: calling ${SPACE_ID} class=${CLASS} seed=${SEED} (one ZeroGPU slot)…`);
    const t0 = Date.now();
    try {
      reconBuf = await callTryoffSpace(cropBuf);
      save("recon-raw.png", reconBuf);
      reconStatus = "ready";
      reconNote = `wall_ms=${Date.now() - t0} bytes=${reconBuf.length}`;
      console.log(`[4/6] recon: ready (${reconNote})`);
    } catch (e) {
      reconStatus = "failed";
      reconNote = String(e?.message ?? e).slice(0, 300);
      console.log(`[4/6] recon: FAILED — ${reconNote}`);
    }
  }
} else if (!SELFTEST) {
  const existing = join(outDir, "recon-raw.png");
  if (existsSync(existing)) {
    // Quota-friendly re-run: reuse the saved reconstruction (no GPU call).
    reconBuf = readFileSync(existing);
    reconStatus = "reused";
    reconNote = `loaded saved recon-raw.png bytes=${reconBuf.length} (no quota burned)`;
    console.log("[4/6] recon: REUSED saved recon-raw.png (no GPU call)");
  } else {
    console.log("[4/6] recon: skipped (pass --tryoff to call the Space)");
  }
}

/* ---------------- 5 · deterministic chroma extraction ----------------
 * Border-sampled key (Wardrobe method): median RGB of a thin border band,
 * max-per-channel distance, transparent <= 12, opaque >= 220, smoothstep
 * ramp between, key-dominant despill, transparent pixels zeroed to RGBA 0.
 * Runs on recon-raw when present; otherwise analyzes the crop background
 * uniformity and reports (dry-run QA of stage 5 logic without a GPU). */
function borderMedianKey(raw, w, h, ch) {
  const band = 4;
  const rs = [];
  const gs = [];
  const bs = [];
  const push = (x, y) => {
    const o = (y * w + x) * ch;
    rs.push(raw[o]);
    gs.push(raw[o + 1]);
    bs.push(raw[o + 2]);
  };
  for (let y = 0; y < band; y++) for (let x = 0; x < w; x++) push(x, y);
  for (let y = h - band; y < h; y++) for (let x = 0; x < w; x++) push(x, y);
  for (let y = band; y < h - band; y++)
    for (let x = 0; x < band; x++) {
      push(x, y);
      push(w - 1 - x, y);
    }
  const med = (a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];
  return [med(rs), med(gs), med(bs)];
}

function smoothstep(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

async function chromaExtract(inputBuf) {
  const { data, info } = await sharp(inputBuf).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const { width: w, height: h, channels: ch } = info;
  const key = borderMedianKey(data, w, h, ch);
  const keyed = key.map((v, i) => (v > 200 ? i : -1)).filter((i) => i >= 0);
  const neutral = key.map((v, i) => (v < 55 ? i : -1)).filter((i) => i >= 0);
  const out = Buffer.from(data);
  let transparent = 0;
  let opaque = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    const dr = data[o] - key[0];
    const dg = data[o + 1] - key[1];
    const db = data[o + 2] - key[2];
    const dist = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
    let alpha;
    if (dist <= 12) alpha = 0;
    else if (dist >= 220) alpha = 255;
    else alpha = Math.round(255 * smoothstep(12, 220, dist));
    // Despill: cap key-dominant channels to the strongest non-key channel.
    // Skipped when the key is white/grey (all channels keyed): there is no
    // non-key reference, and capping would zero the garment itself.
    if (alpha > 0 && keyed.length > 0 && keyed.length < 3) {
      const nonKeyMax = Math.max(
        ...[0, 1, 2].filter((c) => !keyed.includes(c)).map((c) => data[o + c]),
        0
      );
      for (const c of keyed) {
        if (out[o + c] > nonKeyMax) out[o + c] = nonKeyMax;
      }
      void neutral;
    }
    alpha = Math.round((alpha * data[o + 3]) / 255);
    out[o + 3] = alpha;
    if (alpha === 0) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      transparent++;
    } else if (alpha === 255) opaque++;
  }
  const png = await sharp(out, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toBuffer();
  return { png, key, w, h, transparent, opaque, total: w * h };
}

let chromaInfo = null;
if (reconBuf) {
  chromaInfo = await chromaExtract(reconBuf);
  save("chroma.png", chromaInfo.png);
  console.log(
    `[5/6] chroma.png: key=rgb(${chromaInfo.key.join(",")}) ` +
      `transparent=${((100 * chromaInfo.transparent) / chromaInfo.total).toFixed(1)}%`
  );
} else {
  // Dry-run: still exercise the extractor on the crop to validate stage-5
  // code paths + report background uniformity (crop bg is a busy bedspread,
  // so coverage numbers here diagnose the ALGORITHM, not the garment).
  chromaInfo = await chromaExtract(cropBuf);
  save("chroma-dryrun.png", chromaInfo.png);
  console.log(
    `[5/6] chroma dry-run on crop (no recon yet): key=rgb(${chromaInfo.key.join(",")}) ` +
      `transparent=${((100 * chromaInfo.transparent) / chromaInfo.total).toFixed(1)}%`
  );
}

/* ---------------- 6 · studio composite + QA ---------------- */
const STUDIO_W = 768;
const STUDIO_H = 1024;
const BACKDROP = { top: "#F4F1EB", mid: "#ECE7DD", bottom: "#DCD5C7" };
const hex = (h) => [1, 3, 5].map((o) => parseInt(h.slice(o, o + 2), 16));

async function composite(rgbaBuf) {
  const cut = sharp(rgbaBuf).ensureAlpha();
  const trimmedPng = await cut.clone().trim({ threshold: 10 }).png().toBuffer();
  const t = await sharp(trimmedPng).metadata();
  const tw = t.width ?? 1;
  const th = t.height ?? 1;
  const maxW = Math.round(STUDIO_W * 0.82);
  const maxH = Math.round(STUDIO_H * 0.82);
  const scale = Math.min(maxW / tw, maxH / th);
  const dw = Math.max(1, Math.round(tw * scale));
  const dh = Math.max(1, Math.round(th * scale));
  const dx = Math.round((STUDIO_W - dw) / 2);
  const dy = Math.round((STUDIO_H - dh) / 2);
  const resized = await sharp(trimmedPng).resize(dw, dh, { fit: "fill" }).toBuffer();
  // Backdrop: vertical sweep + catalog glow + soft floor shadow (SVG palette).
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${STUDIO_W}" height="${STUDIO_H}">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="${BACKDROP.top}"/><stop offset="0.62" stop-color="${BACKDROP.mid}"/>` +
    `<stop offset="1" stop-color="${BACKDROP.bottom}"/></linearGradient>` +
    `<radialGradient id="gl" cx="0.5" cy="0.42" r="0.75">` +
    `<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.85"/>` +
    `<stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.25"/>` +
    `<stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>` +
    `<filter id="bl" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="16"/></filter></defs>` +
    `<rect width="${STUDIO_W}" height="${STUDIO_H}" fill="url(#bg)"/>` +
    `<rect width="${STUDIO_W}" height="${STUDIO_H}" fill="url(#gl)"/>` +
    `<ellipse cx="${STUDIO_W / 2}" cy="${dy + dh + 18}" rx="${Math.round(dw * 0.31)}" ry="26" fill="#3A3428" opacity="0.32" filter="url(#bl)"/></svg>`;
  const base = sharp(Buffer.from(svg)).png();
  return base
    .composite([{ input: resized, left: dx, top: dy }])
    .png()
    .toBuffer();
}

function cornersTransparent(raw, w, h, ch) {
  const a = (x, y) => raw[(y * w + x) * ch + 3];
  return (
    a(0, 0) === 0 && a(w - 1, 0) === 0 && a(0, h - 1) === 0 && a(w - 1, h - 1) === 0
  );
}

let finalName = null;
const qa = {
  slug: SLUG,
  class: CLASS,
  seed: SEED,
  input: INPUT,
  analyzer: analysis.analyzer,
  bbox1000: bbox,
  cropRect,
  recon: { status: reconStatus, note: reconNote },
  chroma: chromaInfo
    ? {
        key: chromaInfo.key,
        dims: { width: chromaInfo.w, height: chromaInfo.h },
        transparentFrac: chromaInfo.transparent / chromaInfo.total,
        opaqueFrac: chromaInfo.opaque / chromaInfo.total,
      }
    : null,
  checks: {},
};

if (reconBuf && chromaInfo) {
  const finalBuf = await composite(chromaInfo.png);
  save("final.png", finalBuf);
  finalName = "final.png";
  const { data, info } = await sharp(chromaInfo.png).ensureAlpha().raw().toBuffer({
    resolveWithObject: true,
  });
  const cov = 1 - chromaInfo.transparent / chromaInfo.total;
  qa.checks = {
    validPng: true,
    hasAlpha: info.channels === 4,
    nonEmptyAlpha: chromaInfo.transparent > 0 && chromaInfo.transparent < chromaInfo.total,
    transparentCorners: cornersTransparent(data, info.width, info.height, info.channels),
    coverageInRange: cov >= 0.08 && cov <= 0.85,
    coverage: cov,
  };
  console.log(`[6/6] final.png: composite ready, coverage=${(100 * cov).toFixed(1)}%`);
} else {
  qa.checks = {
    note: "no recon yet — final.png pending remote step; crop + extractor dry-run validated",
  };
  console.log("[6/6] final.png: pending (--tryoff not run)");
}

saveJson("qa.json", qa);
console.log(`\nartifacts → ${OUT}/ { ${[originalName, "analysis.json", "bbox.json", "crop.jpg",
  ...(reconBuf ? ["recon-raw.png", "chroma.png", "final.png"] : ["chroma-dryrun.png"]),
  "qa.json",
].join(", ")} }`);

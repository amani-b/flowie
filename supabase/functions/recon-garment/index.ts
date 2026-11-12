// Supabase Edge Function: recon-garment (garment reconstruction renderer).
// Deploy: `supabase functions deploy recon-garment --no-verify-jwt`
// Secrets (dashboard → Edge Functions → Secrets, NEVER in client code):
//   HF_TRYOFF_SPACE_ID e.g. amani-b/garment-flat-lay-flowie
//   HF_KLEIN_SPACE_ID  e.g. amani-b/klein-garment-test (detail renderer)
//   HF_TOKEN           read token (Spaces). Shared ZeroGPU quota pool.
//   (No SB_* needed: like its flatlay-tryoff predecessor this function does
//   NOT write to Storage or touch rows — it returns base64 and the client
//   caches on the record + IndexedDB. Zero storage writes.)
//
// Input JSON: { garment_id, image_data_url, garment_class ("upper"|"lower"|"dress"),
//   renderer ("tryoff"|"klein", default "tryoff"), name, seed=42 }
// Output JSON: { recon_data_url, renderer } — data:image/png;base64
// Logs one line per call so daily volume can be sanity-checked
// against the free ZeroGPU quota (~30 s tryoff / ~60 s klein per call).
//
// Hybrid router (Track 2 verdict, Sept 2026): plain garments → TryOffDiff
// (silhouette/color/construction, drops micro-graphics); print garments
// (wearer-set hasPrint flag) → FLUX.2-klein-base-4B (keeps GUESS tape
// legible; ~13 GB VRAM, packs free ZeroGPU where 20B Qwen OOMs).
//
// Replaces enhance-garment (FLUX-schnell re-light) + flatlay-tryoff
// (whole-image try-off caller): same engine, new crop-first contract — the
// client sends the analyzer bbox crop, not the raw photo.

// @ts-nocheck — edge runtime has no local tsconfig; keep dependency-free.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const TRYOFF_SPACE_ID = Deno.env.get("HF_TRYOFF_SPACE_ID") ?? "";
const KLEIN_SPACE_ID = Deno.env.get("HF_KLEIN_SPACE_ID") ?? "";
const HF_TOKEN = Deno.env.get("HF_TOKEN") ?? "";
/** Klein operating point from the bounded spike (20 steps, ~35 s wall). */
const KLEIN_STEPS = 20;

function bytesToB64(bytes: Uint8Array): string {
  // Chunked: a single String.fromCharCode(...bytes) overflows the stack.
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * Evidence-bound reconstruction prompt — same text the harness sends the
 * Klein spike Space (scripts/recon-harness.mjs buildReconPrompt). Sent
 * verbatim: no server-side rewrite, no DashScope. The "do not invent"
 * clause is load-bearing (Klein hallucinates drawstrings/stripes on
 * plain garments without it — measured Sept 2026).
 */
function buildReconPrompt(itemName: string, itemClass: string): string {
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

async function gradioPredict(
  spaceId: string,
  imageDataUrl: string,
  /** Endpoint payload AFTER the uploaded file (tryoff: [class, seed]; klein: [prompt, seed, steps]). */
  restData: unknown[]
): Promise<{ b64: string; mime: string }> {
  // Minimal Gradio queue protocol (no SDK dep in edge runtime):
  // upload file → join queue → poll event stream → fetch result bytes.
  // Both Spaces expose a single /predict endpoint at fn_index 0 with the
  // uploaded file first — only the trailing payload differs.
  const apiBase = `https://${spaceId.replace("/", "-")}.hf.space/gradio_api`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${HF_TOKEN}`,
  };
  // 1 · upload the image as a file (data URLs hit HTTP 431 on keyless paths).
  const blob = await (await fetch(imageDataUrl)).blob();
  const form = new FormData();
  form.append("files", blob, "source.jpg");
  const up = await fetch(`${apiBase}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${HF_TOKEN}` },
    body: form,
  });
  if (!up.ok) throw new Error(`space upload failed: HTTP ${up.status}`);
  const upJson = await up.json();
  const filePath = upJson?.[0] ?? upJson?.files?.[0];
  if (!filePath) throw new Error("space upload returned no path");

  // 2 · join the /predict queue (single-endpoint Space: fn_index 0).
  // NOTE: poll with the CLIENT-GENERATED session_hash (not the join
  // event_id) — polling event_id hangs with zero SSE events on Gradio
  // 5.x (verified live against this Space: ~11 s end-to-end).
  const sessionHash = crypto.randomUUID();
  const join = await fetch(`${apiBase}/queue/join`, {
    method: "POST",
    headers,
      body: JSON.stringify({
        data: [
          { path: filePath, url: null, orig_name: "source.jpg", mime_type: "image/jpeg" },
          ...restData,
        ],
      event_data: null,
      fn_index: 0,
      trigger_id: null,
      session_hash: sessionHash,
    }),
  });
  if (!join.ok) throw new Error(`space queue join failed: HTTP ${join.status}`);
  await join.json();

  // 3 · poll the SSE stream for completion.
  const stream = await fetch(`${apiBase}/queue/data?session_hash=${sessionHash}`, { headers });
  if (!stream.body) throw new Error("space queue stream empty");
  const reader = stream.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let fileUrl: string | null = null;
  const deadline = Date.now() + 85_000;
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
        if ((e as Error).message?.startsWith("space job failed")) throw e;
      }
    }
    if (fileUrl) break;
  }
  try { await reader.cancel(); } catch { /* ignore */ }
  if (!fileUrl) throw new Error("space job timed out waiting for result");

  const fileRes = await fetch(fileUrl.startsWith("http") ? fileUrl : `${apiBase}/file=${fileUrl}`, {
    headers: { Authorization: `Bearer ${HF_TOKEN}` },
  });
  if (!fileRes.ok) throw new Error(`space result fetch failed: HTTP ${fileRes.status}`);
  const bytes = new Uint8Array(await fileRes.arrayBuffer());
  const mime = fileRes.headers.get("content-type") ?? "image/png";
  return { b64: bytesToB64(bytes), mime };
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-user-id",
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }
  const t0 = Date.now();
  try {
    const {
      garment_id,
      image_data_url,
      garment_class = "upper",
      renderer = "tryoff",
      name = "garment",
      seed = 42,
    } = await req.json();
    if (!garment_id || !image_data_url) {
      return json({ error: "garment_id + image_data_url required" }, 400);
    }
    if (!["upper", "lower", "dress"].includes(garment_class)) {
      return json({ error: "garment_class must be upper|lower|dress" }, 400);
    }
    if (renderer !== "tryoff" && renderer !== "klein") {
      return json({ error: "renderer must be tryoff|klein" }, 400);
    }
    if (!HF_TOKEN) {
      return json({ error: "function not configured (secrets missing)" }, 503);
    }
    let b64: string;
    let mime: string;
    if (renderer === "klein") {
      if (!KLEIN_SPACE_ID) {
        return json({ error: "klein renderer not configured (HF_KLEIN_SPACE_ID missing)" }, 503);
      }
      const prompt = buildReconPrompt(String(name), garment_class);
      ({ b64, mime } = await gradioPredict(KLEIN_SPACE_ID, image_data_url, [
        prompt,
        seed,
        KLEIN_STEPS,
      ]));
    } else {
      if (!TRYOFF_SPACE_ID) {
        return json({ error: "function not configured (secrets missing)" }, 503);
      }
      ({ b64, mime } = await gradioPredict(TRYOFF_SPACE_ID, image_data_url, [
        garment_class,
        seed,
      ]));
    }
    const ms = Date.now() - t0;
    // Quota log line — count lines per day to sanity-check the free tier.
    console.log(
      `[recon-garment] call garment=${garment_id} class=${garment_class} renderer=${renderer} seed=${seed} b64=${b64.length} wall_ms=${ms}`
    );
    return json({ recon_data_url: `data:${mime};base64,${b64}`, renderer }, 200);
  } catch (e) {
    console.log(`[recon-garment] FAILED wall_ms=${Date.now() - t0}: ${String((e as Error)?.message ?? e).slice(0, 500)}`);
    return json({ error: String((e as Error)?.message ?? e).slice(0, 500) }, 502);
  }
});

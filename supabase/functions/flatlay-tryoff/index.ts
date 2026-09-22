// Supabase Edge Function: flatlay-tryoff (free AI flat-lay).
// Deploy: `supabase functions deploy flatlay-tryoff --no-verify-jwt`
// Secrets (dashboard → Edge Functions → Secrets, NEVER in client code):
//   HF_TRYOFF_SPACE_ID e.g. amani-b/flowie-garment-tryoff
//   HF_TOKEN           read token (Spaces). Same token as the schnell
//                      Space works — one token, shared ZeroGPU quota pool.
//   (No SB_* needed: unlike enhance-garment this function does NOT write
//   to Storage or touch rows — it returns base64 and the client caches in
//   IndexedDB like the on-device composite. Zero DB migration.)
//
// Input JSON: { garment_id, image_data_url, garment_class ("upper"|"lower"|"dress"), seed=42 }
// Output JSON: { flatlay_data_url } — data:image/png;base64 (512x512)
// Logs one line per try-off call so daily volume can be sanity-checked
// against the free ZeroGPU quota (~10 s reserved/call here vs 60 s schnell).

// @ts-nocheck — edge runtime has no local tsconfig; keep dependency-free.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

const SPACE_ID = Deno.env.get("HF_TRYOFF_SPACE_ID") ?? "";
const HF_TOKEN = Deno.env.get("HF_TOKEN") ?? "";

function bytesToB64(bytes: Uint8Array): string {
  // Chunked: a single String.fromCharCode(...bytes) overflows the stack.
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

async function gradioPredict(
  imageDataUrl: string,
  garmentClass: string,
  seed: number
): Promise<{ b64: string; mime: string }> {
  // Minimal Gradio queue protocol (no SDK dep in edge runtime):
  // upload file → join queue → poll event stream → fetch result bytes.
  const apiBase = `https://${SPACE_ID.replace("/", "-")}.hf.space/gradio_api`;
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
  // 5.x (verified live against this Space: ~8 s end-to-end).
  const sessionHash = crypto.randomUUID();
  const join = await fetch(`${apiBase}/queue/join`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: [
        { path: filePath, url: null, orig_name: "source.jpg", mime_type: "image/jpeg" },
        garmentClass,
        seed,
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
    const { garment_id, image_data_url, garment_class = "upper", seed = 42 } =
      await req.json();
    if (!garment_id || !image_data_url) {
      return json({ error: "garment_id + image_data_url required" }, 400);
    }
    if (!["upper", "lower", "dress"].includes(garment_class)) {
      return json({ error: "garment_class must be upper|lower|dress" }, 400);
    }
    if (!SPACE_ID || !HF_TOKEN) {
      return json({ error: "function not configured (secrets missing)" }, 503);
    }
    const { b64, mime } = await gradioPredict(image_data_url, garment_class, seed);
    const ms = Date.now() - t0;
    // Quota log line — count lines per day to sanity-check the free tier.
    console.log(
      `[flatlay-tryoff] call garment=${garment_id} class=${garment_class} seed=${seed} b64=${b64.length} wall_ms=${ms}`
    );
    return json({ flatlay_data_url: `data:${mime};base64,${b64}` }, 200);
  } catch (e) {
    console.log(`[flatlay-tryoff] FAILED wall_ms=${Date.now() - t0}: ${String((e as Error)?.message ?? e).slice(0, 500)}`);
    return json({ error: String((e as Error)?.message ?? e).slice(0, 500) }, 502);
  }
});

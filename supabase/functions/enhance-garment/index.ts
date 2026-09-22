// Supabase Edge Function: enhance-garment (Phase 4).
// Deploy: `supabase functions deploy enhance-garment --no-verify-jwt`
// Secrets (dashboard → Edge Functions → Secrets, NEVER in client code):
//   HF_SPACE_ID  e.g. amani-b/flowie-garment-img2img
//   HF_TOKEN     read token (Inference/Spaces)
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (for bucket upload + row update)
//
// Input JSON: { garment_id, image_data_url, strength=0.3, num_steps=4, seed=42 }
// Output JSON: { studio_render_url } — public URL of
//   wardrobe/<userId>/<garmentId>-studio.jpg
// Logs one line per img2img call so the daily count can be sanity-checked
// against the free ZeroGPU quota (~5 garments/day free, 60 s reserved/call).

// @ts-nocheck — edge runtime has no local tsconfig; keep dependency-free.
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.98.0";

const SPACE_ID = Deno.env.get("HF_SPACE_ID") ?? "";
const HF_TOKEN = Deno.env.get("HF_TOKEN") ?? "";
// NOTE: `supabase secrets set` rejects names starting with SUPABASE_
// (reserved), so the project URL + service key live under SB_* names.
// Fall back to the runtime's built-in SUPABASE_* vars where present.
const SB_URL =
  Deno.env.get("SB_URL") ?? Deno.env.get("SUPABASE_URL") ?? "";
const SB_SERVICE_KEY =
  Deno.env.get("SB_SERVICE_ROLE_KEY") ??
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  "";

const STUDIO_PROMPT =
  "professional studio product photography of a garment, soft diffused lighting, crisp fabric texture, perfectly legible printed text and logos, accurate small lettering, clean e-commerce catalog shot, photorealistic";
const STUDIO_NEGATIVE =
  "person, human, model, mannequin, face, hands, blurry, distorted, extra limbs";

async function gradioPredict(imageDataUrl: string, strength: number, steps: number, seed: number): Promise<Uint8Array> {
  // Minimal Gradio queue protocol (no SDK dep in edge runtime):
  // join queue → poll event stream → fetch result file bytes.
  const apiBase = `https://${SPACE_ID.replace("/", "-")}.hf.space/gradio_api`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${HF_TOKEN}`,
  };
  // 1 · upload the image as a file (data URLs hit HTTP 431 on keyless paths).
  const blob = await (await fetch(imageDataUrl)).blob();
  const form = new FormData();
  form.append("files", blob, "composite.jpg");
  const up = await fetch(`${apiBase}/upload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${HF_TOKEN}` },
    body: form,
  });
  if (!up.ok) throw new Error(`space upload failed: HTTP ${up.status}`);
  const upJson = await up.json();
  const filePath = upJson?.[0] ?? upJson?.files?.[0];
  if (!filePath) throw new Error("space upload returned no path");

  // 2 · join the /predict queue.
  const join = await fetch(`${apiBase}/queue/join`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      data: [
        { path: filePath, url: null, orig_name: "composite.jpg", mime_type: "image/jpeg" },
        STUDIO_PROMPT,
        STUDIO_NEGATIVE,
        strength,
        steps,
        seed,
      ],
      event_data: null,
      fn_index: 0,
      trigger_id: null,
      session_hash: crypto.randomUUID(),
    }),
  });
  if (!join.ok) throw new Error(`space queue join failed: HTTP ${join.status}`);
  const { event_id } = await join.json();

  // 3 · poll the SSE stream for completion.
  const stream = await fetch(`${apiBase}/queue/data?session_hash=${event_id}`, { headers });
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
  return new Uint8Array(await fileRes.arrayBuffer());
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
  // Browser clients (supabase-js invoke) send an OPTIONS preflight first
  // because of the auth headers. Answer it or the real POST never arrives
  // (preflight 405 with no CORS headers = blocked at the browser).
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }
  if (req.method !== "POST") {
    return json({ error: "POST only" }, 405);
  }
  const t0 = Date.now();
  try {
    const authUserId = req.headers.get("x-user-id") ?? "";
    const { garment_id, image_data_url, strength = 0.3, num_steps = 4, seed = 42 } =
      await req.json();
    if (!garment_id || !image_data_url) {
      return json({ error: "garment_id + image_data_url required" }, 400);
    }
    if (!SPACE_ID || !HF_TOKEN || !SB_URL || !SB_SERVICE_KEY) {
      return json({ error: "function not configured (secrets missing)" }, 503);
    }
    const out = await gradioPredict(image_data_url, strength, num_steps, seed);
    const ms = Date.now() - t0;
    // Quota log line — count lines per day to sanity-check the free tier.
    console.log(
      `[enhance-garment] img2img call garment=${garment_id} strength=${strength} steps=${num_steps} seed=${seed} bytes=${out.length} wall_ms=${ms}`
    );

    const admin = createClient(SB_URL, SB_SERVICE_KEY);
    // Owner lookup: the row must already exist (created by insertGarmentRow).
    const { data: row } = await admin
      .from("wardrobe_items")
      .select("user_id")
      .eq("id", garment_id)
      .single();
    const ownerId = (row as { user_id?: string } | null)?.user_id ?? authUserId;
    if (!ownerId) {
      return json({ error: "unknown garment owner" }, 404);
    }
    const path = `${ownerId}/${garment_id}-studio.jpg`;
    const { error: upErr } = await admin.storage
      .from("wardrobe")
      .upload(path, out, { upsert: true, contentType: "image/jpeg" });
    if (upErr) throw new Error(`storage upload failed: ${upErr.message}`);
    const { data: urlData } = admin.storage.from("wardrobe").getPublicUrl(path);
    const studioUrl = urlData.publicUrl;
    const { error: rowErr } = await admin
      .from("wardrobe_items")
      .update({ studio_render_url: studioUrl })
      .eq("id", garment_id);
    if (rowErr) {
      // Column missing (migration not applied) or RLS — still return the URL
      // so the client can display it this session; row sync follows later.
      console.log(`[enhance-garment] row update skipped garment=${garment_id}: ${rowErr.message}`);
    }
    return json({ studio_render_url: studioUrl }, 200);
  } catch (e) {
    console.log(`[enhance-garment] FAILED wall_ms=${Date.now() - t0}: ${String((e as Error)?.message ?? e).slice(0, 500)}`);
    return json({ error: String((e as Error)?.message ?? e).slice(0, 500) }, 502);
  }
});

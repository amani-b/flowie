import { supabase, isSupabaseConfigured } from "./supabaseClient";

/**
 * Phase 4 — img2img enhance trigger (client side, secret-free).
 *
 * Full pipeline per garment, run ONCE at import/upload time:
 *   Phase 1 `studioComposite` (local, on-device)
 *     → Edge Function `enhance-garment` (holds HF_TOKEN + HF_SPACE_ID)
 *     → FLUX.1-schnell Space `/predict` (strength 0.3, 4 steps, seed 42)
 *     → result stored to `wardrobe/<userId>/<garmentId>-studio.jpg`
 *     → `wardrobe_items.studio_render_url` updated
 *     → client re-fetches the URL onto the local record (`studioRenderUrl`)
 *
 * Quota guard: the Space burns one reserved 60 s ZeroGPU slot per call
 * (~5 garments/day free). The client never calls the Space directly —
 * HF_TOKEN must never be bundled (no VITE_ prefix, never in client code).
 * The Edge Function is the only caller and logs one line per call so the
 * daily count can be sanity-checked against the free Neuron quota.
 *
 * Failure contract (matches the Phase 4 brief): a failed/timed-out call
 * never blocks the upload — the garment keeps its SVG fallback
 * (`rendering`) + Phase 1 composite, lands on
 * `studioRenderStatus: "failed"`, and becomes retryable from the Closet
 * detail sheet. This function never throws for enhance reasons; it
 * resolves to a status object and logs to console.
 */

export const STUDIO_ENHANCE_STRENGTH = 0.3;
export const STUDIO_ENHANCE_STEPS = 4;
export const STUDIO_ENHANCE_SEED = 42;

/** LocalStorage key for the client-side daily call sanity counter. */
const COUNT_KEY = "fitflow-enhance-calls-v1";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function bumpLocalDailyCounter(): number {
  try {
    const raw = localStorage.getItem(COUNT_KEY);
    const parsed = raw ? (JSON.parse(raw) as { day?: string; n?: number }) : {};
    const today = todayKey();
    const next =
      parsed.day === today ? { day: today, n: (parsed.n ?? 0) + 1 } : { day: today, n: 1 };
    localStorage.setItem(COUNT_KEY, JSON.stringify(next));
    return next.n;
  } catch {
    return -1;
  }
}

export type EnhanceOutcome =
  | { status: "ready"; studioRenderUrl: string }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string };

/**
 * Fire-and-forget enhance for one garment. Call AFTER the garment row
 * exists in Supabase (needs userId + garmentId for the bucket path).
 * Timeout defaults to 90 s (Space cold-start + 4-step schnell headroom).
 */
export async function requestStudioEnhance(args: {
  userId: string;
  garmentId: string;
  /** Phase 1 composite data URL preferred; falls back to original photo. */
  compositeDataUrl?: string;
  photoDataUrl?: string;
  timeoutMs?: number;
}): Promise<EnhanceOutcome> {
  const { userId, garmentId, timeoutMs = 90_000 } = args;
  const source = args.compositeDataUrl ?? args.photoDataUrl;
  if (!isSupabaseConfigured || !supabase) {
    return { status: "skipped", reason: "mock-mode" };
  }
  if (!source) {
    return { status: "skipped", reason: "no-source-image" };
  }

  const callCount = bumpLocalDailyCounter();
  console.log(
    `[studio-enhance] request garment=${garmentId} strength=${STUDIO_ENHANCE_STRENGTH} ` +
      `steps=${STUDIO_ENHANCE_STEPS} seed=${STUDIO_ENHANCE_SEED} ` +
      `local-day-count=${callCount}`
  );

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let fnError: unknown = null;
    let fnData: { studio_render_url?: string } | null = null;
    try {
      const res = await supabase.functions.invoke("enhance-garment", {
        body: {
          garment_id: garmentId,
          image_data_url: source,
          strength: STUDIO_ENHANCE_STRENGTH,
          num_steps: STUDIO_ENHANCE_STEPS,
          seed: STUDIO_ENHANCE_SEED,
        },
      });
      fnData = res.data as typeof fnData;
      fnError = res.error;
    } finally {
      clearTimeout(timer);
    }
    if (fnError) {
      const msg = fnError instanceof Error ? fnError.message : String(fnError);
      console.warn(`[studio-enhance] failed garment=${garmentId}: ${msg}`);
      return { status: "failed", error: msg };
    }
    const url =
      (fnData as { studio_render_url?: string } | null)?.studio_render_url ??
      null;
    if (!url) {
      // Function not deployed yet (or migration pending) — stay on fallback.
      console.warn(
        `[studio-enhance] skipped garment=${garmentId}: no studio_render_url in response (function not deployed?)`
      );
      return { status: "failed", error: "no-url-in-response" };
    }
    void userId;
    console.log(`[studio-enhance] ready garment=${garmentId} url=${url.slice(0, 80)}…`);
    return { status: "ready", studioRenderUrl: url };
  } catch (e) {
    const msg =
      e instanceof DOMException && e.name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e);
    console.warn(`[studio-enhance] failed garment=${garmentId}: ${msg}`);
    return { status: "failed", error: msg };
  }
}

import { supabase, isSupabaseConfigured } from "./supabaseClient";
import { withTimeout } from "../lib/utils";
import { analyzeGarmentBbox, geminiReady } from "./aiStylistService";
import type { Category } from "../types";

/**
 * Garment reconstruction provider — the single source of truth for
 * garment rendering (replaces studioComposite / studioEnhance /
 * studioTryoff / studioFlatlay).
 *
 * Pipeline per garment, run ONCE at import/upload time:
 *   original photo (untouched, kept on `garment.photo`)
 *     → analyze (Gemini garment bbox; full-frame stub as fallback)
 *     → crop to the bbox (lib/crop) — the crop-first contract the edge
 *       function documents
 *     → Edge Function `recon-garment` (holds HF_TOKEN + Space IDs)
 *     → renderer by garment.hasPrint: TryOffDiffv2-MGT (~30 s, default)
 *        or FLUX.2-klein detail spike (~60 s, logos/graphics/text)
 *     → recon PNG data URL cached on `garment.reconUrl` (+ `recon_url` column)
 *     → GarmentPhoto shows recon, SVG skeleton underneath while pending
 *
 * HYBRID ROUTER VERDICT (Track 2 comparison, Sept 2026, max 2 calls):
 * TryOffDiff preserves silhouette/color/construction but drops micro-graphics
 * (GUESS side tape omitted on the hard case). Klein keeps the tape legible
 * on the same case but invents details on plain garments (drawstring + side
 * stripes on navy trousers with no source evidence) and shifts color
 * saturation. So: plain → TryOffDiff, print → Klein, chosen by the
 * wearer-set `hasPrint` flag (the bbox analyzer locates the garment but
 * cannot see prints — the print HINT comes from tagging, suggest-only).
 * Qwen-Image-Edit-2511 stays parked: 20B bf16 OOMs free ZeroGPU at pack.
 *
 * FREE CONTRACT (prototype-safe):
 * - $0 per call inside the ZeroGPU free quota (~30 s reserved/call).
 * - Client-side guards: category gate (try-off only knows upper/lower/
 *   dress — shoes/accessories stay photo-only, no second strategy yet),
 *   daily budget, serialised job chain in the store.
 * - Never throws for recon reasons: resolves to a status object and the
 *   tile falls back to photo/SVG. Quota dry / function undeployed /
 *   mock mode all land on `skipped` or `failed` — never a stuck spinner.
 *
 * KNOWN MEASURED LIMITATION (not a blocker): TryOffDiff preserves
 * silhouette/color/construction but drops micro-graphics and small text
 * (verified: GUESS side tape omitted on the hard-case test) — hence the
 * hybrid router above: print garments go to Klein instead.
 */

export type ReconClass = "upper" | "lower" | "dress";

/** Recon backend: default TryOffDiff, detail Klein for print garments. */
export type ReconRenderer = "tryoff" | "klein";

/** Map closet categories onto recon classes; null = photo-only, no recon. */
export function reconClassFor(category: Category): ReconClass | null {
  switch (category) {
    case "top":
    case "outerwear":
      return "upper";
    case "bottom":
      return "lower";
    case "dress":
      return "dress";
    default:
      return null; // shoes + accessory: photo-only for now
  }
}

/** Bounding box in the Wardrobe 1000×1000 normalized coordinate system. */
export interface ReconBbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The full-frame fallback box — the stub's answer, and the test for "this
 * analysis located nothing", so the caller can skip a pointless crop.
 */
export const STUB_BBOX: ReconBbox = { x: 20, y: 20, width: 960, height: 960 };

export function isStubBbox(b: ReconBbox): boolean {
  return (
    b.x === STUB_BBOX.x &&
    b.y === STUB_BBOX.y &&
    b.width === STUB_BBOX.width &&
    b.height === STUB_BBOX.height
  );
}

export interface ReconAnalysis {
  analyzer: string;
  name: string;
  part: "upperbody" | "lowerbody" | "dress";
  color: string | null;
  secondaryColor: string | null;
  tags: string[];
  boundingBox: ReconBbox;
  reconClass: ReconClass;
}

/**
 * Analyzer (structured-vision contract).
 *
 * v0 was a stub: the full frame minus a margin, because the original sources
 * were single-garment flat-lays. That assumption broke the moment a worn or
 * multi-garment photo arrived — the renderer received the whole scene.
 *
 * The real analyzer asks Gemini for the garment's bounding box in the same
 * 1000×1000 grid the stub used, so the downstream contract never changed:
 * same shape, better numbers. ANY failure (no key, quota, malformed,
 * network) falls back to the full-frame stub — a worse crop costs render
 * quality, a thrown analyzer would cost the whole recon job. The stub's
 * shape IS the fallback contract, by design.
 */
export async function analyzeGarmentPhoto(args: {
  garmentId: string;
  category: Category;
  name: string;
  photoDataUrl?: string;
  signal?: AbortSignal;
}): Promise<ReconAnalysis | null> {
  const reconClass = reconClassFor(args.category);
  if (!reconClass) return null;
  const part =
    reconClass === "upper"
      ? "upperbody"
      : reconClass === "lower"
        ? "lowerbody"
        : "dress";

  if (geminiReady && args.photoDataUrl) {
    try {
      // A data URL rides straight through; an http(s) Storage URL is
      // fetched to bytes inside the bbox reader. Either way a failure
      // lands on null and the stub below takes over.
      const isDataUrl = args.photoDataUrl.startsWith("data:");
      const bbox = await analyzeGarmentBbox(
        args.photoDataUrl,
        isDataUrl ? args.photoDataUrl : undefined,
        args.signal
      );
      if (bbox) {
        return {
          analyzer: "gemini-bbox-v1",
          name: args.name,
          part,
          color: null,
          secondaryColor: null,
          tags: [],
          boundingBox: bbox,
          reconClass,
        };
      }
    } catch (e) {
      // analyzeGarmentBbox already swallows its own failures; this is belt
      // and braces — a broken analyzer must never fail a recon job.
      console.warn("[garment-recon] analyzer failed, using full-frame stub:", e);
    }
  }

  return {
    analyzer: "stub-v0 (Qwen3-VL-8B pending)",
    name: args.name,
    part,
    color: null,
    secondaryColor: null,
    tags: [],
    boundingBox: { ...STUB_BBOX },
    reconClass,
  };
}

/** Daily pool for recon calls (shared ZeroGPU free tier). */
export const RECON_DAILY_BUDGET = 4;

/** Wall-clock ceiling per call (Space queue + 20-step inference headroom). */
export const RECON_TIMEOUT_MS = 90_000;

export const RECON_SEED = 42;

const COUNT_KEY = "fitflow-recon-calls-v1";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Today's local recon call count (no increment — for UI/budget checks). */
export function getReconDailyCount(): number {
  try {
    const raw = localStorage.getItem(COUNT_KEY);
    const parsed = raw ? (JSON.parse(raw) as { day?: string; n?: number }) : {};
    return parsed.day === todayKey() ? (parsed.n ?? 0) : 0;
  } catch {
    return 0;
  }
}

function bumpReconDailyCounter(): number {
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

export type ReconOutcome =
  | { status: "ready"; reconDataUrl: string }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string };

function isAbortError(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || /abort/i.test(e.message))
  );
}

/**
 * Reject as soon as `signal` aborts, without waiting for the HTTP call to
 * give up. The underlying request cannot be truly cancelled (supabase-js has
 * no per-call signal), but the job queue stops waiting on it, so a cancelled
 * recon frees its serial lane immediately instead of holding it for the full
 * timeout.
 */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) {
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort)
    );
  });
}

/**
 * One reconstruction call. Never throws for recon reasons — resolves to
 * a status object; callers keep photo/SVG fallbacks.
 */
export async function requestGarmentRecon(args: {
  garmentId: string;
  reconClass: ReconClass;
  photoDataUrl?: string;
  /** Print garments → klein; default/unset → tryoff. Decided by the caller. */
  renderer?: ReconRenderer;
  name?: string;
  timeoutMs?: number;
  /** Job-queue cancellation. Aborting settles as `skipped("cancelled")`. */
  signal?: AbortSignal;
  /** Human-readable step report, for the progress banner/detail sheet. */
  onStage?: (stage: string) => void;
}): Promise<ReconOutcome> {
  const { garmentId, reconClass, timeoutMs = RECON_TIMEOUT_MS } = args;
  const renderer: ReconRenderer = args.renderer ?? "tryoff";
  const source = args.photoDataUrl;
  const stage = (s: string) => {
    try {
      args.onStage?.(s);
    } catch {
      /* a bad reporter must not fail a recon call */
    }
  };
  if (isSupabaseConfigured && supabase && source) stage("Checking today's budget…");
  if (!isSupabaseConfigured || !supabase) {
    return { status: "skipped", reason: "mock-mode" };
  }
  if (!source) {
    return { status: "skipped", reason: "no-source-image" };
  }
  if (getReconDailyCount() >= RECON_DAILY_BUDGET) {
    return { status: "skipped", reason: "daily-budget" };
  }
  if (args.signal?.aborted) {
    return { status: "skipped", reason: "cancelled" };
  }

  const callCount = bumpReconDailyCounter();
  console.log(
    `[garment-recon] request garment=${garmentId} class=${reconClass} renderer=${renderer} ` +
      `local-day-count=${callCount}`
  );

  try {
    stage("Uploading photo…");
    const outcome = await withTimeout(
      abortable(
        (async () => {
          const { data, error } = await supabase.functions.invoke("recon-garment", {
            body: {
              garment_id: garmentId,
              image_data_url: source,
              garment_class: reconClass,
              renderer,
              name: args.name ?? garmentId,
              seed: RECON_SEED,
            },
          });
          if (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.warn(`[garment-recon] failed garment=${garmentId}: ${msg}`);
            return { status: "failed" as const, error: msg };
          }
          const url = (data as { recon_data_url?: string } | null)?.recon_data_url ?? null;
          if (!url) {
            // Function not deployed yet — stay on fallbacks.
            console.warn(
              `[garment-recon] skipped garment=${garmentId}: no recon_data_url in response (function not deployed?)`
            );
            return { status: "failed" as const, error: "no-url-in-response" };
          }
          console.log(`[garment-recon] ready garment=${garmentId} bytes=${url.length}`);
          return { status: "ready" as const, reconDataUrl: url };
        })(),
        args.signal
      ),
      timeoutMs,
      "Garment recon"
    );
    return outcome;
  } catch (e) {
    // A cancel is a user action, not a failure — report it as such so the
    // garment is not marked "failed" for something the wearer chose.
    if (isAbortError(e) || args.signal?.aborted) {
      return { status: "skipped", reason: "cancelled" };
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[garment-recon] failed garment=${garmentId}: ${msg}`);
    return { status: "failed", error: msg };
  }
}

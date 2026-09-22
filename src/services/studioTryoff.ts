import { supabase, isSupabaseConfigured } from "./supabaseClient";
import { withTimeout } from "../lib/utils";
import type { Category } from "../types";

/**
 * Free AI flat-lay client (TryOffDiffv2-MGT via the `flatlay-tryoff` Edge
 * Function → self-hosted ZeroGPU Space — see hf-tryoff/README.md).
 *
 * Job: rebuild an uploaded garment photo as a canonical flat-lay product
 * shot. Input prefers the Phase-1 on-device composite (already isolated);
 * falls back to the compressed original photo.
 *
 * FREE CONTRACT (prototype-safe):
 * - $0 per call inside the ZeroGPU free quota (~10 s reserved/call).
 * - Client-side guards: category gate (try-off only knows upper/lower/
 *   dress — shoes/accessories never call), separate daily budget
 *   (FLATLAY_TRYOFF_DAILY_BUDGET), serialised job chain in the store.
 * - Never throws for flat-lay reasons: resolves to a status object and the
 *   tile falls back to composite/SVG. Quota dry / function undeployed /
 *   mock mode all land on `skipped` or `failed` — never a stuck spinner.
 */

export type TryoffClass = "upper" | "lower" | "dress";

/** Map closet categories onto try-off classes; null = no try-off model. */
export function tryoffClassFor(category: Category): TryoffClass | null {
  switch (category) {
    case "top":
    case "outerwear":
      return "upper";
    case "bottom":
      return "lower";
    case "dress":
      return "dress";
    default:
      return null; // shoes + accessory: free composite is the finish
  }
}

/** Separate daily pool from the schnell enhance budget (shared ZeroGPU). */
export const FLATLAY_TRYOFF_DAILY_BUDGET = 4;

/** Wall-clock ceiling per call (Space queue + 20-step inference headroom). */
export const FLATLAY_TRYOFF_TIMEOUT_MS = 90_000;

export const FLATLAY_TRYOFF_SEED = 42;

const COUNT_KEY = "fitflow-tryoff-calls-v1";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Today's local try-off call count (no increment — for UI/budget checks). */
export function getTryoffDailyCount(): number {
  try {
    const raw = localStorage.getItem(COUNT_KEY);
    const parsed = raw ? (JSON.parse(raw) as { day?: string; n?: number }) : {};
    return parsed.day === todayKey() ? (parsed.n ?? 0) : 0;
  } catch {
    return 0;
  }
}

function bumpTryoffDailyCounter(): number {
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

export type TryoffOutcome =
  | { status: "ready"; flatlayDataUrl: string }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string };

/**
 * One free flat-lay call. Never throws for flat-lay reasons — resolves to
 * a status object; callers keep composite/SVG fallbacks.
 */
export async function requestStudioTryoff(args: {
  garmentId: string;
  garmentClass: TryoffClass;
  compositeDataUrl?: string;
  photoDataUrl?: string;
  timeoutMs?: number;
}): Promise<TryoffOutcome> {
  const { garmentId, garmentClass, timeoutMs = FLATLAY_TRYOFF_TIMEOUT_MS } = args;
  const source = args.compositeDataUrl ?? args.photoDataUrl;
  if (!isSupabaseConfigured || !supabase) {
    return { status: "skipped", reason: "mock-mode" };
  }
  if (!source) {
    return { status: "skipped", reason: "no-source-image" };
  }
  if (getTryoffDailyCount() >= FLATLAY_TRYOFF_DAILY_BUDGET) {
    return { status: "skipped", reason: "daily-budget" };
  }

  const callCount = bumpTryoffDailyCounter();
  console.log(
    `[studio-tryoff] request garment=${garmentId} class=${garmentClass} ` +
      `local-day-count=${callCount}`
  );

  try {
    const outcome = await withTimeout(
      (async () => {
        const { data, error } = await supabase.functions.invoke("flatlay-tryoff", {
          body: {
            garment_id: garmentId,
            image_data_url: source,
            garment_class: garmentClass,
            seed: FLATLAY_TRYOFF_SEED,
          },
        });
        if (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.warn(`[studio-tryoff] failed garment=${garmentId}: ${msg}`);
          return { status: "failed" as const, error: msg };
        }
        const url = (data as { flatlay_data_url?: string } | null)?.flatlay_data_url ?? null;
        if (!url) {
          // Function not deployed yet — stay on free fallbacks.
          console.warn(
            `[studio-tryoff] skipped garment=${garmentId}: no flatlay_data_url in response (function not deployed?)`
          );
          return { status: "failed" as const, error: "no-url-in-response" };
        }
        console.log(`[studio-tryoff] ready garment=${garmentId} bytes=${url.length}`);
        return { status: "ready" as const, flatlayDataUrl: url };
      })(),
      timeoutMs,
      "Flat-lay"
    );
    return outcome;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[studio-tryoff] failed garment=${garmentId}: ${msg}`);
    return { status: "failed", error: msg };
  }
}

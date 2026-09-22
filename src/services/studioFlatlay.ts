/**
 * Photo-faithful AI flat-lay (Gemini 3.1 Flash Image, direct REST).
 *
 * Job: rebuild an uploaded garment photo as a clean top-down e-commerce
 * flat-lay — same garment pixels, idealized presentation. Input prefers the
 * Phase-1 on-device composite (already isolated); falls back to the
 * compressed original photo.
 *
 * COST CONTRACT (prototype = free by default):
 * - Gemini image output has NO free tier (~$0.03-0.06/image). So this module
 *   NEVER calls the network unless the master switch is on:
 *   `VITE_ENABLE_FLATLAY_AI === "true"`. Default (unset/false): every call
 *   resolves `{ status: "skipped", reason: "disabled" }` with zero cost —
 *   the free on-device composite + SVG carry the whole experience.
 * - When enabled: hybrid trigger (auto on upload while under daily budget +
 *   explicit manual tap), daily local budget guard, 60 s timeout, never-throw
 *   (failures → `{ status: "failed" }`, tile falls back to composite/SVG).
 * - Same REST shape as the tagging path (aiStylistService): no new vendor,
 *   no new secret — reuses `VITE_GEMINI_API_KEY`.
 */

const GEMINI_KEY = (import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();

/** Model: Nano Banana 2 (GA successor — 2.5-flash-image sunsets Oct 2026). */
export const FLATLAY_MODEL = "gemini-3.1-flash-image";

/** Master switch — OFF unless explicitly enabled. Prototype stays free. */
export const FLATLAY_AI_ENABLED =
  (import.meta.env.VITE_ENABLE_FLATLAY_AI ?? "").trim().toLowerCase() === "true";

/** Daily cap when enabled (prototype-small on purpose). */
export const FLATLAY_DAILY_BUDGET = 2;

/** Wall-clock ceiling per call (faster than the 90 s ZeroGPU enhance path). */
export const FLATLAY_TIMEOUT_MS = 60_000;

const COUNT_KEY = "fitflow-flatlay-calls-v1";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Today's local call count (no increment — for UI/budget checks). */
export function getFlatlayDailyCount(): number {
  try {
    const raw = localStorage.getItem(COUNT_KEY);
    const parsed = raw ? (JSON.parse(raw) as { day?: string; n?: number }) : {};
    return parsed.day === todayKey() ? (parsed.n ?? 0) : 0;
  } catch {
    return 0;
  }
}

function bumpFlatlayDailyCounter(): number {
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

export const FLATLAY_INSTRUCTION =
  "Rebuild this as a top-down e-commerce flat-lay product photo: the same garment lying flat on a neutral warm-gray studio sweep, spread neatly and centered, soft diffused lighting with a soft drop shadow. " +
  "Keep the EXACT same garment — same colors, pattern, prints, logos, stitching, buttons and shape. Do not restyle, recolor or redesign anything. " +
  "No person, no model, no mannequin, no face, no hands, no hanger.";

export type FlatlayOutcome =
  | { status: "ready"; flatlayDataUrl: string }
  | { status: "failed"; error: string }
  | { status: "skipped"; reason: string };

function dataUrlToParts(dataUrl: string): { mime: string; b64: string } | null {
  const m = /^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

/**
 * One photo-faithful flat-lay call. Never throws for flat-lay reasons —
 * resolves to a status object; callers keep composite/SVG fallbacks.
 */
export async function requestStudioFlatlay(args: {
  compositeDataUrl?: string;
  photoDataUrl?: string;
  timeoutMs?: number;
}): Promise<FlatlayOutcome> {
  const { timeoutMs = FLATLAY_TIMEOUT_MS } = args;
  const source = args.compositeDataUrl ?? args.photoDataUrl;
  // Free-by-default gates — checked BEFORE any network, in order:
  if (!FLATLAY_AI_ENABLED) return { status: "skipped", reason: "disabled" };
  if (!GEMINI_KEY) return { status: "skipped", reason: "no-key" };
  if (!source) return { status: "skipped", reason: "no-source-image" };
  if (getFlatlayDailyCount() >= FLATLAY_DAILY_BUDGET) {
    return { status: "skipped", reason: "daily-budget" };
  }
  const parts = dataUrlToParts(source);
  if (!parts) return { status: "skipped", reason: "no-source-image" };

  const callCount = bumpFlatlayDailyCounter();
  console.log(
    `[studio-flatlay] request model=${FLATLAY_MODEL} local-day-count=${callCount}`
  );

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${FLATLAY_MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: FLATLAY_INSTRUCTION },
                { inlineData: { mimeType: parts.mime, data: parts.b64 } },
              ],
            },
          ],
          generationConfig: {
            // Ask for image output; some SDK surfaces need this explicit.
            responseModalities: ["IMAGE"],
          },
        }),
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn(`[studio-flatlay] failed: HTTP ${res.status} ${text.slice(0, 200)}`);
      return { status: "failed", error: `gemini-http-${res.status}` };
    }
    const json = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> };
      }>;
    };
    const inline = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    const b64 = inline?.inlineData?.data;
    const mime = inline?.inlineData?.mimeType ?? "image/png";
    if (!b64) {
      console.warn("[studio-flatlay] failed: no image in response");
      return { status: "failed", error: "no-image-in-response" };
    }
    const flatlayDataUrl = `data:${mime};base64,${b64}`;
    console.log(`[studio-flatlay] ready bytes=${b64.length}`);
    return { status: "ready", flatlayDataUrl };
  } catch (e) {
    const msg =
      e instanceof DOMException && e.name === "AbortError"
        ? `timeout after ${timeoutMs}ms`
        : e instanceof Error
          ? e.message
          : String(e);
    console.warn(`[studio-flatlay] failed: ${msg}`);
    return { status: "failed", error: msg };
  } finally {
    clearTimeout(timer);
  }
}

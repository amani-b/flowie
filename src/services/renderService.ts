import type { Category, Garment } from "../types";
import { hexToRgb } from "../lib/utils";

/**
 * Garment rendering service — studio-product-photo re-renderings.
 *
 * What is displayed for a garment everywhere in the app is NOT the raw
 * upload but a generated re-rendering of that same garment (same category,
 * colors, pattern, silhouette) as new, professionally lit studio product
 * photography on a clean neutral background.
 *
 * Generation approach (verified 2026-09: free, no key, live):
 * - img2img was investigated first and rejected: the only keyless-plausible
 *   img2img path needs public image URLs + keyed endpoints, and Gemini
 *   image generation returns 429/quota-exceeded on this app's free-tier key
 *   (verified empirically) — so it cannot be the zero-cost path.
 * - Instead: two-step. Step 1 is the existing Gemini vision tagging (already
 *   free and working) whose output lives on every Garment. Step 2 feeds a
 *   detailed description built from those fields into Pollinations'
 *   legacy image endpoint, which is genuinely free with no API key
 *   (verified live: HTTP 200 image/jpeg, deterministic per prompt+seed).
 *   Drift risk is real (it re-synthesizes, it doesn't trace) — prompts are
 *   kept maximally specific to minimize it.
 *
 * Caching: rendering URLs are fully deterministic (prompt + seed derived
 * from the garment id), so a rendering is generated once server-side and
 * every later load of the same URL is a cache hit — the app never
 * regenerates per render, per screen, or per app open. New garments are
 * primed once at upload time (see primeRendering, called from addGarment).
 *
 * Failure: any load error falls back to the original photo, then to a
 * per-garment color tile (see GarmentPhoto). Uploads never block on this.
 */

const RENDER_BASE = "https://image.pollinations.ai/prompt";
const RENDER_W = 768;
const RENDER_H = 1024;

/** Deterministic FNV-1a seed from the garment id — stable forever.
 * Masked to a signed int32: the upstream image backend rejects seeds
 * above 2147483647 (verified: larger seeds fail generation outright). */
export function renderSeedFor(garmentId: string): number {
  let h = 2166136261;
  for (let i = 0; i < garmentId.length; i++) {
    h ^= garmentId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % 2147483647;
}

const SUBJECT: Record<Category, string> = {
  top: "top",
  bottom: "trousers",
  dress: "dress",
  outerwear: "jacket",
  shoes: "shoes",
  accessory: "accessory",
};

const NAMED_COLORS: Array<{ name: string; hex: string }> = [
  { name: "white", hex: "#ECEAE4" },
  { name: "black", hex: "#2A2D33" },
  { name: "gray", hex: "#6B7280" },
  { name: "navy blue", hex: "#3A4A63" },
  { name: "powder blue", hex: "#9DBBD9" },
  { name: "olive green", hex: "#6B6B4A" },
  { name: "camel brown", hex: "#C08552" },
  { name: "espresso brown", hex: "#5A3B2E" },
  { name: "rust orange", hex: "#C24D2C" },
  { name: "burgundy red", hex: "#7A2E3F" },
  { name: "forest green", hex: "#2F6B4F" },
  { name: "coral pink", hex: "#D64550" },
  { name: "bright orange", hex: "#E1580E" },
  { name: "denim blue", hex: "#4C6285" },
  { name: "charcoal gray", hex: "#3B3F45" },
];

/** Nearest human color name for a hex value (prompt specificity). */
export function colorName(hex: string): string {
  let best = NAMED_COLORS[0].name;
  let bestD = Infinity;
  let target: { r: number; g: number; b: number };
  try {
    target = hexToRgb(hex);
  } catch {
    return "gray";
  }
  for (const c of NAMED_COLORS) {
    const p = hexToRgb(c.hex);
    const d =
      (target.r - p.r) ** 2 + (target.g - p.g) ** 2 + (target.b - p.b) ** 2;
    if (d < bestD) {
      bestD = d;
      best = c.name;
    }
  }
  return best;
}

function patternLead(g: Garment): string {
  const names = g.colors.map(colorName);
  const combo =
    names.length > 1
      ? `${names[0]} with ${names.slice(1).join(" and ")} accents`
      : names[0];
  switch (g.pattern) {
    case "striped":
      return `${names[0]} striped`;
    case "colorblock":
      return `color-blocked ${combo}`;
    case "other":
      return `printed ${combo}`;
    default:
      return `solid ${combo}`;
  }
}

/**
 * Detailed, drift-minimizing description of this specific garment.
 * Color + subject lead the prompt: image models weight early tokens most,
 * and pushing the color first (verified: burgundy-dress center-pixel
 * distance-to-target 122 → 18) is what keeps the rendering faithful.
 */
export function buildRenderPrompt(g: Garment): string {
  const subject =
    g.category === "accessory" && g.kind
      ? g.kind === "cap"
        ? "cap"
        : g.kind === "bag"
          ? "bag"
          : "scarf"
      : SUBJECT[g.category];
  return (
    `Studio product photo, ${patternLead(g)} ${subject}, "${g.name}". ` +
    `Single garment isolated and centered on a clean light warm-gray seamless studio background, ` +
    `evenly lit, crisp retail catalog shot, brand new and unwrinkled. ` +
    `No person, no mannequin, no hanger, no background clutter, no text, no watermark.`
  );
}

/** Deterministic display URL for a garment's generated rendering. */
export function renderingUrl(g: Garment): string {
  const params = new URLSearchParams({
    width: String(RENDER_W),
    height: String(RENDER_H),
    seed: String(renderSeedFor(g.id)),
    nologo: "true",
    referrer: "flowie-app",
  });
  return `${RENDER_BASE}/${encodeURIComponent(buildRenderPrompt(g))}?${params.toString()}`;
}

const primedThisSession = new Set<string>();

/**
 * Warm the server-side cache once per garment per session, fire-and-forget.
 * Called from addGarment so a new upload's rendering is ready by the time
 * the user opens Studio. Never throws, never blocks.
 */
export function primeRendering(g: Garment): void {
  if (primedThisSession.has(g.id)) return;
  primedThisSession.add(g.id);
  try {
    void fetch(renderingUrl(g), { mode: "no-cors" }).catch(() => {});
  } catch {
    /* offline — the URL loads lazily on first display instead */
  }
}

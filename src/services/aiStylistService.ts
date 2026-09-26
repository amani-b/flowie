import type { Garment, Category, ColorFamily, Warmth, Formality } from "../types";
import { hexToRgb, withTimeout } from "../lib/utils";
import { detectPattern, type PixelSample } from "../lib/patternDetect";
import {
  EMPTY_PIXEL_TRUTH,
  SAMPLE_MAX_DIM,
  pixelTruthFromImageData,
} from "../lib/pixelSample";
import { blobToDataUrl } from "../lib/imagePipeline";

// Re-exported so existing callers keep a single import site.
export { withTimeout };

/**
 * AI-powered garment tagging service using Gemini (flash tier, free).
 * Sends uploaded garment photos to Gemini for structured analysis:
 * category, colors (hex array), pattern, color family, warmth level,
 * formality level, and optional tags.
 *
 * Falls back to client-side heuristic tagging when:
 * - No Gemini key is configured
 * - API quota is exceeded (429)
 * - Response is malformed
 */

/** Gemini flash-tier model for tagging + styling (free tier, vision-capable). */
export const GEMINI_MODEL = "gemini-3.5-flash";

/** Network ceiling for tagging calls: browser fetch never times out alone. */
const TAG_TIMEOUT_MS = 25_000;

const GEMINI_KEY = (import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();
export const geminiReady = GEMINI_KEY.length > 0;

export interface TaggingResult {
  name: string;
  category: Category;
  colors: string[]; // 1-3 hex values, most prominent first
  pattern: "solid" | "striped" | "colorblock" | "other";
  /** share of garment pixels per entry in `colors` (same order, sums to ~1) */
  patternMix?: number[];
  colorFamily: ColorFamily;
  warmth: Warmth;
  formality: Formality;
  tags: string[];
  confidence: number;
}

const CATEGORY_KEYWORDS: Record<Category, string[]> = {
  top: ["shirt", "tee", "t-shirt", "blouse", "sweater", "hoodie", "tank", "polo", "cardigan", "jersey"],
  bottom: ["pants", "jeans", "trousers", "shorts", "skirt", "leggings", "joggers", "chinos"],
  dress: ["dress", "jumpsuit", "romper"],
  outerwear: ["jacket", "coat", "blazer", "vest", "windbreaker", "parka", "overcoat", "cardigan"],
  shoes: ["shoes", "sneakers", "boots", "sandals", "loafers", "heels", "flats", "oxfords"],
  accessory: ["scarf", "hat", "cap", "bag", "belt", "gloves", "socks", "tie", "watch"],
};

const COLOR_MAP: Array<{ names: string[]; hex: string; family: ColorFamily }> = [
  { names: ["white", "off-white", "cream", "ivory", "bone"], hex: "#ECEAE4", family: "neutral" },
  { names: ["black", "charcoal", "graphite", "ink"], hex: "#2A2D33", family: "neutral" },
  { names: ["gray", "grey", "slate"], hex: "#6B7280", family: "neutral" },
  { names: ["navy", "indigo", "blue"], hex: "#3A4A63", family: "cool" },
  { names: ["powder blue", "light blue", "sky blue"], hex: "#9DBBD9", family: "cool" },
  { names: ["olive", "khaki", "tan", "beige"], hex: "#6B6B4A", family: "earth" },
  { names: ["camel", "brown", "espresso"], hex: "#C08552", family: "earth" },
  { names: ["rust", "terracotta", "burnt orange"], hex: "#C24D2C", family: "warm" },
  { names: ["red", "burgundy", "wine", "maroon"], hex: "#7A2E3F", family: "warm" },
  { names: ["green", "forest", "emerald", "bottle green"], hex: "#2F6B4F", family: "accent" },
  { names: ["pink", "coral", "salmon"], hex: "#D64550", family: "accent" },
  { names: ["orange", "amber"], hex: "#E1580E", family: "warm" },
];

function guessCategory(text: string): Category {
  const lower = text.toLowerCase();
  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => lower.includes(k))) return cat as Category;
  }
  return "top"; // default
}

function guessColor(text: string): { hex: string; family: ColorFamily } {
  const lower = text.toLowerCase();
  for (const c of COLOR_MAP) {
    if (c.names.some((n) => lower.includes(n))) {
      return { hex: c.hex, family: c.family };
    }
  }
  return { hex: "#6B7280", family: "neutral" }; // default gray
}

/**
 * Classify a hex color into one of the app's color families using HSL.
 * Used so a photo-uploaded garment's family reflects its real sampled
 * color instead of a filename guess (which is often just "IMG_1234").
 */
function classifyColorFamily(hex: string): ColorFamily {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));

  // Very low saturation, or near-black/near-white: neutral.
  if (s < 0.12 || l < 0.12 || l > 0.92) return "neutral";

  let h = 0;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;

  // Muted/darker warm hues read as earth tones (olive, khaki, camel,
  // espresso) rather than a bright accent or saturated warm color.
  if (h >= 25 && h < 75 && (s < 0.45 || l < 0.4)) return "earth";
  if (h >= 190 && h < 260) return "cool";
  if (h >= 75 && h < 190) return "accent"; // greens / teals
  if (h >= 300 || h < 20) return s > 0.5 && l > 0.55 ? "accent" : "warm"; // pink vs red/burgundy
  return "warm"; // remaining oranges / rust
}

type RGB = { r: number; g: number; b: number };

const rgbDist = (a: RGB, b: RGB) =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

/**
 * Extract dominant colors and a pattern classification from an image.
 *
 * The heavy part (decode, canvas, backdrop estimation, classification) now
 * lives in `lib/pixelSample` + `lib/imagePipeline`. This is the thin
 * main-thread wrapper that keeps its original public contract, and it accepts
 * a `Blob` so a caller holding a prepared blob never converts it to a data
 * URL just to sample it.
 *
 * `pixelTruth` lets an import pass truth it already computed in the worker,
 * which removes a whole second decode per garment.
 */
export async function extractColorsFromImage(
  image: Blob | string,
  pixelTruth?: { colors: string[]; pattern: TaggingResult["pattern"]; shares: number[] }
): Promise<{ colors: string[]; pattern: TaggingResult["pattern"]; shares: number[] }> {
  if (pixelTruth) return { ...pixelTruth };

  // Resolve-only by design (any decode failure yields the gray fallback),
  // so race a timeout around it: if neither onload nor onerror ever fires,
  // reject into the caller's fallback instead of pending forever.
  const work = new Promise<{
    colors: string[];
    pattern: TaggingResult["pattern"];
    shares: number[];
  }>((resolve) => {
    let objectUrl: string | null = null;
    const finish = (v: {
      colors: string[];
      pattern: TaggingResult["pattern"];
      shares: number[];
    }) => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      resolve(v);
    };
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      const srcW = img.naturalWidth || img.width;
      const srcH = img.naturalHeight || img.height;
      if (!ctx || srcW < 1 || srcH < 1) {
        finish({ ...EMPTY_PIXEL_TRUTH });
        return;
      }
      // Downscale for performance — 128px keeps narrow stripes resolvable
      // (64px blurs them into the background tone entirely).
      const scale = Math.min(1, SAMPLE_MAX_DIM / Math.max(srcW, srcH));
      const w = Math.max(1, Math.round(srcW * scale));
      const h = Math.max(1, Math.round(srcH * scale));
      canvas.width = w;
      canvas.height = h;
      // Flatten onto white in case any transparency survived upstream —
      // keeps a stray alpha channel from ever reading as black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      try {
        finish(pixelTruthFromImageData(ctx.getImageData(0, 0, w, h).data, w, h));
      } catch {
        finish({ ...EMPTY_PIXEL_TRUTH });
      }
    };
    img.onerror = () => finish({ ...EMPTY_PIXEL_TRUTH });
    if (typeof image === "string") {
      img.src = image;
    } else {
      objectUrl = URL.createObjectURL(image);
      img.src = objectUrl;
    }
  });
  return withTimeout(work, TAG_TIMEOUT_MS, "Color extraction");
}

function guessWarmth(text: string): Warmth {
  const lower = text.toLowerCase();
  if (lower.includes("winter") || lower.includes("heavy") || lower.includes("insulated") || lower.includes("puffer")) return 3;
  if (lower.includes("summer") || lower.includes("light") || lower.includes("thin") || lower.includes("breathable")) return 1;
  return 2;
}

function guessFormality(text: string): Formality {
  const lower = text.toLowerCase();
  if (lower.includes("formal") || lower.includes("suit") || lower.includes("blazer") || lower.includes("oxford")) return 3;
  if (lower.includes("casual") || lower.includes("tee") || lower.includes("jogger") || lower.includes("sneaker")) return 1;
  return 2;
}

/** Client-side heuristic fallback when Gemini is unavailable. */
export async function tagGarmentHeuristic(
  file: File,
  image?: Blob | string,
  pixelTruth?: { colors: string[]; pattern: TaggingResult["pattern"]; shares: number[] }
): Promise<TaggingResult> {
  const safeName = (file.name ?? "Untitled piece").replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");

  // Use actual image color extraction instead of filename guessing
  let colors = ["#6B7280"];
  let pattern: TaggingResult["pattern"] = "solid";
  let patternMix: number[] | undefined;
  // Honest confidence: the fallback can sample real pixels but can't see
  // structure the way a vision model can — solid-with-dominant-color is
  // the only high-confidence call it gets to make.
  let confidence = 0.5;

  if (image) {
    try {
      const extracted = await extractColorsFromImage(image, pixelTruth);
      colors = extracted.colors;
      pattern = extracted.pattern;
      patternMix = extracted.shares;
      confidence =
        pattern === "solid" && (extracted.shares[0] ?? 0) >= 0.9
          ? 0.7
          : pattern === "solid"
            ? 0.6
            : pattern === "other"
              ? 0.55
              : 0.65;
    } catch (e) {
      console.warn("Color extraction failed, using fallback:", e);
    }
  }

  // Prefer the family of the actual sampled color; only fall back to a
  // filename guess when there's no photo to sample from at all.
  const colorFamily = image
    ? classifyColorFamily(colors[0])
    : guessColor(safeName).family;

  return {
    name: safeName || "Untitled piece",
    category: guessCategory(safeName),
    colors,
    pattern,
    patternMix,
    colorFamily,
    warmth: guessWarmth(safeName),
    formality: guessFormality(safeName),
    tags: [],
    confidence,
  };
}

/**
 * Ask Gemini for tags. Accepts a Blob or a data URL.
 *
 * A Blob is encoded here, once, because the Gemini REST payload requires
 * inline base64. Accepting the Blob is what lets the caller pass an already
 * encoded `dataUrl` through untouched (see `tagGarmentPhoto`), so a bulk
 * import never re-encodes the same bytes twice.
 */
async function viaGemini(
  image: Blob | string,
  dataUrl?: string,
  signal?: AbortSignal
): Promise<TaggingResult> {
  const base64 = dataUrl
    ? dataUrl.slice(dataUrl.indexOf(",") + 1)
    : await blobToDataUrl(image as Blob).then((u) => u.slice(u.indexOf(",") + 1));
  const prompt =
    `You are a precise garment analyst. Look at this clothing photo and return ONLY valid JSON:\n` +
    `{"name":"brief descriptive name","category":"one of: top/bottom/dress/outerwear/shoes/accessory","colors":["#RRGGBB", ...],"pattern":"solid|striped|colorblock|other","colorFamily":"one of: neutral/warm/cool/earth/accent","warmth":1-3,"formality":1-3,"tags":["optional keywords"]}\n` +
    `Rules. Category must match exactly one option. colors: 1-3 hex values of the ACTUAL garment fabric (most prominent first) — describe the dominant color, then any real secondary colors; ignore the photo backdrop, hanger, shadows and shading gradients. pattern: classify honestly — "solid" for a plain single-color garment (shadows, folds and texture are still solid), "striped" ONLY for clear repeating stripes, "colorblock" for large distinct color regions, "other" for plaid/checks/florals/graphics/dots/prints. When in doubt between solid and patterned, choose solid. Warmth: 1=light/summer, 2=mid-season, 3=heavy/winter. Formality: 1=casual, 2=smart, 3=formal.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // AbortSignal.timeout: fetch has no default timeout — a stalled
      // connection used to hang tagGarmentPhoto (and the upload spinner)
      // forever instead of falling back to the heuristic path. A caller
      // signal is honoured too, so "Stop" on an import aborts in flight
      // instead of waiting out the ceiling.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TAG_TIMEOUT_MS)]) : AbortSignal.timeout(TAG_TIMEOUT_MS),
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { mimeType: "image/jpeg", data: base64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.3, responseMimeType: "application/json" },
      }),
    }
  );

  if (!res.ok) {
    if (res.status === 429) throw new Error("Gemini quota exceeded");
    throw new Error(`Gemini ${res.status}`);
  }

  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty Gemini response");

  const parsed = JSON.parse(text) as Partial<TaggingResult>;

  // Validate and fill defaults
  const validCategories = ["top", "bottom", "dress", "outerwear", "shoes", "accessory"] as Category[];
  const validFamilies = ["neutral", "warm", "cool", "earth", "accent"] as ColorFamily[];
  const validPatterns = ["solid", "striped", "colorblock", "other"] as const;

  // Validate colors array - each hex must be valid
  let colors: string[] = [];
  if (Array.isArray(parsed.colors)) {
    for (const c of parsed.colors.slice(0, 3)) {
      if (typeof c === "string" && /^#[0-9A-F]{6}$/i.test(c)) {
        colors.push(c);
      }
    }
  }
  if (colors.length === 0) colors = ["#6B7280"];

  // Validate pattern
  const pattern: TaggingResult["pattern"] = validPatterns.includes(parsed.pattern as any)
    ? (parsed.pattern as TaggingResult["pattern"])
    : "solid";

  return {
    name: parsed.name?.trim() || "Analyzed piece",
    category: validCategories.includes(parsed.category!) ? parsed.category! : "top",
    colors,
    pattern,
    colorFamily: validFamilies.includes(parsed.colorFamily!) ? parsed.colorFamily! : "neutral",
    warmth: (parsed.warmth && parsed.warmth >= 1 && parsed.warmth <= 3) ? parsed.warmth : 2,
    formality: (parsed.formality && parsed.formality >= 1 && parsed.formality <= 3) ? parsed.formality : 2,
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    confidence: 0.85,
  };
}

/**
 * Pixel-truth clamp: when the sampled pixels show one color owning the
 * garment (>=90%), a patterned label is a hallucination — force solid and
 * keep the sampled colors. Vision models occasionally read shading or
 * texture as pattern; pixels don't lie about area share.
 */
function clampPatternToPixels(
  t: TaggingResult,
  pixels: { colors: string[]; shares: number[] }
): TaggingResult {
  const dominantShare = pixels.shares[0] ?? 0;
  if (dominantShare >= 0.9 && t.pattern !== "solid") {
    return { ...t, pattern: "solid", colors: pixels.colors, patternMix: pixels.shares };
  }
  return t;
}

/**
 * Main entry point: analyze a garment photo.
 * Returns structured tagging data for user confirmation before saving.
 */
export interface TagPhotoOptions {
  /**
   * A data URL already encoded from `image`. Passed straight through to the
   * Gemini payload so a caller holding one (the import queue does) pays the
   * base64 cost once rather than again here.
   */
  dataUrl?: string;
  /** Caller cancellation, combined with the internal timeout. */
  signal?: AbortSignal;
  /** Pixel truth already computed upstream (worker), skipping a 2nd decode. */
  pixelTruth?: { colors: string[]; pattern: TaggingResult["pattern"]; shares: number[] };
}

/**
 * Main entry point: analyze a garment photo.
 * Returns structured tagging data for user confirmation before saving.
 *
 * Accepts a `Blob` (preferred) or a data URL, for backwards compatibility.
 * Both the Gemini path and the heuristic fallback used to re-wrap the data
 * URL with `fetch(dataUrl).blob()` just to get bytes back — decoding a
 * ~1.3 MB base64 payload twice per garment. With a Blob there is nothing to
 * unwrap, so both re-wraps are gone.
 */
export async function tagGarmentPhoto(
  image: Blob | string,
  fileName: string,
  opts: TagPhotoOptions = {}
): Promise<TaggingResult> {
  const { dataUrl, signal, pixelTruth } = opts;
  // Only a string needs materialising into a Blob; a Blob is already one.
  const asBlob = async (): Promise<Blob> =>
    typeof image === "string" ? fetch(image).then((r) => r.blob()) : image;

  if (geminiReady) {
    try {
      const [tagged, pixels] = await Promise.all([
        viaGemini(image, dataUrl, signal),
        // Pixel ground truth in parallel: cheap, local, no extra API cost.
        extractColorsFromImage(image, pixelTruth).catch(() => null),
      ]);
      const clamped = pixels ? clampPatternToPixels(tagged, pixels) : tagged;
      // Always attach the locally measured mix so the avatar renders the
      // real proportions even when the model only named the colors.
      if (pixels) {
        clamped.patternMix = pixels.shares;
      } else {
        try {
          const blob = await asBlob();
          const heur = await tagGarmentHeuristic(
            new File([blob], fileName, { type: blob.type }),
            blob,
            pixelTruth
          );
          clamped.patternMix = heur.patternMix;
        } catch {
          /* keep the model result without a mix */
        }
      }
      return clamped;
    } catch (e) {
      if (signal?.aborted) throw e;
      console.warn("Gemini tagging failed, falling back to heuristic:", e);
      // Fall through to heuristic
    }
  }
  // Heuristic fallback: the same bytes, never a re-fetch of a data URL.
  const blob = await asBlob();
  const file = new File([blob], fileName, { type: blob.type });
  return tagGarmentHeuristic(file, blob, pixelTruth);
}

/**
 * Convert TaggingResult to garment fields. The store mints the id/createdAt.
 *
 * `sha256` is the prepared-image content hash from the import pipeline
 * (`PreparedImage.sha256`). It rides along so reconstruction can be cached by
 * source content (see `services/reconCache.ts`) — re-importing identical
 * bytes must not spend a second remote call. Optional because manual/legacy
 * records have no hash; those fall back to a length-based cache key.
 */
export function taggingToGarment(
  t: TaggingResult,
  imageDataUrl?: string,
  sha256?: string
): Omit<Garment, "id" | "createdAt"> {
  return {
    name: t.name,
    category: t.category,
    color: t.colors[0], // primary/dominant color
    colors: t.colors,
    pattern: t.pattern,
    patternMix: t.patternMix,
    colorFamily: t.colorFamily,
    warmth: t.warmth,
    formality: t.formality,
    kind: t.category === "accessory" ? (t.tags.find((tag) => ["scarf", "cap", "bag"].includes(tag)) as any) : undefined,
    photo: imageDataUrl,
    photoSha256: sha256 || undefined,
  };
}

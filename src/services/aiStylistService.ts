import type { Garment, Category, ColorFamily, Warmth, Formality } from "../types";
import { uid, hexToRgb } from "../lib/utils";

/**
 * AI-powered garment tagging service using Gemini 2.5 Flash.
 * Sends uploaded garment photos to Gemini for structured analysis:
 * category, colors (hex array), pattern, color family, warmth level,
 * formality level, and optional tags.
 *
 * Falls back to client-side heuristic tagging when:
 * - No Gemini key is configured
 * - API quota is exceeded (429)
 * - Response is malformed
 */

const GEMINI_KEY = (import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();
export const geminiReady = GEMINI_KEY.length > 0;

export interface TaggingResult {
  name: string;
  category: Category;
  colors: string[]; // 1-3 hex values, most prominent first
  pattern: "solid" | "striped" | "colorblock" | "other";
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

const clampByte = (v: number) => Math.min(255, Math.max(0, v));

const rgbToHex = (c: RGB) =>
  `#${[c.r, c.g, c.b].map((v) => clampByte(Math.round(v)).toString(16).padStart(2, "0")).join("")}`;

/** Extract dominant colors (and a rough pattern) from an image using canvas sampling. */
async function extractColorsFromImage(imageDataUrl: string): Promise<{ colors: string[]; pattern: TaggingResult["pattern"] }> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        resolve({ colors: ["#6B7280"], pattern: "solid" });
        return;
      }
      // Downscale for performance
      const maxDim = 64;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      canvas.width = w;
      canvas.height = h;
      // Flatten onto white in case any transparency survived upstream —
      // keeps a stray alpha channel from ever reading as black.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);

      const imageData = ctx.getImageData(0, 0, w, h);
      const pixels = imageData.data;
      const pixelAt = (x: number, y: number): RGB => {
        const i = (y * w + x) * 4;
        return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] };
      };

      // Estimate the backdrop from the border pixels: garment photos are
      // typically shot centered on a plain backdrop (white, gray, etc.), so
      // the frame edge is a reasonable proxy for "not the garment" — a lot
      // more reliable than assuming the backdrop is always white.
      const border: RGB[] = [];
      const xStep = Math.max(1, Math.floor(w / 12));
      const yStep = Math.max(1, Math.floor(h / 12));
      for (let x = 0; x < w; x += xStep) {
        border.push(pixelAt(x, 0));
        border.push(pixelAt(x, h - 1));
      }
      for (let y = 0; y < h; y += yStep) {
        border.push(pixelAt(0, y));
        border.push(pixelAt(w - 1, y));
      }

      let backdrop: RGB | null = null;
      if (border.length > 0) {
        const sum = border.reduce(
          (acc, p) => ({ r: acc.r + p.r, g: acc.g + p.g, b: acc.b + p.b }),
          { r: 0, g: 0, b: 0 }
        );
        const mean: RGB = { r: sum.r / border.length, g: sum.g / border.length, b: sum.b / border.length };
        const agree = border.filter((p) => rgbDist(p, mean) < 40).length;
        // Only trust this as a real backdrop if most border samples agree —
        // otherwise the garment likely fills the frame and there's nothing
        // to subtract (subtracting a "backdrop" here would eat the garment).
        if (agree / border.length > 0.6) backdrop = mean;
      }

      // Quantize pixels into color bins, skipping backdrop and transparent
      // pixels. Bins keep a running average so the final hex reflects the
      // true sampled color, not just the bucket floor.
      const bucket = 28;
      const bins = new Map<string, { r: number; g: number; b: number; count: number }>();

      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];
        if (a < 128) continue;

        const px: RGB = { r, g, b };
        if (backdrop && rgbDist(px, backdrop) < 42) continue;
        // Safety net when no clear backdrop was detected: pure white
        // studio blowout right at the edge of exposure is still almost
        // never the garment itself.
        if (!backdrop && r > 250 && g > 250 && b > 250) continue;

        const key = `${Math.floor(r / bucket)},${Math.floor(g / bucket)},${Math.floor(b / bucket)}`;
        const existing = bins.get(key);
        if (existing) {
          existing.r += r;
          existing.g += g;
          existing.b += b;
          existing.count += 1;
        } else {
          bins.set(key, { r, g, b, count: 1 });
        }
      }

      if (bins.size === 0) {
        resolve({ colors: ["#6B7280"], pattern: "solid" });
        return;
      }

      const rawBins = Array.from(bins.values()).map((v) => ({
        r: v.r / v.count,
        g: v.g / v.count,
        b: v.b / v.count,
        count: v.count,
      }));
      rawBins.sort((a, b) => b.count - a.count);

      // Merge near-duplicate bins (anti-aliasing, shadow, and highlight
      // noise around a single true garment color) so a genuinely solid
      // garment doesn't get misread as a multi-color pattern.
      const merged: typeof rawBins = [];
      for (const bin of rawBins) {
        const target = merged.find((m) => rgbDist(m, bin) < 34);
        if (target) {
          const total = target.count + bin.count;
          target.r = (target.r * target.count + bin.r * bin.count) / total;
          target.g = (target.g * target.count + bin.g * bin.count) / total;
          target.b = (target.b * target.count + bin.b * bin.count) / total;
          target.count = total;
        } else {
          merged.push({ ...bin });
        }
      }
      merged.sort((a, b) => b.count - a.count);

      const top = merged.slice(0, 3);
      const colors = top.map(rgbToHex);

      // Detect pattern based on color distribution. The runner-up color
      // must carry real weight AND be visually distinct from the dominant
      // one — otherwise it's shading/noise on what is really a solid piece.
      let pattern: TaggingResult["pattern"] = "solid";
      const [first, second, third] = top;
      if (first && second) {
        const distinct = rgbDist(first, second) > 38;
        const significant = second.count > first.count * 0.3;
        if (distinct && significant) {
          const hasThird = !!third && rgbDist(third, first) > 38 && third.count > first.count * 0.18;
          pattern = hasThird ? "colorblock" : "striped";
        }
      }

      resolve({ colors: colors.length > 0 ? colors : ["#6B7280"], pattern });
    };
    img.onerror = () => resolve({ colors: ["#6B7280"], pattern: "solid" });
    img.src = imageDataUrl;
  });
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
export async function tagGarmentHeuristic(file: File, imageDataUrl?: string): Promise<TaggingResult> {
  const safeName = (file.name ?? "Untitled piece").replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");

  // Use actual image color extraction instead of filename guessing
  let colors = ["#6B7280"];
  let pattern: TaggingResult["pattern"] = "solid";

  if (imageDataUrl) {
    try {
      const extracted = await extractColorsFromImage(imageDataUrl);
      colors = extracted.colors;
      pattern = extracted.pattern;
    } catch (e) {
      console.warn("Color extraction failed, using fallback:", e);
    }
  }

  // Prefer the family of the actual sampled color; only fall back to a
  // filename guess when there's no photo to sample from at all.
  const colorFamily = imageDataUrl ? classifyColorFamily(colors[0]) : guessColor(safeName).family;

  return {
    name: safeName || "Untitled piece",
    category: guessCategory(safeName),
    colors,
    pattern,
    colorFamily,
    warmth: guessWarmth(safeName),
    formality: guessFormality(safeName),
    tags: [],
    confidence: 0.6,
  };
}

async function viaGemini(imageDataUrl: string): Promise<TaggingResult> {
  const prompt =
    `Analyze this garment photo and return ONLY valid JSON with this exact structure:\n` +
    `{"name":"brief descriptive name","category":"one of: top/bottom/dress/outerwear/shoes/accessory","colors":["#RRGGBB", ...],"pattern":"solid|striped|colorblock|other","colorFamily":"one of: neutral/warm/cool/earth/accent","warmth":1-3,"formality":1-3,"tags":["optional keywords"]}\n` +
    `Be precise. Category must match exactly one option. colors: array of 1-3 hex values (most prominent first). pattern: solid/striped/colorblock/other. Warmth: 1=light/summer, 2=mid-season, 3=heavy/winter. Formality: 1=casual, 2=smart, 3=formal.`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { mimeType: "image/jpeg", data: imageDataUrl.split(",")[1] } },
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
 * Main entry point: analyze a garment photo.
 * Returns structured tagging data for user confirmation before saving.
 */
export async function tagGarmentPhoto(imageDataUrl: string, fileName: string): Promise<TaggingResult> {
  if (geminiReady) {
    try {
      return await viaGemini(imageDataUrl);
    } catch (e) {
      console.warn("Gemini tagging failed, falling back to heuristic:", e);
      // Fall through to heuristic
    }
  }
  // Create a fake File for the heuristic fallback
  const blob = await fetch(imageDataUrl).then((r) => r.blob());
  const file = new File([blob], fileName, { type: blob.type });
  return tagGarmentHeuristic(file, imageDataUrl);
}

/** Convert TaggingResult to a full Garment object. */
export function taggingToGarment(t: TaggingResult, imageDataUrl?: string): Garment {
  return {
    id: uid("g"),
    name: t.name,
    category: t.category,
    color: t.colors[0], // primary/dominant color
    colors: t.colors,
    pattern: t.pattern,
    colorFamily: t.colorFamily,
    warmth: t.warmth,
    formality: t.formality,
    kind: t.category === "accessory" ? (t.tags.find((tag) => ["scarf", "cap", "bag"].includes(tag)) as any) : undefined,
    photo: imageDataUrl,
    createdAt: Date.now(),
  };
}

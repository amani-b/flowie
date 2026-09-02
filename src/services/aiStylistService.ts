import type { Garment, Category, ColorFamily, Warmth, Formality } from "../types";
import { uid } from "../lib/utils";

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

/** Extract dominant colors from an image using canvas sampling. */
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
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const pixels = imageData.data;

      // Simple color quantization: bucket pixels into color bins
      const colorBins = new Map<string, number>();
      const skipThreshold = 245; // Skip very light/white pixels

      for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const a = pixels[i + 3];

        // Skip transparent or near-white pixels
        if (a < 128 || (r > skipThreshold && g > skipThreshold && b > skipThreshold)) continue;

        // Quantize to reduce color space (bucket similar colors)
        const qr = Math.floor(r / 32) * 32;
        const qg = Math.floor(g / 32) * 32;
        const qb = Math.floor(b / 32) * 32;
        const key = `${qr},${qg},${qb}`;

        colorBins.set(key, (colorBins.get(key) ?? 0) + 1);
      }

      // Sort by frequency and take top 3
      const sorted = Array.from(colorBins.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);

      if (sorted.length === 0) {
        resolve({ colors: ["#6B7280"], pattern: "solid" });
        return;
      }

      const rgbToHex = (r: number, g: number, b: number) =>
        `#${[r, g, b].map((v) => Math.min(255, v).toString(16).padStart(2, "0")).join("")}`;

      const colors = sorted.map(([key]) => {
        const [r, g, b] = key.split(",").map(Number);
        return rgbToHex(r, g, b);
      });

      // Detect pattern based on color distribution
      let pattern: TaggingResult["pattern"] = "solid";
      if (colors.length >= 2) {
        const topCount = sorted[0][1];
        const secondCount = sorted[1]?.[1] ?? 0;
        // If second color is significant (>25% of top), consider it multi-color
        if (secondCount > topCount * 0.25) {
          pattern = colors.length >= 3 ? "colorblock" : "striped";
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

  const colorFamily = guessColor(safeName).family;

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

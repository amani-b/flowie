import type { Garment, Category, ColorFamily, Warmth, Formality } from "../types";
import { uid } from "../lib/utils";

/**
 * AI-powered garment tagging service using Gemini 2.5 Flash.
 * Sends uploaded garment photos to Gemini for structured analysis:
 * category, color (hex approximation), color family, warmth level,
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
  colorHex: string;
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
export function tagGarmentHeuristic(file: File): Promise<TaggingResult> {
  return new Promise((resolve) => {
    // Use filename and basic file metadata for educated guesses
    const safeName = (file.name ?? "Untitled piece").replace(/\.[^/.]+$/, "").replace(/[-_]/g, " ");
    const colorInfo = guessColor(safeName);
    setTimeout(() => {
      resolve({
        name: safeName || "Untitled piece",
        category: guessCategory(safeName),
        colorHex: colorInfo.hex,
        colorFamily: colorInfo.family,
        warmth: guessWarmth(safeName),
        formality: guessFormality(safeName),
        tags: [],
        confidence: 0.6,
      });
    }, 400);
  });
}

async function viaGemini(imageDataUrl: string): Promise<TaggingResult> {
  const prompt =
    `Analyze this garment photo and return ONLY valid JSON with this exact structure:\n` +
    `{"name":"brief descriptive name","category":"one of: top/bottom/dress/outerwear/shoes/accessory","colorHex":"#RRGGBB","colorFamily":"one of: neutral/warm/cool/earth/accent","warmth":1-3,"formality":1-3,"tags":["optional keywords"]}\n` +
    `Be precise. Category must match exactly one option. Warmth: 1=light/summer, 2=mid-season, 3=heavy/winter. Formality: 1=casual, 2=smart, 3=formal.`;

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

  return {
    name: parsed.name?.trim() || "Analyzed piece",
    category: validCategories.includes(parsed.category!) ? parsed.category! : "top",
    colorHex: /^#[0-9A-F]{6}$/i.test(parsed.colorHex || "") ? parsed.colorHex! : "#6B7280",
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
  return tagGarmentHeuristic(file);
}

/** Convert TaggingResult to a full Garment object. */
export function taggingToGarment(t: TaggingResult, imageDataUrl?: string): Garment {
  return {
    id: uid("g"),
    name: t.name,
    category: t.category,
    color: t.colorHex,
    colorFamily: t.colorFamily,
    warmth: t.warmth,
    formality: t.formality,
    kind: t.category === "accessory" ? (t.tags.find((tag) => ["scarf", "cap", "bag"].includes(tag)) as any) : undefined,
    photo: imageDataUrl,
    createdAt: Date.now(),
  };
}

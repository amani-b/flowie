import type {
  ColorFamily,
  Garment,
  Occasion,
  Outfit,
  StyleResult,
  WeatherNow,
} from "../types";
import { BUCKET_META, delay, pick, rand } from "../lib/utils";

/* ------------------------------------------------------------------ */
/*  Gemini 2.5 Flash (Google AI Studio). Without a key — or when the   */
/*  free-tier quota is exhausted (429) — we fall back to the local     */
/*  heuristic engine below, so styling always works.                   */
/* ------------------------------------------------------------------ */

const GEMINI_KEY = (import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();
export const geminiReady = GEMINI_KEY.length > 0;

const TARGET_FORMALITY: Record<Occasion, number> = {
  casual: 1,
  gym: 1,
  date: 2,
  party: 2,
  work: 3,
};

const HARMONY: Record<ColorFamily, Record<ColorFamily, number>> = {
  neutral: { neutral: 2, warm: 2, cool: 2, earth: 2, accent: 2 },
  warm: { neutral: 2, warm: 1, cool: -1, earth: 1, accent: 0 },
  cool: { neutral: 2, warm: -1, cool: 1, earth: 0, accent: 1 },
  earth: { neutral: 2, warm: 1, cool: 0, earth: 1, accent: 0 },
  accent: { neutral: 2, warm: 0, cool: 1, earth: 0, accent: -1 },
};

const harmony = (a?: Garment, b?: Garment) =>
  a && b ? HARMONY[a.colorFamily][b.colorFamily] : 0;

function byCat(garments: Garment[], cat: Garment["category"]) {
  return garments.filter((g) => g.category === cat);
}

function scoreCandidate(
  o: Outfit,
  occasion: Occasion,
  weather: WeatherNow | null
): number {
  const targetW = weather ? BUCKET_META[weather.bucket].targetWarmth : 2;
  const targetF = TARGET_FORMALITY[occasion];
  let s = 0;

  const cores = [o.top, o.bottom, o.dress, o.shoes].filter(Boolean) as Garment[];
  for (const g of cores) {
    s += 4 - 1.8 * Math.abs(g.warmth - targetW);
    s += 2.5 - 1.2 * Math.abs(g.formality - targetF);
  }

  const anchor = o.dress ?? o.top;
  s += harmony(anchor, o.bottom) * 1.2;
  s += harmony(anchor, o.shoes) * 0.8;
  s += harmony(anchor, o.outer) * 0.8;
  s += harmony(anchor, o.accessory) * 0.6;

  if (weather?.isRain) s += o.outer ? 3 : -2.5;
  if (weather?.bucket === "cold") {
    if (!o.outer) s -= 4;
    else if (o.outer.warmth >= 3) s += 2;
  }
  if (weather && (weather.bucket === "hot" || weather.bucket === "warm")) {
    if (o.outer) s -= o.outer.warmth >= 2 ? 4 : 1;
  }
  if (occasion === "gym" && o.dress) s -= 6;
  if ((occasion === "date" || occasion === "party") && o.accessory) s += 1.5;

  return s + rand(0, 1.2); // jitter so "regenerate" actually changes things
}

function buildRationale(
  o: Outfit,
  occasion: Occasion,
  weather: WeatherNow | null
): string {
  const bits: string[] = [];
  if (weather) {
    const opener = weather.isRain
      ? `${weather.feelsC}° with ${weather.label.toLowerCase()} — cover beats courage today`
      : weather.bucket === "hot" || weather.bucket === "warm"
        ? `${weather.feelsC}° and ${weather.label.toLowerCase()} — keep it airy`
        : `${weather.feelsC}° and ${weather.label.toLowerCase()} — layers earn their keep`;
    bits.push(opener + ".");
  }
  const anchor = o.dress ?? o.top;
  if (anchor) {
    const pair = o.dress
      ? `${o.dress.name} carries the whole look`
      : o.bottom
        ? `${anchor.name} over ${o.bottom.name} hits the ${occasion} brief`
        : `${anchor.name} leads`;
    bits.push(pair + ".");
  }
  const fam = anchor?.colorFamily;
  if (fam === "neutral") bits.push("A quiet tonal base lets one accent do the talking.");
  else if (fam === "accent") bits.push("One loud piece, everything else plays support.");
  else if (fam === "earth") bits.push("Earth tones keep it grounded without going flat.");
  else if (fam === "cool") bits.push("Cool hues read sharp in daylight.");
  else if (fam === "warm") bits.push("Warm tones add heat the sky may not.");
  if (o.outer && weather?.isRain) bits.push("Outer layer doubles as your umbrella.");
  return bits.join(" ");
}

/** Local heuristic engine — deterministic-ish, always available. */
export function composeOutfit(
  garments: Garment[],
  occasion: Occasion,
  weather: WeatherNow | null
): StyleResult {
  const tops = byCat(garments, "top");
  const bottoms = byCat(garments, "bottom");
  const dresses = byCat(garments, "dress");
  const outers = byCat(garments, "outerwear");
  const shoes = byCat(garments, "shoes");
  const extras = byCat(garments, "accessory");

  if (tops.length + dresses.length === 0) {
    throw new Error("No tops or dresses in the closet — add one to get styled.");
  }
  if (shoes.length === 0) {
    throw new Error("No shoes in the closet — even stylists draw the line at barefoot.");
  }

  const needOuter =
    !!weather &&
    (weather.isRain || weather.bucket === "cold" || weather.bucket === "cool");
  const wantAccessory =
    occasion === "date" || occasion === "party" || weather?.bucket === "cold";
  const dressOk = occasion !== "gym" && occasion !== "work" && dresses.length > 0;

  let best: Outfit | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < 110; i++) {
    const useDress = dressOk && (bottoms.length === 0 || Math.random() < 0.4);
    const o: Outfit = { shoes: pick(shoes) };
    if (useDress) {
      o.dress = pick(dresses);
    } else {
      if (tops.length) o.top = pick(tops);
      if (bottoms.length) o.bottom = pick(bottoms);
    }
    if (outers.length && (needOuter || Math.random() < 0.22)) {
      o.outer = pick(outers);
    }
    if (extras.length && (wantAccessory || Math.random() < 0.25)) {
      o.accessory = pick(extras);
    }
    const s = scoreCandidate(o, occasion, weather);
    if (s > bestScore) {
      bestScore = s;
      best = o;
    }
  }

  const outfit = best ?? { shoes: pick(shoes) };
  return {
    outfit,
    rationale: buildRationale(outfit, occasion, weather),
    engine: "heuristic",
    score: Math.round(bestScore * 10) / 10,
    occasion,
  };
}

/* ------------------------- Gemini pathway ------------------------- */

async function viaGemini(
  garments: Garment[],
  occasion: Occasion,
  weather: WeatherNow | null
): Promise<StyleResult> {
  const listing = garments
    .map(
      (g) =>
        `- id:${g.id} ${g.category} "${g.name}" color:${g.colorFamily} warmth:${g.warmth}/3 formality:${g.formality}/3`
    )
    .join("\n");
  const wx = weather
    ? `Weather: ${weather.feelsC}°C feels-like, ${weather.label}, rain:${weather.isRain}, bucket:${weather.bucket}.`
    : "Weather unknown; assume mild.";
  const prompt =
    `You are a personal stylist. Pick ONE outfit from this closet for occasion "${occasion}". ${wx}\n` +
    `Closet:\n${listing}\n` +
    `Respond with JSON only: {"top":id|null,"bottom":id|null,"dress":id|null,"outer":id|null,"shoes":id|null,"accessory":id|null,"rationale":"two sentences max"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.8, responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty Gemini response");
  const parsed = JSON.parse(text) as {
    top?: string | null;
    bottom?: string | null;
    dress?: string | null;
    outer?: string | null;
    shoes?: string | null;
    accessory?: string | null;
    rationale?: string;
  };
  const find = (id?: string | null) => garments.find((g) => g.id === id);
  const outfit: Outfit = {
    top: find(parsed.top),
    bottom: find(parsed.bottom),
    dress: find(parsed.dress),
    outer: find(parsed.outer),
    shoes: find(parsed.shoes) ?? byCat(garments, "shoes")[0],
    accessory: find(parsed.accessory),
  };
  if (!outfit.top && !outfit.dress) throw new Error("Gemini returned no core piece");
  return {
    outfit,
    rationale: parsed.rationale ?? "Assembled by Gemini.",
    engine: "gemini",
    score: 0,
    occasion,
  };
}

/* --------------------------- public API --------------------------- */

export async function generateStyle(
  garments: Garment[],
  occasion: Occasion,
  weather: WeatherNow | null
): Promise<StyleResult> {
  // Small latency keeps the staged UI readable and prevents flicker.
  await delay(650 + Math.random() * 550);
  if (geminiReady) {
    try {
      return await viaGemini(garments, occasion, weather);
    } catch {
      // Quota hit or bad response — fall through to the heuristic.
    }
  }
  return composeOutfit(garments, occasion, weather);
}

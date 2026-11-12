import type {
  ColorFamily,
  Garment,
  Occasion,
  Outfit,
  StyleResult,
  WeatherNow,
} from "../types";
import { BUCKET_META, OCCASION_META, delay, pick, rand } from "../lib/utils";

/* ------------------------------------------------------------------ */
/*  Gemini flash tier (free). Without a key — or when the free-tier    */
/*  quota is exhausted (429) — we fall back to the local heuristic     */
/*  engine below, so styling always works.                             */
/* ------------------------------------------------------------------ */

import { GEMINI_MODEL } from "./aiStylistService";

const GEMINI_KEY = (import.meta.env.VITE_GEMINI_API_KEY ?? "").trim();
export const geminiReady = GEMINI_KEY.length > 0;

/* ------------------------- prompt relevance ------------------------ */

export type PromptVerdict =
  | { kind: "empty" }
  | { kind: "gibberish" }
  | { kind: "ok"; text: string };

/**
 * Coarse local gate for free-text styling requests. Only catches the
 * obvious cases — empty input and keyboard mashing. Coherent-but-unrelated
 * text ("explain quantum physics") passes through and is judged by the
 * model itself, which reports back via `usedPrompt`.
 */
export function assessPrompt(raw: string): PromptVerdict {
  const text = raw.trim();
  if (!text) return { kind: "empty" };
  const letters = text.toLowerCase().replace(/[^a-z]/g, "");
  if (letters.length < 3) return { kind: "gibberish" };
  const vowels = (letters.match(/[aeiou]/g) ?? []).length;
  // English prose runs ~35-45% vowels; mashing skews far below.
  if (vowels / letters.length < 0.2) return { kind: "gibberish" };
  return { kind: "ok", text };
}

const GIBBERISH_NOTE = (occasion: Occasion) =>
  `That didn't sound like a look — styled for ${OCCASION_META[occasion].label} instead.`;

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

/* ------------------------- one-tap tweaks --------------------------- */
/** Shared by the Studio tweak buttons and the prompt fallback path. */

export type TweakKind = "swapTop" | "swapShoes" | "warmer" | "cooler" | "dressUp" | "casual";

function randomOther(pool: Garment[], currentId?: string): Garment | undefined {
  if (pool.length === 0) return undefined;
  const alt = pool.filter((g) => g.id !== currentId);
  const src = alt.length > 0 ? alt : pool;
  return src[Math.floor(Math.random() * src.length)];
}

const byWarmthDesc = (a: Garment, b: Garment) => b.warmth - a.warmth;
const byFormalityDesc = (a: Garment, b: Garment) => b.formality - a.formality;

export function applyTweak(outfit: Outfit, kind: TweakKind, garments: Garment[]): Outfit {
  const inCat = (c: Garment["category"]) => garments.filter((g) => g.category === c);
  const next: Outfit = { ...outfit };
  switch (kind) {
    case "swapTop": {
      if (next.dress) {
        const d = randomOther(inCat("dress"), next.dress.id);
        if (d) next.dress = d;
      } else {
        const t = randomOther(inCat("top"), next.top?.id);
        if (t) {
          next.top = t;
          delete next.dress;
        }
      }
      break;
    }
    case "swapShoes": {
      const s = randomOther(inCat("shoes"), next.shoes?.id);
      if (s) next.shoes = s;
      break;
    }
    case "warmer": {
      const outers = inCat("outerwear");
      if (outers.length > 0) next.outer = [...outers].sort(byWarmthDesc)[0];
      if (next.top) {
        const tops = inCat("top");
        if (tops.length > 0) next.top = [...tops].sort(byWarmthDesc)[0];
      }
      if (next.bottom) {
        const bots = inCat("bottom");
        if (bots.length > 0) next.bottom = [...bots].sort(byWarmthDesc)[0];
      }
      if (next.dress) {
        const dresses = inCat("dress");
        if (dresses.length > 0) next.dress = [...dresses].sort(byWarmthDesc)[0];
      }
      break;
    }
    case "cooler": {
      delete next.outer;
      if (next.top) {
        const tops = inCat("top");
        if (tops.length > 0) next.top = [...tops].sort((a, b) => a.warmth - b.warmth)[0];
      }
      if (next.bottom) {
        const bots = inCat("bottom");
        if (bots.length > 0) next.bottom = [...bots].sort((a, b) => a.warmth - b.warmth)[0];
      }
      if (next.dress) {
        const dresses = inCat("dress");
        if (dresses.length > 0) next.dress = [...dresses].sort((a, b) => a.warmth - b.warmth)[0];
      }
      break;
    }
    case "dressUp": {
      (["top", "bottom", "dress", "outer", "shoes"] as const).forEach((slot) => {
        const cur = next[slot];
        if (!cur) return;
        const pool = inCat(cur.category);
        if (pool.length > 0) next[slot] = [...pool].sort(byFormalityDesc)[0] as never;
      });
      if (!next.accessory) {
        const extras = inCat("accessory");
        if (extras.length > 0) next.accessory = [...extras].sort(byFormalityDesc)[0];
      }
      break;
    }
    case "casual": {
      (["top", "bottom", "dress", "outer", "shoes"] as const).forEach((slot) => {
        const cur = next[slot];
        if (!cur) return;
        const pool = inCat(cur.category);
        if (pool.length > 0)
          next[slot] = [...pool].sort((a, b) => a.formality - b.formality)[0] as never;
      });
      delete next.accessory;
      break;
    }
  }
  return next;
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
  weather: WeatherNow | null,
  userRequest: string | null
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

  const requestBlock = userRequest
    ? `USER REQUEST (primary instruction — it outranks defaults below): "${userRequest}"\n` +
      `- Honor it with concrete picks: if they name weather, formality, colors or garment types, the outfit must visibly reflect that.\n` +
      `- Weather conflicts: if the request fights the weather (e.g. shorts in freezing cold), still honor the requested garments BUT add the warmest available outerwear for cold/rain (or drop outerwear for heat), and state the tradeoff plainly in the rationale.\n` +
      `- Relevance: if the request is nonsensical or unrelated to clothing, style, occasions or weather, IGNORE it, style for the occasion + weather, set usedPrompt:false, and explain why in promptNote. Otherwise set usedPrompt:true and write promptNote as one concrete sentence naming which picks honor the request.\n`
    : `No user request: style for the occasion + weather. Set usedPrompt:false and promptNote:"".\n`;

  const prompt =
    `You are a personal stylist. Pick ONE outfit from this closet for occasion "${occasion}". ${wx}\n` +
    requestBlock +
    `Closet:\n${listing}\n` +
    `Respond with JSON only: {"top":id|null,"bottom":id|null,"dress":id|null,"outer":id|null,"shoes":id|null,"accessory":id|null,"rationale":"two sentences max","usedPrompt":true|false,"promptNote":"one sentence, max 140 chars"}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Same defect class as the tagging path: no default fetch timeout,
      // so a stalled connection left generation stuck on "working" forever.
      signal: AbortSignal.timeout(25_000),
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
    usedPrompt?: boolean;
    promptNote?: string;
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
  const usedPrompt = userRequest ? parsed.usedPrompt === true : false;
  return {
    outfit,
    rationale: parsed.rationale ?? "Styled for the occasion and weather.",
    engine: "gemini",
    score: 0,
    occasion,
    usedPrompt,
    promptNote:
      typeof parsed.promptNote === "string" && parsed.promptNote.trim()
        ? parsed.promptNote.trim().slice(0, 140)
        : undefined,
  };
}

/**
 * Offline fallback for a free-text request: keyword-driven tweaks on top of
 * the heuristic outfit, with honest notes when the text maps to nothing or
 * fights the weather.
 */
export function composeWithPrompt(
  garments: Garment[],
  occasion: Occasion,
  weather: WeatherNow | null,
  text: string
): StyleResult {
  const lower = text.toLowerCase();
  const base = composeOutfit(garments, occasion, weather);
  let outfit = base.outfit;
  const applied: string[] = [];
  let matched = false;

  if (/warm|winter|cold|coat|chill|freez|heat|layer|sweater|jacket/.test(lower)) {
    outfit = applyTweak(outfit, "warmer", garments);
    applied.push("warmer layers");
    matched = true;
  } else if (/cool|breez|summer|hot|light|airy|heatwave|shorts|tank/.test(lower)) {
    outfit = applyTweak(outfit, "cooler", garments);
    applied.push("lighter pieces");
    matched = true;
  }
  if (/rain|wet|storm|drizzle|shower|umbrella/.test(lower) && !outfit.outer) {
    const outers = garments.filter((g) => g.category === "outerwear");
    if (outers.length > 0) {
      outfit = { ...outfit, outer: [...outers].sort(byWarmthDesc)[0] };
      applied.push("rain cover");
      matched = true;
    }
  }
  if (/formal|fancy|elegant|dressy|dressed|smart|sharp|polish|date|wedding/.test(lower)) {
    outfit = applyTweak(outfit, "dressUp", garments);
    applied.push("sharper picks");
    matched = true;
  } else if (/casual|relax|chill|everyday|laid|comfy|cozy/.test(lower)) {
    outfit = applyTweak(outfit, "casual", garments);
    applied.push("laid-back picks");
    matched = true;
  }

  // Weather conflict, stated plainly instead of silently obeyed.
  let conflict: string | undefined;
  const wantsCool = /shorts|tank|sleeveless|skirt|sandals|dress\b/.test(lower);
  const wantsWarm = /coat|jacket|sweater|boots|layer|flannel/.test(lower);
  if (wantsCool && weather && (weather.bucket === "cold" || weather.bucket === "cool")) {
    const outers = garments.filter((g) => g.category === "outerwear");
    if (outers.length > 0 && !outfit.outer) {
      outfit = { ...outfit, outer: [...outers].sort(byWarmthDesc)[0] };
    }
    conflict = `Breezy picks at ${weather.feelsC}°C — kept them, added the warmest cover.`;
  } else if (wantsWarm && weather && (weather.bucket === "hot" || weather.bucket === "warm")) {
    delete outfit.outer;
    conflict = `Heavy layers at ${weather.feelsC}°C — kept the look, dropped the outer layer.`;
  }

  if (!matched && !conflict) {
    return {
      ...base,
      usedPrompt: false,
      promptNote: `Couldn't map that to anything wearable — styled for ${OCCASION_META[occasion].label} instead.`,
    };
  }
  const note = conflict ?? `Worked in ${applied.join(", ")} for your note.`;
  // Rebuild the rationale from the final outfit so it names what changed.
  return {
    ...base,
    outfit,
    rationale: buildRationale(outfit, occasion, weather),
    usedPrompt: true,
    promptNote: note,
  };
}

/* --------------------------- public API --------------------------- */

export async function generateStyle(
  garments: Garment[],
  occasion: Occasion,
  weather: WeatherNow | null,
  promptRaw = ""
): Promise<StyleResult> {
  // Small latency keeps the staged UI readable and prevents flicker.
  await delay(650 + Math.random() * 550);
  const verdict = assessPrompt(promptRaw);

  if (geminiReady) {
    try {
      if (verdict.kind === "ok") {
        return await viaGemini(garments, occasion, weather, verdict.text);
      }
      const plain = await viaGemini(garments, occasion, weather, null);
      if (verdict.kind === "gibberish") {
        return { ...plain, usedPrompt: false, promptNote: GIBBERISH_NOTE(occasion) };
      }
      return plain;
    } catch {
      // Quota hit or bad response — fall through to the heuristic.
    }
  }

  if (verdict.kind === "ok") return composeWithPrompt(garments, occasion, weather, verdict.text);
  if (verdict.kind === "gibberish") {
    const plain = composeOutfit(garments, occasion, weather);
    return { ...plain, usedPrompt: false, promptNote: GIBBERISH_NOTE(occasion) };
  }
  return composeOutfit(garments, occasion, weather);
}

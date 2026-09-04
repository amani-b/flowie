import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowLeftRight, Bookmark, Briefcase, Coffee, Expand, Flame, Plus, RefreshCw, Send, Shirt, Snowflake, Wand2, X } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { cn, darken, OCCASION_META, VIBE_TO_OCCASION } from "../lib/utils";
import type { Garment, Occasion, Outfit, StyleResult, WeatherNow } from "../types";
import FitAvatar from "../components/FitAvatar";
import Sheet from "../components/Sheet";
import { StudioSkeleton } from "../components/Skeletons";
import { GarmentGlyph } from "../components/icons";
import { composeOutfit } from "../services/stylist";

const STAGES = [
  "Reading the sky…",
  "Raiding the closet…",
  "Checking the mirror…",
];

function outfitPieces(o: Record<string, Garment | undefined>): Garment[] {
  return ["dress", "top", "bottom", "outer", "shoes", "accessory"]
    .map((k) => o[k])
    .filter((g): g is Garment => Boolean(g));
}

/* ------------------------- quick tweaks (local) ------------------------ */
/** One-tap adjustments applied to the current result using the real closet.
 *  Pure function — no engine calls, no file changes elsewhere. */
type TweakKind = "swapTop" | "swapShoes" | "warmer" | "cooler" | "dressUp" | "casual";

const TWEAKS: Array<{ kind: TweakKind; label: string; icon: typeof Flame }> = [
  { kind: "swapTop", label: "Swap top", icon: ArrowLeftRight },
  { kind: "swapShoes", label: "Swap shoes", icon: ArrowLeftRight },
  { kind: "warmer", label: "Warmer", icon: Flame },
  { kind: "cooler", label: "Cooler", icon: Snowflake },
  { kind: "dressUp", label: "Dress up", icon: Briefcase },
  { kind: "casual", label: "Casual", icon: Coffee },
];

function randomOther(pool: Garment[], currentId?: string): Garment | undefined {
  if (pool.length === 0) return undefined;
  const alt = pool.filter((g) => g.id !== currentId);
  const src = alt.length > 0 ? alt : pool;
  return src[Math.floor(Math.random() * src.length)];
}

const byWarmthDesc = (a: Garment, b: Garment) => b.warmth - a.warmth;
const byFormalityDesc = (a: Garment, b: Garment) => b.formality - a.formality;

function applyTweak(outfit: Outfit, kind: TweakKind, garments: Garment[]): Outfit {
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

/** Guess an occasion + adjustments from free-form text. */
function styleFromPrompt(
  text: string,
  fallback: Occasion,
  garments: Garment[],
  weather: WeatherNow | null
): StyleResult {
  const lower = text.toLowerCase();
  const occasion: Occasion = /work|office|meeting|interview|business|conference/.test(lower)
    ? "work"
    : /date|dinner|romant|anniversary|drinks/.test(lower)
      ? "date"
      : /gym|run|workout|sport|train|yoga|jog/.test(lower)
        ? "gym"
        : /party|club|wedding|event|formal|fancy|elegant|ceremony/.test(lower)
          ? "party"
          : fallback;
  const base = composeOutfit(garments, occasion, weather);
  let outfit = base.outfit;
  if (/warm|winter|cold|coat|chill|freez|heat|layer/.test(lower))
    outfit = applyTweak(outfit, "warmer", garments);
  else if (/cool|breez|summer|hot|light|airy|heatwave/.test(lower))
    outfit = applyTweak(outfit, "cooler", garments);
  if (/rain|wet|storm|drizzle|shower|umbrella/.test(lower) && !outfit.outer) {
    const outers = garments.filter((g) => g.category === "outerwear");
    if (outers.length > 0) outfit = { ...outfit, outer: [...outers].sort(byWarmthDesc)[0] };
  }
  if (/formal|fancy|elegant|dressy|dressed|smart|sharp|polish/.test(lower))
    outfit = applyTweak(outfit, "dressUp", garments);
  else if (/casual|relax|chill|everyday|laid|comfy|cozy/.test(lower))
    outfit = applyTweak(outfit, "casual", garments);
  return {
    ...base,
    outfit,
    occasion,
    rationale: `For \u201C${text.trim()}\u201D: ${base.rationale}`,
  };
}

type SlotKey = "top" | "bottom" | "dress" | "outer" | "shoes" | "accessory";

const SLOT_LABELS: Record<SlotKey, string> = {
  top: "Top",
  bottom: "Bottom",
  dress: "Dress",
  outer: "Outerwear",
  shoes: "Shoes",
  accessory: "Accessory",
};

export default function Studio() {
  const garments = useAppStore((s) => s.garments);
  const generation = useAppStore((s) => s.generation);
  const generateForStudio = useAppStore((s) => s.generateForStudio);
  const setStudioResult = useAppStore((s) => s.setStudioResult);
  const saveLook = useAppStore((s) => s.saveLook);
  const stylePrefs = useAppStore((s) => s.stylePrefs);
  const restoreSamples = useAppStore((s) => s.restoreSamples);
  const setTab = useAppStore((s) => s.setTab);
  const weather = useAppStore((s) => s.weather);
  const notify = useAppStore((s) => s.notify);

  const [mode, setMode] = useState<"ai" | "manual">("ai");
  const [occasion, setOccasion] = useState<Occasion>(() =>
    stylePrefs ? VIBE_TO_OCCASION[stylePrefs.vibe] : "casual"
  );
  const [stage, setStage] = useState(0);
  const [prompt, setPrompt] = useState("");
  const [zoom, setZoom] = useState<Outfit | null>(null);

  // Manual mode state
  const [manualOutfit, setManualOutfit] = useState<Outfit>({});
  const [activeSlot, setActiveSlot] = useState<SlotKey | null>(null);

  // Reset manual outfit when switching to AI mode
  useEffect(() => {
    if (mode === "ai") {
      setManualOutfit({});
    }
  }, [mode]);

  // Cycle the staged status line while the engine thinks.
  useEffect(() => {
    if (generation.status !== "working") return;
    setStage(0);
    const t = setInterval(() => setStage((s) => (s + 1) % STAGES.length), 900);
    return () => clearInterval(t);
  }, [generation.status]);

  const result = mode === "ai" ? generation.result : { outfit: manualOutfit, rationale: "Styled by you", engine: "manual" as const, score: 0, occasion };
  const pieces = result ? outfitPieces(result.outfit as Record<string, Garment | undefined>) : [];
  const zoomPieces = zoom ? outfitPieces(zoom as Record<string, Garment | undefined>) : [];

  const runTweak = (kind: TweakKind) => {
    if (!result) return;
    const next = applyTweak(result.outfit, kind, garments);
    setStudioResult({ ...result, outfit: next });
  };

  const runPrompt = () => {
    const text = prompt.trim();
    if (!text) return;
    try {
      const styled = styleFromPrompt(text, occasion, garments, weather.data);
      setOccasion(styled.occasion);
      setStudioResult(styled);
      setPrompt("");
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not style that prompt", "err");
    }
  };

  const openSlotPicker = (slot: SlotKey) => {
    setActiveSlot(slot);
  };

  const selectGarmentForSlot = (g: Garment) => {
    setManualOutfit((prev) => {
      const next: Outfit = { ...prev };
      // Dress is mutually exclusive with top/bottom
      if (g.category === "dress") {
        delete next.top;
        delete next.bottom;
        next.dress = g;
      } else if (g.category === "top") {
        delete next.dress;
        next.top = g;
      } else if (g.category === "bottom") {
        delete next.dress;
        next.bottom = g;
      } else {
        next[g.category as keyof Outfit] = g;
      }
      return next;
    });
    setActiveSlot(null);
  };

  const clearSlot = (slot: SlotKey) => {
    setManualOutfit((prev) => {
      const next = { ...prev };
      delete next[slot];
      return next;
    });
  };

  const getGarmentsByCategory = (cat: string): Garment[] => {
    return garments.filter((g) => g.category === cat);
  };

  if (garments.length === 0) {
    return (
      <div className="px-4 pb-44 pt-4">
        <header>
          <p className="label-micro">Styling studio</p>
          <h1 className="font-display text-[27px] font-extrabold tracking-tight">Studio</h1>
        </header>
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="card mt-6 flex flex-col items-center rounded-[24px] px-6 py-12 text-center"
        >
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accsoft text-acc">
            <Wand2 className="h-7 w-7" />
          </span>
          <h2 className="mt-4 font-display text-[20px] font-extrabold">Nothing to style</h2>
          <p className="mt-1.5 max-w-[270px] text-[13px] font-medium leading-relaxed text-mut">
            The studio needs pieces to work with. Fill the closet first — the
            sample wardrobe gets you there in one tap.
          </p>
          <div className="mt-5 flex gap-2">
            <button
              onClick={restoreSamples}
              className="rounded-full bg-acc px-5 py-2.5 text-[13px] font-extrabold text-accink transition active:scale-95"
            >
              Load samples
            </button>
            <button
              onClick={() => setTab("closet")}
              className="flex items-center gap-1.5 rounded-full border border-line px-4 py-2.5 text-[13px] font-extrabold text-mut transition active:scale-95"
            >
              <Shirt className="h-4 w-4" /> Open closet
            </button>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-44 pt-4">
      <header className="flex items-end justify-between">
        <div>
          <p className="label-micro">Styling studio</p>
          <h1 className="font-display text-[27px] font-extrabold tracking-tight">Studio</h1>
        </div>
      </header>

      {/* mode selector */}
      <div className="-mx-4 mt-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
        <button
          onClick={() => setMode("ai")}
          className={cn(
            "shrink-0 rounded-full border px-4 py-2 text-[12px] font-extrabold transition-all active:scale-95",
            mode === "ai"
              ? "border-transparent bg-ink text-bg"
              : "border-line bg-card text-mut hover:text-ink"
          )}
        >
          AI Stylist
        </button>
        <button
          onClick={() => setMode("manual")}
          className={cn(
            "shrink-0 rounded-full border px-4 py-2 text-[12px] font-extrabold transition-all active:scale-95",
            mode === "manual"
              ? "border-transparent bg-ink text-bg"
              : "border-line bg-card text-mut hover:text-ink"
          )}
        >
          Style it yourself
        </button>
      </div>

      {/* occasion picker (AI mode only) */}
      {mode === "ai" && (
        <>
          <div className="no-scrollbar -mx-4 mt-4 flex gap-1.5 overflow-x-auto px-4 pb-1">
            {(Object.keys(OCCASION_META) as Occasion[]).map((o) => (
              <button
                key={o}
                onClick={() => {
                  setOccasion(o);
                  void generateForStudio(o);
                }}
                disabled={generation.status === "working"}
                className={cn(
                  "shrink-0 rounded-full border px-4 py-2 text-[12px] font-extrabold transition-all active:scale-95 disabled:opacity-60",
                  occasion === o
                    ? "border-transparent bg-ink text-bg"
                    : "border-line bg-card text-mut hover:text-ink"
                )}
                title={OCCASION_META[o].blurb}
              >
                {OCCASION_META[o].label}
              </button>
            ))}
          </div>
          <p className="mt-1 px-1 text-[11px] font-bold text-mut">
            {OCCASION_META[occasion].blurb}
          </p>
          {/* free-form prompt: "rainy evening jacket", "dressy but warm"… */}
          <form
            className="mt-2 flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              runPrompt();
            }}
          >
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe it — “warm but dressy”…"
              aria-label="Describe the look you want"
              className="min-w-0 flex-1 rounded-full border border-line bg-card px-4 py-2 text-[12.5px] font-semibold text-ink placeholder:text-mut/70 focus:outline-none"
            />
            <button
              type="submit"
              disabled={!prompt.trim()}
              aria-label="Style from description"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-ink text-bg transition active:scale-90 disabled:opacity-40"
            >
              <Send className="h-4 w-4" />
            </button>
          </form>
        </>
      )}

      {/* stage */}
      <motion.section
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        className="card mt-4 rounded-[24px] p-5"
      >
        {mode === "manual" ? (
          // Manual mode UI
          <div>
            {/* Slot chips */}
            <div className="flex flex-wrap gap-2">
              {(Object.keys(SLOT_LABELS) as SlotKey[]).map((slot) => {
                const garment = manualOutfit[slot];
                return (
                  <button
                    key={slot}
                    onClick={() => openSlotPicker(slot)}
                    className={cn(
                      "flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-extrabold transition active:scale-95",
                      garment
                        ? "border-transparent bg-accsoft text-acc"
                        : "border-line bg-card text-mut hover:text-ink"
                    )}
                  >
                    {garment ? (
                      <>
                        <span
                          className="h-2.5 w-2.5 rounded-full border border-linestrong"
                          style={{ background: garment.color }}
                        />
                        {garment.name}
                        <span
                          onClick={(e) => {
                            e.stopPropagation();
                            clearSlot(slot);
                          }}
                          className="ml-0.5 rounded-full p-0.5 hover:bg-black/10"
                        >
                          <X className="h-3 w-3" />
                        </span>
                      </>
                    ) : (
                      <>
                        <Plus className="h-3 w-3" />
                        {SLOT_LABELS[slot]}
                      </>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Avatar preview — tap for full-screen */}
            <button
              onClick={() => pieces.length > 0 && setZoom({ ...manualOutfit })}
              aria-label="Preview look full-screen"
              className="group relative mx-auto mt-6 block w-[190px]"
            >
              <FitAvatar outfit={manualOutfit} className="w-full" />
              {pieces.length > 0 && (
                <span className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-card/90 text-mut transition group-active:scale-90">
                  <Expand className="h-3.5 w-3.5" />
                </span>
              )}
            </button>

            {/* Save button */}
            <div className="mt-4 flex justify-center gap-2">
              <button
                onClick={() => saveLook({ outfit: manualOutfit, rationale: "Styled by you", engine: "manual", score: 0, occasion })}
                disabled={!pieces.length}
                className="flex items-center gap-1.5 rounded-full bg-acc px-5 py-2.5 text-[12.5px] font-extrabold text-accink transition active:scale-95 disabled:opacity-50"
              >
                <Bookmark className="h-3.5 w-3.5" /> Save look
              </button>
            </div>
          </div>
        ) : generation.status === "idle" ? (
          <div className="py-6 text-center">
            <motion.div
              animate={{ rotate: [0, -6, 6, 0], y: [0, -4, 0] }}
              transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
              className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-accsoft text-acc"
            >
              <Wand2 className="h-8 w-8" />
            </motion.div>
            <p className="mt-4 text-[15px] font-extrabold">Pick a plan, get dressed</p>
            <p className="mx-auto mt-1 max-w-[260px] text-[12.5px] font-medium leading-relaxed text-mut">
              Tap an occasion above — the stylist reads the weather and pulls a
              full look from your {garments.length} pieces.
            </p>
          </div>
        ) : generation.status === "working" ? (
          <>
            <p className="label-micro mb-4 flex items-center gap-2">
              <span className="pulse-dot h-1.5 w-1.5 rounded-full bg-acc" />
              {STAGES[stage]}
            </p>
            <StudioSkeleton />
          </>
        ) : generation.status === "error" ? (
          <div className="flex flex-col items-center py-4 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-dangersoft text-danger">
              <AlertTriangle className="h-6 w-6" />
            </span>
            <p className="mt-3 text-[14px] font-extrabold">The stylist tripped</p>
            <p className="mt-1 max-w-[260px] text-[12.5px] font-medium text-mut">
              {generation.error}
            </p>
            <button
              onClick={() => void generateForStudio(generation.occasion)}
              className="mt-4 flex items-center gap-1.5 rounded-full bg-acc px-5 py-2.5 text-[12.5px] font-extrabold text-accink transition active:scale-95"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Try again
            </button>
          </div>
        ) : result ? (
          <AnimatePresence mode="wait">
            <motion.div
              key={pieces.map((p) => p.id).join(".")}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            >
              <button
                onClick={() => setZoom(result.outfit)}
                aria-label="Preview look full-screen"
                className="group relative mx-auto block w-[190px]"
              >
                <FitAvatar
                  outfit={result.outfit}
                  animateKey={pieces.map((p) => p.id).join(".")}
                  className="w-full"
                />
                <span className="absolute bottom-1 right-1 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-card/90 text-mut transition group-active:scale-90">
                  <Expand className="h-3.5 w-3.5" />
                </span>
              </button>
              <p className="mt-3 text-[13.5px] font-semibold leading-relaxed">
                {result.rationale}
              </p>
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {pieces.map((g) => (
                  <span
                    key={g.id}
                    className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[10.5px] font-extrabold"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full border border-linestrong"
                      style={{ background: g.color }}
                    />
                    {g.name}
                  </span>
                ))}
              </div>
              <div className="mt-4 flex justify-center gap-2">
                <button
                  onClick={() => saveLook(result)}
                  className="flex items-center gap-1.5 rounded-full bg-acc px-5 py-2.5 text-[12.5px] font-extrabold text-accink transition active:scale-95"
                >
                  <Bookmark className="h-3.5 w-3.5" /> Save look
                </button>
                <button
                  onClick={() => void generateForStudio(occasion)}
                  className="flex items-center gap-1.5 rounded-full border border-line px-4 py-2.5 text-[12.5px] font-extrabold text-mut transition active:scale-95"
                >
                  <RefreshCw className="h-3.5 w-3.5" /> Regenerate
                </button>
              </div>
              {/* one-tap tweaks */}
              <div className="mt-3 flex flex-wrap justify-center gap-1.5">
                {TWEAKS.map(({ kind, label, icon: Icon }) => (
                  <button
                    key={kind}
                    onClick={() => runTweak(kind)}
                    className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1.5 text-[11px] font-extrabold text-mut transition hover:text-ink active:scale-95"
                  >
                    <Icon className="h-3 w-3" /> {label}
                  </button>
                ))}
              </div>
            </motion.div>
          </AnimatePresence>
        ) : null}
      </motion.section>

      {/* Full-screen look preview */}
      <AnimatePresence>
        {zoom && (
          <div className="fixed inset-0 z-[60]">
            <motion.button
              aria-label="Close preview"
              className="absolute inset-0 h-full w-full bg-black/60 backdrop-blur-[3px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setZoom(null)}
            />
            <motion.div
              className="absolute inset-x-0 bottom-0 top-10 mx-auto flex w-full max-w-md flex-col items-center overflow-y-auto px-6 pb-[calc(env(safe-area-inset-bottom)+28px)] pt-4"
              style={{
                background: "color-mix(in srgb, var(--surface-solid) 97%, transparent)",
                borderTop: "1px solid var(--line)",
                borderRadius: "26px 26px 0 0",
              }}
              initial={{ y: "100%" }}
              animate={{ y: 0 }}
              exit={{ y: "100%" }}
              transition={{ type: "spring", stiffness: 340, damping: 34 }}
            >
              <div className="flex w-full items-center justify-between">
                <span className="label-micro">Look preview</span>
                <button
                  onClick={() => setZoom(null)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-mut transition active:scale-90"
                  aria-label="Close preview"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-2 w-[min(72vw,300px)]">
                <FitAvatar outfit={zoom} className="w-full" />
              </div>
              <div className="mt-3 flex max-w-full flex-wrap justify-center gap-1.5">
                {zoomPieces.map((g) => (
                  <span
                    key={g.id}
                    className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[10.5px] font-extrabold"
                  >
                    <span
                      className="h-2.5 w-2.5 rounded-full border border-linestrong"
                      style={{ background: g.color }}
                    />
                    {g.name}
                  </span>
                ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Garment picker sheet for manual mode */}
      <Sheet
        open={!!activeSlot}
        onClose={() => setActiveSlot(null)}
        title={activeSlot ? `Select ${SLOT_LABELS[activeSlot].toLowerCase()}` : "Select item"}
      >
        <div className="mt-2 grid grid-cols-2 gap-3">
          {!activeSlot || getGarmentsByCategory(activeSlot).length === 0 ? (
            <div className="col-span-2 flex flex-col items-center py-8 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accsoft text-acc">
                <Shirt className="h-6 w-6" />
              </span>
              <p className="mt-3 text-[14px] font-extrabold">Nothing here yet</p>
              <p className="mt-1 max-w-[260px] text-[12.5px] font-medium text-mut">
                Add some {activeSlot ? SLOT_LABELS[activeSlot].toLowerCase() : "items"} to your closet first.
              </p>
            </div>
          ) : (
            getGarmentsByCategory(activeSlot).map((g) => (
              <button
                key={g.id}
                onClick={() => selectGarmentForSlot(g)}
                className="card overflow-hidden rounded-[18px] text-left"
              >
                <div className="relative aspect-[4/5]">
                  {g.photo ? (
                    <img src={g.photo} alt={g.name} className="h-full w-full object-cover" />
                  ) : (
                    <div
                      className="flex h-full w-full items-center justify-center"
                      style={{
                        background: `linear-gradient(160deg, ${g.color} 0%, ${darken(g.color, 0.22)} 100%)`,
                      }}
                    >
                      <GarmentGlyph category={g.category} kind={g.kind} className="h-[54%] w-[54%]" strokeWidth={5.5} />
                    </div>
                  )}
                </div>
                <div className="px-3 py-2.5">
                  <p className="truncate text-[12.5px] font-extrabold">{g.name}</p>
                  <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-mut">
                    {g.category === "accessory" ? g.kind ?? "extra" : g.category} · {g.colorFamily}
                  </p>
                </div>
              </button>
            ))
          )}
        </div>
      </Sheet>
    </div>
  );
}

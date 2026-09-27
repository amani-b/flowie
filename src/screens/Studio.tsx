import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, ArrowLeftRight, Bookmark, Briefcase, Check, Coffee, Expand, Flame, Info, Plus, RefreshCw, Send, Shirt, Snowflake, Wand2, X } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { useGarments } from "../store/selectors";
import { cn, OCCASION_META, VIBE_TO_OCCASION } from "../lib/utils";
import type { Category, Garment, Occasion, Outfit } from "../types";
import OutfitBoard from "../components/OutfitBoard";
import GarmentPhoto from "../components/GarmentPhoto";
import Sheet from "../components/Sheet";
import { StudioSkeleton } from "../components/Skeletons";
import { applyTweak, type TweakKind } from "../services/stylist";

const STAGES = [
  "Reading the sky…",
  "Raiding the closet…",
  "Laying out the board…",
];

function outfitPieces(o: Record<string, Garment | undefined>): Garment[] {
  return ["dress", "top", "bottom", "outer", "shoes", "accessory"]
    .map((k) => o[k])
    .filter((g): g is Garment => Boolean(g));
}

/* ------------------------- quick tweaks (UI labels) ------------------------ */
/** The tweak engine itself lives in services/stylist (shared with the
 *  free-text fallback path); this is just button labels. */
const TWEAKS: Array<{ kind: TweakKind; label: string; icon: typeof Flame }> = [
  { kind: "swapTop", label: "Swap top", icon: ArrowLeftRight },
  { kind: "swapShoes", label: "Swap shoes", icon: ArrowLeftRight },
  { kind: "warmer", label: "Warmer", icon: Flame },
  { kind: "cooler", label: "Cooler", icon: Snowflake },
  { kind: "dressUp", label: "Dress up", icon: Briefcase },
  { kind: "casual", label: "Casual", icon: Coffee },
];

type SlotKey = "top" | "bottom" | "dress" | "outer" | "shoes" | "accessory";

const SLOT_LABELS: Record<SlotKey, string> = {
  top: "Top",
  bottom: "Bottom",
  dress: "Dress",
  outer: "Outerwear",
  shoes: "Shoes",
  accessory: "Accessory",
};

/**
 * Outfit slots ("outer") vs garment categories ("outerwear") use different
 * strings for the same thing. This map is the single translation point
 * between the manual-styling picker and the closet data — every filter and
 * every slot assignment must go through it, otherwise outerwear silently
 * never matches and the picker reports "Nothing here yet".
 */
const SLOT_TO_CATEGORY: Record<SlotKey, Category> = {
  top: "top",
  bottom: "bottom",
  dress: "dress",
  outer: "outerwear",
  shoes: "shoes",
  accessory: "accessory",
};

const CATEGORY_TO_SLOT: Record<Category, SlotKey> = {
  top: "top",
  bottom: "bottom",
  dress: "dress",
  outerwear: "outer",
  shoes: "shoes",
  accessory: "accessory",
};

export default function Studio() {
  const garments = useGarments();
  const generation = useAppStore((s) => s.generation);
  const generateForStudio = useAppStore((s) => s.generateForStudio);
  const setStudioResult = useAppStore((s) => s.setStudioResult);
  const saveLook = useAppStore((s) => s.saveLook);
  const stylePrefs = useAppStore((s) => s.stylePrefs);
  const restoreSamples = useAppStore((s) => s.restoreSamples);
  const setTab = useAppStore((s) => s.setTab);

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
    if (!text || generation.status === "working") return;
    // The text goes to the styling engine as a first-class instruction
    // (model call when online, keyword path when offline). The result
    // carries usedPrompt/promptNote so the UI can say what happened.
    setPrompt("");
    void generateForStudio(occasion, text);
  };

  const openSlotPicker = (slot: SlotKey) => {
    setActiveSlot(slot);
  };

  const selectGarmentForSlot = (g: Garment) => {
    // Route the garment into the correct outfit slot via the category map
    // (a garment stored as "outerwear" belongs in the "outer" slot).
    const slot = CATEGORY_TO_SLOT[g.category];
    setManualOutfit((prev) => {
      const next: Outfit = { ...prev };
      // Dress is mutually exclusive with top/bottom
      if (slot === "dress") {
        delete next.top;
        delete next.bottom;
        next.dress = g;
      } else if (slot === "top") {
        delete next.dress;
        next.top = g;
      } else if (slot === "bottom") {
        delete next.dress;
        next.bottom = g;
      } else {
        next[slot] = g;
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

  const getGarmentsByCategory = (slot: SlotKey): Garment[] => {
    const cat = SLOT_TO_CATEGORY[slot];
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
              disabled={!prompt.trim() || generation.status === "working"}
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

            {/* Outfit board preview — tap pieces to combine/separate, expand for full-screen */}
            <div className="mx-auto mt-6 max-w-[280px]">
              <OutfitBoard outfit={manualOutfit} />
            </div>
            {pieces.length > 0 && (
              <div className="mt-2 flex justify-center">
                <button
                  onClick={() => setZoom({ ...manualOutfit })}
                  aria-label="Preview look full-screen"
                  className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-mut transition active:scale-95"
                >
                  <Expand className="h-3.5 w-3.5" /> Full-screen
                </button>
              </div>
            )}

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
              <div className="mx-auto max-w-[280px]">
                <OutfitBoard
                  outfit={result.outfit}
                  animateKey={pieces.map((p) => p.id).join(".")}
                />
              </div>
              <div className="mt-2 flex justify-center">
                <button
                  onClick={() => setZoom(result.outfit)}
                  aria-label="Preview look full-screen"
                  className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-mut transition active:scale-95"
                >
                  <Expand className="h-3.5 w-3.5" /> Full-screen
                </button>
              </div>
              <p className="mt-3 text-[13.5px] font-semibold leading-relaxed">
                {result.rationale}
              </p>
              {result.promptNote && (
                <p className="mx-auto mt-2 flex max-w-[300px] items-start justify-center gap-1.5 text-center text-[12px] font-semibold leading-snug text-mut">
                  {result.usedPrompt ? (
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-acc" strokeWidth={3} />
                  ) : (
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  )}
                  {result.promptNote}
                </p>
              )}
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
              <div className="mx-auto mt-2 w-full max-w-[320px]">
                <OutfitBoard outfit={zoom} eager />
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
                  <GarmentPhoto garment={g} />
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

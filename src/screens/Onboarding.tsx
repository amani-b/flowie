import { useState } from "react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { cn, firstName, isLightColor } from "../lib/utils";
import type { ColorFamily, StylePrefs } from "../types";
import OutfitBoard from "../components/OutfitBoard";
import { LogoMark } from "../components/icons";
import { PLACEHOLDER_OUTFIT } from "../lib/mock";

const FAMILIES: Array<{ id: ColorFamily; label: string; swatch: string }> = [
  { id: "neutral", label: "Neutrals", swatch: "#ECEAE4" },
  { id: "earth", label: "Earth", swatch: "#C08552" },
  { id: "cool", label: "Cool", swatch: "#3A4A63" },
  { id: "warm", label: "Warm", swatch: "#C24D2C" },
  { id: "accent", label: "Loud", swatch: "#D64550" },
];

const VIBES: Array<{ id: StylePrefs["vibe"]; label: string; blurb: string }> = [
  { id: "casual", label: "Casual", blurb: "Comfort leads" },
  { id: "smart", label: "Smart", blurb: "Polished default" },
  { id: "formal", label: "Formal", blurb: "Dressed intent" },
];

const STEP_COUNT = 3;

export default function Onboarding() {
  const user = useAppStore((s) => s.user);
  const stylePrefs = useAppStore((s) => s.stylePrefs);
  const setStylePrefs = useAppStore((s) => s.setStylePrefs);
  const completeOnboarding = useAppStore((s) => s.completeOnboarding);
  const notify = useAppStore((s) => s.notify);

  const [step, setStep] = useState(0);
  const [dir, setDir] = useState(1);

  const prefs: StylePrefs = stylePrefs ?? { families: [], vibe: "casual" };

  const go = (next: number) => {
    setDir(next > step ? 1 : -1);
    setStep(Math.max(0, Math.min(STEP_COUNT - 1, next)));
  };

  const finish = () => {
    completeOnboarding();
    notify(`Welcome in, ${firstName(user?.name ?? "stylist")}`);
  };

  const toggleFamily = (f: ColorFamily) => {
    const has = prefs.families.includes(f);
    const next = has
      ? prefs.families.filter((x) => x !== f)
      : prefs.families.length >= 3
        ? [...prefs.families.slice(1), f]
        : [...prefs.families, f];
    setStylePrefs({ ...prefs, families: next });
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x < -70 && step < STEP_COUNT - 1) go(step + 1);
    if (info.offset.x > 70 && step > 0) go(step - 1);
  };

  const variants = {
    enter: (d: number) => ({ opacity: 0, x: 70 * d }),
    center: { opacity: 1, x: 0 },
    exit: (d: number) => ({ opacity: 0, x: -70 * d }),
  };

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-[70] flex flex-col px-6 pb-[calc(env(safe-area-inset-bottom)+26px)] pt-[calc(env(safe-area-inset-top)+22px)]"
    >
      {/* top rail: progress + skip */}
      <div className="flex items-center gap-3">
        <div className="flex flex-1 gap-1.5">
          {Array.from({ length: STEP_COUNT }).map((_, i) => (
            <div key={i} className="h-1 flex-1 overflow-hidden rounded-full bg-line">
              <motion.div
                className="h-full rounded-full bg-acc"
                initial={false}
                animate={{ width: i < step ? "100%" : i === step ? "55%" : "0%" }}
                transition={{ duration: 0.4, ease: "easeOut" }}
              />
            </div>
          ))}
        </div>
        <button
          onClick={finish}
          className="rounded-full border border-line bg-card px-3 py-1.5 text-[11px] font-extrabold text-mut transition active:scale-95"
        >
          Skip
        </button>
      </div>

      {/* step canvas */}
      <div className="relative flex flex-1 items-center overflow-hidden">
        <AnimatePresence mode="wait" custom={dir} initial={false}>
          <motion.div
            key={step}
            custom={dir}
            variants={variants}
            initial="enter"
            animate="center"
            exit="exit"
            transition={{ type: "spring", stiffness: 340, damping: 32 }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.55}
            onDragEnd={onDragEnd}
            className="w-full"
          >
            {/* ---------------- step 0 · welcome ---------------- */}
            {step === 0 && (
              <div className="text-center">
                <motion.div
                  animate={{ rotate: [0, -4, 3.5, 0], y: [0, -6, 0] }}
                  transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
                  style={{ originY: 0.05, width: "fit-content", margin: "0 auto" }}
                >
                  <LogoMark className="h-20 w-20 text-ink" />
                </motion.div>
                <p className="label-micro mt-7">
                  {user ? `Hey ${firstName(user.name)}` : "Hey"} · step 1 of 3
                </p>
                <h2 className="mx-auto mt-2 max-w-[300px] font-display text-[32px] font-extrabold leading-[1.02] tracking-tight">
                  Let's tune your stylist.
                </h2>
                <p className="mx-auto mt-3 max-w-[280px] text-[13.5px] font-semibold leading-relaxed text-mut">
                  Three quick steps — your palette, your default vibe, and a
                  first look at your outfit board.
                </p>
                <div className="mx-auto mt-6 flex max-w-[280px] flex-col gap-2 text-left">
                  {[
                    "Weather-aware outfit picks",
                    "A photo board of every outfit",
                    "Saved looks you can schedule",
                  ].map((t, i) => (
                    <motion.div
                      key={t}
                      initial={{ opacity: 0, x: -14 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.25 + i * 0.12 }}
                      className="flex items-center gap-2.5 rounded-[14px] border border-line bg-card px-3.5 py-2.5"
                    >
                      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accsoft text-acc">
                        <Check className="h-3 w-3" strokeWidth={3.2} />
                      </span>
                      <span className="text-[12.5px] font-extrabold">{t}</span>
                    </motion.div>
                  ))}
                </div>
              </div>
            )}

            {/* ---------------- step 1 · style DNA ---------------- */}
            {step === 1 && (
              <div>
                <p className="label-micro">Step 2 of 3</p>
                <h2 className="mt-2 font-display text-[30px] font-extrabold leading-[1.02] tracking-tight">
                  Your style DNA.
                </h2>
                <p className="mt-2 text-[13.5px] font-semibold leading-relaxed text-mut">
                  Pick up to three color families you gravitate to — the stylist
                  biases picks toward them.
                </p>

                <div className="mt-5 flex flex-wrap gap-2">
                  {FAMILIES.map((f) => {
                    const active = prefs.families.includes(f.id);
                    const light = isLightColor(f.swatch);
                    return (
                      <motion.button
                        key={f.id}
                        whileTap={{ scale: 0.94 }}
                        onClick={() => toggleFamily(f.id)}
                        className={cn(
                          "flex items-center gap-2 rounded-full border py-2 pl-2 pr-4 text-[13px] font-extrabold transition-all",
                          active
                            ? "border-acc bg-accsoft text-ink"
                            : "border-line bg-card text-mut"
                        )}
                      >
                        <span
                          className="flex h-7 w-7 items-center justify-center rounded-full border border-linestrong"
                          style={{ background: f.swatch }}
                        >
                          {active && (
                            <Check
                              className={cn("h-3.5 w-3.5", light ? "text-black/70" : "text-white")}
                              strokeWidth={3.4}
                            />
                          )}
                        </span>
                        {f.label}
                      </motion.button>
                    );
                  })}
                </div>

                <p className="label-micro mt-7">Default vibe</p>
                <p className="mt-1.5 text-[12.5px] font-semibold text-mut">
                  Sets the studio's starting occasion.
                </p>
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {VIBES.map((v) => {
                    const active = prefs.vibe === v.id;
                    return (
                      <button
                        key={v.id}
                        onClick={() => setStylePrefs({ ...prefs, vibe: v.id })}
                        className={cn(
                          "rounded-[16px] border px-3 py-3 text-left transition-all active:scale-95",
                          active
                            ? "border-acc bg-accsoft"
                            : "border-line bg-card"
                        )}
                      >
                        <span
                          className={cn(
                            "block text-[13.5px] font-extrabold",
                            active ? "text-acc" : "text-ink"
                          )}
                        >
                          {v.label}
                        </span>
                        <span className="mt-0.5 block text-[10.5px] font-bold text-mut">
                          {v.blurb}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ---------------- step 2 · outfit board ---------------- */}
            {step === 2 && (
              <div className="text-center">
                <p className="label-micro">Step 3 of 3</p>
                <h2 className="mt-2 font-display text-[30px] font-extrabold tracking-tight">
                  Your outfits, on a board.
                </h2>
                <div className="relative mx-auto mt-4 max-w-[230px]">
                  <div className="card relative overflow-hidden rounded-[26px] p-3">
                    <OutfitBoard outfit={PLACEHOLDER_OUTFIT} animateKey="onboard" />
                  </div>
                  <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-acc px-2.5 py-1 text-[8.5px] font-extrabold tracking-[0.16em] text-accink">
                    LIVE PREVIEW
                  </span>
                </div>
                <p className="mx-auto mt-4 max-w-[290px] text-[12px] font-semibold leading-relaxed text-mut">
                  Every outfit shows your real garment photos — tap to combine
                  pieces into one flat-lay, tap again to browse them separately.
                </p>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* bottom controls */}
      <div className="flex items-center gap-3">
        {step > 0 ? (
          <motion.button
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            onClick={() => go(step - 1)}
            className="flex h-[52px] w-[52px] shrink-0 items-center justify-center rounded-full border border-line bg-card text-mut transition active:scale-90"
            aria-label="Back"
          >
            <ArrowLeft className="h-5 w-5" />
          </motion.button>
        ) : (
          <span className="w-[52px] shrink-0 text-center text-[9.5px] font-extrabold tracking-[0.14em] text-mut">
            SWIPE →
          </span>
        )}
        <motion.button
          whileTap={{ scale: 0.97 }}
          onClick={() => (step === STEP_COUNT - 1 ? finish() : go(step + 1))}
          className="flex h-[52px] flex-1 items-center justify-center gap-2 rounded-full bg-acc font-display text-[15.5px] font-extrabold text-accink"
        >
          {step === STEP_COUNT - 1 ? (
            <>
              Enter Flowie <Check className="h-5 w-5" strokeWidth={2.8} />
            </>
          ) : (
            <>
              Next <ArrowRight className="h-5 w-5" />
            </>
          )}
        </motion.button>
      </div>
    </motion.div>
  );
}

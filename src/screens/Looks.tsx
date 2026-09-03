import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Cpu, Sparkles, Trash2, Wand2 } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { cn, OCCASION_META, timeAgo } from "../lib/utils";
import type { Garment, SavedLook } from "../types";
import Avatar from "../components/Avatar";
import Sheet from "../components/Sheet";
import { LogoMark } from "../components/icons";

function pieces(o: Record<string, Garment | undefined>): Garment[] {
  return ["dress", "top", "bottom", "outer", "shoes", "accessory"]
    .map((k) => o[k])
    .filter((g): g is Garment => Boolean(g));
}

function LookSheet({ look, onClose }: { look: SavedLook | null; onClose: () => void }) {
  const deleteLook = useAppStore((s) => s.deleteLook);
  const setTab = useAppStore((s) => s.setTab);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => setConfirmDel(false), [look?.id]);
  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 2600);
    return () => clearTimeout(t);
  }, [confirmDel]);

  return (
    <Sheet open={!!look} onClose={onClose} title={look?.name}>
      {look && (
        <div className="space-y-4">
          <div className="card rounded-[22px] px-4 pt-3">
            <div className="flex items-center justify-between">
              <span className="rounded-full bg-accsoft px-2.5 py-1 text-[9.5px] font-extrabold tracking-[0.14em] text-acc">
                {OCCASION_META[look.occasion].label.toUpperCase()}
              </span>
              <span className="flex items-center gap-1 text-[10px] font-extrabold tracking-[0.12em] text-mut">
                {look.engine === "gemini" ? (
                  <>
                    <Sparkles className="h-3 w-3 text-acc" /> GEMINI
                  </>
                ) : look.engine === "manual" ? (
                  <>
                    <Wand2 className="h-3 w-3 text-rose" /> MANUAL
                  </>
                ) : (
                  <>
                    <Cpu className="h-3 w-3 text-amber" /> HEURISTIC
                  </>
                )}
                · {timeAgo(look.createdAt)}
              </span>
            </div>
            <Avatar
              outfit={look.outfit}
              animateKey={look.id}
              className="mx-auto w-[168px]"
            />
          </div>

          {look.rationale && (
            <p className="px-1 text-[13px] font-semibold leading-relaxed text-mut">
              {look.rationale}
            </p>
          )}

          <div className="flex flex-wrap gap-1.5 px-1">
            {pieces(look.outfit as Record<string, Garment | undefined>).map((g) => (
              <span
                key={g.id}
                className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-[11px] font-extrabold"
              >
                <span
                  className="h-2.5 w-2.5 rounded-full border border-linestrong"
                  style={{ background: g.color }}
                />
                {g.name}
              </span>
            ))}
          </div>

          {look.weatherTags && look.weatherTags.length > 0 && (
            <p className="px-1 text-[10.5px] font-bold text-mut">
              Weather tags: {look.weatherTags.join(" · ")}
            </p>
          )}

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => {
                onClose();
                setTab("studio");
              }}
              className="flex flex-1 items-center justify-center gap-2 rounded-[16px] bg-acc py-3 text-[13px] font-extrabold text-accink transition active:scale-[0.98]"
            >
              <Wand2 className="h-4 w-4" /> Restyle this occasion
            </button>
            <button
              onClick={() => {
                if (confirmDel) {
                  deleteLook(look.id);
                  onClose();
                } else setConfirmDel(true);
              }}
              className={cn(
                "flex items-center justify-center gap-2 rounded-[16px] border px-4 py-3 text-[13px] font-extrabold transition active:scale-[0.98]",
                confirmDel ? "border-danger bg-dangersoft text-danger" : "border-line text-mut"
              )}
              aria-label="Delete look"
            >
              <Trash2 className="h-4 w-4" />
              {confirmDel ? "Sure?" : ""}
            </button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

export default function Looks() {
  const looks = useAppStore((s) => s.looks);
  const setTab = useAppStore((s) => s.setTab);
  const [sel, setSel] = useState<SavedLook | null>(null);

  return (
    <div className="px-4 pb-44 pt-4">
      <header className="flex items-end justify-between">
        <div>
          <p className="label-micro">Saved outfits</p>
          <h1 className="font-display text-[27px] font-extrabold tracking-tight">Lookbook</h1>
        </div>
        <span className="mb-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-extrabold text-mut">
          {looks.length} looks
        </span>
      </header>

      {looks.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="card mt-6 flex flex-col items-center rounded-[24px] px-6 py-12 text-center"
        >
          <LogoMark className="h-14 w-14 text-mut" />
          <h2 className="mt-4 font-display text-[20px] font-extrabold">No looks pinned yet</h2>
          <p className="mt-1.5 max-w-[260px] text-[13px] font-medium leading-relaxed text-mut">
            When the studio nails an outfit, save it here to build your personal
            rotation.
          </p>
          <button
            onClick={() => setTab("studio")}
            className="mt-5 flex items-center gap-2 rounded-full bg-acc px-5 py-2.5 text-[13px] font-extrabold text-accink transition active:scale-95"
          >
            <Wand2 className="h-4 w-4" /> Style something
          </button>
        </motion.div>
      ) : (
        <motion.div layout className="mt-5 grid grid-cols-2 gap-3">
          <AnimatePresence mode="popLayout">
            {looks.map((look) => (
              <motion.button
                key={look.id}
                layout
                initial={{ opacity: 0, scale: 0.92 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ type: "spring", stiffness: 360, damping: 30 }}
                whileTap={{ scale: 0.96 }}
                onClick={() => setSel(look)}
                className="card rounded-[20px] p-3 text-left"
              >
                <Avatar outfit={look.outfit} className="w-full" />
                <p className="mt-1.5 truncate text-[13px] font-extrabold">{look.name}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="rounded-full bg-accsoft px-2 py-0.5 text-[9px] font-extrabold tracking-[0.12em] text-acc">
                    {OCCASION_META[look.occasion].label.toUpperCase()}
                  </span>
                  <span className="text-[9.5px] font-bold text-mut">
                    {timeAgo(look.createdAt)}
                  </span>
                </div>
              </motion.button>
            ))}
          </AnimatePresence>
        </motion.div>
      )}

      <LookSheet look={sel} onClose={() => setSel(null)} />
    </div>
  );
}

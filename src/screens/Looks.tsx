import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Search, Trash2, Wand2, X } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { useLooks } from "../store/selectors";
import { cn, OCCASION_META, timeAgo } from "../lib/utils";
import type { Garment, SavedLook } from "../types";
import OutfitBoard from "../components/OutfitBoard";
import Sheet from "../components/Sheet";
import { LogoMark } from "../components/icons";

function pieces(o: Record<string, Garment | undefined>): Garment[] {
  return ["dress", "top", "bottom", "outer", "shoes", "accessory"]
    .map((k) => o[k])
    .filter((g): g is Garment => Boolean(g));
}

function LookSheet({ look, onClose }: { look: SavedLook | null; onClose: () => void }) {
  const deleteLook = useAppStore((s) => s.deleteLook);
  const updateLookTags = useAppStore((s) => s.updateLookTags);
  const setTab = useAppStore((s) => s.setTab);
  const [confirmDel, setConfirmDel] = useState(false);
  const [tagInput, setTagInput] = useState("");

  useEffect(() => setConfirmDel(false), [look?.id]);
  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 2600);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const handleAddTag = () => {
    const trimmed = tagInput.trim();
    if (!trimmed || !look) return;
    const newTags = [...(look.tags ?? []), trimmed];
    updateLookTags(look.id, newTags);
    setTagInput("");
  };

  const handleRemoveTag = (tagToRemove: string) => {
    if (!look) return;
    const newTags = (look.tags ?? []).filter((t) => t !== tagToRemove);
    updateLookTags(look.id, newTags);
  };

  return (
    <Sheet open={!!look} onClose={onClose} title={look?.name}>
      {look && (
        <div className="space-y-4">
          <div className="card rounded-[22px] px-4 pt-3">
            <div className="flex items-center justify-between">
              <span className="rounded-full bg-accsoft px-2.5 py-1 text-[11px] font-extrabold tracking-[0.14em] text-acc">
                {OCCASION_META[look.occasion].label.toUpperCase()}
              </span>
              <span className="flex items-center gap-1 text-[11px] font-extrabold tracking-[0.12em] text-mut">
                {look.engine === "manual" && (
                  <>
                    <Wand2 className="h-3 w-3 text-rose" /> STYLED BY YOU ·
                  </>
                )}
                {timeAgo(look.createdAt)}
              </span>
            </div>
            <OutfitBoard
              outfit={look.outfit}
              animateKey={look.id}
              className="mx-auto max-w-[280px]"
              eager
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
            <p className="px-1 text-[11px] font-bold text-mut">
              Weather tags: {look.weatherTags.join(" · ")}
            </p>
          )}

          {/* Tag editor */}
          <div>
            <p className="mb-2 label-micro">Tags</p>
            <div className="flex flex-wrap gap-1.5">
              {(look.tags ?? []).map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-1 rounded-full bg-accsoft px-2.5 py-1 text-[11px] font-extrabold text-acc"
                >
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    className="ml-0.5 rounded-full p-0.5 hover:bg-acc/20"
                    aria-label={`Remove ${tag}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <div className="flex items-center gap-1">
                <input
                  type="text"
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleAddTag()}
                  placeholder="+ add tag"
                  className="w-[100px] rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-medium placeholder:text-mut focus:border-acc focus:outline-none"
                />
                <button
                  onClick={handleAddTag}
                  disabled={!tagInput.trim()}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-acc text-accink transition disabled:opacity-50 active:scale-95"
                  aria-label="Add tag"
                >
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                    <path d="M7 1V13M1 7H13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

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
  const looks = useLooks();
  const setTab = useAppStore((s) => s.setTab);
  const [sel, setSel] = useState<SavedLook | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // Filter looks by name, occasion, or tags
  const filteredLooks = looks.filter((look) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    const matchesName = look.name.toLowerCase().includes(q);
    const matchesOccasion = OCCASION_META[look.occasion].label.toLowerCase().includes(q);
    const matchesTags = (look.tags ?? []).some((t) => t.toLowerCase().includes(q));
    return matchesName || matchesOccasion || matchesTags;
  });

  return (
    <div className="px-4 pb-44 pt-4">
      <header className="flex items-end justify-between">
        <div>
          <p className="label-micro">Saved outfits</p>
          <h1 className="font-display text-[27px] font-extrabold tracking-tight">Lookbook</h1>
        </div>
        <span className="mb-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-extrabold text-mut">
          {filteredLooks.length} looks
        </span>
      </header>

      {/* Search bar */}
      <div className="mt-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-mut" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search by name, occasion, or tag"
            className="w-full rounded-[16px] border border-line bg-card py-2.5 pl-10 pr-3 text-[13px] font-medium placeholder:text-mut focus:border-acc focus:outline-none"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-3 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full bg-line text-mut hover:text-ink"
              aria-label="Clear search"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>

      {filteredLooks.length === 0 ? (
        looks.length === 0 ? (
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className="card mt-6 flex flex-col items-center rounded-[24px] px-6 py-12 text-center"
          >
            <LogoMark className="h-14 w-14 text-mut" />
            <h2 className="mt-4 text-[20px] font-extrabold">No looks pinned yet</h2>
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
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className="card mt-6 flex flex-col items-center rounded-[24px] px-6 py-12 text-center"
          >
            <Search className="mb-2 h-10 w-10 text-mut opacity-50" />
            <h2 className="mt-2 text-[18px] font-extrabold">No matches found</h2>
            <p className="mt-1.5 max-w-[260px] text-[13px] font-medium leading-relaxed text-mut">
              Try a different search term or clear the filter.
            </p>
            <button
              onClick={() => setSearchQuery("")}
              className="mt-4 rounded-full border border-line px-4 py-2 text-[12px] font-extrabold text-mut transition active:scale-95"
            >
              Clear search
            </button>
          </motion.div>
        )
      ) : (
        <motion.div layout className="mt-5 grid grid-cols-2 gap-3">
          <AnimatePresence mode="popLayout">
            {filteredLooks.map((look) => (
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
                <OutfitBoard outfit={look.outfit} compact staticBoard />
                <p className="mt-1.5 truncate text-[13px] font-extrabold">{look.name}</p>
                <div className="mt-1 flex items-center gap-1.5">
                  <span className="rounded-full bg-accsoft px-2 py-0.5 text-[11px] font-extrabold tracking-[0.12em] text-acc">
                    {OCCASION_META[look.occasion].label.toUpperCase()}
                  </span>
                  <span className="text-[11px] font-bold text-mut">
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

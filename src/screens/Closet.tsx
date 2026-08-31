import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Camera, Check, Loader2, Plus, RotateCcw, Search, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { CATEGORIES } from "../lib/mock";
import {
  COLOR_SWATCHES,
  cn,
  compressImage,
  darken,
  isLightColor,
  uid,
} from "../lib/utils";
import type { Category, Formality, Garment, Warmth, ColorFamily, AccessoryKind } from "../types";
import GarmentCard from "../components/GarmentCard";
import Sheet from "../components/Sheet";
import { GarmentGlyph, LogoMark } from "../components/icons";
import { tagGarmentPhoto, taggingToGarment, geminiReady, type TaggingResult } from "../services/aiStylistService";

type Filter = "all" | Category;

interface PendingGarment extends TaggingResult {
  tempId: string;
  imageDataUrl?: string;
  fileName: string;
}

const SHORT_CAT: Record<Category, string> = {
  top: "Top",
  bottom: "Bottom",
  dress: "Dress",
  outerwear: "Outer",
  shoes: "Shoes",
  accessory: "Extra",
};

/* ------------------------------ add form ------------------------------ */

/** AI-powered garment upload with confirmation step */
function AIUploadForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const addGarment = useAppStore((s) => s.addGarment);
  const notify = useAppStore((s) => s.notify);

  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState<PendingGarment[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);

  const fileRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const newFiles = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (newFiles.length === 0) {
      notify("Please select image files", "err");
      return;
    }
    setFiles((prev) => [...prev, ...newFiles]);
  };

  const analyzeFiles = async () => {
    if (files.length === 0) return;
    setAnalyzing(true);
    setProgress(0);

    const results: PendingGarment[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      try {
        const dataUrl = await compressImage(file);
        const tags = await tagGarmentPhoto(dataUrl, file.name);
        results.push({
          ...tags,
          tempId: uid("p"),
          imageDataUrl: dataUrl,
          fileName: file.name,
        });
        setProgress(Math.round(((i + 1) / files.length) * 100));
      } catch (e) {
        notify(`Failed to analyze ${file.name}`, "err");
      }
    }

    setPending(results);
    setAnalyzing(false);
    setFiles([]);
  };

  const updatePending = (tempId: string, updates: Partial<PendingGarment>) => {
    setPending((prev) => prev.map((p) => (p.tempId === tempId ? { ...p, ...updates } : p)));
  };

  const removePending = (tempId: string) => {
    setPending((prev) => prev.filter((p) => p.tempId !== tempId));
  };

  const confirmAndSave = () => {
    pending.forEach((p) => {
      const garment = taggingToGarment(p, p.imageDataUrl);
      addGarment(garment);
    });
    notify(`${pending.length} item(s) added to closet`);
    onDone();
  };

  const validCategories = ["top", "bottom", "dress", "outerwear", "shoes", "accessory"] as Category[];
  const validFamilies = ["neutral", "warm", "cool", "earth", "accent"] as ColorFamily[];

  if (pending.length > 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-display text-[16px] font-extrabold">Review & Confirm</h3>
          <span className="text-[11px] font-bold text-mut">{pending.length} item(s)</span>
        </div>

        <div className="space-y-3 max-h-[60vh] overflow-y-auto pr-1">
          {pending.map((p) => (
            <div key={p.tempId} className="rounded-[16px] border border-line bg-card p-3">
              <div className="flex gap-3">
                <div className="h-20 w-20 shrink-0 overflow-hidden rounded-[12px] bg-bgdeep">
                  {p.imageDataUrl ? (
                    <img src={p.imageDataUrl} alt={p.name} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center">
                      <GarmentGlyph category={p.category} kind={undefined} className="h-8 w-8 text-mut" />
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-2">
                  <input
                    className="field !py-1.5 !text-[13px]"
                    value={p.name}
                    onChange={(e) => updatePending(p.tempId, { name: e.target.value })}
                    placeholder="Item name"
                  />

                  <div className="flex items-center gap-2">
                    <select
                      className="field !py-1 !text-[11px] !px-2"
                      value={p.category}
                      onChange={(e) => updatePending(p.tempId, { category: e.target.value as Category })}
                    >
                      {validCategories.map((c) => (
                        <option key={c} value={c}>
                          {c.charAt(0).toUpperCase() + c.slice(1)}
                        </option>
                      ))}
                    </select>

                    <select
                      className="field !py-1 !text-[11px] !px-2"
                      value={p.colorFamily}
                      onChange={(e) => updatePending(p.tempId, { colorFamily: e.target.value as ColorFamily })}
                    >
                      {validFamilies.map((f) => (
                        <option key={f} value={f}>
                          {f.charAt(0).toUpperCase() + f.slice(1)}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-mut">Warmth:</span>
                      <div className="flex rounded-[8px] border border-line bg-bgdeep p-0.5">
                        {([1, 2, 3] as Warmth[]).map((w) => (
                          <button
                            key={w}
                            onClick={() => updatePending(p.tempId, { warmth: w })}
                            className={cn(
                              "rounded-[6px] px-1.5 py-0.5 text-[9px] font-extrabold",
                              p.warmth === w ? "bg-acc text-accink" : "text-mut"
                            )}
                          >
                            {w === 1 ? "L" : w === 2 ? "M" : "W"}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[10px] font-bold text-mut">Formality:</span>
                      <div className="flex rounded-[8px] border border-line bg-bgdeep p-0.5">
                        {([1, 2, 3] as Formality[]).map((f) => (
                          <button
                            key={f}
                            onClick={() => updatePending(p.tempId, { formality: f })}
                            className={cn(
                              "rounded-[6px] px-1.5 py-0.5 text-[9px] font-extrabold",
                              p.formality === f ? "bg-acc text-accink" : "text-mut"
                            )}
                          >
                            {f === 1 ? "C" : f === 2 ? "S" : "F"}
                          </button>
                        ))}
                      </div>
                    </div>

                    <button
                      onClick={() => removePending(p.tempId)}
                      className="rounded-full p-1 text-mut hover:bg-dangersoft hover:text-danger"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 rounded-[16px] border border-line py-3 text-[13.5px] font-extrabold text-mut transition active:scale-[0.98]"
          >
            Discard
          </button>
          <button
            onClick={confirmAndSave}
            className="flex-1 rounded-[16px] bg-acc py-3 font-display text-[15px] font-extrabold text-accink transition active:scale-[0.98]"
          >
            Save {pending.length} Item{pending.length > 1 ? "s" : ""}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <label className="label-micro mb-1.5 block">Upload Photos</label>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => handleFileSelect(e.target.files)}
        />
        {files.length > 0 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {files.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[10.5px] font-medium"
                >
                  {f.name.length > 20 ? f.name.slice(0, 20) + "…" : f.name}
                  <button
                    onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                    className="text-mut hover:text-danger"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
            <button
              onClick={() => fileRef.current?.click()}
              className="text-[11.5px] font-extrabold text-acc underline-offset-2 hover:underline"
            >
              + Add more photos
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileRef.current?.click()}
            className="flex w-full flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed border-linestrong py-8 text-[12.5px] font-medium text-mut transition hover:border-acc hover:text-acc active:scale-[0.98]"
          >
            <Camera className="h-6 w-6" />
            <span>Click to select photos · Single or bulk upload</span>
            <span className="text-[10.5px] text-mut">Auto-compressed to ~500KB each</span>
          </button>
        )}
      </div>

      {analyzing && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="label-micro">AI analyzing…</span>
            <span className="text-[10px] font-bold text-mut">{progress}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-bgdeep">
            <motion.div
              className="h-full bg-acc"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ ease: "easeOut" }}
            />
          </div>
          <p className="text-[11px] text-mut">Using Gemini 2.5 Flash for smart tagging…</p>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={onCancel}
          disabled={analyzing || files.length === 0}
          className="flex-1 rounded-[16px] border border-line py-3 text-[13.5px] font-extrabold text-mut transition active:scale-[0.98] disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          onClick={analyzeFiles}
          disabled={analyzing || files.length === 0}
          className="flex flex-1 items-center justify-center gap-2 rounded-[16px] bg-acc py-3 font-display text-[15px] font-extrabold text-accink transition active:scale-[0.98] disabled:opacity-50"
        >
          {analyzing ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Analyzing…
            </>
          ) : (
            <>
              <Sparkles className="h-4 w-4" /> Auto-Tag {files.length > 0 ? `(${files.length})` : ""}
            </>
          )}
        </button>
      </div>

      {!geminiReady && files.length === 0 && (
        <div className="rounded-[14px] border border-acc/30 bg-accsoft/50 p-3">
          <p className="text-[11px] font-medium leading-relaxed text-mut">
            <span className="font-extrabold text-acc">Note:</span> No Gemini API key configured.
            Using client-side heuristic tagging (filename-based guesses). Add{" "}
            <code className="rounded bg-card px-1 py-0.5 text-[10px]">VITE_GEMINI_API_KEY</code> to your .env for AI tagging.
          </p>
        </div>
      )}
    </div>
  );
}

/* ------------------------------ add form ------------------------------ */

function AddForm({ onDone }: { onDone: () => void }) {
  const addGarment = useAppStore((s) => s.addGarment);
  const notify = useAppStore((s) => s.notify);

  const [name, setName] = useState("");
  const [nameErr, setNameErr] = useState(false);
  const [category, setCategory] = useState<Category>("top");
  const [swatch, setSwatch] = useState(COLOR_SWATCHES[0]);
  const [warmth, setWarmth] = useState<Warmth>(2);
  const [formality, setFormality] = useState<Formality>(1);
  const [photo, setPhoto] = useState<string | null>(null);
  const [compressing, setCompressing] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setCompressing(true);
    try {
      const dataUrl = await compressImage(file);
      setPhoto(dataUrl);
      notify(`Photo compressed to ~${Math.round((dataUrl.length * 0.75) / 1024)} KB`);
    } catch (e) {
      notify(e instanceof Error ? e.message : "Could not read image", "err");
    } finally {
      setCompressing(false);
    }
  };

  const submit = () => {
    if (!name.trim()) {
      setNameErr(true);
      return;
    }
    addGarment({
      id: uid("g"),
      name: name.trim(),
      category,
      color: swatch.hex,
      colorFamily: swatch.family,
      warmth,
      formality,
      kind: category === "accessory" ? "scarf" : undefined,
      photo: photo ?? undefined,
      createdAt: Date.now(),
    });
    notify(`“${name.trim()}” added to closet`);
    onDone();
  };

  const segBtn = (active: boolean) =>
    cn(
      "rounded-[10px] px-2 py-2 text-[11.5px] font-extrabold transition-all",
      active ? "bg-card text-ink shadow-sm" : "text-mut hover:text-ink"
    );

  return (
    <div className="space-y-5">
      <div>
        <label className="label-micro mb-1.5 block">Name</label>
        <input
          className={cn("field", nameErr && "!border-danger")}
          placeholder="e.g. Camel overshirt"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (nameErr && e.target.value.trim()) setNameErr(false);
          }}
          autoFocus
        />
        {nameErr && (
          <p className="mt-1 text-[11px] font-bold text-danger">Give it a name first.</p>
        )}
      </div>

      <div>
        <label className="label-micro mb-1.5 block">Category</label>
        <div className="grid grid-cols-6 gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={cn(
                "flex flex-col items-center gap-1 rounded-[14px] border py-2.5 transition-all",
                category === c.id
                  ? "border-acc bg-accsoft text-acc"
                  : "border-line text-mut active:scale-95"
              )}
            >
              <GarmentGlyph
                category={c.id}
                kind="scarf"
                className="h-6 w-6"
                strokeWidth={8}
              />
              <span className="text-[8.5px] font-extrabold uppercase tracking-wide">
                {SHORT_CAT[c.id]}
              </span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="label-micro mb-1.5 block">
          Color — <span className="text-ink">{swatch.name}</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {COLOR_SWATCHES.map((s) => (
            <button
              key={s.hex}
              onClick={() => setSwatch(s)}
              aria-label={s.name}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded-full border transition-all active:scale-90",
                swatch.hex === s.hex
                  ? "scale-110 border-acc ring-2 ring-acc/40"
                  : "border-linestrong"
              )}
              style={{ background: s.hex }}
            >
              {swatch.hex === s.hex && (
                <span className={isLightColor(s.hex) ? "text-black/70" : "text-white"}>
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 13l4 4L19 7" />
                  </svg>
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="label-micro mb-1.5 block">Warmth</label>
          <div className="flex rounded-[14px] border border-line bg-bgdeep p-1">
            {([1, 2, 3] as Warmth[]).map((w) => (
              <button key={w} onClick={() => setWarmth(w)} className={cn(segBtn(warmth === w), "flex-1")}>
                {w === 1 ? "Light" : w === 2 ? "Mid" : "Winter"}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="label-micro mb-1.5 block">Formality</label>
          <div className="flex rounded-[14px] border border-line bg-bgdeep p-1">
            {([1, 2, 3] as Formality[]).map((f) => (
              <button key={f} onClick={() => setFormality(f)} className={cn(segBtn(formality === f), "flex-1")}>
                {f === 1 ? "Casual" : f === 2 ? "Smart" : "Formal"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div>
        <label className="label-micro mb-1.5 block">Photo (optional)</label>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
        {photo ? (
          <div className="relative overflow-hidden rounded-[16px]">
            <img src={photo} alt="Garment preview" className="h-36 w-full object-cover" />
            <button
              onClick={() => setPhoto(null)}
              className="absolute right-2 top-2 rounded-full bg-black/55 px-2.5 py-1 text-[10.5px] font-extrabold text-white backdrop-blur-sm"
            >
              Remove
            </button>
          </div>
        ) : (
          <button
            onClick={() => fileRef.current?.click()}
            disabled={compressing}
            className="flex w-full items-center justify-center gap-2 rounded-[16px] border border-dashed border-linestrong py-4 text-[12.5px] font-extrabold text-mut transition active:scale-[0.98]"
          >
            {compressing ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin text-acc" /> Compressing…
              </>
            ) : (
              <>
                <Camera className="h-4 w-4" /> Add photo · auto-compressed ≤ 1 MB
              </>
            )}
          </button>
        )}
      </div>

      <button
        onClick={submit}
        className="w-full rounded-[16px] bg-acc py-3.5 font-display text-[15px] font-extrabold text-accink transition active:scale-[0.98]"
      >
        Add to closet
      </button>
    </div>
  );
}

/* ---------------------------- detail sheet ---------------------------- */

function DetailSheet({ garment, onClose }: { garment: Garment | null; onClose: () => void }) {
  const removeGarment = useAppStore((s) => s.removeGarment);
  const notify = useAppStore((s) => s.notify);
  const [confirmDel, setConfirmDel] = useState(false);

  useEffect(() => {
    setConfirmDel(false);
  }, [garment?.id]);

  useEffect(() => {
    if (!confirmDel) return;
    const t = setTimeout(() => setConfirmDel(false), 2600);
    return () => clearTimeout(t);
  }, [confirmDel]);

  const g = garment;

  return (
    <Sheet open={!!g} onClose={onClose} title={g?.name}>
      {g && (
        <div className="space-y-4">
          <div
            className="relative flex h-40 items-center justify-center overflow-hidden rounded-[20px]"
            style={{
              background: `linear-gradient(160deg, ${g.color}, ${darken(g.color, 0.25)})`,
            }}
          >
            {g.photo ? (
              <img src={g.photo} alt={g.name} className="absolute inset-0 h-full w-full object-cover" />
            ) : (
              <GarmentGlyph
                category={g.category}
                kind={g.kind}
                className="h-24 w-24"
                strokeWidth={5}
              />
            )}
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            {[
              ["Category", g.category === "accessory" ? g.kind ?? "extra" : g.category],
              ["Color family", g.colorFamily],
              ["Warmth", `${"●".repeat(g.warmth)}${"○".repeat(3 - g.warmth)} ${g.warmth}/3`],
              [
                "Formality",
                g.formality === 1 ? "Casual" : g.formality === 2 ? "Smart" : "Formal",
              ],
            ].map(([k, v]) => (
              <div key={k} className="rounded-[14px] border border-line px-3.5 py-2.5">
                <p className="label-micro !text-[9px]">{k}</p>
                <p className="mt-0.5 text-[13px] font-extrabold capitalize">{v}</p>
              </div>
            ))}
          </div>

          <button
            onClick={() => {
              if (confirmDel) {
                removeGarment(g.id);
                notify(`“${g.name}” removed`);
                onClose();
              } else {
                setConfirmDel(true);
              }
            }}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-[16px] border py-3 text-[13.5px] font-extrabold transition active:scale-[0.98]",
              confirmDel
                ? "border-danger bg-dangersoft text-danger"
                : "border-line text-mut"
            )}
          >
            <Trash2 className="h-4 w-4" />
            {confirmDel ? "Tap again to confirm" : "Remove from closet"}
          </button>
        </div>
      )}
    </Sheet>
  );
}

/* ------------------------------- screen ------------------------------- */

export default function Closet() {
  const garments = useAppStore((s) => s.garments);
  const restoreSamples = useAppStore((s) => s.restoreSamples);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [addOpen, setAddOpen] = useState(false);
  const [detail, setDetail] = useState<Garment | null>(null);

  const filtered = garments.filter((g) => {
    const okCat = filter === "all" || g.category === filter;
    const okQuery =
      !query.trim() ||
      g.name.toLowerCase().includes(query.trim().toLowerCase()) ||
      g.colorFamily.includes(query.trim().toLowerCase());
    return okCat && okQuery;
  });

  const countFor = (c: Filter) =>
    c === "all" ? garments.length : garments.filter((g) => g.category === c).length;

  return (
    <div className="px-4 pb-44 pt-4">
      <header className="flex items-end justify-between">
        <div>
          <p className="label-micro">Wardrobe</p>
          <h1 className="font-display text-[27px] font-extrabold tracking-tight">Closet</h1>
        </div>
        <span className="mb-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-extrabold text-mut">
          {garments.length} pieces
        </span>
      </header>

      {garments.length === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="card mt-6 flex flex-col items-center rounded-[24px] px-6 py-12 text-center"
        >
          <LogoMark className="h-14 w-14 text-mut" />
          <h2 className="mt-4 font-display text-[20px] font-extrabold">Nothing to wear (yet)</h2>
          <p className="mt-1.5 max-w-[260px] text-[13px] font-medium leading-relaxed text-mut">
            Your closet is empty. Add your first piece, or bring back the sample
            wardrobe to explore.
          </p>
          <div className="mt-5 flex gap-2">
            <button
              onClick={() => setAddOpen(true)}
              className="flex items-center gap-1.5 rounded-full bg-acc px-5 py-2.5 text-[13px] font-extrabold text-accink transition active:scale-95"
            >
              <Plus className="h-4 w-4" /> Add a piece
            </button>
            <button
              onClick={restoreSamples}
              className="flex items-center gap-1.5 rounded-full border border-line px-4 py-2.5 text-[13px] font-extrabold text-mut transition active:scale-95"
            >
              <RotateCcw className="h-4 w-4" /> Samples
            </button>
          </div>
        </motion.div>
      ) : (
        <>
          <div className="relative mt-4">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-mut" />
            <input
              className="field !pl-10"
              placeholder="Search pieces or colors…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>

          <div className="no-scrollbar -mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1">
            {(["all", ...CATEGORIES.map((c) => c.id)] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "shrink-0 rounded-full border px-3.5 py-1.5 text-[11.5px] font-extrabold transition-all active:scale-95",
                  filter === f
                    ? "border-transparent bg-ink text-bg"
                    : "border-line text-mut hover:text-ink"
                )}
              >
                {f === "all" ? "All" : CATEGORIES.find((c) => c.id === f)?.label}
                <span className={cn("ml-1.5", filter === f ? "opacity-70" : "text-mut")}>
                  {countFor(f)}
                </span>
              </button>
            ))}
          </div>

          {filtered.length === 0 ? (
            <div className="card mt-6 rounded-[20px] px-6 py-10 text-center">
              <p className="text-[14px] font-extrabold">No matches</p>
              <p className="mt-1 text-[12.5px] font-medium text-mut">
                Nothing fits that search and filter combo.
              </p>
              <button
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
                className="mt-3 rounded-full border border-line px-4 py-2 text-[12px] font-extrabold text-mut transition active:scale-95"
              >
                Clear filters
              </button>
            </div>
          ) : (
            <motion.div layout className="mt-4 grid grid-cols-2 gap-3 min-[420px]:grid-cols-3">
              <AnimatePresence mode="popLayout">
                {filtered.map((g) => (
                  <GarmentCard key={g.id} garment={g} onOpen={setDetail} />
                ))}
              </AnimatePresence>
            </motion.div>
          )}
        </>
      )}

      {/* FAB */}
      <motion.button
        onClick={() => setAddOpen(true)}
        whileTap={{ scale: 0.9 }}
        className="fixed bottom-[calc(env(safe-area-inset-bottom)+88px)] right-4 z-30 flex h-[54px] w-[54px] items-center justify-center rounded-full bg-acc text-accink shadow-xl"
        style={{ boxShadow: "0 12px 30px -8px var(--acc)" }}
        aria-label="Add garment"
      >
        <Plus className="h-6 w-6" strokeWidth={2.6} />
      </motion.button>

      <Sheet open={addOpen} onClose={() => setAddOpen(false)} title="Add a piece">
        <AIUploadForm
          onDone={() => {
            setAddOpen(false);
          }}
          onCancel={() => {
            setAddOpen(false);
          }}
        />
      </Sheet>

      <DetailSheet garment={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

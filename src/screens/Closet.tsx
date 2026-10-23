import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Ban, Camera, Loader2, Plus, RotateCcw, Search, Sparkles, Trash2, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useAppStore } from "../store/appStore";
import { useGarment, useGarmentIds } from "../store/selectors";
import { INTERRUPTED_ERROR, useJobsStore } from "../store/jobsStore";
import { cancel as cancelJob } from "../services/jobQueue";
import { useElapsedSeconds } from "../lib/useElapsed";
import { CATEGORIES } from "../lib/mock";
import {
  COLOR_SWATCHES,
  cn,
  compressImage,
  isLightColor,
  uid,
} from "../lib/utils";
import type { Category, Formality, Garment, Warmth, ColorFamily, AccessoryKind } from "../types";
import type { PatternKind } from "../lib/patternDetect";
import GarmentCard from "../components/GarmentCard";
import GarmentPhoto from "../components/GarmentPhoto";
import Sheet from "../components/Sheet";
import { LogoMark } from "../components/icons";
import { taggingToGarment, withTimeout, type TaggingResult } from "../services/aiStylistService";
import { startImport, type ImportHandle } from "../services/uploadQueue";
import { reconClassFor } from "../services/garmentRecon";
import { markStage } from "../lib/telemetry";

type Filter = "all" | Category;

interface PendingGarment extends TaggingResult {
  tempId: string;
  imageDataUrl?: string;
  fileName: string;
  /** Prepared-image hash, carried through review so the recon cache still
   *  matches when the item is saved later (Phase 2). */
  photoSha256?: string;
  /** The wearer confirmed the model's `printHint` during review — the only
   *  path that turns a hint into the wearer-set hasPrint flag. */
  printConfirmed?: boolean;
}
const SHORT_CAT: Record<Category, string> = {
  top: "Top",
  bottom: "Bottom",
  dress: "Dress",
  outerwear: "Outer",
  shoes: "Shoes",
  accessory: "Extra",
};

/* ------------------------- review stash (survives close) ------------------------- */

/**
 * The add sheet unmounts its children when closed, and the import outlives
 * the sheet by design. So the review list cannot live in component state:
 * a batch analysed with review enabled would finish into a component that no
 * longer exists, and the wearer's corrections would vanish.
 *
 * This module-level stash is the handoff. The queue writes here when it
 * finishes; the sheet reads it on mount and re-opens itself. It holds at
 * most one batch — a new import replaces it — and holds image data URLs
 * only while review is on, which is the opt-in path.
 */
let reviewStash: PendingGarment[] | null = null;
const reviewListeners = new Set<() => void>();

const notifyReviewListeners = () => {
  for (const fn of reviewListeners) fn();
};

export const setReviewStash = (items: PendingGarment[] | null) => {
  reviewStash = items;
  notifyReviewListeners();
};

export const takeReviewStash = (): PendingGarment[] | null => {
  const items = reviewStash;
  reviewStash = null;
  return items;
};

export const peekReviewStash = (): PendingGarment[] | null => reviewStash;

/* ------------------------ print hints (ephemeral) ------------------------ */

/**
 * One-time "this looks like it has a logo or print" nudges, keyed by the
 * prepared-image content hash, for garments that were added WITHOUT review
 * (the default path — the sheet closes and the item is saved as it tags).
 *
 * Deliberately NOT a Garment field: spec §6 locks the field names, and the
 * wearer's `hasPrint` flag must stay wearer-set — the detail renderer
 * measurably invents detail on plain garments (spec §9, klein verdict), so a
 * model guess must never silently pick the renderer. The hint rides from the
 * import callback to the first detail-sheet open and is then consumed: one
 * tap to act, one to dismiss, never persisted, never nagging.
 *
 * Entries whose sheet is never opened just sit (a few bytes each, bounded by
 * import count) — an acceptable leak for a nudge that must outlive a reload
 * only long enough to reach the wearer.
 */
const printHints = new Map<string, boolean>();

const rememberPrintHint = (key: string) => {
  printHints.set(key, true);
};

const takePrintHint = (key: string): boolean => {
  const hit = printHints.get(key) === true;
  printHints.delete(key);
  return hit;
};

export const subscribeReview = (fn: () => void): (() => void) => {
  reviewListeners.add(fn);
  return () => {
    reviewListeners.delete(fn);
  };
};

/* ------------------------------ add form ------------------------------ */

/**
 * AI-powered garment upload.
 *
 * The import itself lives in `services/uploadQueue` — this component is only
 * the picker plus an optional review step. Two deliberate changes from the
 * old inline loop:
 *
 * - **The sheet closes on Analyse.** Decoding and tagging a photo takes
 *   seconds; holding the wearer in a modal for the whole batch (with a
 *   spinner they could not escape) was the complaint. Work continues in the
 *   background, items land in the closet as they finish, and the sheet
 *   returns to file-picking straight away.
 * - **Review is opt-in, default off.** The old flow always paused on a
 *   confirm screen; most imports are "these are my new things, save them",
 *   so the common path now saves directly and still allows full manual
 *   correction when wanted.
 */
function AIUploadForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const addGarment = useAppStore((s) => s.addGarment);
  const notify = useAppStore((s) => s.notify);

  const [files, setFiles] = useState<File[]>([]);
  const [pending, setPending] = useState<PendingGarment[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [review, setReview] = useState(false);
  // Live handle on the running import so "Stop" really aborts it, and so
  // the ref stays valid after this component unmounts (the sheet closes
  // immediately, but the import does not).
  const handleRef = useRef<ImportHandle | null>(null);

  const cancelAnalysis = () => {
    handleRef.current?.cancel();
    handleRef.current = null;
    setAnalyzing(false);
  };

  const fileRef = useRef<HTMLInputElement>(null);

  // A batch that finished while this sheet was closed: pick it up on mount so
  // the review screen is waiting for them, not silently discarded.
  useEffect(() => {
    const stashed = takeReviewStash();
    if (stashed && stashed.length > 0) {
      setPending(stashed);
      setReview(true);
    }
  }, []);

  const handleFileSelect = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const newFiles = Array.from(fileList).filter((f) => f.type.startsWith("image/"));
    if (newFiles.length === 0) {
      notify("Please select image files", "err");
      return;
    }
    markStage("import:files-picked", `count=${newFiles.length}`);
    setFiles((prev) => [...prev, ...newFiles]);
  };

  /**
   * Start the import and get out of the wearer's way.
   *
   * With review off (the default) the sheet closes here and each item is
   * saved as it finishes. With review on we still close the sheet — the
   * pending list is picked up by the review screen when it is ready, so the
   * modal is never a cage either way.
   */
  const analyzeFiles = () => {
    if (files.length === 0) return;
    const items = files.map((file) => ({ file, fileName: file.name }));
    const total = items.length;
    markStage("import:analyze-start", `files=${total} review=${review}`);
    setAnalyzing(true);
    setProgress(0);
    setFiles([]);

    // Collected for the review screen. In the default (non-review) path
    // these are ignored, but populating them costs nothing and keeps the
    // toggle honest if it is flipped while a batch is in flight.
    const collected: PendingGarment[] = [];

    handleRef.current = startImport(items, {
      onItem: (garment, tags, fileName) => {
        if (review) {
          collected.push({
            ...tags,
            tempId: uid("p"),
            imageDataUrl: garment.photo,
            fileName,
            // The hash must survive the review round-trip too, or saving
            // later would miss the content-addressed recon cache.
            photoSha256: garment.photoSha256,
          });
        } else {
          // Optimistic: visible in the closet immediately, and recon /
          // sync run behind it exactly as before.
          // A print hint can't be asked about here (no review screen), so
          // park it for the first detail-sheet open — keyed by content hash,
          // which the saved garment carries.
          if (tags.printHint && garment.photoSha256) {
            rememberPrintHint(garment.photoSha256);
          }
          void addGarment(garment, garment.photo);
        }
      },
      onProgress: (done, n) => {
        setProgress(Math.round((done / Math.max(1, n)) * 100));
      },
      onError: (fileName, message) => {
        notify(`Skipped ${fileName} — ${message}`, "err");
      },
      onComplete: (added, n) => {
        handleRef.current = null;
        setAnalyzing(false);
        markStage("import:analyze-end", `added=${added}/${n}`);
        if (review) {
          // Completion order is nondeterministic across lanes — restore a
          // stable review list so items don't shuffle between runs.
          collected.sort((a, b) => a.name.localeCompare(b.name));
          // Hand off through the module stash: this component is about to
          // unmount when the sheet closes, and the review screen reads the
          // batch back on its next mount.
          setReviewStash(collected);
        } else {
          notify(
            added === n
              ? `${added} item${added === 1 ? "" : "s"} added to closet`
              : `${added} of ${n} added — the rest were skipped`
          );
        }
      },
    });

    // Close immediately. The import owns itself from here.
    onDone();
  };


  const updatePending = (tempId: string, updates: Partial<PendingGarment>) => {
    setPending((prev) => prev.map((p) => (p.tempId === tempId ? { ...p, ...updates } : p)));
  };

  const removePending = (tempId: string) => {
    setPending((prev) => prev.filter((p) => p.tempId !== tempId));
  };

  const confirmAndSave = () => {
    pending.forEach((p) => {
      const garment = taggingToGarment(p, p.imageDataUrl, p.photoSha256, p.printConfirmed);
      addGarment(garment);
    });
    notify(`${pending.length} item(s) added to closet`);
    setPending([]);
    onDone();
  };

  const validCategories = ["top", "bottom", "dress", "outerwear", "shoes", "accessory"] as Category[];
  const validFamilies = ["neutral", "warm", "cool", "earth", "accent"] as ColorFamily[];
  const validPatterns: Array<{ id: PatternKind; label: string }> = [
    { id: "solid", label: "Solid" },
    { id: "striped", label: "Striped" },
    { id: "colorblock", label: "Colorblock" },
    { id: "other", label: "Print" },
  ];

  if (pending.length > 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-[16px] font-extrabold">Review &amp; Confirm</h3>
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
                    <div className="flex h-full w-full items-center justify-center px-1 text-center">
                      <span className="line-clamp-2 text-[11px] font-extrabold text-mut">{p.name}</span>
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1 space-y-2">
                  {/* Name + remove button: allow wrap on narrow screens */}
                  <div className="flex flex-wrap items-start gap-2">
                    <input
                      className="field !py-1.5 !text-[13px] min-w-[140px] flex-1"
                      value={p.name}
                      onChange={(e) => updatePending(p.tempId, { name: e.target.value })}
                      placeholder="Item name"
                    />
                    <button
                      onClick={() => removePending(p.tempId)}
                      className="shrink-0 rounded-full p-1.5 text-mut hover:bg-dangersoft hover:text-danger"
                      aria-label="Remove item"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  {/* Category + color family: stack on mobile, row on desktop */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <select
                      className="field !py-1 !text-[11px] !px-2 w-full sm:w-auto"
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
                      className="field !py-1 !text-[11px] !px-2 w-full sm:w-auto"
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

                  {/* Detected colors + pattern: confirm or correct before saving */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-bold text-mut">Colors:</span>
                      {(p.colors ?? []).slice(0, 3).map((hex, i) => (
                        <button
                          key={`${hex}-${i}`}
                          onClick={() => {
                            // Promote tapped swatch to the primary color,
                            // keeping the measured shares aligned.
                            const order = (p.colors ?? []).map((_, j) => j);
                            const next = [i, ...order.filter((j) => j !== i)];
                            updatePending(p.tempId, {
                              colors: next.map((j) => (p.colors ?? [])[j]),
                              patternMix: p.patternMix
                                ? next.map((j) => p.patternMix![j])
                                : undefined,
                            });
                          }}
                          title={i === 0 ? "Main color (tap another to change)" : "Tap to make main"}
                          aria-label={`Set ${hex} as main color`}
                          className={cn(
                            "h-6 w-6 rounded-full border-2 transition active:scale-90",
                            i === 0 ? "border-acc" : "border-linestrong"
                          )}
                          style={{ background: hex }}
                        />
                      ))}
                    </div>
                    <select
                      className="field !py-1 !text-[11px] !px-2 w-full sm:w-auto"
                      value={p.pattern}
                      onChange={(e) => updatePending(p.tempId, { pattern: e.target.value as PatternKind })}
                      aria-label="Pattern"
                    >
                      {validPatterns.map((pt) => (
                        <option key={pt.id} value={pt.id}>
                          {pt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Print hint: the model saw a logo/graphic/text. Asked
                      HERE so the FIRST reconstruction uses the right
                      renderer — confirming costs nothing extra, and the
                      wearer's answer (not the model's guess) sets the flag. */}
                  {p.printHint && !p.printConfirmed ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-[12px] border border-line bg-bgdeep px-3 py-2">
                      <span className="text-[11px] font-bold leading-snug text-ink">
                        Looks like it has a logo or print — the detail renderer keeps those legible (~60 s).
                      </span>
                      <div className="ml-auto flex shrink-0 gap-1.5">
                        <button
                          onClick={() => updatePending(p.tempId, { printConfirmed: true })}
                          className="rounded-full bg-acc px-3 py-1 text-[11px] font-extrabold text-accink transition active:scale-95"
                        >
                          Yes, flag it
                        </button>
                        <button
                          onClick={() => updatePending(p.tempId, { printHint: false })}
                          className="rounded-full border border-line px-3 py-1 text-[11px] font-extrabold text-mut transition active:scale-95"
                        >
                          No
                        </button>
                      </div>
                    </div>
                  ) : p.printConfirmed ? (
                    <p className="text-[11px] font-bold text-acc">
                      Flagged for the detail renderer — prints stay legible.
                    </p>
                  ) : null}

                  {/* Warmth + formality: stack vertically on mobile */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-mut">Warmth:</span>
                      <div className="flex rounded-[8px] border border-line bg-bgdeep p-0.5">
                        {([1, 2, 3] as Warmth[]).map((w) => (
                          <button
                            key={w}
                            onClick={() => updatePending(p.tempId, { warmth: w })}
                            className={cn(
                              "rounded-[6px] px-1.5 py-0.5 text-[11px] font-extrabold",
                              p.warmth === w ? "bg-acc text-accink" : "text-mut"
                            )}
                          >
                            {w === 1 ? "L" : w === 2 ? "M" : "W"}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-bold text-mut">Formality:</span>
                      <div className="flex rounded-[8px] border border-line bg-bgdeep p-0.5">
                        {([1, 2, 3] as Formality[]).map((f) => (
                          <button
                            key={f}
                            onClick={() => updatePending(p.tempId, { formality: f })}
                            className={cn(
                              "rounded-[6px] px-1.5 py-0.5 text-[11px] font-extrabold",
                              p.formality === f ? "bg-acc text-accink" : "text-mut"
                            )}
                          >
                            {f === 1 ? "C" : f === 2 ? "S" : "F"}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex gap-2 pt-2">
          <button
            onClick={() => {
              // Clear the stash too: re-opening the sheet must not resurrect
              // a batch the wearer just discarded.
              setReviewStash(null);
              setPending([]);
              onCancel();
            }}
            className="flex-1 rounded-[16px] border border-line py-3 text-[13.5px] font-extrabold text-mut transition active:scale-[0.98]"
          >
            Discard
          </button>
          <button
            onClick={confirmAndSave}
            className="flex-1 rounded-[16px] bg-acc py-3 text-[15px] font-extrabold text-accink transition active:scale-[0.98]"
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
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-medium"
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
            <span className="text-[11px] text-mut">Auto-compressed to ~500KB each</span>
          </button>
        )}
      </div>

      {!analyzing && (
        <label className="flex cursor-pointer items-center gap-2.5 rounded-[14px] border border-line bg-card px-3.5 py-3">
          <input
            type="checkbox"
            checked={review}
            onChange={(e) => setReview(e.target.checked)}
            className="h-4 w-4 shrink-0 accent-[var(--accent)]"
          />
          <span className="min-w-0 flex-1">
            <span className="block text-[12px] font-extrabold">Review before saving</span>
            <span className="block text-[11px] leading-snug text-mut">
              Off: photos go straight to your closet as they finish. On: check the
              tags first.
            </span>
          </span>
        </label>
      )}

      {analyzing && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="label-micro">Analyzing…</span>
            <span className="text-[11px] font-bold text-mut">{progress}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-bgdeep">
            <motion.div
              className="h-full bg-acc"
              initial={{ width: 0 }}
              animate={{ width: `${progress}%` }}
              transition={{ ease: "easeOut" }}
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[11px] text-mut">You can close this — it keeps going.</p>
            <button
              onClick={cancelAnalysis}
              className="shrink-0 rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-mut transition active:scale-95"
            >
              Stop
            </button>
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <button
          onClick={analyzing ? cancelAnalysis : onCancel}
          disabled={!analyzing && files.length === 0}
          className="flex-1 rounded-[16px] border border-line py-3 text-[13.5px] font-extrabold text-mut transition active:scale-[0.98] disabled:opacity-50"
        >
          {analyzing ? "Stop analysis" : "Cancel"}
        </button>
        <button
          onClick={analyzeFiles}
          disabled={analyzing || files.length === 0}
          className="flex flex-1 items-center justify-center gap-2 rounded-[16px] bg-acc py-3 text-[15px] font-extrabold text-accink transition active:scale-[0.98] disabled:opacity-50"
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
      name: name.trim(),
      category,
      color: swatch.hex,
      colors: [swatch.hex],
      pattern: "solid",
      colorFamily: swatch.family,
      warmth,
      formality,
      kind: category === "accessory" ? "scarf" : undefined,
      photo: photo ?? undefined,
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
        <div className="grid grid-cols-3 gap-1.5">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => setCategory(c.id)}
              className={cn(
                "rounded-[14px] border px-2 py-2.5 text-center transition-all",
                category === c.id
                  ? "border-acc bg-accsoft text-acc"
                  : "border-line text-mut active:scale-95"
              )}
            >
              <span className="block text-[11px] font-extrabold">
                {SHORT_CAT[c.id]}
              </span>
              <span className="mt-0.5 block text-[11px] font-bold opacity-70">
                {c.label}
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
              className="absolute right-2 top-2 rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-extrabold text-white backdrop-blur-sm"
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
        className="w-full rounded-[16px] bg-acc py-3.5 text-[15px] font-extrabold text-accink transition active:scale-[0.98]"
      >
        Add to closet
      </button>
    </div>
  );
}

/* ---------------------------- detail sheet ---------------------------- */

function DetailSheet({ garment, onClose }: { garment: Garment | null; onClose: () => void }) {
  const removeGarment = useAppStore((s) => s.removeGarment);
  const retryRecon = useAppStore((s) => s.retryRecon);
  const setGarmentPrint = useAppStore((s) => s.setGarmentPrint);
  const notify = useAppStore((s) => s.notify);
  // Live queue state for THIS garment, so the sheet reports the step that is
  // really running instead of a generic spinner (and so the controls agree
  // with the banner).
  const reconJob = useJobsStore((s) => (garment ? s.jobs[garment.id] : undefined));
  const reconLive =
    reconJob?.status === "running" || reconJob?.status === "queued";
  const elapsed = useElapsedSeconds(reconJob?.startedAt);
  const [confirmDel, setConfirmDel] = useState(false);

  // Print hint parked by a no-review import (see `printHints`). Taken, not
  // peeked: it is a one-time nudge, so opening the sheet consumes it. Acting
  // on it runs the same store action as the toggle below — there is no
  // second path to the renderer choice, and no silent re-routing.
  const [printHint, setPrintHint] = useState(false);
  useEffect(() => {
    if (garment?.photoSha256) setPrintHint(takePrintHint(garment.photoSha256));
  }, [garment?.photoSha256]);

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
          <div className="relative h-56 overflow-hidden rounded-[20px]">
            <GarmentPhoto garment={g} eager />
          </div>
          {/* Garment reconstruction: one remote call per garment at import;
              the photo/SVG skeleton always shows when this hasn't run or
              failed. Manual retry only — never auto-retried, to respect the
              free quota. Hybrid router: the wearer flags print garments
              (logos/graphics/text) for the detail renderer; plain pieces
              stay on the default backend. Toggling re-runs reconstruction
              (one extra quota call) when a photo is present. */}
          {g.reconUrl && g.reconStatus === "ready" ? (
            <p className="flex items-center gap-1.5 text-[11px] font-bold text-mut">
              <Sparkles className="h-3.5 w-3.5 text-acc" /> Reconstructed · true to your photo
              {g.reconRenderer === "klein" ? " · detail render" : ""}
            </p>
          ) : g.reconStatus === "pending" ? (
            <div className="flex items-center justify-between gap-2 rounded-[14px] border border-line px-3.5 py-2.5">
              <p className="flex items-center gap-1.5 text-[11px] font-bold leading-snug text-mut">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-acc" />
                {/* Uploading and "waiting on the renderer" are very different
                    waits for the wearer — say which one this is, and how long
                    it has been going (recon reports no percentage). */}
                {reconJob?.status === "running"
                  ? `${reconJob.stage ?? "Reconstructing"} · ${elapsed}s · photo showing`
                  : reconJob?.status === "queued"
                    ? "Queued behind another garment · photo showing"
                    : "Reconstructing… photo showing"}
              </p>
              {reconLive && (
                <button
                  onClick={() => cancelJob(g.id)}
                  className="flex shrink-0 items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-ink transition active:scale-95"
                >
                  <Ban className="h-3.5 w-3.5" /> Cancel
                </button>
              )}
            </div>
          ) : g.photo && !g.reconUrl ? (
            <div className="flex items-center justify-between gap-2 rounded-[14px] border border-line px-3.5 py-2.5">
              <p className="text-[11px] font-bold leading-snug text-mut">
                {g.reconStatus === "failed"
                  ? g.reconError === INTERRUPTED_ERROR
                    ? "Interrupted when the app closed — photo kept. One tap to finish it."
                    : `Reconstruction didn’t run${g.reconError ? ` — ${g.reconError}` : ""} — photo kept. Retry when quota allows.`
                  : "Rebuild this as a clean standalone garment — free, one-time."}
              </p>
              <button
                onClick={() => retryRecon(g.id)}
                disabled={reconLive}
                className="flex shrink-0 items-center gap-1.5 rounded-full bg-acc px-3 py-1.5 text-[11px] font-extrabold text-accink transition active:scale-95 disabled:opacity-60"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {g.reconStatus === "failed" ? "Try again" : "Reconstruct"}
              </button>
            </div>
          ) : null}
          {g.photo && reconClassFor(g.category) && !g.hasPrint && printHint ? (
            <div className="flex flex-wrap items-center gap-2 rounded-[14px] border border-line bg-accsoft px-3.5 py-2.5">
              <p className="text-[11px] font-bold leading-snug text-ink">
                This looks like it has a logo or print. The detail renderer keeps those legible (~60 s) —
                switching rebuilds the image once.
              </p>
              <div className="ml-auto flex shrink-0 gap-1.5">
                <button
                  onClick={() => {
                    setPrintHint(false);
                    void setGarmentPrint(g.id, true);
                  }}
                  className="rounded-full bg-acc px-3 py-1 text-[11px] font-extrabold text-accink transition active:scale-95"
                >
                  Use it
                </button>
                <button
                  onClick={() => setPrintHint(false)}
                  className="rounded-full border border-line px-3 py-1 text-[11px] font-extrabold text-mut transition active:scale-95"
                >
                  Not really
                </button>
              </div>
            </div>
          ) : null}
          {g.photo && reconClassFor(g.category) ? (
            <button
              onClick={() => g.reconStatus !== "pending" && setGarmentPrint(g.id, !g.hasPrint)}
              aria-pressed={!!g.hasPrint}
              disabled={reconLive || g.reconStatus === "pending"}
              className="flex w-full items-center justify-between gap-2 rounded-[14px] border border-line px-3.5 py-2.5 text-left transition active:scale-[0.99] disabled:opacity-60"
            >
              <span>
                <span className="block text-[11px] font-extrabold text-ink">
                  Logos, graphics or text {g.hasPrint ? "· on" : "· off"}
                </span>
                <span className="block text-[11px] font-bold leading-snug text-mut">
                  {g.hasPrint
                    ? "Detail renderer keeps prints legible — slower, ~60 s."
                    : "Default renderer for plain garments — faster, ~30 s."}
                  {g.reconUrl ? " Toggling rebuilds the image." : ""}
                </span>
              </span>
              <span
                aria-hidden
                className={`relative h-5 w-9 shrink-0 rounded-full transition ${g.hasPrint ? "bg-acc" : "bg-line"}`}
              >
                <span
                  className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${g.hasPrint ? "left-[18px]" : "left-0.5"}`}
                />
              </span>
            </button>
          ) : null}
          {g.photo && (
            <details className="rounded-[14px] border border-line px-3.5 py-2.5">
              <summary className="cursor-pointer text-[11px] font-extrabold uppercase tracking-[0.14em] text-mut">
                Original photo
              </summary>
              <img
                src={g.photo}
                alt={`Original photo of ${g.name}`}
                loading="lazy"
                className="mt-2 max-h-56 w-full rounded-[10px] object-contain"
              />
            </details>
          )}

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
                <p className="label-micro !text-[11px]">{k}</p>
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

/**
 * One closet tile, subscribed to ONE garment record.
 *
 * This is the shape Phase 3 asks for: the tile renders `useGarment(id)`, so a
 * store write that touches some other garment — or that touches garments not
 * at all — cannot re-render it. Previously the screen read the whole array and
 * mapped over it, so every `applyReconPatch` (one per stage event, per
 * garment, during a batch) re-rendered every tile in the grid.
 *
 * `React.memo` on `GarmentCard` still helps — the parent passes a stable
 * `onOpen` — but it is the per-record subscription here that makes the
 * isolation provable rather than merely likely.
 */
function ClosetTile({ id, onOpen }: { id: string; onOpen: (g: Garment) => void }) {
  const garment = useGarment(id);
  // Drop the tile on the frame the record disappears, rather than rendering a
  // skeleton that never resolves. `<AnimatePresence>` still gets its exit
  // animation because the parent keeps the id until the removal settles here.
  if (!garment) return null;
  return <GarmentCard garment={garment} onOpen={onOpen} />;
}

/* ------------------------------- screen ------------------------------- */

export default function Closet() {
  // Ids, not records: the ids of a garment only change when garments are added
  // or removed, so a per-garment status tick leaves this list identical.
  const garmentIds = useGarmentIds();
  const restoreSamples = useAppStore((s) => s.restoreSamples);

  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [addOpen, setAddOpen] = useState(false);
  // True while the sheet is showing a review batch rather than the picker.
  const [reviewing, setReviewing] = useState(false);

  // The import outlives the sheet, so a review batch can land after the
  // wearer has already walked away. Re-open on it — otherwise their pending
  // corrections would sit invisible until they happened to tap + again.
  useEffect(
    () =>
      subscribeReview(() => {
        if (peekReviewStash()?.length) {
          setReviewing(true);
          setAddOpen(true);
        } else {
          setReviewing(false);
        }
      }),
    []
  );
  const [detail, setDetail] = useState<Garment | null>(null);

  /**
   * The visible ids. Filtering on ids alone would mean resolving every record;
   * matching needs name/category/colourFamily, so the predicate runs inside a
   * `useMemo` over the stable id list. The result is `useShallow`-compared by
   * the array, so re-running the filter with the same outcome is a no-op.
   */
  const filteredIds = useMemo(
    () =>
      garmentIds.filter((id) => {
        const g = useAppStore.getState().garments.find((x) => x.id === id);
        if (!g) return false;
        const okCat = filter === "all" || g.category === filter;
        const q = query.trim().toLowerCase();
        const okQuery =
          !q ||
          g.name.toLowerCase().includes(q) ||
          g.colorFamily.toLowerCase().includes(q);
        return okCat && okQuery;
      }),
    [garmentIds, filter, query]
  );

  // Stable identity for the memoised cards: a new function per render would
  // defeat `React.memo` on GarmentCard and re-render the whole grid anyway.
  const openDetail = useCallback((g: Garment) => setDetail(g), []);

  const counts = useAppStore(
    useShallow((s) => {
      const out: Record<Filter, number> = {
        all: s.garments.length,
        top: 0,
        bottom: 0,
        dress: 0,
        outerwear: 0,
        shoes: 0,
        accessory: 0,
      };
      for (const g of s.garments) out[g.category] += 1;
      return out;
    })
  );

  const countFor = (c: Filter) => counts[c];

  return (
    <div className="px-4 pb-44 pt-4">
      <header className="flex items-end justify-between">
        <div>
          <p className="label-micro">Wardrobe</p>
          <h1 className="font-display text-[27px] font-extrabold tracking-tight">Closet</h1>
        </div>
        <span className="mb-1.5 rounded-full border border-line bg-card px-2.5 py-1 text-[11px] font-extrabold text-mut">
          {counts.all} pieces
        </span>
      </header>

      {counts.all === 0 ? (
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="card mt-6 flex flex-col items-center rounded-[24px] px-6 py-12 text-center"
        >
          <LogoMark className="h-14 w-14 text-mut" />
          <h2 className="mt-4 text-[20px] font-extrabold">Nothing to wear (yet)</h2>
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
                aria-pressed={filter === f}
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

          {filteredIds.length === 0 ? (
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
                {filteredIds.map((id) => (
                  <ClosetTile key={id} id={id} onOpen={openDetail} />
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

      <Sheet
        open={addOpen}
        onClose={() => {
          setAddOpen(false);
          setReviewing(false);
        }}
        title={reviewing ? "Review your pieces" : "Add a piece"}
      >
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

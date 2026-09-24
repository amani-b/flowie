import { useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "../lib/utils";
import { renderingFor } from "../services/studioRender";
import { useAppStore } from "../store/appStore";
import ErrorBoundary from "./ErrorBoundary";
import type { Garment } from "../types";

/** Soft neutral "product photo" backdrop behind cover-fit imagery. */
export const BOARD_TILE_BG =
  "linear-gradient(160deg, var(--board-1) 0%, var(--board-2) 100%)";

/**
 * One garment's display image, best-first:
 * 1. the reconstruction final (`reconUrl`, built ONCE at import via the
 *    recon-garment Edge Function — the complete empty garment);
 * 2. the original photo (always present for photo garments);
 * 3. the cached procedural SVG skeleton (instant, deterministic —
 *    same backdrop palette, so swaps are seamless).
 *
 * The SVG renders synchronously, so pending recon jobs never block the
 * tile: the skeleton shows immediately with a small progress pill, then
 * the recon swaps in when it lands. Failures are silent here (photo/SVG
 * carry on) — retries live in the Closet detail sheet.
 */
export default function GarmentPhoto({
  garment,
  imgClassName,
  eager,
}: {
  garment: Garment;
  imgClassName?: string;
  eager?: boolean;
}) {
  const backfillRendering = useAppStore((s) => s.backfillRendering);
  const [failed, setFailed] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  const status = garment.renderStatus ?? (garment.rendering ? "ready" : "pending");
  // A "failed" recon is discarded for display (photo/SVG is the honest
  // finished state); "pending" keeps showing photo/SVG underneath.
  const recon =
    garment.reconStatus === "failed" ? undefined : garment.reconUrl;
  const reconPending =
    garment.reconStatus === "pending" && !recon;

  // Legacy records that predate cached renderings: generate once, store on
  // the record (and its look snapshots), then display. One effect, one write.
  useEffect(() => {
    if (!garment.rendering && status !== "failed") {
      backfillRendering(garment.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [garment.id, garment.rendering]);

  useEffect(() => {
    setFailed(false);
  }, [garment.id, garment.rendering, garment.photo, recon, retryTick]);

  if (status === "failed" || failed) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center"
        style={{ background: BOARD_TILE_BG }}
        role="status"
        aria-label={`Studio shot for ${garment.name} needs another try`}
      >
        <p className="text-[11px] font-extrabold text-mut">
          Studio shot didn&rsquo;t come out
        </p>
        <button
          onClick={() => {
            setRetryTick((t) => t + 1);
            backfillRendering(garment.id);
          }}
          className="flex items-center gap-1.5 rounded-full border border-line px-3 py-1.5 text-[11px] font-extrabold text-ink transition active:scale-95"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Try again
        </button>
      </div>
    );
  }

  if (!garment.rendering && status === "pending") {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center"
        style={{ background: BOARD_TILE_BG }}
        role="status"
        aria-label={`Preparing studio shot for ${garment.name}`}
      >
        <Loader2 className="h-5 w-5 animate-spin text-mut" />
        <p className="text-[10px] font-extrabold uppercase tracking-[0.16em] text-mut">
          Preparing shot…
        </p>
      </div>
    );
  }

  // Last-resort inline derivation (should already be cached on the record).
  // Recon wins when ready, then the original photo, then the SVG skeleton —
  // same frame and backdrop palette, so grids stay uniform whichever source
  // is showing.
  // renderingFor never throws (normalises corrupt records), but the tile is
  // additionally isolated: one poisoned garment shows a fallback tile
  // instead of erasing the whole screen via the top boundary.
  const src = recon ?? garment.photo ?? garment.rendering ?? renderingFor(garment);

  return (
    <ErrorBoundary
      resetKey={`${garment.id}-${retryTick}`}
      fallback={
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-1 px-3 text-center"
          style={{ background: BOARD_TILE_BG }}
          role="status"
          aria-label={`${garment.name} preview unavailable`}
        >
          <p className="line-clamp-2 text-[11px] font-extrabold text-mut">
            {garment.name}
          </p>
        </div>
      }
    >
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden"
      style={{ background: BOARD_TILE_BG }}
    >
      <img
        key={`${garment.id}-${recon ? "recon" : garment.photo ? "photo" : "render"}-${retryTick}`}
        src={src}
        alt={garment.name}
        loading={eager ? "eager" : "lazy"}
        draggable={false}
        onError={() => setFailed(true)}
        className={cn("h-full w-full object-cover", imgClassName)}
      />
      {reconPending && (
        <span className="absolute bottom-2 left-2 flex items-center gap-1 rounded-full bg-black/45 px-2 py-1 text-[9px] font-extrabold uppercase tracking-[0.12em] text-white backdrop-blur-sm">
          <Loader2 className="h-3 w-3 animate-spin" /> Reconstructing…
        </span>
      )}
    </div>
    </ErrorBoundary>
  );
}

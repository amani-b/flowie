import { useEffect, useState } from "react";
import { cn, darken, isLightColor } from "../lib/utils";
import { renderingUrl } from "../services/renderService";
import type { Garment } from "../types";

/** Soft neutral "product photo" backdrop behind cover-fit imagery. */
export const BOARD_TILE_BG =
  "linear-gradient(160deg, var(--board-1) 0%, var(--board-2) 100%)";

/**
 * One garment's display image, resolved through a strict fallback chain:
 *   1. generated studio rendering (preloaded; shown the moment it loads),
 *   2. the original uploaded photo, cleanly cropped/centered,
 *   3. last resort: a solid tile in THAT garment's own extracted color.
 *
 * While the rendering loads, the photo (or color tile) shows — never a
 * blank box. Any failure degrades one step, never to a generic placeholder:
 * the color fallback always uses this garment's own color, so two different
 * garments can never render identically.
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
  const url = renderingUrl(garment);
  const [renderReady, setRenderReady] = useState(false);
  const [renderFailed, setRenderFailed] = useState(false);
  const [photoFailed, setPhotoFailed] = useState(false);

  // New garment → re-attempt the rendering (automatic retry on every view).
  useEffect(() => {
    setRenderReady(false);
    setRenderFailed(false);
    setPhotoFailed(false);
  }, [url, garment.photo]);

  const showRender = renderReady && !renderFailed;
  const showPhoto = !showRender && !renderFailed && garment.photo && !photoFailed;
  const shownSrc = showRender ? url : showPhoto ? garment.photo! : undefined;
  const swatchLight = isLightColor(garment.color);

  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden"
      style={{ background: BOARD_TILE_BG }}
    >
      {/* Hidden probe: promotes the rendering to display only on success. */}
      {!renderReady && !renderFailed && (
        <img
          src={url}
          alt=""
          aria-hidden
          loading={eager ? "eager" : "lazy"}
          className="absolute h-px w-px opacity-0"
          onLoad={() => setRenderReady(true)}
          onError={() => setRenderFailed(true)}
        />
      )}
      {shownSrc ? (
        <img
          key={shownSrc}
          src={shownSrc}
          alt={garment.name}
          loading={eager ? "eager" : "lazy"}
          draggable={false}
          onError={() => {
            if (showRender) setRenderFailed(true);
            else setPhotoFailed(true);
          }}
          className={cn("h-full w-full object-cover", imgClassName)}
        />
      ) : (
        <div
          className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center"
          style={{
            background: `linear-gradient(160deg, ${garment.color} 0%, ${darken(garment.color, 0.22)} 100%)`,
          }}
        >
          <p
            className={cn(
              "line-clamp-2 text-[12px] font-extrabold leading-tight drop-shadow",
              swatchLight ? "text-black/75" : "text-white"
            )}
          >
            {garment.name}
          </p>
          <p
            className={cn(
              "text-[9px] font-bold uppercase tracking-[0.16em]",
              swatchLight ? "text-black/55" : "text-white/85"
            )}
          >
            {garment.category === "accessory" ? garment.kind ?? "extra" : garment.category}
          </p>
        </div>
      )}
    </div>
  );
}

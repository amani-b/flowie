import { cn } from "../lib/utils";
import { useCutoutSrc } from "../lib/cutout";
import type { Garment } from "../types";

/** Soft neutral "product photo" backdrop shared by every garment tile. */
export const BOARD_TILE_BG =
  "linear-gradient(160deg, var(--board-1) 0%, var(--board-2) 100%)";

/**
 * One garment rendered as isolated product photography: the real uploaded
 * photo (background-removed cutout when isolation succeeds, original photo
 * otherwise), floating on a clean neutral tile. No illustration, no figure.
 * Garments without a photo get a neutral name tile — never a glyph.
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
  const src = useCutoutSrc(garment.photo);

  if (!src) {
    return (
      <div
        className="flex h-full w-full flex-col items-center justify-center gap-1 px-2 text-center"
        style={{ background: BOARD_TILE_BG }}
      >
        <p className="line-clamp-2 text-[12px] font-extrabold leading-tight text-ink">
          {garment.name}
        </p>
        <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-mut">
          {garment.category === "accessory" ? garment.kind ?? "extra" : garment.category}
        </p>
      </div>
    );
  }

  return (
    <div
      className="flex h-full w-full items-center justify-center overflow-hidden"
      style={{ background: BOARD_TILE_BG }}
    >
      <img
        src={src}
        alt={garment.name}
        loading={eager ? "eager" : "lazy"}
        draggable={false}
        className={cn("h-full w-full object-contain p-2 drop-shadow-md", imgClassName)}
      />
    </div>
  );
}

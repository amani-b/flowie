import { useState } from "react";
import { motion } from "framer-motion";
import { Combine, Split } from "lucide-react";
import { cn } from "../lib/utils";
import type { Garment, Outfit } from "../types";
import GarmentPhoto from "./GarmentPhoto";

function outfitPieces(o: Outfit): Garment[] {
  return (["dress", "top", "bottom", "outer", "shoes", "accessory"] as const)
    .map((k) => o[k])
    .filter((g): g is Garment => Boolean(g));
}

/** Flat-lay order: outer, top/dress, bottom, shoes, accessory. */
function flatLayOrder(o: Outfit): Garment[] {
  return (["outer", "dress", "top", "bottom", "shoes", "accessory"] as const)
    .map((k) => o[k])
    .filter((g): g is Garment => Boolean(g));
}

function slotOf(o: Outfit, g: Garment): string {
  return (Object.keys(o) as Array<keyof Outfit>).find((k) => o[k]?.id === g.id) ?? "top";
}

/**
 * Photographic outfit board — the replacement for the cartoon avatar.
 *
 * Separate (default): each garment floats independently as an isolated
 * product-style photo, like browsing a retailer's product grid.
 * Combined: the same real photos animate into one flat-lay composition
 * (top above bottom, shoes below, outer/accessory alongside).
 * Tap the board or the affordance to toggle both directions. Still just
 * photos — never a body, never an illustration.
 */
export default function OutfitBoard({
  outfit,
  animateKey,
  className,
  compact,
  eager,
  staticBoard,
}: {
  outfit: Outfit;
  animateKey?: string | number;
  className?: string;
  /** smaller tiles for cards / schedule rows; interaction still works */
  compact?: boolean;
  eager?: boolean;
  /**
   * Non-interactive tile grid for boards embedded inside another clickable
   * card (nested buttons would break a11y). The full interactive board
   * lives one tap away in each detail view.
   */
  staticBoard?: boolean;
}) {
  const [combined, setCombined] = useState(false);
  const pieces = outfitPieces(outfit);
  const interactive = !staticBoard;
  const toggle = () => {
    if (interactive && pieces.length > 0) setCombined((c) => !c);
  };

  if (pieces.length === 0) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-[20px] border border-dashed border-linestrong px-4",
          compact ? "py-4" : "py-8",
          className
        )}
      >
        <p className="text-center text-[12px] font-bold text-mut">No pieces yet</p>
      </div>
    );
  }

  const tile = compact ? "w-14" : "w-24";
  const smallTile = compact ? "w-11" : "w-[72px]";

  return (
    <div className={cn("select-none", className)} key={animateKey ?? "board"}>
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="text-[9.5px] font-extrabold uppercase tracking-[0.18em] text-mut">
          {combined ? "Flat-lay" : `${pieces.length} piece${pieces.length > 1 ? "s" : ""}`}
        </span>
        {interactive && (
          <button
            onClick={toggle}
            aria-pressed={combined}
            aria-label={combined ? "Show pieces separately" : "Combine into one outfit"}
            className="flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-[10px] font-extrabold text-mut transition hover:text-ink active:scale-95"
          >
            {combined ? <Split className="h-3 w-3" /> : <Combine className="h-3 w-3" />}
            {combined ? "Separate" : "Combine"}
          </button>
        )}
      </div>

      {combined ? (
        /* ------- combined: single flat-lay composition ------- */
        <motion.div
          onClick={interactive ? toggle : undefined}
          role={interactive ? "button" : undefined}
          tabIndex={interactive ? 0 : undefined}
          aria-label="Show pieces separately"
          onKeyDown={
            interactive
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle();
                  }
                }
              : undefined
          }
          className={cn(
            "mx-auto flex max-w-[300px] flex-col items-center gap-1.5",
            interactive && "cursor-pointer"
          )}
          initial={{ opacity: 0.6 }}
          animate={{ opacity: 1 }}
        >
          <div className="flex items-start justify-center gap-1.5">
            {flatLayOrder(outfit)
              .filter((g) => ["outer", "dress", "top"].includes(slotOf(outfit, g)))
              .map((g) => (
                <motion.div
                  key={g.id}
                  layout
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className={cn("overflow-hidden rounded-[16px]", compact ? "w-16" : "w-28")}
                >
                  <div className="aspect-[4/5]">
                    <GarmentPhoto garment={g} eager={eager} />
                  </div>
                </motion.div>
              ))}
          </div>
          {flatLayOrder(outfit)
            .filter((g) => slotOf(outfit, g) === "bottom")
            .map((g) => (
              <motion.div
                key={g.id}
                layout
                transition={{ type: "spring", stiffness: 300, damping: 30 }}
                className={cn("overflow-hidden rounded-[16px]", compact ? "w-14" : "w-24")}
              >
                <div className="aspect-[4/5]">
                  <GarmentPhoto garment={g} eager={eager} />
                </div>
              </motion.div>
            ))}
          <div className="flex items-start justify-center gap-1.5">
            {flatLayOrder(outfit)
              .filter((g) => ["shoes", "accessory"].includes(slotOf(outfit, g)))
              .map((g) => (
                <motion.div
                  key={g.id}
                  layout
                  transition={{ type: "spring", stiffness: 300, damping: 30 }}
                  className={cn("overflow-hidden rounded-[14px]", smallTile)}
                >
                  <div className="aspect-square">
                    <GarmentPhoto garment={g} eager={eager} />
                  </div>
                </motion.div>
              ))}
          </div>
        </motion.div>
      ) : (
        /* ------- separate: independent floating renderings ------- */
        <motion.div
          onClick={interactive ? toggle : undefined}
          role={interactive ? "button" : undefined}
          tabIndex={interactive ? 0 : undefined}
          aria-label="Combine into one outfit"
          onKeyDown={
            interactive
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    toggle();
                  }
                }
              : undefined
          }
          className={cn(
            compact
              ? "flex flex-wrap justify-center gap-1.5"
              : "grid grid-cols-2 gap-2.5",
            interactive && "cursor-pointer"
          )}
        >
          {pieces.map((g, i) => (
            <motion.div
              key={g.id}
              layout
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                type: "spring",
                stiffness: 320,
                damping: 28,
                delay: Math.min(i * 0.05, 0.25),
              }}
              className={cn("overflow-hidden rounded-[16px]", tile)}
            >
              <div className="aspect-[4/5]">
                <GarmentPhoto garment={g} eager={eager} />
              </div>
              {!compact && (
                <p className="truncate bg-card px-2 py-1.5 text-center text-[10px] font-extrabold">
                  {g.name}
                </p>
              )}
            </motion.div>
          ))}
        </motion.div>
      )}
    </div>
  );
}

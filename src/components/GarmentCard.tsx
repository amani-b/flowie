import { memo } from "react";
import { motion } from "framer-motion";
import type { Garment } from "../types";
import GarmentPhoto from "./GarmentPhoto";

/**
 * Memoised deliberately: the grid maps over the whole closet, so without this
 * every store mutation (a recon stage tick, another garment being patched)
 * re-rendered every card in the list. `garment` is a stable object reference
 * between mutations because the store patches by rebuilding only the record it
 * touches — so the default shallow prop comparison is enough, provided the
 * parent also passes a stable `onOpen` (it does; see the `useCallback` in
 * Closet).
 */
function GarmentCard({
  garment,
  onOpen,
}: {
  garment: Garment;
  onOpen: (g: Garment) => void;
}) {
  return (
    <motion.button
      layout
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ type: "spring", stiffness: 380, damping: 30 }}
      whileTap={{ scale: 0.96 }}
      onClick={() => onOpen(garment)}
      className="card overflow-hidden rounded-[18px] text-left"
    >
      <div className="relative aspect-[4/5]">
        <GarmentPhoto garment={garment} />
        <span
          className="absolute right-2 top-2 flex gap-[3px] rounded-full bg-black/35 px-1.5 py-1 backdrop-blur-sm"
          title={`Warmth ${garment.warmth}/3`}
        >
          {[1, 2, 3].map((i) => (
            <span
              key={i}
              className="h-[5px] w-[5px] rounded-full"
              style={{
                background:
                  i <= garment.warmth
                    ? "rgba(255,255,255,0.95)"
                    : "rgba(255,255,255,0.35)",
              }}
            />
          ))}
        </span>
      </div>
      <div className="px-3 py-2.5">
        <p className="truncate text-[12.5px] font-extrabold">{garment.name}</p>
        <p className="mt-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-mut">
          {garment.category === "accessory" ? garment.kind ?? "extra" : garment.category}
          {" · "}
          {garment.colorFamily}
        </p>
      </div>
    </motion.button>
  );
}

export default memo(GarmentCard);

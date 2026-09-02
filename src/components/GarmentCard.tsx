import { motion } from "framer-motion";
import type { Garment } from "../types";
import { darken, isLightColor } from "../lib/utils";
import { GarmentGlyph } from "./icons";

/** Render a color swatch that supports multi-color garments */
function renderSwatch(garment: Garment): React.CSSProperties {
  // Single color or solid pattern: use simple gradient as before
  if (garment.colors.length === 1 || garment.pattern === "solid") {
    return {
      background: `linear-gradient(160deg, ${garment.color} 0%, ${darken(garment.color, 0.22)} 100%)`,
    };
  }

  // Multi-color garments: create pattern-based backgrounds
  const [c1, c2, c3] = garment.colors;

  if (garment.pattern === "striped") {
    // Diagonal stripes for striped patterns
    return {
      backgroundImage: `repeating-linear-gradient(
        45deg,
        ${c1},
        ${c1} 8px,
        ${c2 || c1} 8px,
        ${c2 || c1} 16px
      )`,
    };
  }

  if (garment.pattern === "colorblock") {
    // Hard-stop horizontal blocks for colorblock
    if (c3) {
      return {
        backgroundImage: `linear-gradient(
          to bottom,
          ${c1} 0%, ${c1} 33%,
          ${c2} 33%, ${c2} 66%,
          ${c3} 66%, ${c3} 100%
        )`,
      };
    }
    return {
      backgroundImage: `linear-gradient(
        to bottom,
        ${c1} 0%, ${c1} 50%,
        ${c2} 50%, ${c2} 100%
      )`,
    };
  }

  // For 'other' pattern, use a soft gradient across all colors
  if (c3) {
    return {
      background: `linear-gradient(160deg, ${c1} 0%, ${c2} 50%, ${c3} 100%)`,
    };
  }
  return {
    background: `linear-gradient(160deg, ${c1} 0%, ${c2 || c1} 100%)`,
  };
}

export default function GarmentCard({
  garment,
  onOpen,
}: {
  garment: Garment;
  onOpen: (g: Garment) => void;
}) {
  const light = isLightColor(garment.color);
  const glyphColor = light ? darken(garment.color, 0.55) : "#F7F6F2";
  const swatchStyle = renderSwatch(garment);

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
      <div
        className="relative flex aspect-[4/5] items-center justify-center"
        style={swatchStyle}
      >
        {garment.photo ? (
          <img
            src={garment.photo}
            alt={garment.name}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <GarmentGlyph
            category={garment.category}
            kind={garment.kind}
            className="h-[54%] w-[54%] drop-shadow-sm"
            strokeWidth={5.5}
          />
        )}
        <span
          className="absolute right-2 top-2 flex gap-[3px]"
          style={{ color: glyphColor }}
          title={`Warmth ${garment.warmth}/3`}
        >
          {[1, 2, 3].map((i) => (
            <span
              key={i}
              className="h-[5px] w-[5px] rounded-full"
              style={{
                background:
                  i <= garment.warmth
                    ? light
                      ? "rgba(0,0,0,0.55)"
                      : "rgba(255,255,255,0.9)"
                    : light
                      ? "rgba(0,0,0,0.18)"
                      : "rgba(255,255,255,0.28)",
              }}
            />
          ))}
        </span>
        {garment.photo && (
          <span className="absolute bottom-2 right-2 rounded-full bg-black/45 p-1.5 text-white backdrop-blur-sm">
            <GarmentGlyph
              category={garment.category}
              kind={garment.kind}
              className="h-4 w-4"
              strokeWidth={8}
            />
          </span>
        )}
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

import type { AccessoryKind, Category } from "../types";
import { cn } from "../lib/utils";

/** Chunky stroke-based garment pictograms used across the app. */
export function GarmentGlyph({
  category,
  kind,
  className,
  strokeWidth = 6.5,
}: {
  category: Category;
  kind?: AccessoryKind;
  className?: string;
  strokeWidth?: number;
}) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  return (
    <svg viewBox="0 0 96 96" className={cn("h-8 w-8", className)} aria-hidden>
      {category === "top" && (
        <path
          {...common}
          d="M34 35 L43 27 C45 31.5 51 31.5 53 27 L62 35 L70 46 L60.5 52 L57.5 45.5 L57.5 69 L38.5 69 L38.5 45.5 L35.5 52 L26 46 Z"
        />
      )}
      {category === "bottom" && (
        <path {...common} d="M37 26 H59 L63 70 H51.5 L48 46 L44.5 70 H33 Z" />
      )}
      {category === "dress" && (
        <path {...common} d="M41 26 H55 L58 40 L66 70 H30 L38 40 Z M41 26 L43 20 M55 26 L53 20" />
      )}
      {category === "outerwear" && (
        <>
          <path {...common} d="M47 28 L38 25 L29 35 L35 42 L35 70 L46 70 L46 33" />
          <path {...common} d="M49 28 L58 25 L67 35 L61 42 L61 70 L50 70 L50 33" />
        </>
      )}
      {category === "shoes" && (
        <>
          <path
            {...common}
            d="M26 63 L28 49 C28.5 45 32 43 36 44 L45 47 C52 49.5 59 52 65 54.5 C69 56 69.5 63 65 63 Z"
          />
          <path {...common} d="M26 63 H65" />
        </>
      )}
      {category === "accessory" && kind === "cap" && (
        <>
          <path {...common} d="M32 50 A16 16 0 0 1 64 50 Z" />
          <path {...common} d="M32 50 H72" />
          <path {...common} d="M48 34 V30" />
        </>
      )}
      {category === "accessory" && kind === "bag" && (
        <>
          <path {...common} d="M35 42 H61 L64 70 H32 Z" />
          <path {...common} d="M41 42 C41 31 55 31 55 42" />
        </>
      )}
      {category === "accessory" && (kind === "scarf" || !kind) && (
        <>
          <path {...common} d="M36 30 H60 V41 H36 Z" />
          <path {...common} d="M43 41 V64 M52 41 V58" />
          <path {...common} d="M39 64 H47" />
        </>
      )}
    </svg>
  );
}

/** Brand mark: hanger + spark. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("h-6 w-6", className)} aria-hidden>
      <path
        d="M12 7.6 C12 6.4 13.9 6.6 13.9 5 A1.9 1.9 0 1 0 10.1 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <path
        d="M12 7.6 L3.8 15.4 C2.9 16.3 3.5 17.8 4.7 17.8 H19.3 C20.5 17.8 21.1 16.3 20.2 15.4 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
      <path
        d="M19.6 1.6 L20.3 3.4 L22.1 4.1 L20.3 4.8 L19.6 6.6 L18.9 4.8 L17.1 4.1 L18.9 3.4 Z"
        fill="var(--acc)"
        stroke="none"
      />
    </svg>
  );
}

import { motion } from "framer-motion";
import type { Garment, Outfit } from "../types";
import { darken, isLightColor } from "../lib/utils";

/**
 * 2D layered mannequin: a matte abstract figure with flat garment
 * shapes composited on top (shoes → bottoms/dress → top → outerwear →
 * accessory). Deliberately stylized — no photoreal draping.
 */

const pop = (delay: number) => ({
  initial: { opacity: 0, y: 10, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  transition: { type: "spring", stiffness: 320, damping: 26, delay },
});

/** Generate SVG pattern ID for a garment */
function getPatternId(g: Garment): string {
  const pattern = g.pattern ?? "solid";
  return `pattern-${g.id}-${pattern}`;
}

/** Deterministic PRNG so a garment's print looks identical on every render. */
function seedFrom(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Per-color shares normalized to sum to 1 (falls back to even splits). */
function patternShares(garment: Garment, colors: string[]): number[] {
  const mix = garment.patternMix;
  if (mix && mix.length === colors.length && mix.every((v) => v > 0)) {
    const total = mix.reduce((a, b) => a + b, 0);
    if (total > 0) return mix.map((v) => v / total);
  }
  return colors.map(() => 1 / colors.length);
}

/** Render SVG pattern definitions for multi-color garments.
 *  Only the paint changes — every garment silhouette below is untouched.
 *  Band widths/heights follow the measured pixel shares, and prints use
 *  the garment's real secondary colors, so the avatar echoes the photo. */
function renderPatternDefs(garment: Garment) {
  const colors = garment.colors ?? [garment.color];
  const pattern = garment.pattern ?? "solid";
  
  if (colors.length <= 1 || pattern === "solid") {
    return null;
  }

  const [c1, c2, c3] = colors;
  const patternId = getPatternId(garment);

  if (pattern === "striped") {
    // Vertical bands with measured proportions (dominant color first).
    const shares = patternShares(garment, colors);
    const W = 36;
    let x = 0;
    const bands = shares.map((s, i) => {
      const w = i === shares.length - 1 ? W - x : Math.max(2, Math.round(W * s));
      const rect = <rect key={i} x={x} y="0" width={w} height={W} fill={colors[i]} />;
      x += w;
      return rect;
    });
    return (
      <pattern id={patternId} x="0" y="0" width={W} height={W} patternUnits="userSpaceOnUse">
        {bands}
      </pattern>
    );
  }

  if (pattern === "colorblock") {
    // Horizontal bands with measured proportions.
    const shares = patternShares(garment, colors);
    const H = 48;
    let y = 0;
    const bands = shares.map((s, i) => {
      const h = i === shares.length - 1 ? H - y : Math.max(3, Math.round(H * s));
      const rect = <rect key={i} x="0" y={y} width="12" height={h} fill={colors[i]} />;
      y += h;
      return rect;
    });
    return (
      <pattern id={patternId} x="0" y="0" width="12" height={H} patternUnits="userSpaceOnUse">
        {bands}
      </pattern>
    );
  }

  // "other" (plaid / floral / graphic / dots): dominant base with a
  // deterministic scatter of the real secondary colors — reads as a busy
  // print instead of a solid, without pretending to know the print type.
  const rng = mulberry(seedFrom(garment.id));
  const T = 110;
  const dots = Array.from({ length: 14 }, (_, i) => {
    const fill = i % 3 === 2 && c3 ? c3 : c2 || c1;
    return (
      <circle
        key={`d${i}`}
        cx={6 + rng() * (T - 12)}
        cy={6 + rng() * (T - 12)}
        r={2.4 + rng() * 2.2}
        fill={fill}
        opacity={0.9}
      />
    );
  });
  const dashes = Array.from({ length: 5 }, (_, i) => {
    const fill = i % 2 === 0 ? c2 || c1 : c3 || c2 || c1;
    return (
      <rect
        key={`h${i}`}
        x={6 + rng() * (T - 18)}
        y={6 + rng() * (T - 12)}
        width={9 + rng() * 7}
        height={2.6}
        rx={1.3}
        fill={fill}
        opacity={0.85}
        transform={`rotate(${(rng() * 60 - 30).toFixed(1)} ${T / 2} ${T / 2})`}
      />
    );
  });
  return (
    <pattern id={patternId} x="0" y="0" width={T} height={T} patternUnits="userSpaceOnUse">
      <rect x="0" y="0" width={T} height={T} fill={c1} />
      {dots}
      {dashes}
    </pattern>
  );
}

/** Get the fill value for a garment (pattern URL or solid color) */
function getGarmentFill(g: Garment): string {
  const colors = g.colors ?? [g.color];
  const pattern = g.pattern ?? "solid";
  
  if (colors.length > 1 && pattern !== "solid") {
    return `url(#${getPatternId(g)})`;
  }
  return g.color;
}

function Sleeves({ g, long, outer }: { g: Garment; long: boolean; outer?: boolean }) {
  const h = long ? 122 : 54;
  const w = outer ? 26 : 23;
  const x = outer ? 58 : 63;
  const fill = getGarmentFill(g);
  return (
    <>
      <rect x={x} y={95} width={w} height={h} rx={w / 2} fill={fill} />
      <rect x={240 - x - w} y={95} width={w} height={h} rx={w / 2} fill={fill} />
    </>
  );
}

function TopLayer({ g, delay }: { g: Garment; delay: number }) {
  const shade = darken(g.color, 0.16);
  const long = g.warmth >= 2;
  const fill = getGarmentFill(g);
  return (
    <motion.g {...pop(delay)}>
      <Sleeves g={g} long={long} />
      <rect x="82" y="90" width="76" height="146" rx="26" fill={fill} />
      <rect x="82" y="226" width="76" height="10" rx="5" fill={shade} opacity="0.55" />
      <path
        d="M104 91 Q120 103 136 91"
        fill="none"
        stroke={shade}
        strokeWidth="4"
        strokeLinecap="round"
      />
    </motion.g>
  );
}

function BottomLayer({ g, delay }: { g: Garment; delay: number }) {
  const shade = darken(g.color, 0.18);
  const shorts = g.warmth === 1;
  const legH = shorts ? 78 : 152;
  const fill = getGarmentFill(g);
  return (
    <motion.g {...pop(delay)}>
      <rect x="91" y="224" width="58" height="46" rx="16" fill={fill} />
      <rect x="94" y="252" width="25" height={legH} rx="11" fill={fill} />
      <rect x="121" y="252" width="25" height={legH} rx="11" fill={fill} />
      <rect x="94" y={252 + legH - 9} width="25" height="9" rx="4" fill={shade} opacity="0.5" />
      <rect x="121" y={252 + legH - 9} width="25" height="9" rx="4" fill={shade} opacity="0.5" />
      <rect x="91" y="224" width="58" height="8" rx="4" fill={shade} opacity="0.6" />
    </motion.g>
  );
}

function DressLayer({ g, delay }: { g: Garment; delay: number }) {
  const shade = darken(g.color, 0.16);
  const fill = getGarmentFill(g);
  return (
    <motion.g {...pop(delay)}>
      <Sleeves g={g} long={g.warmth >= 2} />
      <path
        d="M94 90 H146 C151 90 155 94 154.5 99 L150 152 L166 288 C167.2 297 160 303 152 303 H88 C80 303 72.8 297 74 288 L90 152 L85.5 99 C85 94 89 90 94 90 Z"
        fill={fill}
      />
      <path d="M90 152 H150" stroke={shade} strokeWidth="3.5" opacity="0.5" strokeLinecap="round" />
      <path d="M80 294 H160" stroke={shade} strokeWidth="5" opacity="0.45" strokeLinecap="round" />
    </motion.g>
  );
}

function OuterLayer({ g, delay }: { g: Garment; delay: number }) {
  const shade = darken(g.color, 0.2);
  const fill = getGarmentFill(g);
  return (
    <motion.g {...pop(delay)}>
      <Sleeves g={g} long outer />
      <rect x="76" y="87" width="36" height="158" rx="15" fill={fill} />
      <rect x="128" y="87" width="36" height="158" rx="15" fill={fill} />
      <rect x="106" y="90" width="6" height="152" rx="3" fill={shade} opacity="0.55" />
      <rect x="128" y="90" width="6" height="152" rx="3" fill={shade} opacity="0.55" />
      <path d="M112 90 L97 95 L109 108 Z" fill={shade} />
      <path d="M128 90 L143 95 L131 108 Z" fill={shade} />
    </motion.g>
  );
}

function ShoesLayer({ g, delay }: { g: Garment; delay: number }) {
  const sole = darken(g.color, 0.3);
  const lace = isLightColor(g.color) ? darken(g.color, 0.25) : "rgba(255,255,255,0.4)";
  const fill = getGarmentFill(g);
  return (
    <motion.g {...pop(delay)}>
      <rect x="85" y="392" width="41" height="26" rx="12" fill={fill} />
      <rect x="114" y="392" width="41" height="26" rx="12" fill={fill} />
      <rect x="85" y="410" width="41" height="8" rx="4" fill={sole} />
      <rect x="114" y="410" width="41" height="8" rx="4" fill={sole} />
      <path d="M94 399 H112 M128 399 H146" stroke={lace} strokeWidth="3" strokeLinecap="round" />
    </motion.g>
  );
}

function AccessoryLayer({ g, delay }: { g: Garment; delay: number }) {
  const shade = darken(g.color, 0.2);
  const fill = getGarmentFill(g);
  if (g.kind === "cap") {
    return (
      <motion.g {...pop(delay)}>
        <path d="M95 48 A25 25 0 0 1 145 48 Z" fill={fill} />
        <rect x="138" y="43" width="30" height="9" rx="4.5" fill={fill} />
        <rect x="138" y="48" width="30" height="4" rx="2" fill={shade} opacity="0.5" />
        <circle cx="120" cy="24" r="4" fill={shade} />
      </motion.g>
    );
  }
  if (g.kind === "bag") {
    return (
      <motion.g {...pop(delay)}>
        <path
          d="M160 102 L176 206"
          stroke={fill}
          strokeWidth="7"
          strokeLinecap="round"
        />
        <rect x="160" y="202" width="38" height="44" rx="11" fill={fill} />
        <rect x="160" y="202" width="38" height="14" rx="7" fill={shade} opacity="0.6" />
      </motion.g>
    );
  }
  // default: scarf
  return (
    <motion.g {...pop(delay)}>
      <rect x="95" y="76" width="50" height="19" rx="9.5" fill={fill} />
      <rect x="105" y="90" width="21" height="52" rx="10" fill={fill} />
      <rect x="105" y="132" width="21" height="10" rx="5" fill={shade} opacity="0.55" />
      <rect x="95" y="86" width="50" height="6" rx="3" fill={shade} opacity="0.4" />
    </motion.g>
  );
}

export default function Avatar({
  outfit,
  className,
  animateKey,
}: {
  outfit: Outfit;
  className?: string;
  /** change to retrigger the layer pop-in animation */
  animateKey?: string | number;
}) {
  // Collect all garments that need pattern definitions
  const garmentsWithPatterns = [
    outfit.top,
    outfit.bottom,
    outfit.dress,
    outfit.outer,
    outfit.shoes,
    outfit.accessory,
  ].filter((g): g is Garment => !!(g && (g.colors?.length ?? 1) > 1 && (g.pattern ?? "solid") !== "solid"));

  return (
    <svg viewBox="0 0 240 440" className={className} aria-hidden>
      {/* Define patterns for multi-color garments */}
      <defs>
        {garmentsWithPatterns.map((g) => (
          <g key={getPatternId(g)}>{renderPatternDefs(g)}</g>
        ))}
      </defs>
      <g key={animateKey ?? "static"}>
        {/* ground shadow */}
        <ellipse cx="120" cy="424" rx="58" ry="9" fill="#000" opacity="0.16" />

        {/* mannequin */}
        <g fill="var(--mannequin)">
          <circle cx="120" cy="50" r="24" />
          <rect x="112" y="68" width="16" height="26" rx="7" />
          <rect x="66" y="100" width="16" height="116" rx="8" />
          <rect x="158" y="100" width="16" height="116" rx="8" />
          <circle cx="74" cy="222" r="8" />
          <circle cx="166" cy="222" r="8" />
          <rect x="86" y="92" width="68" height="140" rx="26" />
          <rect x="93" y="226" width="54" height="40" rx="16" />
          <rect x="96" y="252" width="21" height="152" rx="10" />
          <rect x="123" y="252" width="21" height="152" rx="10" />
        </g>
        {/* subtle right-side shading */}
        <g fill="var(--mannequin-shade)" opacity="0.6">
          <path d="M120 26 A24 24 0 0 1 120 74 Z" />
          <rect x="140" y="96" width="14" height="132" rx="7" />
          <rect x="134" y="254" width="10" height="148" rx="5" />
        </g>

        {outfit.shoes && <ShoesLayer g={outfit.shoes} delay={0} />}
        {outfit.bottom && !outfit.dress && <BottomLayer g={outfit.bottom} delay={0.06} />}
        {outfit.dress ? (
          <DressLayer g={outfit.dress} delay={0.12} />
        ) : (
          outfit.top && <TopLayer g={outfit.top} delay={0.12} />
        )}
        {outfit.outer && <OuterLayer g={outfit.outer} delay={0.18} />}
        {outfit.accessory && <AccessoryLayer g={outfit.accessory} delay={0.24} />}
      </g>
    </svg>
  );
}

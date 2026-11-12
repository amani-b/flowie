import type { Garment } from "../types";

/**
 * Flowie studio renderer — procedural e-commerce product shots.
 *
 * Every garment in the app is displayed through its *studio rendering*: the
 * garment isolated and centered on a clean warm-gray studio sweep with a soft
 * floor shadow, even catalog lighting and fabric shading — the look of an
 * online store's product grid. The rendering is derived from the garment's
 * own fields (category, name keywords, exact colors, pattern), so it can
 * never drift to the wrong color, sprout a mannequin, or show a person.
 *
 * Why procedural (verified Sept 2026, see commit history):
 * - Text-to-image (Pollinations, keyless) was tried and rejected after
 *   looking at real output: fashion prompts persistently leak people /
 *   mannequins despite "no person" negatives, colors drift, and rapid
 *   requests hit HTTP 429 — unusable as a per-garment pipeline.
 * - This renderer is zero-cost (no APIs, keys, quotas, or downloads),
 *   deterministic, offline-capable, and infallible at runtime.
 *
 * Caching: `renderingFor(g)` returns an SVG data URL memoized on the
 * garment's identity fields, and callers store it on `garment.rendering`
 * once — screens only ever load the cached string, never re-render.
 */

const W = 768;
const H = 1024;

export type RenderStatus = "pending" | "ready" | "failed";

/* ------------------------------ color ------------------------------ */

function hx(h: string): [number, number, number] {
  const s = h.replace("#", "");
  return [
    parseInt(s.slice(0, 2), 16),
    parseInt(s.slice(2, 4), 16),
    parseInt(s.slice(4, 6), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** amt -1..1: negative darkens toward black, positive lightens toward white. */
export function shade(hex: string, amt: number): string {
  let rgb: [number, number, number];
  try {
    rgb = hx(hex);
  } catch {
    return hex;
  }
  const t = amt < 0 ? 0 : 255;
  const p = Math.abs(amt);
  return toHex(
    rgb[0] + (t - rgb[0]) * p,
    rgb[1] + (t - rgb[1]) * p,
    rgb[2] + (t - rgb[2]) * p
  );
}

function lum(hex: string): number {
  try {
    const [r, g, b] = hx(hex);
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  } catch {
    return 0.5;
  }
}

const edgeFor = (color: string, darkLift = 0.4, lightCut = -0.3) =>
  shade(color, lum(color) < 0.35 ? darkLift : lightCut);

/* ------------------------------ scene ------------------------------ */

function defs(uid: string): string {
  return `<defs>
    <linearGradient id="bg-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#F4F1EB"/><stop offset="0.62" stop-color="#ECE7DD"/><stop offset="1" stop-color="#DCD5C7"/>
    </linearGradient>
    <radialGradient id="glow-${uid}" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.85"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.25"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="cloth-${uid}" x1="0" y1="0" x2="1" y2="0.35">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.34"/><stop offset="0.38" stop-color="#FFFFFF" stop-opacity="0.06"/>
      <stop offset="0.62" stop-color="#000000" stop-opacity="0.04"/><stop offset="1" stop-color="#000000" stop-opacity="0.30"/>
    </linearGradient>
    <linearGradient id="clothv-${uid}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.20"/><stop offset="0.5" stop-color="#FFFFFF" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.18"/>
    </linearGradient>
    <filter id="soft-${uid}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="16"/></filter>
    <filter id="soft2-${uid}" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3"/></filter>
  </defs>`;
}

function clothWash(uid: string, clipId: string, inner: string): string {
  return `<g clip-path="url(#${clipId})">${inner}
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#cloth-${uid})"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="url(#clothv-${uid})"/></g>`;
}

/* ----------------------------- garments ---------------------------- */

function tee(color: string, uid: string, boxy = false, clip?: string): string {
  const edge = edgeFor(color);
  const rib = shade(color, -0.32);
  const hemY = boxy ? 640 : 668;
  const halfW = boxy ? 128 : 112;
  const cx = 384;
  const topY = 190;
  const clipId = clip ?? `c-${uid}`;
  const body = `M${cx - 52},${topY} L${cx - 96},${topY + 16} L${cx - halfW - 78},${topY + 66} L${cx - halfW - 44},${topY + 128} L${cx - halfW},${topY + 96} L${cx - halfW},${hemY} Q${cx - halfW},${hemY + 20} ${cx - halfW + 20},${hemY + 20} L${cx + halfW - 20},${hemY + 20} Q${cx + halfW},${hemY + 20} ${cx + halfW},${hemY} L${cx + halfW},${topY + 96} L${cx + halfW + 44},${topY + 128} L${cx + halfW + 78},${topY + 66} L${cx + 96},${topY + 16} L${cx + 52},${topY} Q${cx},${topY + 30} ${cx - 52},${topY} Z`;
  return `<clipPath id="${clipId}"><path d="${body}"/></clipPath>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, clipId, `
    <path d="M${cx - 70},${topY + 130} q8,140 -4,250 M${cx + 70},${topY + 130} q-8,140 4,250" fill="none" stroke="${shade(color, -0.4)}" stroke-opacity="0.26" stroke-width="6" filter="url(#soft2-${uid})"/>
    <path d="M${cx - 60},${hemY - 60} q60,24 120,0" fill="none" stroke="${shade(color, -0.35)}" stroke-opacity="0.2" stroke-width="10" filter="url(#soft2-${uid})"/>
    <path d="M${cx - halfW},${topY + 96} L${cx - halfW - 44},${topY + 128} M${cx + halfW},${topY + 96} L${cx + halfW + 44},${topY + 128}" stroke="${shade(color, -0.35)}" stroke-opacity="0.4" stroke-width="4"/>
    <path d="M${cx - halfW},${hemY + 4} L${cx + halfW},${hemY + 4}" stroke="${shade(color, -0.3)}" stroke-opacity="0.5" stroke-width="5"/>
  `)}
  <path d="M${cx - 52},${topY} Q${cx},${topY + 30} ${cx + 52},${topY} L${cx + 44},${topY + 16} Q${cx},${topY + 42} ${cx - 44},${topY + 16} Z" fill="${rib}"/>
  <path d="M${cx - 52},${topY} Q${cx},${topY + 30} ${cx + 52},${topY}" fill="none" stroke="${edge}" stroke-width="3"/>`;
}

function graphicTee(color: string, uid: string): string {
  const print = `<g clip-path="url(#c-${uid})" opacity="0.92"><circle cx="384" cy="400" r="52" fill="#EDE6D3"/>
    <path d="M310,470 L458,470 M322,492 L446,492 M340,514 L428,514" stroke="#EDE6D3" stroke-width="10" stroke-linecap="round"/>
    <circle cx="384" cy="400" r="52" fill="none" stroke="${shade(color, -0.4)}" stroke-width="3" opacity="0.5"/></g>`;
  return tee(color, uid, true) + print;
}

function oxford(color: string, uid: string): string {
  const edge = edgeFor(color);
  const cx = 384;
  const topY = 190;
  const hemY = 700;
  const halfW = 108;
  const cuffY = hemY - 60;
  const body = `M${cx - 50},${topY} L${cx - 94},${topY + 16} L${cx - halfW - 70},${topY + 70} L${cx - halfW - 44},${cuffY} L${cx - halfW},${cuffY + 8} L${cx - halfW + 6},${topY + 140} L${cx - halfW + 2},${hemY} Q${cx - halfW + 2},${hemY + 18} ${cx - halfW + 22},${hemY + 18} L${cx + halfW - 22},${hemY + 18} Q${cx + halfW - 2},${hemY + 18} ${cx + halfW - 2},${hemY} L${cx + halfW - 6},${topY + 140} L${cx + halfW},${cuffY + 8} L${cx + halfW + 44},${cuffY} L${cx + halfW + 70},${topY + 70} L${cx + 94},${topY + 16} L${cx + 50},${topY} Q${cx},${topY + 24} ${cx - 50},${topY} Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M${cx - 66},${topY + 140} q8,150 -4,260 M${cx + 66},${topY + 140} q-8,150 4,260" fill="none" stroke="${shade(color, -0.4)}" stroke-opacity="0.26" stroke-width="6" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M${cx - 50},${topY} L${cx - 78},${topY + 44} L${cx - 40},${topY + 62} L${cx - 14},${topY + 26} Z" fill="${shade(color, -0.12)}" stroke="${edge}" stroke-width="2.5"/>
  <path d="M${cx + 50},${topY} L${cx + 78},${topY + 44} L${cx + 40},${topY + 62} L${cx + 14},${topY + 26} Z" fill="${shade(color, -0.12)}" stroke="${edge}" stroke-width="2.5"/>
  <rect x="${cx - 13}" y="${topY + 26}" width="26" height="${hemY - topY - 44}" fill="${shade(color, -0.08)}" stroke="${edge}" stroke-width="2"/>
  ${[0, 1, 2, 3].map((i) => `<circle cx="${cx}" cy="${topY + 105 + i * 120}" r="8" fill="${shade(color, 0.55)}" stroke="${edge}" stroke-width="2.5"/>`).join("")}
  <path d="M${cx - halfW + 34},${topY + 120} h64 v84 h-64 Z" fill="${shade(color, -0.1)}" stroke="${edge}" stroke-width="2.5"/>
  <rect x="${cx - halfW - 50}" y="${cuffY - 6}" width="50" height="42" fill="${shade(color, -0.14)}" stroke="${edge}" stroke-width="2.5"/>
  <rect x="${cx + halfW}" y="${cuffY - 6}" width="50" height="42" fill="${shade(color, -0.14)}" stroke="${edge}" stroke-width="2.5"/>`;
}

function crewneck(color: string, uid: string): string {
  const edge = edgeFor(color);
  const rib = shade(color, -0.3);
  const cx = 384;
  const topY = 196;
  const hemY = 690;
  const body = `M${cx - 54},${topY} L${cx - 100},${topY + 18} L${cx - 148},${topY + 60} L${cx - 176},${hemY - 60} L${cx - 132},${hemY - 44} L${cx - 112},${topY + 130} L${cx - 112},${hemY} Q${cx - 112},${hemY + 20} ${cx - 92},${hemY + 20} L${cx + 92},${hemY + 20} Q${cx + 112},${hemY + 20} ${cx + 112},${hemY} L${cx + 112},${topY + 130} L${cx + 132},${hemY - 44} L${cx + 176},${hemY - 60} L${cx + 148},${topY + 60} L${cx + 100},${topY + 18} L${cx + 54},${topY} Q${cx},${topY + 32} ${cx - 54},${topY} Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M${cx - 70},${topY + 150} q10,150 -2,260 M${cx + 70},${topY + 150} q-10,150 2,260" fill="none" stroke="${shade(color, -0.4)}" stroke-opacity="0.26" stroke-width="6" filter="url(#soft2-${uid})"/>
    <path d="M${cx - 140},${topY + 200} q14,120 6,220 M${cx + 140},${topY + 200} q-14,120 -6,220" fill="none" stroke="${shade(color, -0.35)}" stroke-opacity="0.3" stroke-width="5" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M${cx - 54},${topY} Q${cx},${topY + 32} ${cx + 54},${topY} L${cx + 46},${topY + 18} Q${cx},${topY + 48} ${cx - 46},${topY + 18} Z" fill="${rib}"/>
  <rect x="${cx - 112}" y="${hemY - 6}" width="224" height="26" fill="${rib}" stroke="${edge}" stroke-width="2.5"/>
  <rect x="${cx - 176}" y="${hemY - 84}" width="44" height="40" fill="${rib}" stroke="${edge}" stroke-width="2.5"/>
  <rect x="${cx + 132}" y="${hemY - 84}" width="44" height="40" fill="${rib}" stroke="${edge}" stroke-width="2.5"/>`;
}

function trousers(color: string, uid: string): string {
  const edge = edgeFor(color);
  const body = `M284,220 L484,220 L500,300 L496,780 Q496,800 476,800 L410,800 Q392,800 390,782 L384,480 L376,782 Q374,800 356,800 L290,800 Q270,800 270,780 L266,300 Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <rect x="280" y="196" width="208" height="40" rx="6" fill="${shade(color, -0.15)}" stroke="${edge}" stroke-width="3"/>
  <rect x="372" y="188" width="24" height="56" rx="5" fill="${shade(color, -0.28)}" stroke="${edge}" stroke-width="2"/>
  <circle cx="384" cy="222" r="7" fill="${shade(color, 0.5)}" stroke="${edge}" stroke-width="2"/>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M330,320 L326,740 M384,320 L384,470 M438,320 L442,740" stroke="${shade(color, -0.38)}" stroke-opacity="0.4" stroke-width="5"/>
    <path d="M352,320 L350,720 M416,320 L418,720" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="8" filter="url(#soft2-${uid})"/>
    <path d="M300,560 q30,10 60,0 M408,600 q30,10 60,0" fill="none" stroke="${shade(color, -0.35)}" stroke-opacity="0.25" stroke-width="6" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M270,772 L356,772 M390,772 L496,772" stroke="${shade(color, -0.3)}" stroke-opacity="0.5" stroke-width="4"/>`;
}

function jeans(color: string, uid: string): string {
  const edge = edgeFor(color, 0.45);
  const stitch = "#C8873A";
  const body = `M284,220 L484,220 L502,310 L496,786 Q496,806 476,806 L408,806 Q390,806 388,788 L384,480 L380,788 Q378,806 360,806 L292,806 Q272,806 272,786 L266,310 Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <rect x="280" y="196" width="208" height="40" rx="6" fill="${shade(color, -0.15)}" stroke="${edge}" stroke-width="3"/>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M384,300 L384,470" stroke="${shade(color, -0.4)}" stroke-opacity="0.5" stroke-width="6"/>
    <path d="M322,340 L318,720 M446,340 L450,720" fill="none" stroke="${shade(color, -0.35)}" stroke-opacity="0.3" stroke-width="6" filter="url(#soft2-${uid})"/>
    <path d="M300,540 q40,14 80,4 M388,580 q40,14 80,4" fill="none" stroke="#FFFFFF" stroke-opacity="0.14" stroke-width="9" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M300,250 h56 v44 h-56 Z M412,250 h56 v44 h-56 Z" fill="${shade(color, -0.12)}" stroke="${stitch}" stroke-width="2.5" stroke-dasharray="6 4"/>
  <path d="M296,236 L472,236" stroke="${stitch}" stroke-width="3" stroke-dasharray="6 4"/>
  <circle cx="384" cy="222" r="8" fill="#B9B0A0" stroke="${edge}" stroke-width="2.5"/>
  <path d="M270,780 L362,780 M392,780 L496,780" stroke="${stitch}" stroke-width="3" stroke-dasharray="6 4"/>`;
}

function cargo(color: string, uid: string): string {
  const edge = edgeFor(color);
  const body = `M280,220 L488,220 L504,320 L500,740 L502,786 Q502,806 482,806 L414,806 Q396,806 394,788 L384,470 L374,788 Q372,806 354,806 L286,806 Q266,806 266,786 L268,740 L264,320 Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <rect x="276" y="196" width="216" height="40" rx="6" fill="${shade(color, -0.15)}" stroke="${edge}" stroke-width="3"/>
  <path d="M368,188 h32 v52 h-32 Z" fill="${shade(color, -0.28)}" stroke="${edge}" stroke-width="2"/>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M326,330 L322,700 M442,330 L446,700" stroke="${shade(color, -0.38)}" stroke-opacity="0.35" stroke-width="5"/>
  `)}
  <g><rect x="272" y="430" width="76" height="110" rx="6" fill="${shade(color, -0.1)}" stroke="${edge}" stroke-width="2.5"/>
  <rect x="272" y="430" width="76" height="30" rx="6" fill="${shade(color, -0.2)}" stroke="${edge}" stroke-width="2.5"/>
  <rect x="420" y="430" width="76" height="110" rx="6" fill="${shade(color, -0.1)}" stroke="${edge}" stroke-width="2.5"/>
  <rect x="420" y="430" width="76" height="30" rx="6" fill="${shade(color, -0.2)}" stroke="${edge}" stroke-width="2.5"/></g>
  <rect x="266" y="770" width="100" height="36" fill="${shade(color, -0.2)}" stroke="${edge}" stroke-width="2.5"/>
  <rect x="402" y="770" width="100" height="36" fill="${shade(color, -0.2)}" stroke="${edge}" stroke-width="2.5"/>`;
}

function shorts(color: string, uid: string): string {
  const edge = edgeFor(color);
  const body = `M286,220 L482,220 L510,300 L502,560 Q502,582 480,582 L420,582 Q400,582 398,562 L384,430 L370,562 Q368,582 348,582 L288,582 Q266,582 266,560 L258,300 Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <rect x="282" y="196" width="204" height="40" rx="6" fill="${shade(color, -0.15)}" stroke="${edge}" stroke-width="3"/>
  <path d="M372,188 h24 v52 h-24 Z" fill="${shade(color, -0.28)}" stroke="${edge}" stroke-width="2"/>
  <circle cx="384" cy="222" r="7" fill="${shade(color, 0.5)}" stroke="${edge}" stroke-width="2"/>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M330,320 L328,520 M438,320 L440,520" stroke="${shade(color, -0.38)}" stroke-opacity="0.35" stroke-width="5"/>
    <path d="M384,320 L384,430" stroke="${shade(color, -0.4)}" stroke-opacity="0.5" stroke-width="6"/>
  `)}
  <path d="M266,548 L348,548 M420,548 L502,548" stroke="${shade(color, -0.3)}" stroke-opacity="0.5" stroke-width="4"/>`;
}

function slipDress(color: string, uid: string): string {
  const edge = edgeFor(color, 0.45);
  const cx = 384;
  const body = `M${cx - 70},250 L${cx + 70},250 L${cx + 96},420 L${cx + 130},760 Q${cx + 132},786 ${cx + 104},786 L${cx - 104},786 Q${cx - 132},786 ${cx - 130},760 L${cx - 96},420 Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <path d="M${cx - 70},250 L${cx - 62},170 M${cx + 70},250 L${cx + 62},170" stroke="${shade(color, -0.25)}" stroke-width="10" stroke-linecap="round"/>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M${cx - 40},300 Q${cx - 60},500 ${cx - 80},740 M${cx + 10},300 Q${cx},520 ${cx - 6},750 M${cx + 60},300 Q${cx + 80},500 ${cx + 70},740" fill="none" stroke="${shade(color, -0.4)}" stroke-opacity="0.3" stroke-width="6" filter="url(#soft2-${uid})"/>
    <path d="M${cx - 60},420 Q${cx},460 ${cx + 70},420" fill="none" stroke="#FFFFFF" stroke-opacity="0.2" stroke-width="14" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M${cx - 70},250 Q${cx},278 ${cx + 70},250" fill="none" stroke="${shade(color, -0.3)}" stroke-width="3"/>
  <path d="M${cx - 104},786 L${cx + 104},786" stroke="${shade(color, -0.3)}" stroke-opacity="0.5" stroke-width="4"/>`;
}

function overcoat(color: string, uid: string): string {
  const edge = edgeFor(color, 0.5);
  const cx = 384;
  const topY = 170;
  const hemY = 800;
  const halfW = 140;
  const body = `M${cx - 60},${topY} L${cx - 110},${topY + 20} L${cx - halfW - 40},${topY + 90} L${cx - halfW - 8},${hemY} Q${cx - halfW - 8},${hemY + 16} ${cx - halfW + 8},${hemY + 16} L${cx + halfW - 8},${hemY + 16} Q${cx + halfW + 8},${hemY + 16} ${cx + halfW + 8},${hemY} L${cx + halfW + 40},${topY + 90} L${cx + 110},${topY + 20} L${cx + 60},${topY} Q${cx},${topY + 26} ${cx - 60},${topY} Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M${cx - 90},${topY + 200} q10,220 -4,400 M${cx + 90},${topY + 200} q-10,220 4,400" fill="none" stroke="#000000" stroke-opacity="0.3" stroke-width="7" filter="url(#soft2-${uid})"/>
    <path d="M${cx - 150},${topY + 250} q12,180 4,330 M${cx + 150},${topY + 250} q-12,180 -4,330" fill="none" stroke="#000000" stroke-opacity="0.25" stroke-width="6" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M${cx - 60},${topY} L${cx - 96},${topY + 88} L${cx - 40},${topY + 108} L${cx - 8},${topY + 30} Z" fill="${shade(color, 0.14)}" stroke="${edge}" stroke-width="2.5"/>
  <path d="M${cx + 60},${topY} L${cx + 96},${topY + 88} L${cx + 40},${topY + 108} L${cx + 8},${topY + 30} Z" fill="${shade(color, 0.14)}" stroke="${edge}" stroke-width="2.5"/>
  <path d="M${cx - 8},${topY + 30} L${cx - 8},${hemY} M${cx + 8},${topY + 30} L${cx + 8},${hemY}" stroke="${edge}" stroke-width="2.5" opacity="0.7"/>
  ${[0, 1, 2].map((i) => `<circle cx="${cx - 26}" cy="${340 + i * 120}" r="10" fill="#1B1D20" stroke="${shade(color, 0.4)}" stroke-width="2"/>`).join("")}
  <path d="M${cx - halfW + 26},${topY + 90} L${cx - halfW + 44},${hemY - 40} M${cx + halfW - 26},${topY + 90} L${cx + halfW - 44},${hemY - 40}" stroke="${edge}" stroke-width="2.5" opacity="0.8"/>
  <path d="M${cx - halfW - 8},${hemY - 120} L${cx - halfW - 4},${hemY} M${cx + halfW + 8},${hemY - 120} L${cx + halfW + 4},${hemY}" stroke="${edge}" stroke-width="2.5"/>`;
}

function trucker(color: string, uid: string): string {
  const edge = edgeFor(color, 0.45);
  const stitch = "#D8A24A";
  const cx = 384;
  const topY = 186;
  const hemY = 640;
  const halfW = 132;
  const body = `M${cx - 56},${topY} L${cx - 104},${topY + 18} L${cx - halfW - 34},${topY + 80} L${cx - halfW - 6},${hemY} Q${cx - halfW - 6},${hemY + 16} ${cx - halfW + 10},${hemY + 16} L${cx + halfW - 10},${hemY + 16} Q${cx + halfW + 6},${hemY + 16} ${cx + halfW + 6},${hemY} L${cx + halfW + 34},${topY + 80} L${cx + 104},${topY + 18} L${cx + 56},${topY} Q${cx},${topY + 24} ${cx - 56},${topY} Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M${cx - 80},${topY + 180} q8,160 -2,280 M${cx + 80},${topY + 180} q-8,160 2,280" fill="none" stroke="${shade(color, -0.4)}" stroke-opacity="0.3" stroke-width="6" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M${cx - 56},${topY} L${cx - 84},${topY + 52} L${cx - 44},${topY + 66} L${cx - 16},${topY + 24} Z" fill="${shade(color, -0.14)}" stroke="${edge}" stroke-width="2.5"/>
  <path d="M${cx + 56},${topY} L${cx + 84},${topY + 52} L${cx + 44},${topY + 66} L${cx + 16},${topY + 24} Z" fill="${shade(color, -0.14)}" stroke="${edge}" stroke-width="2.5"/>
  <path d="M${cx - 14},${topY + 30} L${cx - 14},${hemY} M${cx + 14},${topY + 30} L${cx + 14},${hemY}" stroke="${stitch}" stroke-width="2.5" stroke-dasharray="7 5"/>
  ${[0, 1, 2, 3].map((i) => `<circle cx="${cx}" cy="${topY + 130 + i * 110}" r="8" fill="#C9C2B2" stroke="${edge}" stroke-width="2.5"/>`).join("")}
  <g><path d="M${cx - 108},${topY + 220} h72 v26 h-72 Z M${cx - 108},${topY + 246} h72 v64 h-72 Z" fill="${shade(color, -0.1)}" stroke="${edge}" stroke-width="2.5"/>
  <path d="M${cx + 36},${topY + 220} h72 v26 h-72 Z M${cx + 36},${topY + 246} h72 v64 h-72 Z" fill="${shade(color, -0.1)}" stroke="${edge}" stroke-width="2.5"/>
  <circle cx="${cx - 72}" cy="${topY + 233}" r="6" fill="#C9C2B2" stroke="${edge}" stroke-width="2"/><circle cx="${cx + 72}" cy="${topY + 233}" r="6" fill="#C9C2B2" stroke="${edge}" stroke-width="2"/></g>
  <path d="M${cx - halfW + 22},${topY + 80} L${cx - halfW + 34},${hemY - 30} M${cx + halfW - 22},${topY + 80} L${cx + halfW - 34},${hemY - 30}" stroke="${edge}" stroke-width="2.5" opacity="0.8"/>`;
}

function sneakers(color: string, uid: string): string {
  const edge = edgeFor(color, 0.45);
  const sole = "#F5F3EC";
  const soleEdge = "#C9C2B2";
  const lace = shade(color, 0.6);
  const body = `M196,560 L196,500 Q196,442 248,424 L328,392 L370,380 L378,332 Q380,314 398,314 L420,314 Q436,314 438,332 L448,382 L520,410 Q590,432 614,486 L626,540 Q627,585 580,588 L252,596 Q196,596 196,560 Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <path d="M186,592 L634,592 L624,656 Q620,682 592,682 L244,682 Q214,682 206,654 Z" fill="${sole}" stroke="${soleEdge}" stroke-width="3"/>
  <path d="M206,654 L624,654" stroke="${soleEdge}" stroke-width="4"/>
  <path d="M214,620 L618,620" stroke="${soleEdge}" stroke-opacity="0.7" stroke-width="3"/>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M470,430 q90,20 130,70 M250,450 q40,60 30,120" fill="none" stroke="${shade(color, -0.4)}" stroke-opacity="0.25" stroke-width="6" filter="url(#soft2-${uid})"/>
    <path d="M240,500 q90,50 220,60" fill="none" stroke="#FFFFFF" stroke-opacity="0.22" stroke-width="12" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M372,376 L452,378 L436,470 L360,462 Z" fill="${shade(color, -0.16)}" stroke="${edge}" stroke-width="3"/>
  <path d="M366,392 L446,396 M362,416 L442,420 M358,440 L436,444" stroke="${lace}" stroke-width="10" stroke-linecap="round"/>
  <path d="M196,500 Q196,442 248,424 L260,420 L260,560 Q220,560 196,560 Z" fill="${shade(color, -0.22)}" stroke="${edge}" stroke-width="3"/>
  <path d="M520,410 Q590,432 614,486" fill="none" stroke="#FFFFFF" stroke-opacity="0.3" stroke-width="6"/>
  <path d="M618,470 L626,540" stroke="${shade(color, -0.25)}" stroke-opacity="0.5" stroke-width="4"/>`;
}

function chelsea(color: string, uid: string): string {
  const edge = edgeFor(color, 0.5);
  const body = `M300,220 L440,220 L440,420 Q440,500 470,540 L560,620 Q600,652 600,700 L600,710 L320,710 Q290,710 288,680 L286,560 Q284,480 300,420 Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <path d="M280,700 L612,700 L606,744 Q604,760 586,760 L306,760 Q284,760 282,738 Z" fill="#26262A" stroke="#101012" stroke-width="3"/>
  <path d="M560,700 L560,760 M300,700 L300,760" stroke="#101012" stroke-width="3" opacity="0.6"/>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M330,300 q-8,120 2,220 M410,300 q8,100 30,160" fill="none" stroke="#000000" stroke-opacity="0.35" stroke-width="7" filter="url(#soft2-${uid})"/>
    <path d="M470,560 q60,40 110,90" fill="none" stroke="#FFFFFF" stroke-opacity="0.16" stroke-width="12" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M300,260 L300,480 L344,520 L344,260 Z" fill="${shade(color, 0.3)}" stroke="${edge}" stroke-width="2.5"/>
  <path d="M312,260 L312,470 M328,260 L328,490" stroke="${edge}" stroke-width="2" opacity="0.6"/>
  <path d="M300,220 L440,220" stroke="${edge}" stroke-width="4"/>
  <path d="M286,560 Q340,600 380,610" fill="none" stroke="#000000" stroke-opacity="0.3" stroke-width="5" filter="url(#soft2-${uid})"/>
  <path d="M560,620 Q600,652 600,700" fill="none" stroke="#FFFFFF" stroke-opacity="0.18" stroke-width="6"/>`;
}

function cap(color: string, uid: string): string {
  const edge = edgeFor(color);
  const dome = `M264,470 Q264,300 384,300 Q504,300 504,470 L504,486 L264,486 Z`;
  const brim = `M340,480 L560,480 Q622,484 638,538 Q642,560 620,560 L340,560 Z`;
  return `<clipPath id="c-${uid}"><path d="${dome}"/><path d="${brim}"/></clipPath>
  <path d="${brim}" fill="${shade(color, -0.08)}" stroke="${edge}" stroke-width="3"/>
  <path d="${dome}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M324,340 Q310,410 312,470 M444,340 Q458,410 456,470" fill="none" stroke="${shade(color, -0.4)}" stroke-opacity="0.3" stroke-width="5" filter="url(#soft2-${uid})"/>
    <path d="M300,520 Q450,505 600,530" fill="none" stroke="#FFFFFF" stroke-opacity="0.2" stroke-width="10" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M384,300 L384,470" stroke="${shade(color, -0.3)}" stroke-width="3" opacity="0.6"/>
  <path d="M312,360 Q340,330 384,326 M456,360 Q428,330 384,326" fill="none" stroke="${shade(color, -0.3)}" stroke-width="2.5" opacity="0.6"/>
  <circle cx="384" cy="300" r="12" fill="${shade(color, -0.2)}" stroke="${edge}" stroke-width="2.5"/>
  <path d="M264,502 L620,502" stroke="${shade(color, -0.3)}" stroke-width="3" opacity="0.5"/>`;
}

function backpack(color: string, uid: string): string {
  const edge = edgeFor(color, 0.5);
  const body = `M264,720 Q258,420 300,340 Q340,270 384,270 Q428,270 468,340 Q510,420 504,720 Q504,752 472,752 L296,752 Q264,752 264,720 Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <path d="M352,272 Q352,230 384,230 Q416,230 416,272" fill="none" stroke="${shade(color, -0.3)}" stroke-width="12" stroke-linecap="round"/>
  <path d="M252,420 Q236,480 240,560 M516,420 Q532,480 528,560" fill="none" stroke="${shade(color, -0.3)}" stroke-width="14" stroke-linecap="round"/>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M310,420 q-6,140 0,260 M458,420 q6,140 0,260" fill="none" stroke="#000000" stroke-opacity="0.3" stroke-width="7" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M312,560 L312,700 Q312,716 328,716 L440,716 Q456,716 456,700 L456,560 Q456,544 440,544 L328,544 Q312,544 312,560 Z" fill="${shade(color, -0.1)}" stroke="${edge}" stroke-width="2.5"/>
  <path d="M312,584 L456,584" stroke="${edge}" stroke-width="2.5" opacity="0.7"/>
  <path d="M300,340 Q384,310 468,340" fill="none" stroke="${edge}" stroke-width="2.5" opacity="0.7"/>`;
}

function scarf(color: string, uid: string): string {
  const edge = edgeFor(color);
  const body = `M280,340 L488,340 L500,640 L496,700 Q496,716 480,716 L288,716 Q272,716 272,700 L268,640 Z`;
  return `<clipPath id="c-${uid}"><path d="${body}"/></clipPath>
  <path d="${body}" fill="${color}" stroke="${edge}" stroke-width="3"/>
  ${clothWash(uid, `c-${uid}`, `
    <path d="M330,360 L326,690 M384,360 L384,700 M438,360 L442,690" stroke="${shade(color, -0.38)}" stroke-opacity="0.35" stroke-width="6" filter="url(#soft2-${uid})"/>
    <path d="M356,360 L356,690 M412,360 L412,690" stroke="#FFFFFF" stroke-opacity="0.15" stroke-width="8" filter="url(#soft2-${uid})"/>
  `)}
  <path d="M280,340 L488,340" stroke="${edge}" stroke-width="3"/>
  ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<path d="M${292 + i * 26},716 L${292 + i * 26},752" stroke="${shade(color, -0.2)}" stroke-width="7" stroke-linecap="round"/>`).join("")}
  <path d="M300,470 L468,470" stroke="${shade(color, -0.3)}" stroke-width="4" opacity="0.4"/>`;
}

/* ------------------------- pattern overlays ------------------------ */

function patternOverlay(g: Garment, uid: string): string {
  if (g.pattern === "solid") return "";
  const clip = `c-${uid}`;
  const second = g.colors[1] ?? shade(g.color, 0.45);
  if (g.pattern === "striped") {
    let bands = "";
    for (let y = 140; y < H; y += 58) {
      bands += `<rect x="100" y="${y}" width="${W - 200}" height="17" fill="${second}"/>`;
    }
    return `<g clip-path="url(#${clip})" opacity="0.7">${bands}</g>`;
  }
  if (g.pattern === "colorblock") {
    return `<g clip-path="url(#${clip})"><rect x="0" y="560" width="${W}" height="${H - 560}" fill="${second}" opacity="0.9"/>
      <rect x="0" y="552" width="${W}" height="10" fill="${shade(g.color, -0.3)}" opacity="0.6"/></g>`;
  }
  // "other" — subtle all-over print
  let dots = "";
  for (let y = 200; y < H; y += 64) {
    for (let x = 200; x < W - 160; x += 64) {
      dots += `<circle cx="${x + ((y / 64) % 2) * 32}" cy="${y}" r="7" fill="${second}"/>`;
    }
  }
  return `<g clip-path="url(#${clip})" opacity="0.5">${dots}</g>`;
}

/* --------------------------- selection ---------------------------- */

type Maker = (color: string, uid: string) => string;

function pickMaker(g: Garment): { make: Maker; low: boolean } {
  const n = g.name.toLowerCase();
  if (g.category === "accessory") {
    if (g.kind === "cap" || /cap|hat|beanie/.test(n)) return { make: cap, low: false };
    if (g.kind === "bag" || /bag|backpack|tote/.test(n)) return { make: backpack, low: false };
    return { make: scarf, low: false };
  }
  if (g.category === "shoes") {
    if (/boot|chelsea/.test(n)) return { make: chelsea, low: true };
    return { make: sneakers, low: true };
  }
  if (g.category === "dress") return { make: slipDress, low: false };
  if (g.category === "outerwear") {
    if (/coat|overcoat|trench|parka|wool/.test(n)) return { make: overcoat, low: false };
    return { make: trucker, low: false };
  }
  if (g.category === "bottom") {
    if (/short/.test(n)) return { make: shorts, low: false };
    if (/jean|denim|selvedge/.test(n)) return { make: jeans, low: false };
    if (/cargo|tech|utility/.test(n)) return { make: cargo, low: false };
    return { make: trousers, low: false };
  }
  if (/oxford|shirt|button|flannel|blouse/.test(n)) return { make: oxford, low: false };
  if (/crew|sweater|knit|merino|jumper|sweatshirt|hoodie/.test(n))
    return { make: crewneck, low: false };
  if (/boxy|graphic|oversize|print/.test(n)) return { make: graphicTee, low: false };
  return { make: (c, u) => tee(c, u, false), low: false };
}

/* ----------------------------- public ----------------------------- */

/** Full 768×1024 studio-scene SVG for a garment. Pure function of its fields. */
export function studioSvg(g: Garment, uid?: string): string {
  const id = (uid ?? g.id).replace(/[^a-zA-Z0-9_-]/g, "");
  const color = g.color || "#9AA0A6";
  const { make, low } = pickMaker(g);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    defs(id) +
    `<rect width="${W}" height="${H}" fill="url(#bg-${id})"/><rect width="${W}" height="${H}" fill="url(#glow-${id})"/>` +
    `<ellipse cx="384" cy="${low ? 780 : 856}" rx="${low ? 210 : 165}" ry="26" fill="#3A3428" opacity="0.32" filter="url(#soft-${id})"/>` +
    `<g>${make(color, id)}${patternOverlay(g, id)}</g></svg>`;
}

/**
 * Defensive normalisation: persisted records from older versions (or a
 * corrupt snapshot) can reach the renderer missing `colors`/`name`/`id`.
 * A throw here used to happen at render time and erase the whole screen —
 * so sanitise first, never throw.
 */
function safeGarment(g: Garment): Garment {
  const isHex = (c: unknown): c is string =>
    typeof c === "string" && /^#[0-9A-F]{6}$/i.test(c);
  const raw = Array.isArray(g.colors) && g.colors.length > 0 ? g.colors : [];
  const valid = raw.filter(isHex);
  const fallback = isHex(g.color) ? g.color : "#6B7280";
  const colors = valid.length > 0 ? valid : [fallback];
  return {
    ...g,
    id: typeof g.id === "string" && g.id ? g.id : "g-unknown",
    name: typeof g.name === "string" && g.name ? g.name : "Untitled piece",
    color: colors[0],
    colors,
    pattern: g.pattern ?? "solid",
  };
}

function keyFor(g: Garment): string {
  const s = safeGarment(g);
  return [s.id, s.category, s.kind ?? "", s.name, s.color, s.colors.join(","), s.pattern].join("|");
}

const memo = new Map<string, { key: string; url: string }>();

/**
 * Cached studio-rendering data URL for a garment. The URL is stored on
 * `garment.rendering` once (see ensureRendering); this memo just avoids
 * re-encoding within a session.
 */
export function renderingFor(g: Garment): string {
  const s = safeGarment(g);
  const key = keyFor(s);
  const hit = memo.get(s.id);
  if (hit && hit.key === key) return hit.url;
  // studioSvg is pure string-building and shouldn't throw, but this runs
  // at render time across every tile — belt and braces so one bad record
  // can never blank a screen. Worst case: a neutral placeholder tile.
  try {
    const url = `data:image/svg+xml,${encodeURIComponent(studioSvg(s))}`;
    memo.set(s.id, { key, url });
    return url;
  } catch {
    // Static last resort (no garment-derived computation at all).
    return (
      "data:image/svg+xml," +
      encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">` +
          `<rect width="${W}" height="${H}" fill="#ECE7DD"/></svg>`
      )
    );
  }
}

/**
 * Generate-once: returns the cached rendering when the record already has
 * one for its current fields, otherwise generates, stamps
 * `rendering`/`renderStatus`, and returns it.
 */
export function ensureRendering<T extends Garment>(g: T): T {
  try {
    const fresh = renderingFor(g);
    if (g.rendering === fresh && g.renderStatus === "ready") return g;
    g.rendering = fresh;
    g.renderStatus = "ready";
    return g;
  } catch {
    // Frozen/sealed record (or anything exotic): return it untouched with
    // at least a valid rendering string rather than throwing into render.
    try {
      return { ...g, rendering: renderingFor(g), renderStatus: "ready" as const };
    } catch {
      return g;
    }
  }
}

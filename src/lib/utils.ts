import type { ColorFamily, Occasion, TempBucket, Units } from "../types";

/* ------------------------------ misc ------------------------------ */

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function uid(prefix = "id"): string {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rnd}`;
}

export const clamp = (n: number, min: number, max: number) =>
  Math.min(max, Math.max(min, n));

export const rand = (min: number, max: number) => min + Math.random() * (max - min);

export function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/* ----------------------------- colors ----------------------------- */

const DEFAULT_HEX = "#6B7280";
const HEX_REGEX = /^#?[0-9a-f]{3}$|^#?[0-9a-f]{6}$/i;

export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  // Defensive: fall back to default gray if hex is falsy or invalid
  if (!hex || !HEX_REGEX.test(hex)) {
    hex = DEFAULT_HEX;
  }
  const h = hex.replace("#", "");
  const full =
    h.length === 3 ? h.split("").map((c) => c + c).join("") : h.padEnd(6, "0");
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

export function isLightColor(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62;
}

/** Darken a hex color by a fraction (0..1). */
export function darken(hex: string, f: number): string {
  const { r, g, b } = hexToRgb(hex);
  const t = (v: number) =>
    Math.round(clamp(v * (1 - f), 0, 255))
      .toString(16)
      .padStart(2, "0");
  return `#${t(r)}${t(g)}${t(b)}`;
}

/* --------------------------- temperature -------------------------- */

export const BUCKET_META: Record<
  TempBucket,
  { label: string; range: string; targetWarmth: 1 | 2 | 3 }
> = {
  cold: { label: "Cold", range: "under 5°", targetWarmth: 3 },
  cool: { label: "Cool", range: "5–12°", targetWarmth: 2 },
  mild: { label: "Mild", range: "13–19°", targetWarmth: 2 },
  warm: { label: "Warm", range: "20–26°", targetWarmth: 1 },
  hot: { label: "Hot", range: "27°+", targetWarmth: 1 },
};

export function tempBucket(feelsC: number): TempBucket {
  if (feelsC < 5) return "cold";
  if (feelsC < 13) return "cool";
  if (feelsC < 20) return "mild";
  if (feelsC < 27) return "warm";
  return "hot";
}

export const cToF = (c: number) => (c * 9) / 5 + 32;

export function formatTemp(c: number, units: Units): string {
  const v = units === "C" ? c : cToF(c);
  return `${Math.round(v)}°`;
}

/* ----------------------------- occasion --------------------------- */

/** Onboarding "vibe" → default studio occasion. */
export const VIBE_TO_OCCASION: Record<"casual" | "smart" | "formal", Occasion> = {
  casual: "casual",
  smart: "work",
  formal: "party",
};

export function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || full;
}

export const OCCASION_META: Record<Occasion, { label: string; blurb: string }> = {
  casual: { label: "Casual", blurb: "Errands, coffee, zero stakes" },
  work: { label: "Work", blurb: "Meetings and desk hours" },
  date: { label: "Date", blurb: "A little intention goes far" },
  gym: { label: "Gym", blurb: "Sweat first, style second" },
  party: { label: "Party", blurb: "Low lights, high stakes" },
};

/* ------------------------- color swatches ------------------------- */

export const COLOR_SWATCHES: Array<{ hex: string; family: ColorFamily; name: string }> = [
  { hex: "#ECEAE4", family: "neutral", name: "Bone" },
  { hex: "#3B3F45", family: "neutral", name: "Graphite" },
  { hex: "#2A2D33", family: "neutral", name: "Ink" },
  { hex: "#9DBBD9", family: "cool", name: "Powder blue" },
  { hex: "#2E4057", family: "cool", name: "Navy" },
  { hex: "#3A4A63", family: "cool", name: "Indigo" },
  { hex: "#C08552", family: "earth", name: "Camel" },
  { hex: "#6B6B4A", family: "earth", name: "Olive" },
  { hex: "#5A3B2E", family: "earth", name: "Espresso" },
  { hex: "#C24D2C", family: "warm", name: "Rust" },
  { hex: "#7A2E3F", family: "warm", name: "Wine" },
  { hex: "#E1580E", family: "warm", name: "Signal orange" },
  { hex: "#2F6B4F", family: "accent", name: "Bottle green" },
  { hex: "#D64550", family: "accent", name: "Poppy" },
];

/* ------------------------------ dates ----------------------------- */

export function todayLabel(): string {
  return new Date()
    .toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })
    .toUpperCase();
}

export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d}d ago`;
}

/* ------------------------- image compression ---------------------- */

/**
 * Downscale + re-encode an image file on the client.
 * Resolves to a JPEG data-URL of at most ~maxBytes (default 1 MB).
 */
export function compressImage(
  file: File,
  maxSide = 1024,
  maxBytes = 1_000_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Canvas unavailable"));
        return;
      }
      let scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      let quality = 0.85;
      const step = () => {
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        // Flatten onto white first: JPEG has no alpha channel, and an
        // untouched canvas defaults transparent pixels to black. Without
        // this, a cutout garment photo (transparent PNG background) bakes
        // in a black backdrop that later throws off color/pattern detection.
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const out = canvas.toDataURL("image/jpeg", quality);
        const approxBytes = out.length * 0.75;
        if (approxBytes > maxBytes && (quality > 0.5 || scale > 0.35)) {
          if (quality > 0.5) quality -= 0.12;
          else scale *= 0.78;
          step();
        } else {
          resolve(out);
        }
      };
      step();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read that image"));
    };
    img.src = url;
  });
}

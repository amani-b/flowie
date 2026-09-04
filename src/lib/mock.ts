import type { AuthUser, Garment, Outfit, SavedLook } from "../types";

/**
 * Mock dataset (Phase 1). Powers the entire app in dev/demo mode:
 * a fake user, ~12 wardrobe items and 3 saved outfits. IDs are stable
 * so outfit snapshots resolve across reloads.
 */

export const DEMO_USER: AuthUser = {
  id: "demo-ava-0001",
  email: "ava@flowie.app",
  name: "Ava Fields",
  isDemo: true,
};

const t0 = Date.now() - 86_400_000 * 12;
const at = (days: number) => t0 + days * 86_400_000;

export const DEMO_WARDROBE: Garment[] = [
  // tops
  { id: "g-heavy-tee", name: "Heavyweight Tee", category: "top", color: "#ECEAE4", colors: ["#ECEAE4"], pattern: "solid", colorFamily: "neutral", warmth: 1, formality: 1, createdAt: at(0) },
  { id: "g-oxford", name: "Oxford Shirt", category: "top", color: "#9DBBD9", colors: ["#9DBBD9"], pattern: "solid", colorFamily: "cool", warmth: 2, formality: 3, createdAt: at(1) },
  { id: "g-merino-crew", name: "Merino Crewneck", category: "top", color: "#C08552", colors: ["#C08552"], pattern: "solid", colorFamily: "earth", warmth: 3, formality: 2, createdAt: at(2) },
  { id: "g-graphic-tee", name: "Boxy Graphic Tee", category: "top", color: "#2F6B4F", colors: ["#2F6B4F"], pattern: "solid", colorFamily: "accent", warmth: 1, formality: 1, createdAt: at(3) },
  // bottoms
  { id: "g-selvedge", name: "Selvedge Denim", category: "bottom", color: "#3A4A63", colors: ["#3A4A63"], pattern: "solid", colorFamily: "cool", warmth: 2, formality: 2, createdAt: at(4) },
  { id: "g-pleated", name: "Pleated Trousers", category: "bottom", color: "#3B3F45", colors: ["#3B3F45"], pattern: "solid", colorFamily: "neutral", warmth: 2, formality: 3, createdAt: at(5) },
  { id: "g-cargo", name: "Tech Cargo", category: "bottom", color: "#6B6B4A", colors: ["#6B6B4A"], pattern: "solid", colorFamily: "earth", warmth: 2, formality: 1, createdAt: at(6) },
  // dress
  { id: "g-slip-dress", name: "Bias Slip Dress", category: "dress", color: "#7A2E3F", colors: ["#7A2E3F"], pattern: "solid", colorFamily: "warm", warmth: 1, formality: 2, createdAt: at(7) },
  // outerwear
  { id: "g-overcoat", name: "Wool Overcoat", category: "outerwear", color: "#2A2D33", colors: ["#2A2D33"], pattern: "solid", colorFamily: "neutral", warmth: 3, formality: 3, createdAt: at(8) },
  { id: "g-trucker", name: "Denim Trucker", category: "outerwear", color: "#4C6285", colors: ["#4C6285"], pattern: "solid", colorFamily: "cool", warmth: 2, formality: 2, createdAt: at(9) },
  // shoes
  { id: "g-court", name: "Court Sneakers", category: "shoes", color: "#ECEAE4", colors: ["#ECEAE4"], pattern: "solid", colorFamily: "neutral", warmth: 1, formality: 1, createdAt: at(10) },
  { id: "g-chelsea", name: "Chelsea Boots", category: "shoes", color: "#5A3B2E", colors: ["#5A3B2E"], pattern: "solid", colorFamily: "earth", warmth: 2, formality: 3, createdAt: at(11) },
];

const byId = new Map(DEMO_WARDROBE.map((g) => [g.id, g]));
const g = (id: string): Garment => byId.get(id)!;

/** Three saved outfits for the demo user (maps to the outfits table). */
export const DEMO_OUTFITS: SavedLook[] = [
  {
    id: "look-studio-friday",
    name: "Studio Friday",
    occasion: "work",
    outfit: { top: g("g-oxford"), bottom: g("g-pleated"), shoes: g("g-court") },
    rationale:
      "Crisp oxford over pleated trousers — formal enough for the 10am, loose enough for the 6pm. Sneakers keep the commute honest.",
    engine: "heuristic",
    weatherTags: ["mild", "dry"],
    createdAt: Date.now() - 86_400_000 * 2,
  },
  {
    id: "look-golden-spritz",
    name: "Golden Hour Spritz",
    occasion: "date",
    outfit: { dress: g("g-slip-dress"), outer: g("g-trucker"), shoes: g("g-chelsea") },
    rationale:
      "The slip dress does the talking; the trucker keeps it from trying too hard. Chelsea boots for cobblestones and cold shoulders.",
    engine: "heuristic",
    weatherTags: ["cool", "dry"],
    createdAt: Date.now() - 86_400_000 * 5,
  },
  {
    id: "look-errand-loop",
    name: "Saturday Errand Loop",
    occasion: "casual",
    outfit: { top: g("g-heavy-tee"), bottom: g("g-selvedge"), shoes: g("g-court") },
    rationale:
      "White tee, raw denim, clean sneakers — the uniform that never owes anyone an explanation.",
    engine: "heuristic",
    weatherTags: ["warm", "dry"],
    createdAt: Date.now() - 86_400_000 * 8,
  },
];

/** Neutral snapshot outfit used by the onboarding avatar placeholder. */
export const PLACEHOLDER_OUTFIT: Outfit = {
  top: g("g-oxford"),
  bottom: g("g-selvedge"),
  shoes: g("g-court"),
};

export const CATEGORIES: Array<{ id: Garment["category"]; label: string }> = [
  { id: "top", label: "Tops" },
  { id: "bottom", label: "Bottoms" },
  { id: "dress", label: "Dresses" },
  { id: "outerwear", label: "Outerwear" },
  { id: "shoes", label: "Shoes" },
  { id: "accessory", label: "Extras" },
];

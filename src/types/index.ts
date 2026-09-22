/* ------------------------------------------------------------------ */
/*  Flowie — shared domain types                                         */
/* ------------------------------------------------------------------ */

export type ThemeMode = "light" | "dark";
export type Units = "C" | "F";
export type TabId = "home" | "closet" | "studio" | "looks" | "calendar";

export type Category =
  | "top"
  | "bottom"
  | "dress"
  | "outerwear"
  | "shoes"
  | "accessory";

export type ColorFamily = "neutral" | "warm" | "cool" | "earth" | "accent";

export type AccessoryKind = "scarf" | "cap" | "bag";

/** 1 = light/summer, 2 = mid, 3 = insulated/winter */
export type Warmth = 1 | 2 | 3;

/** 1 = casual, 2 = smart, 3 = formal */
export type Formality = 1 | 2 | 3;

export interface Garment {
  id: string;
  name: string;
  category: Category;
  color: string; // hex (primary/dominant color, same as colors[0])
  colors: string[]; // 1-3 hex values, ordered by visual prominence
  pattern: "solid" | "striped" | "colorblock" | "other";
  /** per-color pixel share, same order as `colors` — drives avatar proportions. Local-only, not synced. */
  patternMix?: number[];
  colorFamily: ColorFamily;
  warmth: Warmth;
  formality: Formality;
  kind?: AccessoryKind; // only for accessories
  photo?: string; // compressed data-URL (max ~1MB) — source only, never displayed as the finished look
  /**
   * Opt-in "studio_composite" version (JPEG data URL, 768×1024): the original
   * photo background-removed and composited onto the neutral studio backdrop
   * with a soft drop shadow (see services/studioComposite.ts). Built
   * automatically on-device for every upload carrying a photo; local-only,
   * not synced — like patternMix. `rendering` (SVG) stays the instant
   * fallback underneath and wins only until the composite is ready.
   */
  studioComposite?: string;
  /** studio_composite build state — independent of renderStatus (SVG). */
  studioCompositeStatus?: "pending" | "ready" | "failed";
  /**
   * Phase 4 img2img final (public URL in Supabase `wardrobe` bucket as
   * `<userId>/<garmentId>-studio.jpg`, mirrored from the
   * `studio_render_url` column). Built ONCE per garment at import time via
   * the enhance-garment Edge Function (Phase 1 composite → FLUX.1-schnell
   * Space, strength 0.3, 4 steps, seed 42) — never re-generated per view.
   * Display precedence in GarmentPhoto: studioRenderUrl > studioComposite
   * > SVG `rendering` fallback. Local-only until synced, like `photo`.
   */
  studioRenderUrl?: string;
  /** img2img final build state — independent of SVG + composite states. */
  studioRenderStatus?: "pending" | "ready" | "failed";
  /**
   * Photo-faithful AI flat-lay (Gemini 3.1 Flash Image, direct REST —
   * see services/studioFlatlay.ts). JPEG/PNG data URL built on explicit
   * opt-in or budgeted auto-run; COST-GATED (no free tier on image output)
   * so the free composite + SVG always carry the default experience.
   * Display precedence in GarmentPhoto: flatLay > studioRenderUrl >
   * studioComposite > SVG `rendering` fallback. Local-only, not synced.
   */
  studioFlatLay?: string;
  /** AI flat-lay build state — independent of SVG/composite/enhance states. */
  studioFlatLayStatus?: "pending" | "ready" | "failed";
  /**
   * Cached studio rendering (SVG data URL): the single display image for
   * this garment on every screen. Generated once via studioRender and stored
   * on the record — never recomputed per screen visit.
   */
  rendering?: string;
  /** ready = cached rendering loads; pending = still generating; failed = needs retry. */
  renderStatus?: "pending" | "ready" | "failed";
  createdAt: number;
  syncStatus?: "synced" | "pending" | "error";
}

export type Occasion = "casual" | "work" | "date" | "gym" | "party";

export type TempBucket = "cold" | "cool" | "mild" | "warm" | "hot";

export type WeatherIconKind =
  | "sun"
  | "partly"
  | "cloud"
  | "fog"
  | "rain"
  | "snow"
  | "storm";

export interface WeatherNow {
  tempC: number;
  feelsC: number;
  highC: number;
  lowC: number;
  code: number;
  label: string;
  icon: WeatherIconKind;
  humidity: number;
  windKph: number;
  isRain: boolean;
  bucket: TempBucket;
  source: "live" | "fallback";
  location: string;
}

export type LoadStatus = "idle" | "loading" | "ready" | "error";

export interface Outfit {
  top?: Garment;
  bottom?: Garment;
  dress?: Garment;
  outer?: Garment;
  shoes?: Garment;
  accessory?: Garment;
}

export type StyleEngine = "gemini" | "heuristic" | "manual";

export interface StyleResult {
  outfit: Outfit;
  rationale: string;
  engine: StyleEngine;
  score: number;
  occasion: Occasion;
  /** free-text request handling: was the text actually used? */
  usedPrompt?: boolean;
  /** one-line note about how the request affected the result (or why not) */
  promptNote?: string;
}

export interface SavedLook {
  id: string;
  name: string;
  occasion: Occasion;
  outfit: Outfit; // full garment snapshots so looks survive closet edits
  rationale: string;
  engine: StyleEngine;
  /** e.g. ["mild", "dry"] — maps to outfits.weather_tags in Postgres */
  weatherTags?: string[];
  /** e.g. ["workwear", "summer"] — additive tags for filtering */
  tags?: string[];
  createdAt: number;
  syncStatus?: "synced" | "pending" | "error";
}

export interface ToastMsg {
  id: number;
  text: string;
  tone: "ok" | "err";
}

export interface GenerationState {
  status: "idle" | "working" | "done" | "error";
  occasion: Occasion;
  result: StyleResult | null;
  error: string | null;
}

/* ------------------------- auth & profile ------------------------- */

export type AppMode = "mock" | "live"; // live = Supabase keys configured

export type AuthStatus = "booting" | "signedOut" | "signedIn";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  isDemo: boolean;
}

export type BodyShape = "slim" | "average" | "athletic" | "curvy";

/** Loosely-typed on purpose: mirrors profiles.avatar_config JSONB. */
export interface AvatarConfig {
  skinTone?: string;
  bodyShape?: BodyShape;
  hairstyle?: string;
}

export interface BodyMetrics {
  heightCm?: number;
  weightKg?: number;
  chestCm?: number;
  waistCm?: number;
  hipsCm?: number;
  shoeEu?: number;
}

export interface Profile {
  userId: string;
  avatarUrl: string | null;
  avatarConfig: AvatarConfig;
  bodyMetrics: BodyMetrics | null;
}

/** Style DNA captured during onboarding. */
export interface StylePrefs {
  families: ColorFamily[];
  vibe: "casual" | "smart" | "formal";
}

/** Forward-compat with the schedules table (calendar lands later). */
export interface Schedule {
  id: string;
  userId: string;
  outfitId: string;
  scheduledDate: string; // YYYY-MM-DD
  createdAt: number;
}

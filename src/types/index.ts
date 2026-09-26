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
   * Base64 SHA-256 of the prepared image bytes (from the import pipeline's
   * worker — `PreparedImage.sha256`). Identity for the content-addressed recon
   * cache (`services/reconCache.ts`), so re-importing identical bytes reuses
   * the render instead of spending another remote call. Local-only, not synced.
   */
  photoSha256?: string;
  /**
   * Reconstruction final (PNG data URL, 512×512): the complete empty
   * garment rebuilt from the original photo by the recon pipeline
   * (see services/garmentRecon.ts) — the single source of truth for
   * garment rendering. Built ONCE per garment at import time via the
   * recon-garment Edge Function (TryOffDiff Space, class-locked, seed 42).
   * Display precedence in GarmentPhoto: reconUrl > SVG `rendering`
   * skeleton. Local-only until synced, like `photo`.
   */
  reconUrl?: string;
  /** Reconstruction build state — independent of the SVG skeleton state. */
  reconStatus?: "pending" | "ready" | "failed";
  /** Human-readable failure reason for the last recon attempt. */
  reconError?: string;
  /**
   * User-set: this garment carries logos, graphics, or legible text.
   * Routes reconstruction to the detail renderer (FLUX.2-klein, ~60 s)
   * instead of the default TryOffDiff (~30 s), which drops micro-graphics
   * (verified: GUESS side tape omitted). Default/unset = plain → TryOffDiff.
   * No auto-detection: the stub analyzer cannot see prints, so the wearer
   * decides. Toggling clears any cached recon so the other renderer runs.
   */
  hasPrint?: boolean;
  /** Which backend built the cached reconUrl — recorded at success time. */
  reconRenderer?: "tryoff" | "klein";
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

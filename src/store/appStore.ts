import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  AppMode,
  AuthStatus,
  AuthUser,
  Garment,
  GenerationState,
  LoadStatus,
  Occasion,
  Profile,
  SavedLook,
  Schedule,
  StylePrefs,
  StyleResult,
  TabId,
  ThemeMode,
  ToastMsg,
  Units,
  WeatherNow,
} from "../types";
import { DEMO_OUTFITS, getDemoWardrobe } from "../lib/mock";
import { fetchWeather } from "../services/weather";
import { generateStyle } from "../services/stylist";
import { ensureRendering } from "../services/studioRender";
import {
  appMode,
  enterDemoMode as demoEnter,
  restoreSession,
  signOut as authSignOut,
  subscribeAuth,
} from "../services/authService";
import {
  deleteGarmentRow,
  deleteOutfitRow,
  deleteScheduleRow,
  fetchSchedules,
  fetchUserData,
  insertGarmentRow,
  insertOutfitRow,
  upsertScheduleRow,
} from "../services/dataService";
import { OCCASION_META, uid, withTimeout } from "../lib/utils";
import { supabase } from "../services/supabaseClient";
import {
  clearBlobs,
  deleteBlobsFor,
  pruneBlobs,
  saveBlob,
} from "../services/blobStore";

interface WeatherState {
  status: LoadStatus;
  data: WeatherNow | null;
}

type SyncStatus = "synced" | "pending" | "error";

/** Phase 5 rollout — explicit opt-in closet upgrade (never automatic). */
export type ClosetUpgradeStatus =
  | "idle"
  | "running"
  | "paused"
  | "quota-paused"
  | "done";

export interface ClosetUpgradeState {
  status: ClosetUpgradeStatus;
  /** Eligible ids snapshotted at start (garments lacking studioRenderUrl). */
  initialIds: string[];
  /** Remaining ids not yet kicked (popped one per pace interval). */
  queued: string[];
  /** Last kicked id (job continues in the serial chains after kick). */
  currentId: string | null;
  total: number;
  startedAt: number | null;
  completedAt: number | null;
}

export const IDLE_UPGRADE: ClosetUpgradeState = {
  status: "idle",
  initialIds: [],
  queued: [],
  currentId: null,
  total: 0,
  startedAt: null,
  completedAt: null,
};

interface SyncState {
  pendingGarments: Set<string>;
  pendingLooks: Set<string>;
  errorGarments: Set<string>;
  errorLooks: Set<string>;
}

// For persistence (Sets don't serialize well)
interface PersistedSyncState {
  pendingGarments: string[];
  pendingLooks: string[];
  errorGarments: string[];
  errorLooks: string[];
}

export interface AppStore {
  /* ------------------------------ session ----------------------------- */
  mode: AppMode;
  authStatus: AuthStatus;
  user: AuthUser | null;
  /** Which account currently owns the persisted garments/looks. */
  ownerId: string | null;
  profile: Profile | null;
  onboardedUsers: string[];
  stylePrefs: StylePrefs | null;

  boot: () => Promise<void>;
  completeAuth: (user: AuthUser) => void;
  enterDemoMode: () => void;
  signOutUser: () => Promise<void>;
  completeOnboarding: () => void;
  setStylePrefs: (p: StylePrefs) => void;
  setProfile: (p: Profile | null) => void;
  hydrateFromCloud: () => Promise<void>;

  /* ------------------------------ shell ------------------------------- */
  theme: ThemeMode;
  units: Units;
  tab: TabId;
  drawerOpen: boolean;
  installPrompt: BeforeInstallPromptEvent | null;

  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;
  setUnits: (u: Units) => void;
  setTab: (t: TabId) => void;
  setDrawer: (open: boolean) => void;
  setInstallPrompt: (event: BeforeInstallPromptEvent | null) => void;

  /* ------------------------------- data ------------------------------- */
  garments: Garment[];
  looks: SavedLook[];
  schedules: Schedule[];
  weather: WeatherState;
  generation: GenerationState;
  today: StyleResult | null;
  toast: ToastMsg | null;

  addGarment: (g: Omit<Garment, "id" | "createdAt">, photoDataUrl?: string) => Promise<void>;
  /** Generate-and-cache the studio rendering for one garment (legacy backfill + retry). */
  backfillRendering: (id: string) => void;
  /**
   * Build (or rebuild) the background-removed neutral-backdrop composite
   * for one garment. No-op while a job for that id is already running.
   * Failures land on `studioCompositeStatus: "failed"` — the SVG rendering
   * fallback is untouched.
   */
  retryStudioComposite: (id: string) => void;
  /**
   * Manual (re)try for the Phase 4 img2img final. Marks pending and runs
   * the same once-per-garment background job as the upload path. Failures
   * stay on "failed" with the SVG fallback — never blocking.
   */
  retryStudioRender: (id: string) => void;
  removeGarment: (id: string) => void;
  restoreSamples: () => void;
  clearAllData: () => void;

  /* --------------------- Phase 5 closet upgrade ---------------------- */
  /** Explicit opt-in rollout for pre-Phase-4 garments (never automatic). */
  closetUpgrade: ClosetUpgradeState;
  startClosetUpgrade: () => void;
  pauseClosetUpgrade: () => void;
  cancelClosetUpgrade: () => void;
  dismissClosetUpgrade: () => void;

  refreshWeather: () => Promise<void>;
  generateToday: (occasion?: Occasion) => Promise<void>;
  generateForStudio: (occasion: Occasion, prompt?: string) => Promise<void>;
  /** Replace the studio result in place (quick tweaks / custom prompt). */
  setStudioResult: (result: StyleResult) => void;
  saveLook: (result: StyleResult, name?: string) => Promise<SavedLook>;
  deleteLook: (id: string) => void;
  updateLookTags: (id: string, tags: string[]) => void;

  scheduleLook: (date: string, lookId: string) => void;
  clearSchedule: (date: string) => void;

  notify: (text: string, tone?: "ok" | "err") => void;
  clearToast: () => void;

  /* --------------------------- sync retry ---------------------------- */
  _syncState: SyncState;
  retrySync: () => Promise<void>;
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

const IDLE_GEN: GenerationState = {
  status: "idle",
  occasion: "casual",
  result: null,
  error: null,
};

const EMPTY_DATA = {
  garments: [] as Garment[],
  looks: [] as SavedLook[],
  today: null as StyleResult | null,
  generation: IDLE_GEN,
};

// Safe storage wrapper that catches localStorage quota errors
const safeStorage = {
  getItem: (name: string) => {
    try {
      const item = localStorage.getItem(name);
      return item ? JSON.parse(item) : null;
    } catch (e) {
      console.warn(`localStorage.getItem("${name}") failed:`, e);
      return null;
    }
  },
  setItem: (name: string, value: { state: unknown; version?: number }) => {
    try {
      localStorage.setItem(name, JSON.stringify(value));
    } catch (e) {
      // QuotaExceededError or other storage failure — degrade gracefully
      console.error("localStorage.setItem failed — storage may be full:", e);
      // Don't rethrow; let the app continue working in-memory
    }
  },
  removeItem: (name: string) => {
    try {
      localStorage.removeItem(name);
    } catch (e) {
      console.warn(`localStorage.removeItem("${name}") failed:`, e);
    }
  },
};

export function applyThemeToDom(theme: ThemeMode) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#0C110D" : "#EDF1EC");
}

function buzz(ms = 8) {
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* no haptics — fine */
  }
}

let bootStarted = false;
let unsubAuth: (() => void) | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;

/* ------------------------- sync hygiene helpers ------------------------ */
// Persisted _syncState rehydrates as string[] (partialize converts Sets to
// arrays), so every access must tolerate Array | Set. Legacy installs may
// also hold local "g-…"/"look-…" ids which are not valid Postgres uuids and
// can never sync — retrying them every boot is what surfaced the
// "N items haven't synced yet" toast. They are dropped silently here.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuidLike = (id: string) => UUID_RE.test(id);

function toSet(ids: unknown): Set<string> {
  if (ids instanceof Set) return new Set(ids as Set<string>);
  if (Array.isArray(ids)) return new Set(ids.filter((x): x is string => typeof x === "string"));
  return new Set<string>();
}

function without<T>(set: Set<T>, ...ids: T[]): Set<T> {
  const next = new Set(set);
  for (const id of ids) next.delete(id);
  return next;
}

function sanitizeIds(ids: unknown, valid: Set<string>): string[] {
  return [...toSet(ids)].filter((id) => isUuidLike(id) && valid.has(id));
}

// Cloud hydrate must never wipe items created on-device while the fetch was
// in flight (upload → jump to Studio during a slow hydrate on fresh open).
// Anything in current state whose id isn't in the fetched set is local-only
// (pending sync or added mid-flight) — keep it, newest first, in front.
function mergeKeptLocal<T extends { id: string; createdAt: number }>(
  current: T[],
  fetched: T[]
): T[] {
  const fetchedIds = new Set(fetched.map((i) => i.id));
  const localOnly = current
    .filter((i) => !fetchedIds.has(i.id))
    .sort((a, b) => b.createdAt - a.createdAt);
  return [...localOnly, ...fetched];
}

function mergeSchedules(current: Schedule[], fetched: Schedule[]): Schedule[] {
  const fetchedIds = new Set(fetched.map((s) => s.id));
  return [...current.filter((s) => !fetchedIds.has(s.id)), ...fetched];
}

/* ------------------- studio-composite background jobs ------------------ */
// Local-only, deterministic: ISNet segmentation + Canvas2D composite onto
// the neutral backdrop (see services/studioComposite.ts). No APIs, no cost,
// no person risk — the original photo and SVG fallback are never touched.
//
// Jobs are serialised through a module-level chain so a bulk upload can't
// spike a phone CPU with N concurrent ONNX inferences; each resolves in
// well under ~2 s once the model is cached. The heavy dependency stays out
// of the initial bundle via dynamic import.
const studioCompositeInFlight = new Set<string>();
// Phase 5 speed: two inference lanes instead of one strictly-serial chain,
// so bulk uploads clear ~2× faster. Low-memory devices (phones reporting
// ≤4 GB) stay on one lane to avoid ONNX memory pressure. Each lane is still
// just a background promise — the UI thread is never blocked.
const studioCompositeQueue: string[] = [];
let studioCompositeActive = 0;

function compositeLaneCount(): number {
  try {
    const mem = (navigator as unknown as { deviceMemory?: number })?.deviceMemory;
    if (typeof mem === "number" && mem <= 4) return 1;
  } catch {
    /* fall through to default */
  }
  return 2;
}

function runStudioCompositeJob(id: string): void {
  if (studioCompositeInFlight.has(id) || studioCompositeQueue.includes(id)) return;
  studioCompositeQueue.push(id);
  pumpStudioCompositeQueue();
}

function pumpStudioCompositeQueue(): void {
  while (
    studioCompositeActive < compositeLaneCount() &&
    studioCompositeQueue.length > 0
  ) {
    const next = studioCompositeQueue.shift()!;
    if (studioCompositeInFlight.has(next)) continue;
    const current = useAppStore.getState().garments.find((g) => g.id === next);
    const source = current?.photo;
    // Photo is the only input: nothing to segment (e.g. a manual entry
    // with no photo, or a record whose base64 was stripped from storage)
    // → leave the SVG fallback in place, don't mark failed.
    if (!current || !source) continue;
    studioCompositeInFlight.add(next);
    studioCompositeActive++;
    void runCompositeWorker(next).finally(() => {
      studioCompositeActive--;
      pumpStudioCompositeQueue();
    });
  }
}

async function runCompositeWorker(id: string): Promise<void> {
  try {
      const current = useAppStore.getState().garments.find((g) => g.id === id);
      const source = current?.photo;
      // Re-checked at worker start (a lane may have waited behind another):
      // nothing to segment → SVG fallback carries on, never "failed".
      if (!current || !source) return;
      const { preprocessGarmentPhoto } = await import(
        "../services/studioComposite"
      );
      const result = await preprocessGarmentPhoto(source);
      if (result.status === "ready" && result.studio_composite) {
        // Persist the blob to IndexedDB (fire-and-forget) — the lean
        // localStorage snapshot no longer carries ~100 KB JPEGs, so this
        // is what brings the composite back after a reload.
        try {
          saveBlob(id, "composite", result.studio_composite);
        } catch {
          /* best-effort */
        }
      }
      useAppStore.setState((s) => {
        const apply = (g: Garment): Garment =>
          g.id === id
            ? {
                ...g,
                ...(result.status === "ready" && result.studio_composite
                  ? {
                      studioComposite: result.studio_composite,
                      studioCompositeStatus: "ready" as const,
                    }
                  : { studioCompositeStatus: "failed" as const }),
              }
            : g;
        const fixOutfit = (o: Record<string, Garment | undefined>) => {
          const next = { ...o };
          for (const k of Object.keys(next)) {
            const piece = next[k];
            if (piece && piece.id === id) next[k] = apply(piece);
          }
          return next;
        };
        return {
          garments: s.garments.map(apply),
          looks: s.looks.map((l) => ({
            ...l,
            outfit: fixOutfit(l.outfit as Record<string, Garment | undefined>) as typeof l.outfit,
          })),
          today: s.today
            ? {
                ...s.today,
                outfit: fixOutfit(s.today.outfit as Record<string, Garment | undefined>) as typeof s.today.outfit,
              }
            : s.today,
        };
      });
    } catch (e) {
      // Infallible by contract: offline, blocked WASM, corrupt input —
      // anything lands here as "failed" and the SVG fallback carries on.
      console.warn("studio-composite deferred:", e);
      useAppStore.setState((s) => ({
        garments: s.garments.map((g) =>
          g.id === id ? { ...g, studioCompositeStatus: "failed" as const } : g
        ),
      }));
    } finally {
      studioCompositeInFlight.delete(id);
      // Phase 4: chain the img2img enhance AFTER the composite lands, so
      // the Space gets the isolated garment (not the raw photo) as input —
      // still exactly one enhance call per garment, never per view.
      try {
        runStudioEnhanceJob(id);
      } catch {
        /* enhance kick is best-effort */
      }
    }
}

/* ------------------- Phase 4 studio-enhance background jobs ------------- */
// One img2img call per garment, at import time, via the secret-holding
// Edge Function (never from the browser bundle). Serialised so a bulk
// upload can't burst the free ZeroGPU quota (~5/day). Failures land on
// `studioRenderStatus: "failed"` — SVG + composite fallbacks untouched.
const studioEnhanceInFlight = new Set<string>();
let studioEnhanceChain: Promise<void> = Promise.resolve();

function runStudioEnhanceJob(id: string): void {
  if (studioEnhanceInFlight.has(id)) return;
  const snapshot = useAppStore.getState().garments.find((g) => g.id === id);
  // No source to enhance (manual entry), or final already cached — never
  // re-generate on view. Retry path re-enters via retryStudioRender.
  if (!snapshot || snapshot.studioRenderUrl) return;
  if (!snapshot.photo && !snapshot.studioComposite) return;
  studioEnhanceInFlight.add(id);
  studioEnhanceChain = studioEnhanceChain.then(async () => {
    try {
      const state = useAppStore.getState();
      const current = state.garments.find((g) => g.id === id);
      const user = state.user;
      // Mock/demo mode or signed out: no backend to hold HF_TOKEN — stay
      // on SVG + composite fallbacks, don't mark failed (retry later).
      if (!current || !user || user.isDemo) return;
      const { requestStudioEnhance } = await import(
        "../services/studioEnhance"
      );
      const outcome = await requestStudioEnhance({
        userId: user.id,
        garmentId: id,
        compositeDataUrl: current.studioComposite,
        photoDataUrl: current.photo,
      });
      if (outcome.status === "ready") {
        const url = outcome.studioRenderUrl;
        useAppStore.setState((s) => {
          const apply = (g: Garment): Garment =>
            g.id === id
              ? { ...g, studioRenderUrl: url, studioRenderStatus: "ready" as const }
              : g;
          const fixOutfit = (o: Record<string, Garment | undefined>) => {
            const next = { ...o };
            for (const k of Object.keys(next)) {
              const piece = next[k];
              if (piece && piece.id === id) next[k] = apply(piece);
            }
            return next;
          };
          return {
            garments: s.garments.map(apply),
            looks: s.looks.map((l) => ({
              ...l,
              outfit: fixOutfit(l.outfit as Record<string, Garment | undefined>) as typeof l.outfit,
            })),
            today: s.today
              ? {
                  ...s.today,
                  outfit: fixOutfit(s.today.outfit as Record<string, Garment | undefined>) as typeof s.today.outfit,
                }
              : s.today,
          };
        });
        // Best-effort row persist (retrySync backfills via upsert anyway).
        try {
          await supabase
            ?.from("wardrobe_items")
            .update({ studio_render_url: url })
            .eq("id", id);
        } catch {
          /* background persist is best-effort */
        }
      } else if (outcome.status === "failed") {
        // API fail / timeout / function not deployed: don't block anything —
        // save for retry from the Closet detail sheet.
        console.warn("studio-enhance deferred:", outcome.error);
        useAppStore.setState((s) => ({
          garments: s.garments.map((g) =>
            g.id === id ? { ...g, studioRenderStatus: "failed" as const } : g
          ),
        }));
      }
      // "skipped" (mock, no source): leave pending/undefined so a later
      // live session can still enhance; SVG fallback carries on.
    } catch (e) {
      console.warn("studio-enhance deferred:", e);
      useAppStore.setState((s) => ({
        garments: s.garments.map((g) =>
          g.id === id ? { ...g, studioRenderStatus: "failed" as const } : g
        ),
      }));
    } finally {
      studioEnhanceInFlight.delete(id);
    }
  });
}

/* ------------------- Phase 5 closet-upgrade orchestrator -------------- */
// Explicit opt-in rollout for pre-Phase-4 garments (never automatic —
// auto-running would burst the ~5/day free ZeroGPU quota by surprise).
// One kick per STUDIO_UPGRADE_PACE_MS via setTimeout (fully non-blocking:
// the UI thread is free between ticks and the user keeps using the app).
// Each kick reuses the exact Phase 1→4 pipeline: composite first when
// missing (which chains the enhance on completion), else enhance direct.
// Daily budget leaves headroom for fresh imports; hitting it parks the
// run in "quota-paused" for the user to resume tomorrow.
let upgradeTimer: ReturnType<typeof setTimeout> | null = null;

function clearUpgradeTimer(): void {
  if (upgradeTimer) {
    clearTimeout(upgradeTimer);
    upgradeTimer = null;
  }
}

/** Garments that can still be upgraded (have an image source, no final). */
function eligibleUpgradeIds(garments: Garment[]): string[] {
  return garments
    .filter((g) => !g.studioRenderUrl && (g.photo || g.studioComposite))
    .map((g) => g.id);
}

/**
 * Merge IndexedDB image blobs back into the lean in-memory state.
 * Never rejects: a missing blob just leaves the SVG/final fallback
 * showing (always correct). Also backfills IDB from any in-state
 * `data:` blobs (first boot after the v10 persist slimming) and prunes
 * blobs for deleted garments. Await it before resuming pending jobs so
 * photo-gated resume sees its sources.
 */
async function rehydrateBlobs(): Promise<void> {
  try {
    const { loadAllBlobs } = await import("../services/blobStore").catch(
      () => ({ loadAllBlobs: null as null | (() => Promise<Map<string, { photo?: string; composite?: string }>>) })
    );
    if (!loadAllBlobs) return;
    const all = await loadAllBlobs().catch(
      () => new Map<string, { photo?: string; composite?: string }>()
    );
    const s = useAppStore.getState();
    // Backfill the store from in-state blobs (v10 slimming leaves old
    // snapshots carrying blobs in memory on first load).
    for (const g of s.garments) {
      if (g.photo?.startsWith("data:")) saveBlob(g.id, "photo", g.photo);
      if (g.studioComposite?.startsWith("data:")) {
        saveBlob(g.id, "composite", g.studioComposite);
      }
    }
    if (all.size > 0) {
      let changed = false;
      const garments = s.garments.map((g) => {
        const pair = all.get(g.id);
        if (!pair) return g;
        let next = g;
        if (!next.photo && pair.photo) {
          next = { ...next, photo: pair.photo };
          changed = true;
        }
        if (!next.studioComposite && pair.composite) {
          next = { ...next, studioComposite: pair.composite };
          changed = true;
        }
        return next;
      });
      if (changed) useAppStore.setState({ garments });
    }
    pruneBlobs(new Set(s.garments.map((g) => g.id)));
  } catch {
    /* best-effort */
  }
}

function pumpClosetUpgrade(): void {
  clearUpgradeTimer();
  const state = useAppStore.getState();
  const up = state.closetUpgrade;
  if (up.status !== "running") return;
  const user = state.user;
  if (!user || user.isDemo) {
    // No backend to hold HF_TOKEN — park, don't burn, don't fail.
    useAppStore.setState((s) => ({
      closetUpgrade: { ...s.closetUpgrade, status: "paused" as const, currentId: null },
    }));
    state.notify("Sign in to upgrade your closet", "err");
    return;
  }
  // Drop ids that no longer need work (upgraded elsewhere, deleted, or
  // source-less manual entries) — progress derives from initialIds so
  // skipping never mis-counts.
  const byId = new Map(state.garments.map((g) => [g.id, g]));
  const remaining = up.queued.filter((id) => {
    const g = byId.get(id);
    return !!g && !g.studioRenderUrl && !!(g.photo || g.studioComposite);
  });
  if (remaining.length === 0) {
    useAppStore.setState((s) => ({
      closetUpgrade: {
        ...s.closetUpgrade,
        queued: [],
        currentId: null,
        status: "done" as const,
        completedAt: Date.now(),
      },
    }));
    state.notify("Closet upgrade complete");
    return;
  }
  // Daily quota guard (local sanity counter; server quota is authoritative).
  // Pause — don't fail — so the user resumes tomorrow with one tap.
  // Paced via dynamic import so the enhance chunk stays out of the boot
  // bundle; the tick itself is just a setTimeout (non-blocking).
  import("../services/studioEnhance").then(
    ({ getEnhanceDailyCount, STUDIO_UPGRADE_DAILY_BUDGET, STUDIO_UPGRADE_PACE_MS }) => {
      const live = useAppStore.getState();
      if (live.closetUpgrade.status !== "running") return;
      if (getEnhanceDailyCount() >= STUDIO_UPGRADE_DAILY_BUDGET) {
        useAppStore.setState((s) => ({
          closetUpgrade: { ...s.closetUpgrade, status: "quota-paused" as const, currentId: null },
        }));
        live.notify("Daily studio budget reached — resume tomorrow", "err");
        return;
      }
      const fresh = useAppStore.getState();
      const fbyId = new Map(fresh.garments.map((g) => [g.id, g]));
      const still = fresh.closetUpgrade.queued.filter((id) => {
        const g = fbyId.get(id);
        return !!g && !g.studioRenderUrl && !!(g.photo || g.studioComposite);
      });
      if (still.length === 0) {
        useAppStore.setState((s) => ({
          closetUpgrade: {
            ...s.closetUpgrade,
            queued: [],
            currentId: null,
            status: "done" as const,
            completedAt: Date.now(),
          },
        }));
        fresh.notify("Closet upgrade complete");
        return;
      }
      const nextId = still[0];
      const target = fbyId.get(nextId)!;
      // Kick the same pipeline as a fresh upload: composite-first when
      // missing (chains enhance on completion), enhance-direct otherwise.
      // Mark pending so tiles show progress; failures land "failed" with
      // the SVG fallback intact and never block the queue.
      if (!target.studioComposite && target.photo) {
        useAppStore.setState((s) => ({
          garments: s.garments.map((g) =>
            g.id === nextId
              ? { ...g, studioCompositeStatus: "pending" as const, studioRenderStatus: "pending" as const }
              : g
          ),
          closetUpgrade: {
            ...s.closetUpgrade,
            queued: still.slice(1),
            currentId: nextId,
          },
        }));
        runStudioCompositeJob(nextId);
      } else {
        useAppStore.setState((s) => ({
          garments: s.garments.map((g) =>
            g.id === nextId ? { ...g, studioRenderStatus: "pending" as const } : g
          ),
          closetUpgrade: {
            ...s.closetUpgrade,
            queued: still.slice(1),
            currentId: nextId,
          },
        }));
        runStudioEnhanceJob(nextId);
      }
      // Pace the next kick — non-blocking; the app stays fully usable.
      upgradeTimer = setTimeout(pumpClosetUpgrade, STUDIO_UPGRADE_PACE_MS);
    }
  ).catch(() => {
    // Dynamic import failed (offline?): retry this item on the next resume.
    useAppStore.setState((s) => ({
      closetUpgrade: { ...s.closetUpgrade, status: "paused" as const, currentId: null },
    }));
  });
}

export const useAppStore = create<AppStore>()(
  persist(
    (set, get) => ({
      /* --------------------------- session ---------------------------- */
      mode: appMode,
      authStatus: "booting",
      user: null,
      ownerId: null,
      profile: null,
      onboardedUsers: [],
      stylePrefs: null,

      boot: async () => {
        if (bootStarted) return;
        bootStarted = true;
        try {
          const restored = await restoreSession();
          if (restored) {
            get().completeAuth(restored);
          } else {
            set({ authStatus: "signedOut" });
          }
        } catch {
          set({ authStatus: "signedOut" });
        }
        // Live mode: follow token refresh / OAuth redirect / remote sign-out.
        // Guarded: if subscribing throws, the app must still leave "booting"
        // (an eternal Splash looks exactly like a blank screen) and a later
        // remount must be allowed to retry.
        try {
          unsubAuth?.();
          unsubAuth = subscribeAuth((u) => {
            if (u) {
              get().completeAuth(u);
              return;
            }
            const current = get().user;
            if (current && !current.isDemo) {
              clearUpgradeTimer();
              set({ user: null, ownerId: null, authStatus: "signedOut", ...EMPTY_DATA, closetUpgrade: { ...IDLE_UPGRADE } });
            }
          });
        } catch {
          // Auth subscription failed (offline tracker, blocked SDK): the
          // closet still works on-device — never strand boot on "booting".
          if (get().authStatus === "booting") set({ authStatus: "signedOut" });
        }
        
        // Silent background sweep for any pending/error items. Never toasts:
        // the closet works fully on-device and cloud sync is best-effort.
        // Sanitize first so legacy non-uuid ids can't fail forever.
        try {
          const s = get();
          const garmentIds = new Set(s.garments.map((g) => g.id));
          const lookIds = new Set(s.looks.map((l) => l.id));
          const clean = {
            pendingGarments: sanitizeIds(s._syncState.pendingGarments, garmentIds),
            errorGarments: sanitizeIds(s._syncState.errorGarments, garmentIds),
            pendingLooks: sanitizeIds(s._syncState.pendingLooks, lookIds),
            errorLooks: sanitizeIds(s._syncState.errorLooks, lookIds),
          };
          const dirty =
            clean.pendingGarments.length !== toSet(s._syncState.pendingGarments).size ||
            clean.errorGarments.length !== toSet(s._syncState.errorGarments).size ||
            clean.pendingLooks.length !== toSet(s._syncState.pendingLooks).size ||
            clean.errorLooks.length !== toSet(s._syncState.errorLooks).size;
          if (dirty) {
            set({
              _syncState: {
                pendingGarments: new Set(clean.pendingGarments),
                pendingLooks: new Set(clean.pendingLooks),
                errorGarments: new Set(clean.errorGarments),
                errorLooks: new Set(clean.errorLooks),
              },
            });
          }
        } catch {
          /* sanitize is best-effort */
        }
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          void get().retrySync().catch(() => {});
        }, 4000);
        // Resume studio-composite jobs interrupted by a reload (persisted as
        // "pending"): the SVG fallback is already on screen, the composite
        // just enhances when it lands. Serialised by the job chain.
        // Phase 4 enhance jobs resume the same way — but ONLY "pending"
        // (a "failed" enhance waits for manual retry so a reload storm can
        // never burst the ~5/day free quota).
        // Phase 5 upgrade runs never auto-resume: a "running" snapshot from
        // before the reload parks as "paused" so quota can't burn without
        // an explicit tap. Individually-pending garments below still resume.
        try {
          const up = get().closetUpgrade;
          if (up && up.status === "running") {
            set({
              closetUpgrade: { ...up, status: "paused" as const, currentId: null },
            });
          }
        } catch {
          /* upgrade park is best-effort */
        }
        // Blob sources first (lean v10 snapshots omit them): IDB reads are
        // milliseconds-local, and photo-gated resume below needs them.
        // Tiles already painted from SVG/final — this never blocks display.
        try {
          await rehydrateBlobs();
        } catch {
          /* rehydrate is best-effort */
        }
        try {
          for (const g of get().garments) {
            if (
              g.studioCompositeStatus === "pending" &&
              g.photo &&
              !g.studioComposite
            ) {
              runStudioCompositeJob(g.id);
            } else if (
              g.studioRenderStatus === "pending" &&
              !g.studioRenderUrl &&
              (g.studioComposite || g.photo)
            ) {
              runStudioEnhanceJob(g.id);
            }
          }
        } catch {
          /* resume is best-effort */
        }
      },

      completeAuth: (user) => {
        const state = get();
        const patch: Partial<AppStore> = { user, authStatus: "signedIn" };

        if (user.isDemo) {
          // The demo user arrives pre-dressed: seed the mock dataset once.
          if (state.garments.length === 0) patch.garments = getDemoWardrobe();
          if (state.looks.length === 0) patch.looks = DEMO_OUTFITS;
          patch.ownerId = user.id;
          patch.onboardedUsers = Array.from(
            new Set([...state.onboardedUsers, user.id])
          );
        } else if (state.ownerId === user.id) {
          // Same account returning — keep the already-loaded data.
        } else {
          // Different account (or first live login): never show another
          // user's wardrobe. Start clean, then pull from Postgres.
          // Sync queues belong to the previous account — drop them so one
          // account's pending ids can never error under another account.
          patch.ownerId = user.id;
          patch.garments = [];
          patch.looks = [];
          patch.today = null;
          patch.generation = IDLE_GEN;
          patch.profile = null;
          patch._syncState = {
            pendingGarments: new Set<string>(),
            pendingLooks: new Set<string>(),
            errorGarments: new Set<string>(),
            errorLooks: new Set<string>(),
          };
          // Upgrade queues belong to the previous account too — never leak
          // one account's rollout into another's closet.
          patch.closetUpgrade = { ...IDLE_UPGRADE };
        }
        set(patch);
        if (!user.isDemo && state.ownerId !== user.id) {
          void get().hydrateFromCloud();
        }
      },

      hydrateFromCloud: async () => {
        const user = get().user;
        if (!user || user.isDemo) return;
        try {
          const [{ garments, looks }, scheduleRows] = await Promise.all([
            fetchUserData(user.id),
            fetchSchedules(user.id),
          ]);
          // Map DB rows to Schedule type (snake_case → camelCase)
          const schedules: Schedule[] = scheduleRows.map((r) => ({
            id: r.id,
            userId: r.user_id,
            outfitId: r.outfit_id,
            scheduledDate: r.scheduled_date,
            createdAt: new Date(r.created_at).getTime(),
          }));
          // Only apply if this account is still active. Merge — never
          // replace — so garments/looks added on-device while this fetch
          // was in flight survive the hydrate instead of being wiped.
          if (get().user?.id === user.id) {
            const s = get();
            set({
              garments: mergeKeptLocal(s.garments, garments),
              looks: mergeKeptLocal(s.looks, looks),
              schedules: mergeSchedules(s.schedules, schedules),
            });
            // Cloud rows may carry photo URLs the lean snapshot lacks —
            // merge stored composites back so tiles upgrade instantly.
            try {
              await rehydrateBlobs();
            } catch {
              /* best-effort */
            }
          }
        } catch (error: any) {
          console.error("Error in hydrateFromCloud:", error?.message ?? error, error?.status);
          // Retry once after refreshing session
          try {
            await supabase?.auth.getSession();
            const [retryData, retryScheduleRows] = await Promise.all([
              fetchUserData(user.id),
              fetchSchedules(user.id),
            ]);
            const schedules: Schedule[] = retryScheduleRows.map((r) => ({
              id: r.id,
              userId: r.user_id,
              outfitId: r.outfit_id,
              scheduledDate: r.scheduled_date,
              createdAt: new Date(r.created_at).getTime(),
            }));
            if (get().user?.id === user.id) {
              const s = get();
              set({
                garments: mergeKeptLocal(s.garments, retryData.garments),
                looks: mergeKeptLocal(s.looks, retryData.looks),
                schedules: mergeSchedules(s.schedules, schedules),
              });
              try {
                await rehydrateBlobs();
              } catch {
                /* best-effort */
              }
            }
            return;
          } catch (retryError: any) {
            console.error("Retry failed in hydrateFromCloud:", retryError?.message ?? retryError, retryError?.status);
          }
          // Silent: the closet works fully on-device; cloud is best-effort.
          // Never surface a boot-time error toast for background sync.
        }
      },

      enterDemoMode: () => {
        const demo = demoEnter();
        get().completeAuth(demo);
        get().notify("Welcome to the demo closet");
      },

      signOutUser: async () => {
        clearUpgradeTimer();
        await authSignOut();
        set({
          user: null,
          ownerId: null,
          profile: null,
          authStatus: "signedOut",
          drawerOpen: false,
          tab: "home",
          stylePrefs: null,
          ...EMPTY_DATA,
          closetUpgrade: { ...IDLE_UPGRADE },
          _syncState: {
            pendingGarments: new Set<string>(),
            pendingLooks: new Set<string>(),
            errorGarments: new Set<string>(),
            errorLooks: new Set<string>(),
          },
        });
        get().notify("Signed out");
      },

      completeOnboarding: () => {
        const u = get().user;
        if (!u) return;
        set({
          onboardedUsers: Array.from(new Set([...get().onboardedUsers, u.id])),
        });
      },

      setStylePrefs: (p) => set({ stylePrefs: p }),
      setProfile: (p) => set({ profile: p }),

      /* ---------------------------- shell ----------------------------- */
      theme: "dark",
      units: "C",
      tab: "home",
      drawerOpen: false,
      installPrompt: null,
      garments: [],
      looks: [],
      schedules: [],
      weather: { status: "idle", data: null },
      generation: IDLE_GEN,
      today: null,
      toast: null,
      _syncState: {
        pendingGarments: new Set<string>(),
        pendingLooks: new Set<string>(),
        errorGarments: new Set<string>(),
        errorLooks: new Set<string>(),
      },
      closetUpgrade: { ...IDLE_UPGRADE },

      setTheme: (t) => {
        applyThemeToDom(t);
        set({ theme: t });
      },
      toggleTheme: () => {
        const t: ThemeMode = get().theme === "dark" ? "light" : "dark";
        applyThemeToDom(t);
        buzz();
        set({ theme: t });
      },
      setUnits: (u) => set({ units: u }),
      setTab: (t) => {
        buzz(6);
        set({ tab: t });
      },
      setDrawer: (open) => set({ drawerOpen: open }),
      setInstallPrompt: (event) => set({ installPrompt: event }),

      /* ----------------------------- data ----------------------------- */
      addGarment: async (g, photoDataUrl) => {
        // Generate stable UUID upfront for sync consistency. Callers may
        // pass a full Garment (e.g. from taggingToGarment) carrying a local
        // "g-…" id — strip it so it can never clobber the uuid: non-uuid
        // ids can never sync to Postgres and get scrubbed as legacy junk.
        const { id: _incomingId, createdAt: _incomingAt, syncStatus: _incomingSync, ...rest } =
          g as Partial<Garment> & Omit<Garment, "id" | "createdAt">;
        void _incomingId;
        void _incomingAt;
        void _incomingSync;
        const id = crypto.randomUUID();

        // Normalize incoming garment to ensure colors/pattern are always present
        const normalizedGarment: Garment = ensureRendering({
          ...rest as Omit<Garment, "id" | "createdAt">,
          id,
          colors: rest.colors?.length ? rest.colors : [rest.color!],
          pattern: rest.pattern ?? "solid",
          photo: photoDataUrl ?? rest.photo,
          createdAt: Date.now(),
          syncStatus: "pending",
        });
        
        set((s) => ({
          garments: [normalizedGarment, ...s.garments],
          _syncState: {
            ...s._syncState,
            pendingGarments: new Set(toSet(s._syncState.pendingGarments)).add(id),
          }
        }));
        // Stash the source photo in IndexedDB (fire-and-forget): the lean
        // persist snapshot omits it, and this is what lets composites
        // (re)build after a reload without re-uploading.
        if (normalizedGarment.photo?.startsWith("data:")) {
          try {
            saveBlob(id, "photo", normalizedGarment.photo);
          } catch {
            /* best-effort */
          }
        }

        // The studio rendering was already generated + cached on the record
        // above (sync, infallible) — nothing to warm, nothing to await.
        // The background-removed composite builds async alongside it: save
        // first (never block the upload on ONNX), enhance right after. The
        // original photo stays untouched; GarmentPhoto shows the SVG until
        // the composite lands, then swaps automatically.
        // Phase 4: the img2img final is marked pending here so the detail
        // sheet can show progress, but the single enhance call fires from
        // runStudioCompositeJob's completion (composite-first input). The
        // upload itself never awaits any of it.
        if (normalizedGarment.photo && !normalizedGarment.studioComposite) {
          set((s) => ({
            garments: s.garments.map((garment) =>
              garment.id === id
                ? {
                    ...garment,
                    studioCompositeStatus: "pending" as const,
                    studioRenderStatus: "pending" as const,
                  }
                : garment
            ),
          }));
          runStudioCompositeJob(id);
        }
        const user = get().user;
        if (!user || user.isDemo) {
          // Demo/mock mode: on-device only — nothing to sync.
          set((s) => ({
            garments: s.garments.map(garment =>
              garment.id === id ? { ...garment, syncStatus: "synced" as const } : garment
            ),
            _syncState: {
              ...s._syncState,
              pendingGarments: without(toSet(s._syncState.pendingGarments), id),
              errorGarments: without(toSet(s._syncState.errorGarments), id),
            }
          }));
          return;
        }

        // Live mode: attempt cloud sync (silent on failure — stays on-device).
        // Bounded: Supabase-JS has no default timeout, so a hung upload
        // used to strand the record in "pending" forever. Timing out lands
        // it on "error" where the silent retry sweep picks it up later.
        try {
          await withTimeout(
            insertGarmentRow(user.id, normalizedGarment),
            30_000,
            "Cloud save"
          );
          set((s) => ({
            garments: s.garments.map(garment =>
              garment.id === id ? { ...garment, syncStatus: "synced" as const } : garment
            ),
            _syncState: {
              ...s._syncState,
              pendingGarments: without(toSet(s._syncState.pendingGarments), id),
              errorGarments: without(toSet(s._syncState.errorGarments), id),
            }
          }));
        } catch (error: unknown) {
          console.warn("addGarment background sync deferred:", error);
          set((s) => ({
            garments: s.garments.map(garment =>
              garment.id === id ? { ...garment, syncStatus: "error" as const } : garment
            ),
            _syncState: {
              ...s._syncState,
              pendingGarments: without(toSet(s._syncState.pendingGarments), id),
              errorGarments: new Set(toSet(s._syncState.errorGarments)).add(id),
            }
          }));
        }
      },
      backfillRendering: (id) => {
        // One-shot generate-and-cache for records that predate renderings.
        // Looks hold snapshot copies, so refresh those too.
        const apply = (g: Garment): Garment =>
          g.id === id ? ensureRendering({ ...g }) : g;
        const fixOutfit = (o: Record<string, Garment | undefined>) => {
          const next = { ...o };
          for (const k of Object.keys(next)) {
            const piece = next[k];
            if (piece && piece.id === id) next[k] = ensureRendering({ ...piece });
          }
          return next;
        };
        set((s) => ({
          garments: s.garments.map(apply),
          looks: s.looks.map((l) => ({ ...l, outfit: fixOutfit(l.outfit as Record<string, Garment | undefined>) as typeof l.outfit })),
          today: s.today
            ? { ...s.today, outfit: fixOutfit(s.today.outfit as Record<string, Garment | undefined>) as typeof s.today.outfit }
            : s.today,
        }));
      },
      retryStudioComposite: (id) => {
        // Manual (re)build from the DetailSheet: needs a photo to segment.
        // Marks pending so GarmentPhoto can show progress, then runs the
        // same serialised background job as the upload path.
        const g = get().garments.find((x) => x.id === id);
        if (
          !g ||
          !g.photo ||
          studioCompositeInFlight.has(id) ||
          studioCompositeQueue.includes(id)
        )
          return;
        set((s) => ({
          garments: s.garments.map((x) =>
            x.id === id ? { ...x, studioCompositeStatus: "pending" as const } : x
          ),
        }));
        runStudioCompositeJob(id);
      },
      retryStudioRender: (id) => {
        // Manual retry for the Phase 4 img2img final (failed / never-ran).
        // Needs a composite or photo as input; skips when the final is
        // already cached or a job is in flight (one call per garment —
        // quota guard). Failures return to "failed" with SVG fallback.
        const g = get().garments.find((x) => x.id === id);
        if (!g || g.studioRenderUrl || studioEnhanceInFlight.has(id)) return;
        if (!g.studioComposite && !g.photo) return;
        set((s) => ({
          garments: s.garments.map((x) =>
            x.id === id ? { ...x, studioRenderStatus: "pending" as const } : x
          ),
        }));
        runStudioEnhanceJob(id);
      },
      /* ---------------- Phase 5 closet upgrade (opt-in) --------------- */
      startClosetUpgrade: () => {
        // Explicit opt-in only — never auto-started (quota surprise guard).
        // Snapshots the eligible set, kicks the first item immediately for
        // responsiveness, then paces the rest. Fully cancellable/resumable;
        // the user keeps using the app between ticks.
        const s = get();
        const user = s.user;
        if (!user || user.isDemo) {
          s.notify("Sign in to upgrade your closet", "err");
          return;
        }
        // Resume a paused run (keeps original total for stable progress).
        if (
          (s.closetUpgrade.status === "paused" ||
            s.closetUpgrade.status === "quota-paused") &&
          s.closetUpgrade.initialIds.length > 0
        ) {
          const still = s.closetUpgrade.queued.filter((id) =>
            s.garments.some(
              (g) => g.id === id && !g.studioRenderUrl && (g.photo || g.studioComposite)
            )
          );
          // Re-top-up with garments added while paused (never duplicates).
          const known = new Set([
            ...s.closetUpgrade.initialIds,
            ...still,
          ]);
          const fresh = eligibleUpgradeIds(s.garments).filter((id) => !known.has(id));
          const initialIds = [...s.closetUpgrade.initialIds, ...fresh];
          set({
            closetUpgrade: {
              ...s.closetUpgrade,
              initialIds,
              queued: [...still, ...fresh],
              total: initialIds.length,
              status: "running" as const,
              currentId: null,
              completedAt: null,
            },
          });
          pumpClosetUpgrade();
          return;
        }
        if (s.closetUpgrade.status === "running") return;
        const ids = eligibleUpgradeIds(s.garments);
        if (ids.length === 0) {
          s.notify("Everything already has the studio finish");
          return;
        }
        set({
          closetUpgrade: {
            status: "running" as const,
            initialIds: ids,
            queued: ids,
            currentId: null,
            total: ids.length,
            startedAt: Date.now(),
            completedAt: null,
          },
        });
        s.notify(`Upgrading ${ids.length} item${ids.length > 1 ? "s" : ""} in the background`);
        pumpClosetUpgrade();
      },
      pauseClosetUpgrade: () => {
        clearUpgradeTimer();
        const s = get();
        if (s.closetUpgrade.status !== "running") return;
        set({
          closetUpgrade: { ...s.closetUpgrade, status: "paused" as const, currentId: null },
        });
      },
      cancelClosetUpgrade: () => {
        clearUpgradeTimer();
        set({ closetUpgrade: { ...IDLE_UPGRADE } });
      },
      dismissClosetUpgrade: () => {
        clearUpgradeTimer();
        set({ closetUpgrade: { ...IDLE_UPGRADE } });
      },
      removeGarment: (id) => {
        const user = get().user;
        // Get userId for storage cleanup before removing from state
        const userId = user?.id;
        // Drop any queued composite work + stored blobs for the garment.
        const qIdx = studioCompositeQueue.indexOf(id);
        if (qIdx >= 0) studioCompositeQueue.splice(qIdx, 1);
        try {
          deleteBlobsFor(id);
        } catch {
          /* best-effort */
        }
        set((s) => ({
          garments: s.garments.filter((g) => g.id !== id),
          closetUpgrade:
            s.closetUpgrade.initialIds.includes(id) || s.closetUpgrade.queued.includes(id)
              ? {
                  ...s.closetUpgrade,
                  initialIds: s.closetUpgrade.initialIds.filter((x) => x !== id),
                  queued: s.closetUpgrade.queued.filter((x) => x !== id),
                  total: Math.max(0, s.closetUpgrade.total - 1),
                  currentId: s.closetUpgrade.currentId === id ? null : s.closetUpgrade.currentId,
                }
              : s.closetUpgrade,
          _syncState: {
            ...s._syncState,
            pendingGarments: without(toSet(s._syncState.pendingGarments), id),
            errorGarments: without(toSet(s._syncState.errorGarments), id),
          },
        }));
        if (user && !user.isDemo && isUuidLike(id)) {
          void deleteGarmentRow(id, userId ?? "").catch(() => {});
        }
      },
      restoreSamples: () => {
        const have = new Set(get().garments.map((g) => g.id));
        const merged = [
          ...get().garments,
          ...getDemoWardrobe().filter((g) => !have.has(g.id)),
        ];
        set({ garments: merged });
        get().notify("Sample closet loaded");
      },
      clearAllData: () => {
        clearUpgradeTimer();
        studioCompositeQueue.length = 0;
        try {
          clearBlobs();
        } catch {
          /* best-effort */
        }
        set({ garments: [], looks: [], today: null, generation: IDLE_GEN, stylePrefs: null, closetUpgrade: { ...IDLE_UPGRADE } });
        get().notify("Local data erased");
      },

      refreshWeather: async () => {
        set({ weather: { status: "loading", data: get().weather.data } });
        try {
          const data = await fetchWeather();
          set({ weather: { status: "ready", data } });
        } catch {
          set({ weather: { status: "error", data: get().weather.data } });
        }
      },

      generateToday: async (occasion = "casual") => {
        const { garments, weather } = get();
        if (garments.length === 0) return;
        try {
          const result = await generateStyle(garments, occasion, weather.data);
          set({ today: result });
        } catch (e) {
          get().notify(e instanceof Error ? e.message : "Could not style today", "err");
        }
      },

      generateForStudio: async (occasion, prompt = "") => {
        set({
          generation: { status: "working", occasion, result: null, error: null },
        });
        const { garments, weather } = get();
        try {
          const result = await generateStyle(garments, occasion, weather.data, prompt);
          set({
            generation: { status: "done", occasion, result, error: null },
          });
        } catch (e) {
          set({
            generation: {
              status: "error",
              occasion,
              result: null,
              error: e instanceof Error ? e.message : "Styling failed",
            },
          });
        }
      },

      setStudioResult: (result) => {
        set((s) => ({
          generation: { status: "done", occasion: result.occasion, result, error: null },
        }));
      },

      saveLook: async (result, name) => {
        const wx = get().weather.data;
        // Generate stable UUID upfront for sync consistency
        const id = crypto.randomUUID();
        const look: SavedLook = {
          id,
          name:
            name?.trim() ||
            `${OCCASION_META[result.occasion].label} look ${get().looks.length + 1}`,
          occasion: result.occasion,
          outfit: result.outfit,
          rationale: result.rationale,
          engine: result.engine,
          weatherTags: wx ? [wx.bucket, wx.isRain ? "rain" : "dry"] : [],
          createdAt: Date.now(),
          syncStatus: "pending",
        };
        set((s) => ({
          looks: [look, ...s.looks].slice(0, 40),
          _syncState: {
            ...s._syncState,
            pendingLooks: new Set(toSet(s._syncState.pendingLooks)).add(id),
          }
        }));
        get().notify(`Saved "${look.name}"`);

        const user = get().user;
        if (!user || user.isDemo) {
          // Demo/mock mode: on-device only — nothing to sync.
          set((s) => ({
            looks: s.looks.map(l =>
              l.id === id ? { ...l, syncStatus: "synced" as const } : l
            ),
            _syncState: {
              ...s._syncState,
              pendingLooks: without(toSet(s._syncState.pendingLooks), id),
              errorLooks: without(toSet(s._syncState.errorLooks), id),
            }
          }));
          return look;
        }

        // Live mode: attempt cloud sync (silent on failure).
        try {
          await insertOutfitRow(user.id, look);
          set((s) => ({
            looks: s.looks.map(l =>
              l.id === id ? { ...l, syncStatus: "synced" as const } : l
            ),
            _syncState: {
              ...s._syncState,
              pendingLooks: without(toSet(s._syncState.pendingLooks), id),
              errorLooks: without(toSet(s._syncState.errorLooks), id),
            }
          }));
        } catch (error: unknown) {
          console.warn("saveLook background sync deferred:", error);
          set((s) => ({
            looks: s.looks.map(l =>
              l.id === id ? { ...l, syncStatus: "error" as const } : l
            ),
            _syncState: {
              ...s._syncState,
              pendingLooks: without(toSet(s._syncState.pendingLooks), id),
              errorLooks: new Set(toSet(s._syncState.errorLooks)).add(id),
            }
          }));
        }
        return look;
      },
      deleteLook: (id) => {
        set((s) => ({
          looks: s.looks.filter((l) => l.id !== id),
          _syncState: {
            ...s._syncState,
            pendingLooks: without(toSet(s._syncState.pendingLooks), id),
            errorLooks: without(toSet(s._syncState.errorLooks), id),
          },
        }));
        get().notify("Look deleted");
        const user = get().user;
        if (user && !user.isDemo && isUuidLike(id)) {
          void deleteOutfitRow(id).catch(() => {});
        }
      },
      updateLookTags: async (id, tags) => {
        const look = get().looks.find((l) => l.id === id);
        if (!look) return;
        const updated: SavedLook = { ...look, tags };
        set((s) => ({
          looks: s.looks.map((l) => (l.id === id ? updated : l)),
        }));
        const user = get().user;
        if (!user || user.isDemo) return;
        try {
          await insertOutfitRow(user.id, updated);
        } catch (error: unknown) {
          // Silent: tags are saved locally; cloud follows when reachable.
          console.warn("updateLookTags background sync deferred:", error);
        }
      },

      scheduleLook: async (date, lookId) => {
        // Generate stable UUID for the schedule row
        const id = crypto.randomUUID();
        const user = get().user;
        
        // Optimistic local update first
        const newSchedule: Schedule = {
          id,
          userId: user?.id ?? "",
          outfitId: lookId,
          scheduledDate: date,
          createdAt: Date.now(),
        };
        
        // Remove any existing schedule for this date (enforce one per day)
        set((s) => ({
          schedules: [newSchedule, ...s.schedules.filter(sch => sch.scheduledDate !== date)],
        }));
        
        if (!user || user.isDemo) return;

        // Sync to cloud in background (silent on failure — saved locally).
        try {
          await upsertScheduleRow(user.id, { id, outfitId: lookId, scheduledDate: date });
        } catch (error: unknown) {
          console.warn("scheduleLook background sync deferred:", error);
        }
      },
      
      clearSchedule: async (date) => {
        const user = get().user;
        const scheduleToDelete = get().schedules.find(s => s.scheduledDate === date);
        
        // Optimistic local removal
        set((s) => ({
          schedules: s.schedules.filter(sch => sch.scheduledDate !== date),
        }));
        
        if (!user || user.isDemo || !scheduleToDelete) return;

        // Sync to cloud in background (silent on failure).
        try {
          await deleteScheduleRow(scheduleToDelete.id);
        } catch (error: unknown) {
          console.warn("clearSchedule background sync deferred:", error);
        }
      },

      /* --------------------------- sync retry ---------------------------- */
      retrySync: async () => {
        const { user, garments, looks, _syncState } = get();
        if (!user || user.isDemo) return; // demo/mock mode is on-device only
        if (typeof navigator !== "undefined" && navigator.onLine === false) return;

        // Drop queue entries that can never succeed: deleted items and
        // legacy local ids that are not valid Postgres uuids.
        const garmentIds = new Set(garments.map((g) => g.id));
        const lookIds = new Set(looks.map((l) => l.id));
        const garmentQueue = sanitizeIds(
          [...toSet(_syncState.pendingGarments), ...toSet(_syncState.errorGarments)],
          garmentIds
        );
        const lookQueue = sanitizeIds(
          [...toSet(_syncState.pendingLooks), ...toSet(_syncState.errorLooks)],
          lookIds
        );
        set({
          _syncState: {
            pendingGarments: new Set(garmentQueue),
            errorGarments: new Set<string>(),
            pendingLooks: new Set(lookQueue),
            errorLooks: new Set<string>(),
          },
        });
        if (garmentQueue.length === 0 && lookQueue.length === 0) return;

        // One quiet pass, sequential with a small pause. Failures stay
        // queued silently for the next online event — never a toast.
        for (const id of garmentQueue) {
          const garment = get().garments.find((g) => g.id === id);
          if (!garment) {
            set((s) => ({
              _syncState: {
                ...s._syncState,
                pendingGarments: without(toSet(s._syncState.pendingGarments), id),
              },
            }));
            continue;
          }
          try {
            await insertGarmentRow(user.id, garment);
            if (get().user?.id !== user.id) return; // account changed mid-sweep
            set((s) => ({
              garments: s.garments.map((g) =>
                g.id === id ? { ...g, syncStatus: "synced" as const } : g
              ),
              _syncState: {
                ...s._syncState,
                pendingGarments: without(toSet(s._syncState.pendingGarments), id),
                errorGarments: without(toSet(s._syncState.errorGarments), id),
              },
            }));
          } catch (error: unknown) {
            console.warn("retrySync garment deferred:", id, error);
            set((s) => ({
              garments: s.garments.map((g) =>
                g.id === id ? { ...g, syncStatus: "error" as const } : g
              ),
              _syncState: {
                ...s._syncState,
                pendingGarments: without(toSet(s._syncState.pendingGarments), id),
                errorGarments: new Set(toSet(s._syncState.errorGarments)).add(id),
              },
            }));
          }
          await new Promise((r) => setTimeout(r, 350));
        }

        for (const id of lookQueue) {
          const look = get().looks.find((l) => l.id === id);
          if (!look) {
            set((s) => ({
              _syncState: {
                ...s._syncState,
                pendingLooks: without(toSet(s._syncState.pendingLooks), id),
              },
            }));
            continue;
          }
          try {
            await insertOutfitRow(user.id, look);
            if (get().user?.id !== user.id) return;
            set((s) => ({
              looks: s.looks.map((l) =>
                l.id === id ? { ...l, syncStatus: "synced" as const } : l
              ),
              _syncState: {
                ...s._syncState,
                pendingLooks: without(toSet(s._syncState.pendingLooks), id),
                errorLooks: without(toSet(s._syncState.errorLooks), id),
              },
            }));
          } catch (error: unknown) {
            console.warn("retrySync look deferred:", id, error);
            set((s) => ({
              looks: s.looks.map((l) =>
                l.id === id ? { ...l, syncStatus: "error" as const } : l
              ),
              _syncState: {
                ...s._syncState,
                pendingLooks: without(toSet(s._syncState.pendingLooks), id),
                errorLooks: new Set(toSet(s._syncState.errorLooks)).add(id),
              },
            }));
          }
          await new Promise((r) => setTimeout(r, 350));
        }
      },

      notify: (text, tone = "ok") =>
        set({ toast: { id: Date.now(), text, tone } }),
      clearToast: () => set({ toast: null }),
    }),
    {
      name: "fitflow-store",
      version: 10,
      storage: safeStorage,
      // Rehydrated _syncState arrives as string[] (see partialize); restore
      // Sets so every selector/mutator can treat them uniformly.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as unknown as Record<string, unknown>;
        const c = (current ?? {}) as unknown as Record<string, unknown>;
        const sync = (p._syncState ?? {}) as Record<string, unknown>;
        // Validate shapes before spreading: a corrupt snapshot (bad tab,
        // non-array garments, trashed queues) used to throw at render time
        // and erase the whole app via the top boundary. Anything invalid
        // falls back to the fresh-install default for that slice.
        const VALID_TABS = ["home", "closet", "studio", "looks", "calendar"];
        const tab =
          typeof p.tab === "string" && VALID_TABS.includes(p.tab)
            ? p.tab
            : c.tab;
        const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
        const garments = asArray(p.garments).filter(
          (g): g is Record<string, unknown> =>
            !!g && typeof g === "object" && typeof (g as { id?: unknown }).id === "string"
        );
        const validGarmentIds = new Set(
          garments.map((g) => (g as { id: string }).id)
        );
        const upgradeRaw = (p.closetUpgrade ?? {}) as Record<string, unknown>;
        const upgradeQueued = asArray(upgradeRaw.queued).filter(
          (id): id is string => typeof id === "string" && validGarmentIds.has(id)
        );
        const upgradeInitial = asArray(upgradeRaw.initialIds).filter(
          (id): id is string => typeof id === "string" && validGarmentIds.has(id)
        );
        return {
          ...(c as object),
          ...(p as object),
          tab,
          garments,
          looks: asArray(p.looks),
          schedules: asArray(p.schedules),
          onboardedUsers: asArray(p.onboardedUsers),
          closetUpgrade: {
            ...IDLE_UPGRADE,
            ...(typeof upgradeRaw === "object" ? upgradeRaw : {}),
            initialIds: upgradeInitial,
            queued: upgradeQueued,
            // Never rehydrate mid-run: quota must not burn without a tap.
            // A paused/quota-paused/done run survives (resumable); a
            // "running" snapshot parks as paused.
            status:
              upgradeRaw.status === "paused" ||
              upgradeRaw.status === "quota-paused" ||
              upgradeRaw.status === "done"
                ? upgradeRaw.status
                : ("idle" as const),
            currentId: null,
          },
          _syncState: {
            pendingGarments: toSet(sync.pendingGarments),
            pendingLooks: toSet(sync.pendingLooks),
            errorGarments: toSet(sync.errorGarments),
            errorLooks: toSet(sync.errorLooks),
          },
        } as never;
      },
      migrate: (persisted, version) => {
        // v1 (Phase 0) → v2: keep user data, add new session fields.
        // Falls through (no early return): a v1 snapshot must still pass
        // through every later migration or records arrive missing fields
        // (e.g. `colors`) that render-time code used to throw on.
        let state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2) {
          state = {
            ...state,
            ownerId: null,
            onboardedUsers: [],
            stylePrefs: null,
          };
        }
        // v2 → v3: backfill colors/pattern fields on garments for backward compatibility
        if (version < 3) {
          state = {
            ...state,
            garments: ((state as any).garments ?? []).map((g: any) => ({
              ...g,
              colors: g.colors?.length ? g.colors : [g.color],
              pattern: g.pattern ?? "solid",
            })),
            looks: ((state as any).looks ?? []).map((look: any) => ({
              ...look,
              outfit: {
                top: look.outfit?.top ? { ...look.outfit.top, colors: look.outfit.top.colors?.length ? look.outfit.top.colors : [look.outfit.top.color], pattern: look.outfit.top.pattern ?? "solid" } : undefined,
                bottom: look.outfit?.bottom ? { ...look.outfit.bottom, colors: look.outfit.bottom.colors?.length ? look.outfit.bottom.colors : [look.outfit.bottom.color], pattern: look.outfit.bottom.pattern ?? "solid" } : undefined,
                dress: look.outfit?.dress ? { ...look.outfit.dress, colors: look.outfit.dress.colors?.length ? look.outfit.dress.colors : [look.outfit.dress.color], pattern: look.outfit.dress.pattern ?? "solid" } : undefined,
                outer: look.outfit?.outer ? { ...look.outfit.outer, colors: look.outfit.outer.colors?.length ? look.outfit.outer.colors : [look.outfit.outer.color], pattern: look.outfit.outer.pattern ?? "solid" } : undefined,
                shoes: look.outfit?.shoes ? { ...look.outfit.shoes, colors: look.outfit.shoes.colors?.length ? look.outfit.shoes.colors : [look.outfit.shoes.color], pattern: look.outfit.shoes.pattern ?? "solid" } : undefined,
                accessory: look.outfit?.accessory ? { ...look.outfit.accessory, colors: look.outfit.accessory.colors?.length ? look.outfit.accessory.colors : [look.outfit.accessory.color], pattern: look.outfit.accessory.pattern ?? "solid" } : undefined,
              },
            })),
          };
        }
        // v3 → v4: add schedules array and tags field to looks
        if (version < 4) {
          state = {
            ...state,
            schedules: [] as Schedule[],
            looks: ((state as any).looks ?? []).map((look: any) => ({
              ...look,
              tags: look.tags ?? [],
            })),
          };
        }
        // v4 → v5: scrub sync queues — drop non-uuid legacy ids and ids for
        // items that no longer exist; mark everything else synced on-device.
        // This one-time cleanup is what stops the phantom boot error toast.
        if (version < 5) {
          const garments = ((state as any).garments ?? []) as Array<{ id: string }>;
          const looks = ((state as any).looks ?? []) as Array<{ id: string }>;
          const gIds = new Set(garments.map((g) => g.id));
          const lIds = new Set(looks.map((l) => l.id));
          const sync = ((state as any)._syncState ?? {}) as Record<string, unknown>;
          const cleanGarments = sanitizeIds(
            [...toSet(sync.pendingGarments), ...toSet(sync.errorGarments)],
            gIds
          );
          const cleanLooks = sanitizeIds(
            [...toSet(sync.pendingLooks), ...toSet(sync.errorLooks)],
            lIds
          );
          const queued = new Set([...cleanGarments, ...cleanLooks]);
          state = {
            ...state,
            garments: garments.map((g: any) => ({
              ...g,
              syncStatus: queued.has(g.id) ? "pending" : "synced",
            })),
            looks: looks.map((l: any) => ({
              ...l,
              syncStatus: queued.has(l.id) ? "pending" : "synced",
            })),
            _syncState: {
              pendingGarments: cleanGarments,
              pendingLooks: cleanLooks,
              errorGarments: [],
              errorLooks: [],
            },
          };
        }
        // v5 → v6: generate-and-cache studio renderings on every garment,
        // including snapshot copies inside saved looks and today's outfit.
        // Records without one predate the renderer — backfill, don't drop.
        if (version < 6) {
          const fixG = (g: any) => {
            try {
              return ensureRendering({ ...g });
            } catch {
              return { ...g, renderStatus: "failed" as const };
            }
          };
          const fixOutfit = (o: any) => {
            if (!o || typeof o !== "object") return o;
            const next = { ...o };
            for (const k of Object.keys(next)) {
              if (next[k]?.id) next[k] = fixG(next[k]);
            }
            return next;
          };
          state = {
            ...state,
            garments: ((state as any).garments ?? []).map(fixG),
            looks: ((state as any).looks ?? []).map((l: any) => ({
              ...l,
              outfit: fixOutfit(l.outfit),
            })),
            today: (state as any).today
              ? { ...(state as any).today, outfit: fixOutfit((state as any).today.outfit) }
              : (state as any).today,
          };
        }
        // v6 → v7: studio-composite is garment-local only. Strip composites
        // cached inside look/today snapshots (quota hygiene + a persisted
        // "pending" there could never resolve); the SVG rendering fallback
        // stays on every snapshot. Live garments are untouched — boot
        // resumes any genuinely pending job.
        if (version < 7) {
          const stripSnap = (g: any) => {
            if (!g || typeof g !== "object") return g;
            const { studioComposite: _c, studioCompositeStatus: _s, ...rest } = g;
            void _c;
            void _s;
            return rest;
          };
          const stripOutfit = (o: any) => {
            if (!o || typeof o !== "object") return o;
            const next = { ...o };
            for (const k of Object.keys(next)) next[k] = stripSnap(next[k]);
            return next;
          };
          state = {
            ...state,
            looks: ((state as any).looks ?? []).map((l: any) => ({
              ...l,
              outfit: stripOutfit(l.outfit),
            })),
            today: (state as any).today
              ? { ...(state as any).today, outfit: stripOutfit((state as any).today.outfit) }
              : (state as any).today,
          };
        }
        // v7 → v8 (Phase 4): studio_render_url is garment-local like the
        // composite — a persisted "pending" inside snapshots could never
        // resolve and would risk a reload burst. Strip pending enhance
        // state from snapshots; live garments untouched (boot resumes).
        // studioRenderUrl *URLs* (small strings) stay on snapshots so saved
        // looks keep showing the final when it exists; SVG fallback covers
        // the rest.
        if (version < 8) {
          const stripSnap = (g: any) => {
            if (!g || typeof g !== "object") return g;
            if (g.studioRenderStatus === "pending" && !g.studioRenderUrl) {
              const { studioRenderStatus: _s, ...rest } = g;
              void _s;
              return rest;
            }
            return g;
          };
          const stripOutfit = (o: any) => {
            if (!o || typeof o !== "object") return o;
            const next = { ...o };
            for (const k of Object.keys(next)) next[k] = stripSnap(next[k]);
            return next;
          };
          state = {
            ...state,
            looks: ((state as any).looks ?? []).map((l: any) => ({
              ...l,
              outfit: stripOutfit(l.outfit),
            })),
            today: (state as any).today
              ? { ...(state as any).today, outfit: stripOutfit((state as any).today.outfit) }
              : (state as any).today,
          };
        }
        // v8 → v9 (Phase 5): closet-upgrade queue is explicit opt-in state.
        // Old snapshots predate it — initialise idle. A "running" snapshot
        // (reload mid-run) parks as "paused" so quota can't burn without a
        // fresh tap; queued ids are re-validated against live garments.
        if (version < 9) {
          const prev = (state as any).closetUpgrade as
            | ClosetUpgradeState
            | undefined;
          const garmentIds = new Set(
            (((state as any).garments ?? []) as Array<{ id: string }>).map((g) => g.id)
          );
          if (!prev || typeof prev !== "object") {
            state = { ...state, closetUpgrade: { ...IDLE_UPGRADE } };
          } else {
            const queued = (prev.queued ?? []).filter((id: string) => garmentIds.has(id));
            const initialIds = (prev.initialIds ?? []).filter((id: string) =>
              garmentIds.has(id)
            );
            state = {
              ...state,
              closetUpgrade: {
                ...IDLE_UPGRADE,
                initialIds,
                queued,
                total: prev.total ?? initialIds.length,
                startedAt: prev.startedAt ?? null,
                status:
                  prev.status === "running" ? ("paused" as const) : (prev.status ?? "idle"),
              },
            };
          }
        }
        // v9 → v10 (speed): image blobs moved to IndexedDB — localStorage
        // snapshots no longer carry them. Nothing to transform: in-memory
        // blobs backfill IDB at boot (rehydrateBlobs) and the next persist
        // write slims itself. Park a mid-run upgrade as paused (same quota
        // rule as before).
        if (version < 10) {
          const prev = (state as any).closetUpgrade as
            | ClosetUpgradeState
            | undefined;
          if (prev && typeof prev === "object" && prev.status === "running") {
            state = {
              ...state,
              closetUpgrade: { ...prev, status: "paused" as const, currentId: null },
            };
          }
        }
        return state as never;
      },
      partialize: (s) => ({
        theme: s.theme,
        units: s.units,
        // Lean snapshots: image blobs live in IndexedDB (see blobStore),
        // never in localStorage. A 40-item closet of ~100 KB composites is
        // ~4 MB of JSON stringify/parse on EVERY store write — jank plus a
        // quota wall. SVG `rendering` + `studioRenderUrl` strings (a few KB
        // each) stay: tiles paint instantly from this snapshot alone, and
        // blobs merge back silently at boot (rehydrateBlobs).
        garments: s.garments.map((g) => ({
          ...g,
          photo: undefined,
          studioComposite: undefined,
        })),
        // Snapshots carry the SVG rendering as their display image; photo
        // sources + ~100 KB studio-composite JPEGs would multiply
        // localStorage usage per snapshot and risk quota failure. Live
        // garments keep their blobs in IndexedDB instead.
        looks: s.looks.map((l) => ({
          ...l,
          outfit: Object.fromEntries(
            Object.entries(l.outfit).map(([k, g]) => [
              k,
              g
                ? {
                    ...g,
                    photo: undefined,
                    studioComposite: undefined,
                    studioCompositeStatus: undefined,
                  }
                : g,
            ])
          ) as typeof l.outfit,
        })),
        schedules: s.schedules,
        today: s.today
          ? {
              ...s.today,
              outfit: Object.fromEntries(
                Object.entries(s.today.outfit).map(([k, g]) => [
                  k,
                  g
                    ? {
                        ...g,
                        photo: undefined,
                        studioComposite: undefined,
                        studioCompositeStatus: undefined,
                      }
                    : g,
                ])
              ) as typeof s.today.outfit,
            }
          : s.today,
        ownerId: s.ownerId,
        onboardedUsers: s.onboardedUsers,
        profile: s.profile,
        stylePrefs: s.stylePrefs,
        _syncState: {
          pendingGarments: Array.from(toSet(s._syncState.pendingGarments)),
          pendingLooks: Array.from(toSet(s._syncState.pendingLooks)),
          errorGarments: Array.from(toSet(s._syncState.errorGarments)),
          errorLooks: Array.from(toSet(s._syncState.errorLooks)),
        },
        // Phase 5 upgrade queue (small id arrays — safe for localStorage).
        // Persisted so progress survives a reload; a "running" snapshot is
        // parked as "paused" on rehydrate + boot (explicit resume only).
        closetUpgrade: s.closetUpgrade.status === "running"
          ? { ...s.closetUpgrade, status: "paused" as const, currentId: null }
          : s.closetUpgrade,
      }),
    }
  )
);

// Quietly sweep the sync queue when connectivity returns. Silent by design:
// the closet is fully usable on-device, cloud follows when it can.
if (typeof window !== "undefined") {
  let onlineTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener("online", () => {
    if (onlineTimer) clearTimeout(onlineTimer);
    onlineTimer = setTimeout(() => {
      void useAppStore.getState().retrySync().catch(() => {});
    }, 3000);
  });
}

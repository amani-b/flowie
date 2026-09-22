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
import { DEMO_OUTFITS, DEMO_WARDROBE } from "../lib/mock";
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
import { OCCASION_META, uid } from "../lib/utils";
import { supabase } from "../services/supabaseClient";

interface WeatherState {
  status: LoadStatus;
  data: WeatherNow | null;
}

type SyncStatus = "synced" | "pending" | "error";

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
let studioCompositeChain: Promise<void> = Promise.resolve();

function runStudioCompositeJob(id: string): void {
  if (studioCompositeInFlight.has(id)) return;
  studioCompositeInFlight.add(id);
  studioCompositeChain = studioCompositeChain.then(async () => {
    try {
      const current = useAppStore.getState().garments.find((g) => g.id === id);
      const source = current?.photo;
      // Photo is the only input: nothing to segment (e.g. a manual entry
      // with no photo, or a record whose base64 was stripped from storage)
      // → leave the SVG fallback in place, don't mark failed.
      if (!current || !source) return;
      const { preprocessGarmentPhoto } = await import(
        "../services/studioComposite"
      );
      const result = await preprocessGarmentPhoto(source);
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
  });
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
        unsubAuth?.();
        unsubAuth = subscribeAuth((u) => {
          if (u) {
            get().completeAuth(u);
            return;
          }
          const current = get().user;
          if (current && !current.isDemo) {
            set({ user: null, ownerId: null, authStatus: "signedOut", ...EMPTY_DATA });
          }
        });
        
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
          if (state.garments.length === 0) patch.garments = DEMO_WARDROBE;
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
        try {
          await insertGarmentRow(user.id, normalizedGarment);
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
        if (!g || !g.photo || studioCompositeInFlight.has(id)) return;
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
      removeGarment: (id) => {
        const user = get().user;
        // Get userId for storage cleanup before removing from state
        const userId = user?.id;
        set((s) => ({
          garments: s.garments.filter((g) => g.id !== id),
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
          ...DEMO_WARDROBE.filter((g) => !have.has(g.id)),
        ];
        set({ garments: merged });
        get().notify("Sample closet loaded");
      },
      clearAllData: () => {
        set({ garments: [], looks: [], today: null, generation: IDLE_GEN, stylePrefs: null });
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
      version: 8,
      storage: safeStorage,
      // Rehydrated _syncState arrives as string[] (see partialize); restore
      // Sets so every selector/mutator can treat them uniformly.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as unknown as Record<string, unknown>;
        const c = (current ?? {}) as unknown as Record<string, unknown>;
        const sync = (p._syncState ?? {}) as Record<string, unknown>;
        return {
          ...(c as object),
          ...(p as object),
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
        const state = (persisted ?? {}) as Record<string, unknown>;
        if (version < 2) {
          return {
            ...state,
            ownerId: null,
            onboardedUsers: [],
            stylePrefs: null,
          } as never;
        }
        // v2 → v3: backfill colors/pattern fields on garments for backward compatibility
        if (version < 3) {
          const newState = {
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
          return newState as never;
        }
        // v3 → v4: add schedules array and tags field to looks
        if (version < 4) {
          const newState = {
            ...state,
            schedules: [] as Schedule[],
            looks: ((state as any).looks ?? []).map((look: any) => ({
              ...look,
              tags: look.tags ?? [],
            })),
          };
          return newState as never;
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
          return {
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
          } as never;
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
          return {
            ...state,
            garments: ((state as any).garments ?? []).map(fixG),
            looks: ((state as any).looks ?? []).map((l: any) => ({
              ...l,
              outfit: fixOutfit(l.outfit),
            })),
            today: (state as any).today
              ? { ...(state as any).today, outfit: fixOutfit((state as any).today.outfit) }
              : (state as any).today,
          } as never;
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
          return {
            ...state,
            looks: ((state as any).looks ?? []).map((l: any) => ({
              ...l,
              outfit: stripOutfit(l.outfit),
            })),
            today: (state as any).today
              ? { ...(state as any).today, outfit: stripOutfit((state as any).today.outfit) }
              : (state as any).today,
          } as never;
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
          return {
            ...state,
            looks: ((state as any).looks ?? []).map((l: any) => ({
              ...l,
              outfit: stripOutfit(l.outfit),
            })),
            today: (state as any).today
              ? { ...(state as any).today, outfit: stripOutfit((state as any).today.outfit) }
              : (state as any).today,
          } as never;
        }
        return state as never;
      },
      partialize: (s) => ({
        theme: s.theme,
        units: s.units,
        garments: s.garments.map((g) => ({ ...g, photo: undefined })), // omit base64 photos from localStorage
        // Snapshots carry the SVG rendering as their display image; the
        // ~100 KB studio-composite JPEGs would multiply localStorage usage
        // per snapshot and risk quota failure. Live garments keep theirs.
        looks: s.looks.map((l) => ({
          ...l,
          outfit: Object.fromEntries(
            Object.entries(l.outfit).map(([k, g]) => [
              k,
              g
                ? {
                    ...g,
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

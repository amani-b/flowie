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
          // Only apply if this account is still active.
          if (get().user?.id === user.id) {
            set({ garments, looks, schedules });
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
              set({ garments: retryData.garments, looks: retryData.looks, schedules });
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
        // Generate stable UUID upfront for sync consistency
        const id = crypto.randomUUID();
        
        // Normalize incoming garment to ensure colors/pattern are always present
        const normalizedGarment: Garment = {
          id,
          ...g,
          colors: g.colors?.length ? g.colors : [g.color],
          pattern: g.pattern ?? "solid",
          createdAt: Date.now(),
          syncStatus: "pending",
        };
        
        set((s) => ({
          garments: [normalizedGarment, ...s.garments],
          _syncState: {
            ...s._syncState,
            pendingGarments: new Set(toSet(s._syncState.pendingGarments)).add(id),
          }
        }));

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
      version: 5,
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
        return state as never;
      },
      partialize: (s) => ({
        theme: s.theme,
        units: s.units,
        garments: s.garments.map((g) => ({ ...g, photo: undefined })), // omit base64 photos from localStorage
        looks: s.looks,
        schedules: s.schedules,
        today: s.today,
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

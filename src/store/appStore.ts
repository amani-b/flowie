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
  fetchUserData,
  insertGarmentRow,
  insertOutfitRow,
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

  setTheme: (t: ThemeMode) => void;
  toggleTheme: () => void;
  setUnits: (u: Units) => void;
  setTab: (t: TabId) => void;
  setDrawer: (open: boolean) => void;

  /* ------------------------------- data ------------------------------- */
  garments: Garment[];
  looks: SavedLook[];
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
  generateForStudio: (occasion: Occasion) => Promise<void>;
  saveLook: (result: StyleResult, name?: string) => Promise<SavedLook>;
  deleteLook: (id: string) => void;

  notify: (text: string, tone?: "ok" | "err") => void;
  clearToast: () => void;

  /* --------------------------- sync retry ---------------------------- */
  _syncState: SyncState;
  retrySync: () => Promise<void>;
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
        
        // Trigger initial sync retry for any pending/error items
        setTimeout(() => {
          get().retrySync();
        }, 500);
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
          patch.ownerId = user.id;
          patch.garments = [];
          patch.looks = [];
          patch.today = null;
          patch.generation = IDLE_GEN;
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
          const { garments, looks } = await fetchUserData(user.id);
          // Only apply if this account is still active.
          if (get().user?.id === user.id) {
            set({ garments, looks });
          }
        } catch (error: any) {
          console.error("Error in hydrateFromCloud:", error?.message ?? error, error?.status);
          // Retry once after refreshing session
          try {
            await supabase?.auth.getSession();
            const retryResult = await fetchUserData(user.id);
            if (get().user?.id === user.id) {
              set({ garments: retryResult.garments, looks: retryResult.looks });
            }
            return;
          } catch (retryError: any) {
            console.error("Retry failed in hydrateFromCloud:", retryError?.message ?? retryError, retryError?.status);
          }
          if (get().user?.id === user.id) {
            get().notify("Cloud sync failed — working on-device for now", "err");
          }
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
      garments: [],
      looks: [],
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
            pendingGarments: new Set(s._syncState.pendingGarments).add(id),
          }
        }));
        
        const user = get().user;
        if (!user || user.isDemo) {
          // Demo/mock mode: mark as synced immediately
          set((s) => ({
            garments: s.garments.map(garment => 
              garment.id === id ? { ...garment, syncStatus: "synced" as const } : garment
            ),
            _syncState: {
              ...s._syncState,
              pendingGarments: new Set(s._syncState.pendingGarments).delete(id) as Set<string>,
            }
          }));
          return;
        }
        
        // Live mode: attempt cloud sync
        try {
          await insertGarmentRow(user.id, normalizedGarment);
          set((s) => ({
            garments: s.garments.map(garment => 
              garment.id === id ? { ...garment, syncStatus: "synced" as const } : garment
            ),
            _syncState: {
              ...s._syncState,
              pendingGarments: new Set(s._syncState.pendingGarments).delete(id) as Set<string>,
            }
          }));
        } catch (error: any) {
          console.error("Error in addGarment sync:", error?.message ?? error);
          set((s) => ({
            garments: s.garments.map(garment => 
              garment.id === id ? { ...garment, syncStatus: "error" as const } : garment
            ),
            _syncState: {
              ...s._syncState,
              pendingGarments: new Set(s._syncState.pendingGarments).delete(id) as Set<string>,
              errorGarments: new Set(s._syncState.errorGarments).add(id),
            }
          }));
        }
      },
      removeGarment: (id) => {
        const user = get().user;
        // Get userId for storage cleanup before removing from state
        const userId = user?.id;
        set((s) => ({ garments: s.garments.filter((g) => g.id !== id) }));
        if (user && !user.isDemo && !id.startsWith("g-")) {
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

      generateForStudio: async (occasion) => {
        set({
          generation: { status: "working", occasion, result: null, error: null },
        });
        const { garments, weather } = get();
        try {
          const result = await generateStyle(garments, occasion, weather.data);
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
            pendingLooks: new Set(s._syncState.pendingLooks).add(id),
          }
        }));
        get().notify(`Saved "${look.name}"`);
        
        const user = get().user;
        if (!user || user.isDemo) {
          // Demo/mock mode: mark as synced immediately
          set((s) => ({
            looks: s.looks.map(l => 
              l.id === id ? { ...l, syncStatus: "synced" as const } : l
            ),
            _syncState: {
              ...s._syncState,
              pendingLooks: new Set(s._syncState.pendingLooks).delete(id) as Set<string>,
            }
          }));
          return look;
        }
        
        // Live mode: attempt cloud sync
        try {
          await insertOutfitRow(user.id, look);
          set((s) => ({
            looks: s.looks.map(l => 
              l.id === id ? { ...l, syncStatus: "synced" as const } : l
            ),
            _syncState: {
              ...s._syncState,
              pendingLooks: new Set(s._syncState.pendingLooks).delete(id) as Set<string>,
            }
          }));
        } catch (error: any) {
          console.error("Error in saveLook sync:", error?.message ?? error);
          set((s) => ({
            looks: s.looks.map(l => 
              l.id === id ? { ...l, syncStatus: "error" as const } : l
            ),
            _syncState: {
              ...s._syncState,
              pendingLooks: new Set(s._syncState.pendingLooks).delete(id) as Set<string>,
              errorLooks: new Set(s._syncState.errorLooks).add(id),
            }
          }));
        }
        return look;
      },
      deleteLook: (id) => {
        set((s) => ({ looks: s.looks.filter((l) => l.id !== id) }));
        get().notify("Look deleted");
        const user = get().user;
        if (user && !user.isDemo && !id.startsWith("look-")) {
          void deleteOutfitRow(id).catch(() => {});
        }
      },

      /* --------------------------- sync retry ---------------------------- */
      retrySync: async () => {
        const { user, garments, looks, _syncState } = get();
        if (!user || user.isDemo) return; // Skip for demo/mock mode
        
        let failedCount = 0;
        const maxRetries = 3;
        
        // Retry garments with pending/error status
        const itemsToRetry = [..._syncState.pendingGarments, ..._syncState.errorGarments];
        for (const id of itemsToRetry) {
          const garment = garments.find(g => g.id === id);
          if (!garment) continue;
          
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              await insertGarmentRow(user.id, garment);
              set((s) => ({
                garments: s.garments.map(g => 
                  g.id === id ? { ...g, syncStatus: "synced" as const } : g
                ),
                _syncState: {
                  ...s._syncState,
                  pendingGarments: new Set(s._syncState.pendingGarments).delete(id) as Set<string>,
                  errorGarments: new Set(s._syncState.errorGarments).delete(id) as Set<string>,
                }
              }));
              break;
            } catch (error: any) {
              if (attempt === maxRetries - 1) {
                failedCount++;
                set((s) => ({
                  _syncState: {
                    ...s._syncState,
                    errorGarments: new Set(s._syncState.errorGarments).add(id),
                  }
                }));
              }
              // Small delay between retries
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            }
          }
        }
        
        // Retry looks with pending/error status
        const looksToRetry = [..._syncState.pendingLooks, ..._syncState.errorLooks];
        for (const id of looksToRetry) {
          const look = looks.find(l => l.id === id);
          if (!look) continue;
          
          for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
              await insertOutfitRow(user.id, look);
              set((s) => ({
                looks: s.looks.map(l => 
                  l.id === id ? { ...l, syncStatus: "synced" as const } : l
                ),
                _syncState: {
                  ...s._syncState,
                  pendingLooks: new Set(s._syncState.pendingLooks).delete(id) as Set<string>,
                  errorLooks: new Set(s._syncState.errorLooks).delete(id) as Set<string>,
                }
              }));
              break;
            } catch (error: any) {
              if (attempt === maxRetries - 1) {
                failedCount++;
                set((s) => ({
                  _syncState: {
                    ...s._syncState,
                    errorLooks: new Set(s._syncState.errorLooks).add(id),
                  }
                }));
              }
              // Small delay between retries
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)));
            }
          }
        }
        
        // Show notification if any sync attempts failed
        if (failedCount > 0) {
          get().notify(`${failedCount} item${failedCount > 1 ? 's' : ''} haven't synced yet`, "err");
        }
      },

      notify: (text, tone = "ok") =>
        set({ toast: { id: Date.now(), text, tone } }),
      clearToast: () => set({ toast: null }),
    }),
    {
      name: "fitflow-store",
      version: 3,
      storage: safeStorage,
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
        return state as never;
      },
      partialize: (s) => ({
        theme: s.theme,
        units: s.units,
        garments: s.garments.map((g) => ({ ...g, photo: undefined })), // omit base64 photos from localStorage
        looks: s.looks,
        today: s.today,
        ownerId: s.ownerId,
        onboardedUsers: s.onboardedUsers,
        stylePrefs: s.stylePrefs,
        _syncState: {
          pendingGarments: Array.from(s._syncState.pendingGarments),
          pendingLooks: Array.from(s._syncState.pendingLooks),
          errorGarments: Array.from(s._syncState.errorGarments),
          errorLooks: Array.from(s._syncState.errorLooks),
        },
      }),
    }
  )
);

// Set up online event listener for auto-retry when connection is restored
if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    useAppStore.getState().retrySync();
  });
}

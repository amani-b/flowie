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

interface WeatherState {
  status: LoadStatus;
  data: WeatherNow | null;
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

  addGarment: (g: Garment) => void;
  removeGarment: (id: string) => void;
  restoreSamples: () => void;
  clearAllData: () => void;

  refreshWeather: () => Promise<void>;
  generateToday: (occasion?: Occasion) => Promise<void>;
  generateForStudio: (occasion: Occasion) => Promise<void>;
  saveLook: (result: StyleResult, name?: string) => SavedLook;
  deleteLook: (id: string) => void;

  notify: (text: string, tone?: "ok" | "err") => void;
  clearToast: () => void;
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
        } catch {
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
      addGarment: (g) => {
        set((s) => ({ garments: [g, ...s.garments] }));
        const user = get().user;
        if (user && !user.isDemo) {
          void insertGarmentRow(user.id, g).catch(() =>
            get().notify("Saved locally — cloud sync failed", "err")
          );
        }
      },
      removeGarment: (id) => {
        set((s) => ({ garments: s.garments.filter((g) => g.id !== id) }));
        const user = get().user;
        if (user && !user.isDemo && !id.startsWith("g-")) {
          void deleteGarmentRow(id).catch(() => {});
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

      saveLook: (result, name) => {
        const wx = get().weather.data;
        const look: SavedLook = {
          id: uid("look"),
          name:
            name?.trim() ||
            `${OCCASION_META[result.occasion].label} look ${get().looks.length + 1}`,
          occasion: result.occasion,
          outfit: result.outfit,
          rationale: result.rationale,
          engine: result.engine,
          weatherTags: wx ? [wx.bucket, wx.isRain ? "rain" : "dry"] : [],
          createdAt: Date.now(),
        };
        set((s) => ({ looks: [look, ...s.looks].slice(0, 40) }));
        get().notify(`Saved “${look.name}”`);
        const user = get().user;
        if (user && !user.isDemo) {
          void insertOutfitRow(user.id, look).catch(() =>
            get().notify("Look kept locally — cloud sync failed", "err")
          );
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

      notify: (text, tone = "ok") =>
        set({ toast: { id: Date.now(), text, tone } }),
      clearToast: () => set({ toast: null }),
    }),
    {
      name: "fitflow-store",
      version: 2,
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
      }),
    }
  )
);

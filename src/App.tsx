import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { applyThemeToDom, useAppStore } from "./store/appStore";
import { useIsOnboarded } from "./store/selectors";
import Ambient from "./components/Ambient";
import TopBar from "./components/TopBar";
import BottomNav from "./components/BottomNav";
import Drawer from "./components/Drawer";
import JobBanner from "./components/JobBanner";
import Toast from "./components/Toast";
import ErrorBoundary from "./components/ErrorBoundary";
import { markStage } from "./lib/telemetry";
import AuthScreen from "./screens/AuthScreen";
import AuthCallback from "./screens/AuthCallback";
import Onboarding from "./screens/Onboarding";
import Home from "./screens/Home";
import Closet from "./screens/Closet";
import Studio from "./screens/Studio";
import Looks from "./screens/Looks";
import CalendarView from "./screens/Calendar";
import { LogoMark } from "./components/icons";
import { supabase } from "./services/supabaseClient";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

/**
 * OAuthHashHandler detects an OAuth hash (access_token) in the URL
 * and redirects to /auth/callback to let AuthCallback handle it.
 * This ensures OAuth callbacks work regardless of which path they land on.
 */
function OAuthHashHandler() {
  const navigate = useNavigate();

  useEffect(() => {
    const hash = window.location.hash;
    if (hash && hash.includes("access_token")) {
      const currentPath = window.location.pathname;
      if (currentPath !== "/auth/callback") {
        navigate("/auth/callback" + window.location.search + hash, { replace: true });
      }
    }
  }, [navigate]);

  return null;
}

/**
 * VisibilityChangeHandler manages Supabase auth token refresh based on tab visibility.
 * When the tab is backgrounded (e.g., app switched away, phone locked), we stop
 * auto-refresh to avoid stale tokens. When visible again, we restart it.
 * This prevents cloud sync failures after the app has been backgrounded.
 */
function VisibilityChangeHandler() {
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!supabase) return; // Guard for mock mode

      if (document.visibilityState === "visible") {
        supabase.auth.startAutoRefresh();
      } else {
        supabase.auth.stopAutoRefresh();
      }
    };

    // Add event listener
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // Initialize based on current visibility state
    if (document.visibilityState === "visible") {
      supabase?.auth.startAutoRefresh();
    } else {
      supabase?.auth.stopAutoRefresh();
    }

    // Clean up
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      supabase?.auth.stopAutoRefresh();
    };
  }, []);

  return null;
}

const SCREENS = {
  home: Home,
  closet: Closet,
  studio: Studio,
  looks: Looks,
  calendar: CalendarView,
} as const;

type TabId = keyof typeof SCREENS;

const TAB_LABELS: Record<TabId, string> = {
  home: "Today",
  closet: "Closet",
  studio: "Studio",
  looks: "Lookbook",
  calendar: "Calendar",
};

/**
 * In-tab recovery screen. The point is that the shell survives: the wearer
 * can still switch tabs and reach the drawer, so a single broken screen is
 * a dead end for that tab only — never for the app.
 */
function TabErrorFallback({ tab }: { tab: TabId }) {
  const other = (Object.keys(TAB_LABELS) as TabId[]).find((t) => t !== tab);
  const goElsewhere = () => {
    if (other) useAppStore.setState({ tab: other });
  };
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <p className="font-display text-[20px] font-extrabold">
        {TAB_LABELS[tab]} didn&rsquo;t load
      </p>
      <p className="max-w-[300px] text-[13px] font-medium leading-relaxed text-mut">
        Your closet is safe — nothing was lost. Switch tabs and come back, or
        reload if it keeps happening.
      </p>
      <div className="mt-2 flex gap-2">
        {other && (
          <button
            onClick={goElsewhere}
            className="rounded-full bg-acc px-5 py-2.5 text-[13px] font-extrabold text-accink transition active:scale-95"
          >
            Go to {TAB_LABELS[other]}
          </button>
        )}
        <button
          onClick={() => window.location.reload()}
          className="rounded-full border border-line px-4 py-2.5 text-[13px] font-extrabold text-mut transition active:scale-95"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

function Splash() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6">
      <motion.div
        animate={{ opacity: [0.55, 1, 0.55], scale: [0.97, 1.02, 0.97] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
      >
        <LogoMark className="h-16 w-16 text-ink" />
      </motion.div>
      <p className="font-display text-[13px] font-extrabold tracking-[0.34em] text-mut">
        FLOWIE
      </p>
      <div className="h-1 w-28 overflow-hidden rounded-full bg-line">
        <motion.div
          className="h-full w-1/3 rounded-full bg-acc"
          animate={{ x: ["-120%", "340%"] }}
          transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
      <p className="text-[11px] font-bold text-mut">Warming up the steamer…</p>
    </div>
  );
}

function Shell() {
  const tab = useAppStore((s) => s.tab);
  const Screen = SCREENS[tab];
  useEffect(() => {
    // Phase 0 timing: tab-switch cost, including the AnimatePresence gap.
    markStage(`tab:${tab}`);
  }, [tab]);
  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-md">
        <div className="pt-[calc(env(safe-area-inset-top)+76px)]">
          <AnimatePresence mode="wait">
            <motion.div
              key={tab}
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -12 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
            >
              {/* Per-tab boundary (Phase 0, RC-7): a throw in one screen used
                  to bubble to the ROOT boundary, so a single bad tab nuked the
                  whole app — nav, drawer and the other tabs included — and the
                  only recovery was a reload. Here the damage stops at the
                  active screen: the shell, bottom nav and drawer stay alive, so
                  the wearer can switch tabs (resetKey={tab} latches a fresh
                  mount per tab, clearing the error on return). `mode="wait"` is
                  kept for now; Phase 4 makes tab switching instant. */}
              <ErrorBoundary resetKey={tab} fallback={<TabErrorFallback tab={tab} />}>
                <Screen />
              </ErrorBoundary>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      <JobBanner />
      <BottomNav />
      <Drawer />
    </>
  );
}

function AppContent() {
  const authStatus = useAppStore((s) => s.authStatus);
  const user = useAppStore((s) => s.user);
  const theme = useAppStore((s) => s.theme);
  // Derived boolean, not the raw `onboardedUsers` array: subscribing to the
  // array meant every onboarding write re-rendered the whole app shell.
  const onboarded = useIsOnboarded();

  // Keep the DOM class in sync with the persisted theme on boot & change.
  useEffect(() => {
    applyThemeToDom(theme);
  }, [theme]);

  return (
    <div className="min-h-dvh">
      <Ambient />
      {authStatus === "booting" ? (
        <Splash />
      ) : !user ? (
        <AuthScreen />
      ) : !onboarded ? (
        <Onboarding />
      ) : (
        <Shell />
      )}
      <Toast />
    </div>
  );
}

/**
 * InstallPromptHandler captures the beforeinstallprompt event
 * and stores it in the app store for the Drawer to use.
 */
function InstallPromptHandler() {
  const setInstallPrompt = useAppStore((s) => s.setInstallPrompt);

  useEffect(() => {
    let capturedEvent: BeforeInstallPromptEvent | null = null;

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      capturedEvent = e as BeforeInstallPromptEvent;
      setInstallPrompt(capturedEvent);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, [setInstallPrompt]);

  return null;
}

export default function App() {
  const boot = useAppStore((s) => s.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  return (
    <BrowserRouter>
      {/* OAuthHashHandler must be outside Routes to run on ALL paths before routing */}
      <OAuthHashHandler />
      {/* VisibilityChangeHandler manages Supabase token refresh for backgrounded tabs */}
      <VisibilityChangeHandler />
      {/* InstallPromptHandler captures PWA install prompt event */}
      <InstallPromptHandler />
      <Routes>
        <Route path="/" element={<AppContent />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/auth" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

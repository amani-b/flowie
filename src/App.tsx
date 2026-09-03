import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { applyThemeToDom, useAppStore } from "./store/appStore";
import Ambient from "./components/Ambient";
import TopBar from "./components/TopBar";
import BottomNav from "./components/BottomNav";
import Drawer from "./components/Drawer";
import Toast from "./components/Toast";
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
        FITFLOW
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
              <Screen />
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
      <BottomNav />
      <Drawer />
    </>
  );
}

function AppContent() {
  const authStatus = useAppStore((s) => s.authStatus);
  const user = useAppStore((s) => s.user);
  const onboardedUsers = useAppStore((s) => s.onboardedUsers);
  const theme = useAppStore((s) => s.theme);

  // Keep the DOM class in sync with the persisted theme on boot & change.
  useEffect(() => {
    applyThemeToDom(theme);
  }, [theme]);

  const onboarded = !!user && onboardedUsers.includes(user.id);

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

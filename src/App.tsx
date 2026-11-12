import { createElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from "react-router-dom";
import { MotionConfig, motion } from "framer-motion";
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
import { exitApp, onBackButton, syncStatusBar } from "./lib/native";
import { closeTopOverlay } from "./lib/overlayStack";
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

/**
 * Android hardware back button.
 *
 * The chain unwinds in the reverse order the user built it up: dismiss the
 * drawer, then the topmost sheet, then return to Today, and only then offer to
 * leave. Exiting on the first press from a deep screen is the classic Android
 * papercut — you lose your place with no warning, and there is no browser
 * chrome to recover it.
 *
 * Registering this listener *disables* Capacitor's own default back handling,
 * so every case must be covered here. There is no fallback underneath: a case
 * this function does not handle leaves the back button inert.
 *
 * Reads the store with `getState()` rather than subscribing — this is an event
 * handler, not render output, and subscribing would re-render the whole app
 * shell on every drawer open and tab change for no reason.
 */
function NativeBackHandler() {
  const lastBackAt = useRef(0);

  useEffect(
    () =>
      onBackButton(() => {
        const s = useAppStore.getState();

        if (s.drawerOpen) {
          s.setDrawer(false);
          return;
        }
        if (closeTopOverlay()) return;
        if (s.tab !== "home") {
          useAppStore.setState({ tab: "home" });
          return;
        }

        // Already on Today with nothing open: this is the only state the app
        // can be left from, so make it deliberate rather than instant.
        const now = Date.now();
        if (now - lastBackAt.current < 2000) {
          void exitApp();
          return;
        }
        lastBackAt.current = now;
        s.notify("Press back again to exit");
      }),
    []
  );

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

const ALL_TABS = Object.keys(SCREENS) as TabId[];

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
 *
 * Phase 4 added `Try again`. Before, the only ways out of a latched error were
 * leaving the tab (which cleared it via a changing `resetKey`) or reloading —
 * so a screen that threw on every render looked unrecoverable, and a screen
 * that threw once cost you your tab. Now the boundary is per-tab and stable,
 * and this button is what clears it.
 */
function TabErrorFallback({ tab, onRetry }: { tab: TabId; onRetry: () => void }) {
  const other = (Object.keys(TAB_LABELS) as TabId[]).find((t) => t !== tab);
  const goElsewhere = () => {
    if (other) useAppStore.setState({ tab: other });
  };
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <p className="text-[20px] font-extrabold">
        {TAB_LABELS[tab]} didn&rsquo;t load
      </p>
      <p className="max-w-[300px] text-[13px] font-medium leading-relaxed text-mut">
        Your closet is safe — nothing was lost. Try again, switch tabs, or
        reload if it keeps happening.
      </p>
      <div className="mt-2 flex flex-wrap justify-center gap-2">
        <button
          onClick={onRetry}
          className="rounded-full bg-acc px-5 py-2.5 text-[13px] font-extrabold text-accink transition active:scale-95"
        >
          Try again
        </button>
        {other && (
          <button
            onClick={goElsewhere}
            className="rounded-full border border-line px-4 py-2.5 text-[13px] font-extrabold text-mut transition active:scale-95"
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

  /**
   * Keep-alive (Phase 4). A screen mounts the first time its tab is opened and
   * then stays mounted, hidden with the `hidden` attribute instead of being
   * unmounted. Two things this buys:
   *
   *  - Tab switching is a display toggle, not a remount. Returning to Closet
   *    no longer re-mounts a 40-tile grid and re-resolves 40 images.
   *  - In-screen state survives a tab switch. Previously the Lookbook search
   *    box, the Closet filters and the Studio selection were all silently
   *    thrown away by any trip to another tab.
   *
   * Lazy, not eager: only visited tabs are mounted, so boot still renders one
   * screen — mounting all five at boot would re-introduce the O(all screens)
   * boot cost Phase 3 removed.
   */
  const [visited, setVisited] = useState<readonly TabId[]>(["home"]);

  /**
   * The union is computed during render, not in an effect.
   *
   * `tab` changes synchronously; an effect runs after paint. Adding the tab to
   * `visited` from an effect therefore produces one commit where the outgoing
   * wrapper is already `hidden` and the incoming one does not exist yet — i.e.
   * a frame with no screen on it at all, which is precisely the empty-frame gap
   * Phase 4 removes. Measured before the fix: 4 cold switches, 4 empty frames.
   * Computing the union in render makes the incoming screen mount in the same
   * commit that hides the outgoing one.
   */
  const rendered = visited.includes(tab) ? visited : [...visited, tab];

  /**
   * One element per screen, created once. A tab switch re-renders the whole
   * Shell, and without a stable element identity React would re-render all five
   * screens on every switch — giving back most of what keep-alive buys. With
   * the element held steady, React skips the subtrees whose tab did not change.
   */
  const screens = useMemo(
    () =>
      Object.fromEntries(
        ALL_TABS.map((t) => [t, createElement(SCREENS[t])])
      ) as Record<TabId, ReactElement>,
    []
  );

  /**
   * Per-tab retry counter. `ErrorBoundary` clears a latched error when its
   * `resetKey` changes, so the boundary is keyed `tab:attempt` and this is
   * what bumps the attempt for the tab the wearer is already looking at.
   */
  const [attempts, setAttempts] = useState<Partial<Record<TabId, number>>>({});

  useEffect(() => {
    // Phase 0 timing: tab-switch cost. Now measures a display toggle.
    markStage(`tab:${tab}`);
    setVisited((v) => (v.includes(tab) ? v : [...v, tab]));
  }, [tab]);

  // A kept-alive tab keeps its DOM but not its scroll offset — the document
  // is one scroll container shared by all five screens, so without this you
  // would land wherever the previous tab left the page. Per-tab scroll memory
  // is deliberately not attempted here; it needs a scroll listener that does
  // not record the browser's height-clamp as the outgoing tab's position.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [tab]);

  const retryTab = useCallback((t: TabId) => {
    setAttempts((a) => ({ ...a, [t]: (a[t] ?? 0) + 1 }));
  }, []);

  return (
    <>
      <TopBar />
      <main className="mx-auto w-full max-w-md">
        <div className="pt-[calc(env(safe-area-inset-top)+76px)]">
          {rendered.map((t) => {
            const active = t === tab;
            return (
              // Per-tab boundary (Phase 0, RC-7): a throw in one screen used to
              // bubble to the ROOT boundary, so a single bad tab nuked the whole
              // app — nav, drawer and the other tabs included. Here the damage
              // stops at the active screen. Phase 4 dropped the
              // `AnimatePresence mode="wait"` wrapper: `mode="wait"` ran the
              // outgoing screen's 0.22s exit before mounting the incoming one,
              // so every tab switch showed an empty frame. There is no exit
              // animation now, and there is nothing to wait for.
              <div key={t} data-tab={t} hidden={!active} aria-hidden={!active}>
                <ErrorBoundary
                  resetKey={`${t}:${attempts[t] ?? 0}`}
                  fallback={<TabErrorFallback tab={t} onRetry={() => retryTab(t)} />}
                >
                  {screens[t]}
                </ErrorBoundary>
              </div>
            );
          })}
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
  // The native status bar follows the same theme: on Android it is always
  // overlaid on the web layer (enforced from Android 15), so a bar left on the
  // wrong style would show dark icons over the app's dark background.
  useEffect(() => {
    applyThemeToDom(theme);
    void syncStatusBar(theme);
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
    // `reducedMotion="user"` makes every Framer animation in the app honour the
    // OS "remove animations" setting — transform/layout animations are skipped,
    // opacity fades still run. index.css handles the plain CSS side of the same
    // setting; this covers the JS-driven half.
    <MotionConfig reducedMotion="user">
      <BrowserRouter>
        {/* OAuthHashHandler must be outside Routes to run on ALL paths before routing */}
        <OAuthHashHandler />
        {/* VisibilityChangeHandler manages Supabase token refresh for backgrounded tabs */}
        <VisibilityChangeHandler />
        {/* InstallPromptHandler captures PWA install prompt event */}
        <InstallPromptHandler />
        {/* NativeBackHandler owns the Android hardware back button */}
        <NativeBackHandler />
        <Routes>
          <Route path="/" element={<AppContent />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route path="/auth" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </MotionConfig>
  );
}

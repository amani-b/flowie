import { useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
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

export default function App() {
  const boot = useAppStore((s) => s.boot);

  useEffect(() => {
    void boot();
  }, [boot]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<AppContent />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/auth" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

import { AnimatePresence, motion } from "framer-motion";
import { Menu, Moon, Sun } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { LogoMark } from "./icons";

export default function TopBar() {
  const theme = useAppStore((s) => s.theme);
  const toggleTheme = useAppStore((s) => s.toggleTheme);
  const setDrawer = useAppStore((s) => s.setDrawer);

  return (
    <header className="fixed inset-x-0 top-0 z-40">
      <div className="mx-auto w-full max-w-md px-3 pt-[calc(env(safe-area-inset-top)+10px)]">
        <div className="glass flex h-[54px] items-center justify-between rounded-[20px] px-3.5 shadow-sm">
          <div className="flex items-center gap-2">
            <LogoMark className="h-[22px] w-[22px] text-ink" />
            <span className="font-display text-[17px] font-extrabold tracking-tight">
              Flowie
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={toggleTheme}
              className="relative flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border border-line bg-card text-ink transition active:scale-90"
              aria-label="Toggle theme"
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={theme}
                  initial={{ y: 14, opacity: 0, rotate: -40 }}
                  animate={{ y: 0, opacity: 1, rotate: 0 }}
                  exit={{ y: -14, opacity: 0, rotate: 40 }}
                  transition={{ duration: 0.18 }}
                  className="flex"
                >
                  {theme === "dark" ? (
                    <Sun className="h-[17px] w-[17px]" />
                  ) : (
                    <Moon className="h-[17px] w-[17px]" />
                  )}
                </motion.span>
              </AnimatePresence>
            </button>
            <button
              onClick={() => setDrawer(true)}
              className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-card text-ink transition active:scale-90"
              aria-label="Open settings"
            >
              <Menu className="h-[17px] w-[17px]" />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

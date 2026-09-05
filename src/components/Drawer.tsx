import { useEffect, useState } from "react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import {
  Cpu,
  Download,
  LogOut,
  Moon,
  RotateCcw,
  Sparkles,
  Sun,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { useAppStore } from "../store/appStore";
import { geminiReady } from "../services/stylist";
import { cn } from "../lib/utils";

function Seg<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ v: T; label: string; icon?: typeof Sun }>;
}) {
  return (
    <div className="flex rounded-[14px] border border-line bg-bgdeep p-1">
      {options.map(({ v, label, icon: Icon }) => {
        const active = v === value;
        return (
          <button
            key={v}
            onClick={() => onChange(v)}
            className={cn(
              "flex flex-1 items-center justify-center gap-1.5 rounded-[10px] px-3 py-2 text-[12.5px] font-extrabold transition-all",
              active
                ? "bg-card text-ink shadow-sm"
                : "text-mut hover:text-ink"
            )}
          >
            {Icon && <Icon className="h-3.5 w-3.5" />}
            {label}
          </button>
        );
      })}
    </div>
  );
}

export default function Drawer() {
  const open = useAppStore((s) => s.drawerOpen);
  const setOpen = useAppStore((s) => s.setDrawer);
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);
  const units = useAppStore((s) => s.units);
  const setUnits = useAppStore((s) => s.setUnits);
  const weather = useAppStore((s) => s.weather);
  const restoreSamples = useAppStore((s) => s.restoreSamples);
  const clearAllData = useAppStore((s) => s.clearAllData);
  const user = useAppStore((s) => s.user);
  const mode = useAppStore((s) => s.mode);
  const signOutUser = useAppStore((s) => s.signOutUser);
  const installPrompt = useAppStore((s) => s.installPrompt);
  const setInstallPrompt = useAppStore((s) => s.setInstallPrompt);

  const initials = (user?.name ?? "?")
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const [confirmErase, setConfirmErase] = useState(false);

  useEffect(() => {
    if (!confirmErase) return;
    const t = setTimeout(() => setConfirmErase(false), 2600);
    return () => clearTimeout(t);
  }, [confirmErase]);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.x > 90 || info.velocity.x > 450) setOpen(false);
  };

  const handleInstall = async () => {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstallPrompt(null);
      }
    } catch {
      // Prompt failed — just clear the stored event
      setInstallPrompt(null);
    }
  };

  // Only show install row if we have a captured prompt AND app is not already standalone
  const isStandalone = typeof window !== "undefined" && window.matchMedia("(display-mode: standalone)").matches;
  const showInstallRow = installPrompt && !isStandalone;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.button
            aria-label="Close menu"
            className="absolute inset-0 w-full bg-black/45 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
          />
          <motion.aside
            className="absolute right-0 top-0 h-full w-[86%] max-w-[340px] overflow-y-auto border-l border-line"
            style={{
              background:
                "color-mix(in srgb, var(--surface-solid) 94%, transparent)",
              backdropFilter: "blur(26px) saturate(1.5)",
              WebkitBackdropFilter: "blur(26px) saturate(1.5)",
            }}
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", stiffness: 330, damping: 33 }}
            drag="x"
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={{ left: 0.5, right: 0 }}
            onDragEnd={handleDragEnd}
          >
            <div className="flex flex-col gap-5 px-5 pb-[calc(env(safe-area-inset-bottom)+28px)] pt-[calc(env(safe-area-inset-top)+18px)]">
              <div className="flex items-center justify-between">
                <span className="label-micro">Settings</span>
                <button
                  onClick={() => setOpen(false)}
                  className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-mut transition active:scale-90"
                  aria-label="Close"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* account */}
              <div className="card flex items-center gap-3 rounded-[20px] p-4">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-acc font-display text-[15px] font-extrabold text-accink">
                  {initials}
                </div>
                <div className="min-w-0">
                  <p className="truncate text-[14px] font-extrabold">{user?.name}</p>
                  <p className="truncate text-[11.5px] font-semibold text-mut">
                    {user?.email}
                  </p>
                </div>
                <span
                  className={cn(
                    "ml-auto shrink-0 rounded-full px-2 py-1 text-[9px] font-extrabold tracking-[0.14em]",
                    user?.isDemo
                      ? "bg-ambersoft text-amber"
                      : mode === "live"
                        ? "bg-accsoft text-acc"
                        : "bg-line text-mut"
                  )}
                >
                  {user?.isDemo ? "Demo" : mode === "live" ? "Synced" : "Offline"}
                </span>
              </div>
              <button
                onClick={() => void signOutUser()}
                className="-mt-2 flex w-full items-center gap-2.5 rounded-[14px] border border-line px-3.5 py-2.5 text-[13px] font-extrabold text-mut transition hover:text-danger active:scale-[0.98]"
              >
                <LogOut className="h-4 w-4" /> Sign out
              </button>

              <section className="space-y-2.5">
                <p className="label-micro">Appearance</p>
                <Seg
                  value={theme}
                  onChange={setTheme}
                  options={[
                    { v: "light", label: "Light", icon: Sun },
                    { v: "dark", label: "Dark", icon: Moon },
                  ]}
                />
                <Seg
                  value={units}
                  onChange={setUnits}
                  options={[
                    { v: "C", label: "°C" },
                    { v: "F", label: "°F" },
                  ]}
                />
              </section>

              <section className="space-y-2.5">
                <p className="label-micro">Styling engine</p>
                <div className="card rounded-[20px] p-4">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "pulse-dot h-2 w-2 rounded-full",
                        geminiReady ? "bg-acc" : "bg-amber"
                      )}
                    />
                    <span className="text-[13px] font-extrabold">
                      {geminiReady ? "Smart styling" : "On-device styling"}
                    </span>
                    {geminiReady ? (
                      <Sparkles className="ml-auto h-4 w-4 text-acc" />
                    ) : (
                      <Cpu className="ml-auto h-4 w-4 text-amber" />
                    )}
                  </div>
                  <p className="mt-2 text-[11.5px] font-medium leading-relaxed text-mut">
                    {geminiReady
                      ? "Picks are tuned online when available, with an on-device fallback so styling always works."
                      : "Outfit logic runs on this device, no connection needed."}
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-[14px] border border-line px-3.5 py-2.5">
                  <Zap className="h-3.5 w-3.5 text-mut" />
                  <span className="text-[11.5px] font-bold text-mut">
                    Weather:{" "}
                    <span className="text-ink">
                      {weather.data?.source === "live"
                        ? "Live"
                        : weather.status === "loading"
                          ? "Updating…"
                          : "Offline estimate"}
                    </span>
                  </span>
                </div>
              </section>

              <section className="space-y-2.5">
                <p className="label-micro">Data</p>
                <div className="card space-y-2 rounded-[20px] p-3">
                  {showInstallRow && (
                    <button
                      onClick={handleInstall}
                      className="flex w-full items-center gap-2.5 rounded-[13px] px-2.5 py-2 text-left text-[12.5px] font-extrabold transition hover:bg-bgdeep active:scale-[0.98]"
                    >
                      <Download className="h-4 w-4 text-acc" />
                      Install app
                    </button>
                  )}
                  <button
                    onClick={restoreSamples}
                    className="flex w-full items-center gap-2.5 rounded-[13px] px-2.5 py-2 text-left text-[12.5px] font-extrabold transition hover:bg-bgdeep active:scale-[0.98]"
                  >
                    <RotateCcw className="h-4 w-4 text-acc" />
                    Load sample closet
                  </button>
                  <button
                    onClick={() => {
                      if (confirmErase) {
                        clearAllData();
                        setConfirmErase(false);
                      } else {
                        setConfirmErase(true);
                      }
                    }}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-[13px] px-2.5 py-2 text-left text-[12.5px] font-extrabold transition active:scale-[0.98]",
                      confirmErase
                        ? "bg-dangersoft text-danger"
                        : "hover:bg-bgdeep text-mut hover:text-danger"
                    )}
                  >
                    <Trash2 className="h-4 w-4" />
                    {confirmErase ? "Tap again to confirm erase" : "Erase local closet & looks"}
                  </button>
                </div>
                <p className="px-1 text-[10px] font-bold leading-relaxed text-mut">
                  Flowie v0.2
                  {user?.isDemo ? " · Demo" : mode === "live" ? " · Synced" : " · On this device"}
                </p>
              </section>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

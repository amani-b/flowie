import { useEffect, useState } from "react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import {
  Check,
  Copy,
  Cpu,
  Download,
  Globe,
  KeyRound,
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
import { supabaseUrl } from "../services/supabaseClient";
import { cn } from "../lib/utils";
import { BODY_SHAPES, SKIN_TONES } from "./FitAvatar";
import type { BodyShape } from "../types";

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

/** Copy-to-clipboard row with inline success feedback. */
function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard blocked (sandboxed iframe) — fall back to execCommand.
      const ta = document.createElement("textarea");
      ta.value = value;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch {
        /* nothing left to try */
      }
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div>
      <p className="mb-1 text-[10.5px] font-extrabold text-mut">{label}</p>
      <button
        onClick={() => void copy()}
        className="group flex w-full items-center gap-2 rounded-[12px] border border-line bg-bgdeep px-3 py-2 text-left transition active:scale-[0.98]"
      >
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-bold text-ink">
          {value}
        </span>
        <span
          className={cn(
            "flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors",
            copied ? "bg-accsoft text-acc" : "bg-line text-mut group-hover:text-ink"
          )}
        >
          {copied ? (
            <Check className="h-3 w-3" strokeWidth={3.4} />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </span>
      </button>
    </div>
  );
}

const OAUTH_STEPS = [
  "Google Cloud Console → OAuth client → paste the callback URL below into Authorized redirect URIs",
  "Consent screen: External + add your email as a test user (fixes the 403)",
  "Supabase → Authentication → Providers → Google → paste Client ID + Secret",
  "Supabase → URL Configuration → Site URL & Redirect URLs = your origin below",
];

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
  const profile = useAppStore((s) => s.profile);
  const setProfile = useAppStore((s) => s.setProfile);

  const skinTone = profile?.avatarConfig?.skinTone;
  const bodyShape: BodyShape = profile?.avatarConfig?.bodyShape ?? "average";
  const setAvatarConfig = (patch: { skinTone?: string; bodyShape?: BodyShape }) =>
    setProfile({
      userId: user?.id ?? "local",
      avatarUrl: profile?.avatarUrl ?? null,
      avatarConfig: { ...profile?.avatarConfig, ...patch },
      bodyMetrics: profile?.bodyMetrics ?? null,
    });
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

  const callbackUrl = supabaseUrl ? `${supabaseUrl}/auth/v1/callback` : "";

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
                  {user?.isDemo ? "DEMO" : mode === "live" ? "CLOUD" : "LOCAL"}
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
                <p className="label-micro">Fit model</p>
                <div className="card rounded-[20px] p-4">
                  <p className="mb-2 text-[10.5px] font-extrabold text-mut">Skin tone</p>
                  <div className="flex gap-2">
                    {SKIN_TONES.map((t) => (
                      <button
                        key={t.hex}
                        onClick={() => setAvatarConfig({ skinTone: t.hex })}
                        title={t.label}
                        aria-label={`Skin tone ${t.label}`}
                        className={cn(
                          "h-8 w-8 rounded-full border-2 transition active:scale-90",
                          skinTone === t.hex ? "border-acc" : "border-line"
                        )}
                        style={{ background: t.hex }}
                      />
                    ))}
                  </div>
                  <p className="mb-2 mt-3 text-[10.5px] font-extrabold text-mut">Build</p>
                  <div className="flex flex-wrap gap-1.5">
                    {BODY_SHAPES.map((b) => (
                      <button
                        key={b.id}
                        onClick={() => setAvatarConfig({ bodyShape: b.id })}
                        className={cn(
                          "rounded-full border px-3 py-1.5 text-[11.5px] font-extrabold transition active:scale-95",
                          bodyShape === b.id
                            ? "border-transparent bg-ink text-bg"
                            : "border-line text-mut"
                        )}
                      >
                        {b.label}
                      </button>
                    ))}
                  </div>
                </div>
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
                      {geminiReady ? "Gemini 2.5 Flash" : "On-device heuristic"}
                    </span>
                    {geminiReady ? (
                      <Sparkles className="ml-auto h-4 w-4 text-acc" />
                    ) : (
                      <Cpu className="ml-auto h-4 w-4 text-amber" />
                    )}
                  </div>
                  <p className="mt-2 text-[11.5px] font-medium leading-relaxed text-mut">
                    {geminiReady
                      ? "Connected via Google AI Studio. If the free-tier quota is hit, FitFlow falls back to the local engine automatically."
                      : "No Gemini key detected — outfit logic runs fully on-device. Set VITE_GEMINI_API_KEY to enable Gemini 2.5 Flash (free tier ≈ 1,000 req/day)."}
                  </p>
                </div>
                <div className="flex items-center gap-2 rounded-[14px] border border-line px-3.5 py-2.5">
                  <Zap className="h-3.5 w-3.5 text-mut" />
                  <span className="text-[11.5px] font-bold text-mut">
                    Weather:{" "}
                    <span className="text-ink">
                      {weather.data?.source === "live"
                        ? "Live · Open-Meteo"
                        : weather.status === "loading"
                          ? "Fetching…"
                          : "Simulated fallback"}
                    </span>
                  </span>
                </div>
              </section>

              {/* OAuth wiring checklist — only meaningful with Supabase keys */}
              {mode === "live" && (
                <section className="space-y-2.5">
                  <p className="label-micro flex items-center gap-1.5">
                    <KeyRound className="h-3 w-3" /> Google OAuth wiring
                  </p>
                  <div className="card space-y-3 rounded-[20px] p-4">
                    <ol className="space-y-2">
                      {OAUTH_STEPS.map((step, i) => (
                        <li key={step} className="flex gap-2.5">
                          <span className="mt-px flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full bg-accsoft text-[9.5px] font-extrabold text-acc">
                            {i + 1}
                          </span>
                          <span className="text-[11.5px] font-semibold leading-snug text-mut">
                            {step}
                          </span>
                        </li>
                      ))}
                    </ol>
                    <CopyRow
                      label="Callback URL → Google client's redirect URIs"
                      value={callbackUrl}
                    />
                    <CopyRow
                      label="Your origin → Supabase Site URL + Redirect URLs"
                      value={typeof window !== "undefined" ? window.location.origin : ""}
                    />
                    <p className="flex gap-1.5 text-[10.5px] font-semibold leading-relaxed text-mut">
                      <Globe className="mt-0.5 h-3 w-3 shrink-0" />
                      Preview domains rotate — also allow https://*.preview.qwenlm.io/**
                      in Redirect URLs so a fresh sandbox session keeps login working.
                    </p>
                  </div>
                </section>
              )}

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
                  FitFlow v0.2 · Phase 1 ·{" "}
                  {mode === "live" ? "Supabase cloud sync" : "on-device mock mode"}
                  {user?.isDemo ? " · demo account" : ""}
                </p>
              </section>
            </div>
          </motion.aside>
        </div>
      )}
    </AnimatePresence>
  );
}

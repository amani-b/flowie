import { useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Inbox, Loader2, MailCheck, ShieldCheck } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { appMode, signIn, signInWithGoogle, signUp } from "../services/authService";
import { cn, firstName } from "../lib/utils";
import { LogoMark } from "../components/icons";

type Mode = "login" | "signup";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function GoogleGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" aria-hidden>
      <path fill="#4285F4" d="M23.5 12.27c0-.85-.08-1.66-.22-2.45H12v4.64h6.46a5.53 5.53 0 0 1-2.4 3.63v3h3.88c2.27-2.1 3.56-5.17 3.56-8.82Z" />
      <path fill="#34A853" d="M12 24c3.24 0 5.96-1.07 7.94-2.91l-3.88-3c-1.07.72-2.45 1.15-4.06 1.15-3.12 0-5.77-2.11-6.71-4.95H1.28v3.1A12 12 0 0 0 12 24Z" />
      <path fill="#FBBC05" d="M5.29 14.29a7.2 7.2 0 0 1 0-4.58v-3.1H1.28a12 12 0 0 0 0 10.78l4.01-3.1Z" />
      <path fill="#EA4335" d="M12 4.76c1.76 0 3.34.6 4.58 1.79l3.44-3.44A11.97 11.97 0 0 0 1.28 6.61l4.01 3.1C6.23 6.87 8.88 4.76 12 4.76Z" />
    </svg>
  );
}

export default function AuthScreen() {
  const completeAuth = useAppStore((s) => s.completeAuth);
  const enterDemoMode = useAppStore((s) => s.enterDemoMode);
  const notify = useAppStore((s) => s.notify);

  const [mode, setMode] = useState<Mode>("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErr, setFieldErr] = useState<{ name?: string; email?: string; password?: string }>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [busy, setBusy] = useState<"submit" | "google" | null>(null);
  const [shakeKey, setShakeKey] = useState(0);

  const isMock = appMode === "mock";

  const validate = (): boolean => {
    const errs: typeof fieldErr = {};
    if (mode === "signup" && name.trim().length < 2) errs.name = "Tell us what to call you.";
    if (!EMAIL_RE.test(email.trim())) errs.email = "That email doesn't look right.";
    if (password.length < 6) errs.password = "At least 6 characters.";
    setFieldErr(errs);
    return Object.keys(errs).length === 0;
  };

  const submit = async () => {
    setFormError(null);
    setNeedsConfirm(false);
    if (!validate()) {
      setShakeKey((k) => k + 1);
      return;
    }
    setBusy("submit");
    try {
      const res =
        mode === "signup"
          ? await signUp(email, password, name)
          : await signIn(email, password);
      if (res.needsConfirm) {
        setNeedsConfirm(true);
        return;
      }
      if (res.user) {
        notify(`Welcome, ${firstName(res.user.name)}`);
        completeAuth(res.user);
      }
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Something went wrong.");
      setShakeKey((k) => k + 1);
    } finally {
      setBusy(null);
    }
  };

  const google = async () => {
    setFormError(null);
    setBusy("google");
    try {
      await signInWithGoogle();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Google sign-in failed.");
      setShakeKey((k) => k + 1);
    } finally {
      setBusy(null);
    }
  };

  const field = (err?: string) => cn("field", err && "!border-danger");

  return (
    <div className="relative flex min-h-dvh flex-col overflow-hidden px-6 pb-[calc(env(safe-area-inset-bottom)+22px)] pt-[calc(env(safe-area-inset-top)+26px)]">
      {/* brand block */}
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      >
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[9.5px] font-extrabold tracking-[0.16em]",
              isMock
                ? "border-line bg-card text-amber"
                : "border-line bg-card text-acc"
            )}
          >
            <span
              className={cn(
                "pulse-dot h-1.5 w-1.5 rounded-full",
                isMock ? "bg-amber" : "bg-acc"
              )}
            />
            {isMock ? "DEMO MODE · ON-DEVICE" : "SUPABASE CONNECTED"}
          </span>
          <span className="ml-auto flex items-center gap-1 text-[9.5px] font-extrabold tracking-[0.14em] text-mut">
            <ShieldCheck className="h-3.5 w-3.5" /> RLS SECURED
          </span>
        </div>

        <motion.div
          className="mt-9"
          animate={{ rotate: [0, -3.5, 3, 0] }}
          transition={{ duration: 5.5, repeat: Infinity, ease: "easeInOut" }}
          style={{ originX: 0.5, originY: 0.08, width: "fit-content" }}
        >
          <LogoMark className="h-14 w-14 text-ink" />
        </motion.div>
        <h1 className="mt-4 font-display text-[42px] font-extrabold leading-[0.95] tracking-tight">
          FitFlow
          <span className="ml-2 rounded-lg bg-accsoft px-2 py-1 align-middle text-[12px] tracking-[0.22em] text-acc">
            AI
          </span>
        </h1>
        <p className="mt-2.5 max-w-[300px] text-[14px] font-semibold leading-relaxed text-mut">
          A stylist that reads the sky, then raids your closet.
        </p>
      </motion.div>

      <div className="flex-1" />

      {/* form card */}
      <motion.div
        initial={{ opacity: 0, y: 22 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.1, ease: "easeOut" }}
        className="glass rounded-[26px] p-5 shadow-lg"
      >
        {needsConfirm ? (
          <div className="py-2 text-center">
            <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accsoft text-acc">
              <Inbox className="h-6 w-6" />
            </span>
            <p className="mt-3 font-display text-[18px] font-extrabold">Check your inbox</p>
            <p className="mt-1 text-[12.5px] font-medium leading-relaxed text-mut">
              We sent a confirmation link to <span className="font-extrabold text-ink">{email.trim()}</span>.
              Confirm it, then log in.
            </p>
            <button
              onClick={() => {
                setNeedsConfirm(false);
                setMode("login");
              }}
              className="mt-4 flex items-center gap-1.5 rounded-full bg-acc px-5 py-2.5 text-[13px] font-extrabold text-accink transition active:scale-95"
            >
              <MailCheck className="h-4 w-4" /> Back to login
            </button>
            <p className="mt-3 text-[11px] font-bold text-mut">
              Already confirmed? You can also{" "}
              <button
                onClick={() => {
                  setNeedsConfirm(false);
                  setMode("login");
                }}
                className="font-extrabold text-acc underline decoration-acc underline-offset-2"
              >
                switch to the login form
              </button>{" "}
              and sign in now.
            </p>
          </div>
        ) : (
          <div key={shakeKey}>
            {/* segmented mode */}
            <div className="flex rounded-[14px] border border-line bg-bgdeep p-1">
              {(["login", "signup"] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => {
                    setMode(m);
                    setFormError(null);
                    setFieldErr({});
                  }}
                  className={cn(
                    "relative flex-1 rounded-[10px] py-2 text-[12.5px] font-extrabold transition-colors",
                    mode === m ? "text-ink" : "text-mut"
                  )}
                >
                  {mode === m && (
                    <motion.span
                      layoutId="auth-seg"
                      className="absolute inset-0 rounded-[10px] bg-card shadow-sm"
                      transition={{ type: "spring", stiffness: 420, damping: 34 }}
                    />
                  )}
                  <span className="relative z-10">{m === "login" ? "Log in" : "Create account"}</span>
                </button>
              ))}
            </div>

            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              {mode === "signup" && (
                <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }}>
                  <input
                    className={field(fieldErr.name)}
                    placeholder="Your name"
                    value={name}
                    autoComplete="name"
                    onChange={(e) => setName(e.target.value)}
                  />
                  {fieldErr.name && (
                    <p className="mt-1 text-[11px] font-bold text-danger">{fieldErr.name}</p>
                  )}
                </motion.div>
              )}
              <div>
                <input
                  className={field(fieldErr.email)}
                  placeholder="Email"
                  type="email"
                  value={email}
                  autoComplete="email"
                  onChange={(e) => setEmail(e.target.value)}
                />
                {fieldErr.email && (
                  <p className="mt-1 text-[11px] font-bold text-danger">{fieldErr.email}</p>
                )}
              </div>
              <div>
                <input
                  className={field(fieldErr.password)}
                  placeholder="Password · min 6 characters"
                  type="password"
                  value={password}
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  onChange={(e) => setPassword(e.target.value)}
                />
                {fieldErr.password && (
                  <p className="mt-1 text-[11px] font-bold text-danger">{fieldErr.password}</p>
                )}
              </div>

              {formError && (
                <motion.p
                  initial={{ opacity: 0, x: 0 }}
                  animate={{ opacity: 1, x: [0, -7, 7, -5, 5, 0] }}
                  transition={{ duration: 0.4 }}
                  className="rounded-[12px] bg-dangersoft px-3.5 py-2.5 text-[12px] font-extrabold text-danger"
                >
                  {formError}
                </motion.p>
              )}

              <motion.button
                whileTap={{ scale: 0.98 }}
                type="submit"
                disabled={busy !== null}
                className="flex w-full items-center justify-center gap-2 rounded-[15px] bg-acc py-3.5 font-display text-[15px] font-extrabold text-accink transition disabled:opacity-70"
              >
                {busy === "submit" ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {mode === "login" ? "Unlocking the closet…" : "Setting up…"}
                  </>
                ) : (
                  <>
                    {mode === "login" ? "Log in" : "Create account"}
                    <ArrowRight className="h-4 w-4" />
                  </>
                )}
              </motion.button>
            </form>

            <div className="my-4 flex items-center gap-3">
              <span className="h-px flex-1 bg-line" />
              <span className="text-[10px] font-extrabold tracking-[0.2em] text-mut">OR</span>
              <span className="h-px flex-1 bg-line" />
            </div>

            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={() => void google()}
              disabled={busy !== null}
              className="flex w-full items-center justify-center gap-2.5 rounded-[15px] border border-linestrong bg-card py-3 text-[13.5px] font-extrabold transition disabled:opacity-70"
            >
              {busy === "google" ? (
                <Loader2 className="h-[18px] w-[18px] animate-spin" />
              ) : (
                <GoogleGlyph />
              )}
              Continue with Google
            </motion.button>
          </div>
        )}
      </motion.div>

      {/* demo door */}
      <motion.button
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.25 }}
        onClick={enterDemoMode}
        className="group mx-auto mt-4 flex items-center gap-2 rounded-full px-4 py-2.5 text-[12.5px] font-extrabold text-mut transition hover:text-ink active:scale-95"
      >
        <span className="underline decoration-linestrong decoration-2 underline-offset-4 group-hover:decoration-acc">
          Skip auth — walk into the demo closet
        </span>
        <ArrowRight className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
      </motion.button>

      <motion.p
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.35 }}
        className="mt-3 text-center text-[10px] font-bold leading-relaxed text-mut"
      >
        {isMock
          ? "No Supabase keys detected — accounts are simulated on this device. Add VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY for real auth."
          : "Email auth + Google OAuth via Supabase · schema in /supabase/schema.sql · OAuth wiring checklist in Settings"}
      </motion.p>
    </div>
  );
}

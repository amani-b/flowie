import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import { Loader2, MailCheck, ArrowLeft } from "lucide-react";
import { useAppStore } from "../store/appStore";
import { signIn } from "../services/authService";

/**
 * AuthCallback handles the OAuth redirect from Supabase.
 * When Google OAuth completes, Supabase redirects here with a hash containing the session.
 * We extract the email and auto-sign-in the user.
 */
export default function AuthCallback() {
  const navigate = useNavigate();
  const completeAuth = useAppStore((s) => s.completeAuth);
  const notify = useAppStore((s) => s.notify);
  
  const [status, setStatus] = useState<"loading" | "error" | "confirming">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    const handleCallback = async () => {
      const hash = window.location.hash;
      if (!hash) {
        setStatus("error");
        setErrorMsg("No authentication data received.");
        return;
      }

      try {
        // Parse the hash fragment from Supabase OAuth redirect
        const params = new URLSearchParams(hash.slice(1));
        const accessToken = params.get("access_token");
        const refreshToken = params.get("refresh_token");
        const type = params.get("type");
        
        // For email confirmation flows
        if (type === "confirmation" || !accessToken) {
          setStatus("confirming");
          return;
        }

        // Extract user info from the token or query params
        const email = params.get("email") || "";
        
        if (accessToken) {
          // Session is already stored by Supabase client via onAuthStateChange
          // We just need to wait for the auth state to be picked up
          // The appStore.subscribeAuth will handle this automatically
          notify("Welcome! You're signed in.");
          
          // Give the auth subscription time to pick up the session
          setTimeout(() => {
            navigate("/", { replace: true });
          }, 500);
        } else {
          setStatus("error");
          setErrorMsg("Sign-in incomplete. Please try again.");
        }
      } catch (err) {
        setStatus("error");
        setErrorMsg(err instanceof Error ? err.message : "Authentication failed.");
      }
    };

    void handleCallback();
  }, [navigate, notify, completeAuth]);

  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 px-6">
      <motion.div
        initial={{ opacity: 0, y: -12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: "easeOut" }}
      >
        {status === "loading" && (
          <>
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-accsoft text-acc">
              <Loader2 className="h-8 w-8 animate-spin" />
            </span>
            <h1 className="mt-6 font-display text-[24px] font-extrabold">Completing sign-in…</h1>
            <p className="mt-2 text-center text-[13px] font-medium text-mut">
              Just a moment while we secure your closet.
            </p>
          </>
        )}

        {status === "confirming" && (
          <>
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-accsoft text-acc">
              <MailCheck className="h-8 w-8" />
            </span>
            <h1 className="mt-6 font-display text-[24px] font-extrabold">Check your inbox</h1>
            <p className="mt-2 max-w-[280px] text-center text-[13px] font-medium text-mut">
              We sent a confirmation link. Once confirmed, return here to complete sign-in.
            </p>
            <button
              onClick={() => navigate("/auth", { replace: true })}
              className="mt-5 flex items-center gap-2 rounded-full bg-acc px-5 py-2.5 text-[13px] font-extrabold text-accink transition active:scale-95"
            >
              <ArrowLeft className="h-4 w-4" /> Back to login
            </button>
          </>
        )}

        {status === "error" && (
          <>
            <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-dangersoft text-danger">
              <MailCheck className="h-8 w-8" />
            </span>
            <h1 className="mt-6 font-display text-[24px] font-extrabold">Sign-in issue</h1>
            <p className="mt-2 max-w-[280px] text-center text-[13px] font-medium text-mut">
              {errorMsg || "Something went wrong during authentication."}
            </p>
            <div className="mt-5 flex gap-2">
              <button
                onClick={() => navigate("/auth", { replace: true })}
                className="flex items-center gap-2 rounded-full bg-acc px-5 py-2.5 text-[13px] font-extrabold text-accink transition active:scale-95"
              >
                <ArrowLeft className="h-4 w-4" /> Back to login
              </button>
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-2 rounded-full border border-line px-5 py-2.5 text-[13px] font-extrabold text-mut transition active:scale-95"
              >
                Try again
              </button>
            </div>
          </>
        )}
      </motion.div>
    </div>
  );
}

import { useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Check } from "lucide-react";
import { useAppStore } from "../store/appStore";

export default function Toast() {
  const toast = useAppStore((s) => s.toast);
  const clearToast = useAppStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(clearToast, 2400);
    return () => clearTimeout(t);
  }, [toast, clearToast]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+88px)] z-[60] flex justify-center px-6">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            initial={{ opacity: 0, y: 24, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            className="glass flex items-center gap-2 rounded-full py-2.5 pl-3 pr-4 shadow-lg"
          >
            <span
              className={
                "flex h-6 w-6 items-center justify-center rounded-full " +
                (toast.tone === "ok" ? "bg-accsoft text-acc" : "bg-dangersoft text-danger")
              }
            >
              {toast.tone === "ok" ? (
                <Check className="h-3.5 w-3.5" strokeWidth={3} />
              ) : (
                <AlertTriangle className="h-3.5 w-3.5" />
              )}
            </span>
            <span className="text-[12.5px] font-extrabold">{toast.text}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

import { useEffect, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { X } from "lucide-react";
import { pushOverlay } from "../lib/overlayStack";

/**
 * Frosted bottom sheet with drag-to-dismiss. The workhorse overlay
 * for add/edit/detail flows across the app.
 */
export default function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}) {
  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 110 || info.velocity.y > 600) onClose();
  };

  /**
   * Announce this sheet to the overlay registry while it is open, so the
   * Android back button can dismiss it (see lib/overlayStack.ts). `onClose` is
   * held in a ref and the effect depends only on `open`: screens pass inline
   * arrows, so a changing `onClose` identity would otherwise re-register on
   * every render and churn the stack.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    return pushOverlay(() => onCloseRef.current());
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-50">
          <motion.button
            aria-label="Close"
            className="absolute inset-0 h-full w-full bg-black/45 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />
          <motion.div
            className="absolute inset-x-0 bottom-0 mx-auto w-full max-w-md"
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", stiffness: 360, damping: 36 }}
            drag="y"
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.6 }}
            onDragEnd={handleDragEnd}
            style={{
              background:
                "color-mix(in srgb, var(--surface-solid) 96%, transparent)",
              backdropFilter: "blur(26px) saturate(1.5)",
              WebkitBackdropFilter: "blur(26px) saturate(1.5)",
              borderTop: "1px solid var(--line)",
              borderLeft: "1px solid var(--line)",
              borderRight: "1px solid var(--line)",
              borderRadius: "26px 26px 0 0",
            }}
          >
            <div className="flex justify-center pt-2.5">
              <span className="h-1.5 w-11 rounded-full bg-linestrong" />
            </div>
            <div className="flex items-center justify-between px-5 pt-3">
              <h2 className="text-[18px] font-extrabold tracking-tight">
                {title}
              </h2>
              <button
                onClick={onClose}
                className="flex h-8 w-8 items-center justify-center rounded-full border border-line text-mut transition active:scale-90"
                aria-label="Close sheet"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[78dvh] overflow-y-auto px-5 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-4">
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/**
 * Honest background-job banner (Phase 2).
 *
 * Sits directly above the bottom nav and reports what the serial recon queue is
 * actually doing, because the alternative — inferring progress from
 * `garment.reconStatus === "pending"` — could only ever say "something is
 * happening somewhere", and would keep saying it after a cancel.
 *
 * Honesty rules this component follows:
 * - It renders `jobsStore`, a projection of real queue events. If the banner is
 *   gone, no job is running. There is no optimistic state here.
 * - No fake percentage. Recon does not report progress, so the bar is
 *   indeterminate and the copy carries what a number would have carried: which
 *   step, and the elapsed time against the known ceiling.
 * - The stage line is the string the job itself reported, not a clock guess.
 * - Cancel is instant; cancelled jobs vanish and never render as failures, and
 *   failures never render as success.
 * - Failed jobs stay visible with a retry, because a silent failure is how the
 *   Phase 1 `garment-shorts` recon sat unnoticed.
 */

import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Ban, Loader2, RefreshCw, X } from "lucide-react";
import { cancel as cancelJob } from "../services/jobQueue";
import { useAppStore } from "../store/appStore";
import { useJobsStore } from "../store/jobsStore";
import { useElapsedSeconds } from "../lib/useElapsed";

/** Recon's hard ceiling (`garmentRecon.RECON_TIMEOUT_MS`), for honest copy. */
const RECON_CEILING_S = 90;

export default function JobBanner() {
  const jobs = useJobsStore((s) => s.jobs);
  const clearSettled = useJobsStore((s) => s.clearSettled);
  const retryRecon = useAppStore((s) => s.retryRecon);

  const all = Object.values(jobs);
  const running = all.filter((j) => j.status === "running");
  const queued = all
    .filter((j) => j.status === "queued")
    .sort((a, b) => a.queuedAt - b.queuedAt);
  const failed = all
    .filter((j) => j.status === "failed")
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));

  const current = running[0];
  const elapsed = useElapsedSeconds(current?.startedAt);
  const active = !!current || queued.length > 0;

  if (!active && failed.length === 0) return null;

  /** Stop everything outstanding — the wearer means "stop the background work". */
  const stopAll = () => {
    for (const j of running) cancelJob(j.id);
    for (const j of queued) cancelJob(j.id);
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(env(safe-area-inset-bottom)+82px)] z-[45] flex justify-center px-3">
      <AnimatePresence>
        <motion.div
          key="jobs"
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 10 }}
          transition={{ type: "spring", stiffness: 380, damping: 32 }}
          className="glass pointer-events-auto w-full max-w-md overflow-hidden rounded-[20px] shadow-lg"
          role="status"
          aria-live="polite"
        >
          {active && (
            <>
              <div className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-acc" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[12.5px] font-extrabold text-ink">
                    {(current ?? queued[0]).label}
                    {current && queued.length > 0 && (
                      <span className="ml-1.5 font-bold text-mut">
                        +{queued.length} waiting
                      </span>
                    )}
                    {!current && queued.length > 1 && (
                      <span className="ml-1.5 font-bold text-mut">
                        +{queued.length - 1} waiting
                      </span>
                    )}
                  </p>
                  <p className="truncate text-[11px] font-bold text-mut">
                    {/* The job's own words. The clock is context, not a guess. */}
                    {current ? current.stage ?? "Working…" : "Waiting for the queue · free tier renders about 4 pieces a day"}
                    {current && (
                      <span className="ml-1.5 tabular-nums opacity-70">
                        {elapsed}s / {RECON_CEILING_S}s
                      </span>
                    )}
                  </p>
                </div>
                <button
                  onClick={stopAll}
                  className="flex shrink-0 items-center gap-1 rounded-full border border-line px-2.5 py-1.5 text-[11px] font-extrabold text-ink transition active:scale-95"
                  aria-label="Cancel background work"
                >
                  <Ban className="h-3.5 w-3.5" /> Cancel
                </button>
              </div>
              {/* Indeterminate on purpose: recon reports no percentage, and a
                  fake bar is worse than an honest sweep. */}
              <div className="h-[3px] w-full overflow-hidden bg-line/60">
                <motion.div
                  className="h-full w-1/3 rounded-full bg-acc"
                  animate={{ x: ["-100%", "300%"] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                />
              </div>
            </>
          )}

          {/* Failures sit under progress rather than replacing it: a
              garment that failed must not be hidden by unrelated work. */}
          {failed.length > 0 && (
            <div
              className={
                active
                  ? "border-t border-line/60 px-3.5 py-2.5"
                  : "px-3.5 py-2.5"
              }
            >
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-danger" />
                <p className="min-w-0 flex-1 truncate text-[12px] font-extrabold text-ink">
                  {failed.length === 1
                    ? `${failed[0].label} didn't finish`
                    : `${failed.length} garments didn't finish`}
                </p>
                <button
                  onClick={clearSettled}
                  className="shrink-0 rounded-full p-1 text-mut transition active:scale-95"
                  aria-label="Dismiss"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mt-0.5 text-[11px] font-bold text-mut">
                {failed[0].error ?? "The renderer didn't answer"}. The photo
                stays on screen in the meantime.
              </p>
              <button
                onClick={() => {
                  // `retryRecon`, not `queue.retry`: the category and daily-
                  // budget pre-checks live there and can explain themselves.
                  for (const j of failed) retryRecon(j.id);
                  clearSettled();
                }}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-full border border-line py-1.5 text-[11.5px] font-extrabold text-ink transition active:scale-[0.98]"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Try again
              </button>
            </div>
          )}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

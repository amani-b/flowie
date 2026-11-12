/**
 * Job state for React, plus the interrupted-job handoff across a reload.
 *
 * `services/jobQueue.ts` owns execution but deliberately keeps no history —
 * it drops a job's record the moment it settles. This store is the projection
 * layer: it mirrors every queue event into a plain `Record<id, JobRecord>`
 * that components can subscribe to, and it is the only place that knows how a
 * job survives a reload.
 *
 * INTERRUPTED JOBS (why it is not just "pending")
 * Before this, a reload during a recon job left `reconStatus: "pending"`
 * persisted, and boot re-ran *every* pending garment. A stale snapshot could
 * therefore fire a burst of remote calls on open, against a shared free
 * quota. The rule now is deliberately narrow:
 * - Only ids that were genuinely queued/running at unload are recorded, and
 *   they are recorded on `pagehide` (the one event that reliably fires on a
 *   mobile PWA/WebView kill).
 * - At boot those garments are marked `failed("interrupted")` — honest: the
 *   job really did not finish — and at most ONE, the most recent, is resumed.
 * A crash that skips `pagehide` leaves no record at all, so boot clears the
 * phantom pending mark instead of inventing work.
 */

import { create } from "zustand";
import {
  subscribe,
  cancel as cancelJob,
  activeIds,
  type JobEvent,
  type JobRecord,
} from "../services/jobQueue";

export interface JobsState {
  /** Every job this session knows about, keyed by job (= garment) id. */
  jobs: Record<string, JobRecord>;
  pushJob: (job: JobRecord) => void;
  patchJob: (id: string, patch: Partial<JobRecord>) => void;
  removeJob: (id: string) => void;
  /** Drop finished jobs (ready/failed/cancelled) — banner dismissal. */
  clearSettled: () => void;
}

export const useJobsStore = create<JobsState>((set) => ({
  jobs: {},
  pushJob: (job) => set((s) => ({ jobs: { ...s.jobs, [job.id]: job } })),
  patchJob: (id, patch) =>
    set((s) => {
      const cur = s.jobs[id];
      if (!cur) return s;
      return { jobs: { ...s.jobs, [id]: { ...cur, ...patch } } };
    }),
  removeJob: (id) =>
    set((s) => {
      if (!(id in s.jobs)) return s;
      const next = { ...s.jobs };
      delete next[id];
      return { jobs: next };
    }),
  clearSettled: () =>
    set((s) => {
      const next: Record<string, JobRecord> = {};
      for (const [id, job] of Object.entries(s.jobs)) {
        if (job.status === "queued" || job.status === "running") next[id] = job;
      }
      return { jobs: next };
    }),
}));

/** Cap on retained finished jobs, so a long session cannot grow unbounded. */
const SETTLED_KEEP = 20;

function pruneSettled(jobs: Record<string, JobRecord>): Record<string, JobRecord> {
  const settled = Object.values(jobs)
    .filter((j) => j.status !== "queued" && j.status !== "running")
    .sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const excess = settled.length - SETTLED_KEEP;
  if (excess <= 0) return jobs;
  const next = { ...jobs };
  for (let i = 0; i < excess; i++) delete next[settled[i].id];
  return next;
}

/* ---------------------- queue → store mirror (once) ------------------- */

const KEY_INTERRUPTED = "fitflow-jobs-interrupted-v1";
/** Error text stored on a garment whose job died with the page. */
export const INTERRUPTED_ERROR = "interrupted";
/** Spec: resume at most the single most-recent interrupted job. */
export const MAX_RESUME = 1;

function handleJobEvent(e: JobEvent): void {
  const { pushJob, patchJob, jobs } = useJobsStore.getState();
  if (e.type === "queued" || e.type === "started") {
    pushJob(e.job);
    return;
  }
  if (e.type === "stage") {
    patchJob(e.id, { stage: e.stage, ...(e.progress != null ? { progress: e.progress } : {}) });
    return;
  }
  // settle: write the terminal record, then bound history.
  const pruned = pruneSettled({ ...jobs, [e.job.id]: e.job });
  useJobsStore.setState({
    jobs: {
      ...pruned,
      [e.job.id]: e.job,
    },
  });
}

let uninstall: (() => void) | null = null;

/**
 * Start mirroring queue events into the store. Idempotent — safe to call from
 * several modules; only the first call subscribes.
 */
export function installJobsMirror(): () => void {
  if (uninstall) return uninstall;
  const off = subscribe(handleJobEvent);
  const onHide = () => rememberInterruptedJobs(activeIds());
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", onHide);
  }
  uninstall = () => {
    off();
    if (typeof window !== "undefined") window.removeEventListener("pagehide", onHide);
    uninstall = null;
  };
  return uninstall;
}

/* --------------------- interrupted-jobs handoff ----------------------- */

/**
 * Record the jobs that were mid-flight when the page went away. Empty input
 * clears the record rather than storing an empty list.
 */
export function rememberInterruptedJobs(ids: string[]): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (!ids || ids.length === 0) {
      localStorage.removeItem(KEY_INTERRUPTED);
      return;
    }
    localStorage.setItem(
      KEY_INTERRUPTED,
      JSON.stringify({ at: Date.now(), ids: ids.slice(0, MAX_RESUME) })
    );
  } catch {
    /* best-effort: losing this only costs a re-run after reload */
  }
}

/**
 * Read AND clear the interrupted record — it describes exactly one unload, so
 * a second boot must not replay it (that would re-run work the user already
 * abandoned).
 */
export function readInterruptedJobs(): { at: number; ids: string[] } | null {
  try {
    if (typeof localStorage === "undefined") return null;
    const raw = localStorage.getItem(KEY_INTERRUPTED);
    localStorage.removeItem(KEY_INTERRUPTED);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; ids?: unknown };
    const ids = Array.isArray(parsed.ids)
      ? parsed.ids.filter((x): x is string => typeof x === "string")
      : [];
    if (ids.length === 0) return null;
    return { at: typeof parsed.at === "number" ? parsed.at : 0, ids };
  } catch {
    return null;
  }
}

export { cancelJob };

/* Auto-install in the browser. Guarded so importing this module from a test
 * or SSR context never touches the queue. */
if (typeof window !== "undefined") {
  installJobsMirror();
}

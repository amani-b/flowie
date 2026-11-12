/**
 * Serial background-job runner (concurrency 1, FIFO).
 *
 * Why this exists: recon jobs used to be driven by a module-level
 * `reconChain: Promise` that each call appended itself to. That worked for
 * serialisation but had no cancel, no retry, and — because the promise chain
 * was the only record of a job — no way for the UI to know a job was queued,
 * running, or how far along it was. Progress was inferred from
 * `garment.reconStatus`, a single field that could only say "pending".
 *
 * This module is the executor and the single source of job lifecycle truth.
 * It owns ordering, cancellation and retry; it emits every transition to
 * subscribers so the store layer (see `store/jobsStore.ts`) can project it
 * into React and persist the interrupted set.
 *
 * CONTRACT
 * - Concurrency is exactly 1. One remote call at a time, always: the recon
 *   backends share one free ZeroGPU pool, and bursting it burns the daily
 *   budget for everyone else's calls too.
 * - `run` is called at most once per `enqueue`. Re-running is `retry`.
 * - A job never rejects into the caller: `run` errors are caught here and
 *   surface as a `failed` settlement event. Nothing thrown by a job can
 *   escape and break the import path that enqueued it.
 * - `cancel` is honest: a queued job is dropped before it starts (zero
 *   calls), a running job gets `signal.abort()`. Either way the job settles
 *   as `cancelled`, never as `failed` — a user's cancel is not an error.
 * - Subscribers are isolated: a throwing listener cannot stop the queue or
 *   starve the other listeners.
 */

/** Lifecycle of one job. `ready` = finished successfully. */
export type JobStatus = "queued" | "running" | "ready" | "failed" | "cancelled";

/** Immutable snapshot of a job, emitted with every event. */
export interface JobRecord {
  id: string;
  /** Coarse grouping for UI copy/logs, e.g. `"recon"`. */
  kind: string;
  /** Human label for the banner, e.g. the garment name. */
  label: string;
  status: JobStatus;
  /** Human-readable current step ("Waiting for the renderer…"). */
  stage?: string;
  /** 0..1 when the backend reports progress; otherwise undefined. */
  progress?: number;
  /** Present only when `status === "failed"`. */
  error?: string;
  queuedAt: number;
  startedAt?: number;
  endedAt?: number;
  /** 1 on first enqueue, incremented by each `retry`. */
  attempts: number;
}

export type JobEvent =
  | { type: "queued"; job: JobRecord }
  | { type: "started"; job: JobRecord }
  | { type: "stage"; id: string; stage: string; progress?: number }
  | { type: "settled"; job: JobRecord };

/** What a job is handed when it runs. */
export interface JobContext {
  /** Aborted by `cancel(id)`. Jobs should honour it and stop early. */
  signal: AbortSignal;
  /**
   * Report a human step. Drives the banner + detail-sheet copy, so write it
   * for the wearer, not the log.
   */
  onStage: (stage: string, progress?: number) => void;
}

export interface JobSpec {
  /** Unique + stable. Re-enqueueing an active id is a no-op. */
  id: string;
  kind?: string;
  label?: string;
  run: (ctx: JobContext) => Promise<void>;
}


/* ------------------------------- state -------------------------------- */

/** Waiting jobs, in FIFO order. Only the pump mutates this. */
const pending: JobSpec[] = [];
/** Records for queued+running jobs; dropped once settled. */
const records = new Map<string, JobRecord>();
/** Last spec per id, so `retry` can re-run a job that already settled. */
const specs = new Map<string, JobSpec>();
/** Live abort controllers for RUNNING jobs only. */
const controllers = new Map<string, AbortController>();
/** Enqueue count per id (surfaced as `attempts`). */
const attempts = new Map<string, number>();
const listeners = new Set<(e: JobEvent) => void>();
let running = false;

/** Test seam: wipe every job, listener and controller. */
export function resetJobQueueForTests(): void {
  pending.length = 0;
  records.clear();
  specs.clear();
  controllers.clear();
  attempts.clear();
  listeners.clear();
  running = false;
}

function isAbort(e: unknown): boolean {
  return (
    e instanceof Error &&
    (e.name === "AbortError" || /abort/i.test(e.message))
  );
}

function emit(event: JobEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* a bad listener must not stall the queue */
    }
  }
}

/** Observe every job transition. Returns an unsubscribe function. */
export function subscribe(fn: (e: JobEvent) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** True while `id` is queued or running. */
export function isActive(id: string): boolean {
  return controllers.has(id) || pending.some((j) => j.id === id);
}

/** Ids that are queued or running right now (used for interrupted-state). */
export function activeIds(): string[] {
  const out = new Set<string>();
  for (const id of controllers.keys()) out.add(id);
  for (const spec of pending) out.add(spec.id);
  return [...out];
}

/** How many jobs are waiting behind the running one. */
export function queueDepth(): number {
  return pending.length;
}

/* ------------------------------- control ------------------------------ */

/**
 * Queue a job. Fire-and-forget by design — callers are UI event handlers and
 * import loops that must never await a remote call.
 */
export function enqueue(spec: JobSpec): void {
  specs.set(spec.id, spec);

  // Already running: a second enqueue is a no-op, not a duplicate call.
  if (controllers.has(spec.id)) return;

  // Already waiting: swap in the newer spec, keep its place in line.
  const waitingAt = pending.findIndex((j) => j.id === spec.id);
  if (waitingAt >= 0) {
    pending[waitingAt] = spec;
    return;
  }

  const n = (attempts.get(spec.id) ?? 0) + 1;
  attempts.set(spec.id, n);

  const job: JobRecord = {
    id: spec.id,
    kind: spec.kind ?? "job",
    label: spec.label ?? spec.id,
    status: "queued",
    stage: "Waiting…",
    queuedAt: Date.now(),
    attempts: n,
  };
  records.set(spec.id, job);
  pending.push(spec);
  emit({ type: "queued", job });
  void pump();
}

/**
 * Cancel a job. Queued jobs never start (zero remote calls); running jobs get
 * their signal aborted and settle as `cancelled`.
 */
export function cancel(id: string): void {
  const controller = controllers.get(id);
  if (controller) {
    try {
      if (!controller.signal.aborted) controller.abort();
    } catch {
      /* already aborted */
    }
    return;
  }

  const at = pending.findIndex((j) => j.id === id);
  if (at < 0) return;
  pending.splice(at, 1);
  const record = records.get(id);
  records.delete(id);
  emit({
    type: "settled",
    job: {
      ...(record ?? {
        id,
        kind: "job",
        label: id,
        queuedAt: Date.now(),
        attempts: 0,
      }),
      status: "cancelled",
      stage: "Cancelled",
      endedAt: Date.now(),
    },
  });
}

/** Re-run a job that already settled or was cancelled. False = nothing to re-run. */
export function retry(id: string): boolean {
  const spec = specs.get(id);
  if (!spec || isActive(id)) return false;
  enqueue(spec);
  return true;
}

/* -------------------------------- pump -------------------------------- */

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    while (pending.length > 0) {
      const spec = pending.shift();
      if (!spec) break;
      const record = records.get(spec.id);
      // Vanished = cancelled while waiting; `cancel` already emitted.
      if (!record) continue;

      const controller = new AbortController();
      controllers.set(spec.id, controller);
      const live: JobRecord = {
        ...record,
        status: "running",
        stage: "Starting…",
        startedAt: Date.now(),
      };
      records.set(spec.id, live);
      emit({ type: "started", job: live });

      let settled: JobRecord;
      try {
        await spec.run({
          signal: controller.signal,
          onStage: (stage, progress) => {
            const cur = records.get(spec.id);
            if (!cur) return;
            records.set(spec.id, {
              ...cur,
              stage,
              progress: progress ?? cur.progress,
            });
            emit({ type: "stage", id: spec.id, stage, progress });
          },
        });
        settled = controller.signal.aborted
          ? { ...live, status: "cancelled", stage: "Cancelled", endedAt: Date.now() }
          : { ...live, status: "ready", stage: "Done", progress: 1, endedAt: Date.now() };
      } catch (e) {
        // A cancel that raced the throw is still a cancel, not a failure.
        settled =
          controller.signal.aborted || isAbort(e)
            ? { ...live, status: "cancelled", stage: "Cancelled", endedAt: Date.now() }
            : {
                ...live,
                status: "failed",
                stage: "Failed",
                error: e instanceof Error ? e.message : String(e),
                endedAt: Date.now(),
              };
      } finally {
        controllers.delete(spec.id);
      }

      records.delete(spec.id);
      emit({ type: "settled", job: settled });
    }
  } finally {
    running = false;
  }
}

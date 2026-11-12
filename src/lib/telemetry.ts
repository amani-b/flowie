/**
 * Phase 0 instrumentation: stage timings, long-task capture and a global
 * error funnel.
 *
 * Dev-only by design. Every export early-returns on `import.meta.env.DEV`,
 * which Vite statically replaces with `false` in production, so Rollup drops
 * these calls from `dist/`. Nothing here changes app behaviour; it observes.
 *
 * During a real import, read the captured data in the browser console:
 *   __flowiePerf.report()   // formatted dump: stages, long tasks, errors
 *   __flowiePerf.timings    // StageTiming[]
 *   __flowiePerf.longTasks  // raw PerformanceObserver entries
 *   __flowiePerf.errors     // CapturedError[]
 *   __flowiePerf.reset()    // clear before the run you want to measure
 */

const isDev = import.meta.env.DEV;

export interface StageTiming {
  /** Stable id, e.g. "import:files-picked", "recon:pending", "boot:rehydrate". */
  stage: string;
  /** performance.now() of this boundary. */
  t: number;
  /** ms elapsed since the previous mark. */
  deltaMs: number;
  detail?: string;
}

export interface LongTaskEntry {
  start: number;
  durationMs: number;
  name: string;
}

export type ErrorKind =
  | "window.onerror"
  | "unhandledrejection"
  | "boundary"
  | "console.error";

export interface CapturedError {
  kind: ErrorKind;
  message: string;
  at: number;
  stack?: string;
}

/** Anything over 50ms blocks input; that is the gate for Phases 1 and 2. */
export const LONG_TASK_MS = 50;

const MAX_TIMINGS = 400;
const MAX_LONG_TASKS = 200;
const MAX_ERRORS = 50;

const timings: StageTiming[] = [];
const longTasks: LongTaskEntry[] = [];
const errors: CapturedError[] = [];

/** Origin for deltaMs; re-based by resetAll()/installTelemetry(). */
let lastT = 0;

function resetOrigin() {
  lastT = performance.now();
}

/** Record a pipeline stage boundary. No-op in production. */
export function markStage(stage: string, detail?: string): void {
  if (!isDev) return;
  const t = performance.now();
  const entry: StageTiming = {
    stage,
    t,
    deltaMs: t - lastT,
    ...(detail ? { detail } : {}),
  };
  timings.push(entry);
  if (timings.length > MAX_TIMINGS) timings.shift();
  lastT = t;
  console.debug(
    `[perf] ${stage}${detail ? ` — ${detail}` : ""} ` +
      `@${entry.t.toFixed(0)}ms (+${entry.deltaMs.toFixed(0)}ms)`
  );
}

/** Funnel an error from any source into one inspectable list. */
export function captureError(kind: ErrorKind, error: unknown): void {
  if (!isDev) return;
  const message =
    error instanceof Error ? error.message : String(error ?? "unknown error");
  const stack = error instanceof Error ? error.stack : undefined;
  const entry: CapturedError = {
    kind,
    message,
    at: performance.now(),
    ...(stack ? { stack } : {}),
  };
  errors.push(entry);
  if (errors.length > MAX_ERRORS) errors.shift();
  console.debug(`[perf] error(${kind}) @${entry.at.toFixed(0)}ms — ${message}`);
}

export function report(): string {
  if (!isDev) return "perf instrumentation is dev-only (not present in production builds)";
  const lines: string[] = [`--- ${timings.length} stage timings ---`];
  for (const e of timings) {
    lines.push(
      `${e.t.toFixed(0).padStart(7)}ms  +${e.deltaMs.toFixed(0).padStart(6)}ms  ${e.stage}` +
        (e.detail ? ` — ${e.detail}` : "")
    );
  }
  const blocking = blockingTasks();
  lines.push(
    `--- long tasks >${LONG_TASK_MS}ms: ${blocking.length} blocking of ${longTasks.length} observed ---`
  );
  for (const l of blocking) {
    lines.push(`  @${l.start.toFixed(0)}ms  ${l.durationMs.toFixed(0)}ms  ${l.name}`);
  }
  lines.push(`--- captured errors: ${errors.length} ---`);
  for (const e of errors) {
    lines.push(`  @${e.at.toFixed(0)}ms  [${e.kind}] ${e.message}`);
  }
  return lines.join("\n");
}

function resetAll() {
  timings.length = 0;
  longTasks.length = 0;
  errors.length = 0;
  resetOrigin();
}

function installLongTaskObserver() {
  if (typeof PerformanceObserver === "undefined") return;
  const supported = PerformanceObserver.supportedEntryTypes ?? [];
  if (!supported.includes("longtask")) {
    console.debug("[perf] 'longtask' entries unsupported here; stage marks still work");
    return;
  }
  try {
    const obs = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks.push({
          start: entry.startTime,
          durationMs: entry.duration,
          name: entry.name,
        });
        if (longTasks.length > MAX_LONG_TASKS) longTasks.shift();
      }
    });
    obs.observe({ entryTypes: ["longtask"] });
  } catch (e) {
    console.debug("[perf] longtask observer failed", e);
  }
}

/**
 * Errors that escape React entirely (async callbacks, a throw before the
 * root mounts) never reach an error boundary, so the window-level funnel is
 * the only place they are observable.
 */
function installErrorCapture() {
  window.addEventListener("error", (ev) => {
    const err = (ev as ErrorEvent).error;
    captureError("window.onerror", err ?? ev.message ?? "unknown error");
  });
  window.addEventListener("unhandledrejection", (ev) => {
    captureError("unhandledrejection", ev.reason);
  });
}

/**
 * Idempotent — safe to call from main.tsx and again after an HMR reload.
 * Installs the long-task observer, the window error funnel and
 * `window.__flowiePerf`.
 */
export function installTelemetry(): void {
  if (!isDev) return;
  const w = window as unknown as { __flowiePerfInstalled?: boolean };
  if (w.__flowiePerfInstalled) {
    resetOrigin();
    return;
  }
  w.__flowiePerfInstalled = true;
  (window as unknown as { __flowiePerf: unknown }).__flowiePerf = {
    timings,
    longTasks,
    errors,
    report,
    markStage,
    blockingTasks,
    reset: resetAll,
  };
  resetAll();
  installLongTaskObserver();
  installErrorCapture();
  markStage("telemetry:installed");
}

/** Clear captured data and re-base deltas, without reinstalling listeners. */
export function resetTimings(): void {
  if (!isDev) return;
  resetAll();
}


/** Long tasks that actually blocked input, worst first. */
export function blockingTasks(): LongTaskEntry[] {
  return longTasks
    .filter((l) => l.durationMs > LONG_TASK_MS)
    .sort((a, b) => b.durationMs - a.durationMs);
}

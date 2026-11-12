/**
 * Phase 2 gate probe, part 2 of 3 — cancellation, on device.
 *
 * Runs while part 1's long batch (1 running + 2 queued) is still in flight.
 * Two different cancels, because they take different code paths:
 *   - QUEUED victim: must be dropped without ever calling the function;
 *   - RUNNING blocker: the in-flight request is abandoned via AbortSignal, and
 *     the outcome must be "cancelled", NOT "failed" — a wearer's own tap is
 *     not an error, and it must not raise a Try again pill.
 * Also asserts the garment record loses its `pending` mark (no phantom
 * spinner) and that the jobs mirror agrees.
 */

const app = await import("/src/store/appStore.ts");
const store = app.useAppStore;
const q = await import("/src/services/jobQueue.ts");
const jobsMirror = await import("/src/store/jobsStore.ts");
const S = window.__phase2;
if (!S || !S.armed) return { error: "part 1 did not arm the batch" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 30000) => {
  const t = performance.now();
  while (!fn()) {
    if (performance.now() - t > ms) throw new Error("timeout waiting for " + label);
    await sleep(40);
  }
};
const garment = (id) => store.getState().garments.find((g) => g.id === id);
const jobOf = (id) => jobsMirror.useJobsStore.getState().jobs[id] ?? null;
const mark = S.calls.length;
const { blocker, victims, ids } = S.armed;
const before = { activeIds: q.activeIds().length, depth: q.queueDepth(), mirror: S.armed.mirror };

/* --- cancel the QUEUED victims: no call must ever be attributed to them -- */
for (const v of victims) q.cancel(v);
await until(
  () => victims.every((v) => jobOf(v)?.status === "cancelled"),
  "victims to report cancelled"
);
const victimJobStates = victims.map((v) => ({
  id: v.slice(0, 8),
  jobStatus: jobOf(v)?.status ?? null,
  reconStatus: garment(v)?.reconStatus ?? null,
  reconError: garment(v)?.reconError ?? null,
  active: q.isActive(v),
}));
const victimCalls = S.calls.filter((c) => victims.some((v) => c.garment === v.slice(0, 8))).length;

/* --- cancel the RUNNING blocker: abandon in flight, never "failed" ------ */
q.cancel(blocker);
await until(() => !q.isActive(blocker), "blocker to settle");
await until(() => jobOf(blocker)?.status !== "running", "blocker mirror to settle");
const blockerState = {
  id: blocker.slice(0, 8),
  jobStatus: jobOf(blocker)?.status ?? null,
  reconStatus: garment(blocker)?.reconStatus ?? null,
  reconError: garment(blocker)?.reconError ?? null,
  hasRecon: !!garment(blocker)?.reconUrl,
  callsAttributed:
    S.calls.filter((c) => c.garment === blocker.slice(0, 8)).length,
};

/* --- the cancelled garments must not resurrect later ------------------- */
const drainMark = S.calls.length;
await sleep(6000); // longer than the stub's 5s ceiling: a resurrect would show
const resurrected = S.calls.length - drainMark;

/* --- the whole arm must be gone, and the queue idle -------------------- */
await until(() => ids.every((id) => !q.isActive(id)), "arm to be empty");

const payload = {
  before,
  victimCalls,
  victimJobStates,
  blockerState,
  resurrectedCalls: resurrected,
  queueAfter: { activeIds: q.activeIds().length, depth: q.queueDepth() },
  failedAnywhere: ids
    .map((id) => garment(id)?.reconError)
    .filter((e) => !!e),
};
localStorage.setItem("flowie-probe-c-v1", JSON.stringify(payload));
return payload;

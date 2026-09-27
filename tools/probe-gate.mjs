/**
 * Phase 2 gate probe — serial execution + recon cache, isolated and decisive.
 *
 * Why this file exists instead of just re-running `probe-jobs-a.mjs`
 * ---------------------------------------------------------------------
 * That probe accumulated state across phases AND across runs: a
 * `window.__phase2` singleton, a closet that already held recon-ready garments
 * from previous runs, and a fetch stub left installed. On a repeat run that
 * produced evidence that was internally INCONSISTENT — "A cold import" reported
 * `calls: 0` while the garment was still `pending` with no recon, and the
 * following "identical re-import" reported 1 call. Those were artefacts of
 * leftover state, not measurements.
 *
 * A gate number that a dirty closet can produce is worse than no gate number,
 * so this probe is single-shot and self-clearing: it empties the closet, clears
 * the recon cache, resets the budget counter, and starts from a known-empty
 * state before measuring each claim.
 *
 * EGRESS IS INTERCEPTED so the shared free recon quota (4/day) is never spent,
 * and so the call count means "requests the app decided to make" — which is
 * what the gate is about. The stub returns a real 1x1 PNG so the ready/cached
 * plumbing runs end to end. Render QUALITY is not under test; that was Phase 1.
 *
 * WHY THIS VERSION WAITS ON GARMENT STATE, NOT ON QUEUE STATE (v2)
 * ----------------------------------------------------------------
 * v1 sampled `until(() => !q.isActive(id))` and counted the calls that landed
 * inside a window delimited by `calls.length` marks. Both are ambiguous:
 *
 * - `isActive(id) === false` is true both BEFORE a job has been observed and
 *   AFTER it settled, so the wait could pass instantly. Every window then
 *   shifts by one: A's call landed in B's window, B's in C's, and C's second
 *   job was still queued when its window closed. That is exactly what the first
 *   `probe-gate.json` shows (`1a: 0 calls + pending`, `1b: 1 call`,
 *   `3: 1 call + 1 running + 1 queued at the end`) — a sampler artefact, not a
 *   product defect. The mirror in that same JSON (`2x ready`, queue drained
 *   behind a single runner) is the queue doing its job.
 * - `peakConcurrency` counted an in-flight call as `[at,+1],[at,-1]`, which
 *   sorts the `-1` first and computes peak 0. Also a sampler artefact.
 *
 * So v2 changes what is measured, and nothing else:
 *   1. Terminal signal = the GARMENT record (`reconStatus` ready/failed, or the
 *      pending mark cleared). That can only be reached after the job ran.
 *   2. Liveness is read from BOTH `jobQueue.isActive` and the jobs mirror, and
 *      both are reported — if the two ever disagree, the JSON shows it instead
 *      of silently trusting one.
 *   3. Calls are attributed PER GARMENT (`body.garment_id`), never by window
 *      slice. A shifted window can no longer move a call between claims.
 *   4. A garment whose job never ran (shoes/accessories, no photo, budget
 *      spent, already had a recon) is reported as UNMEASURED with its
 *      category/reconClass/renderer — never as a silent pass or fail.
 *
 * WHAT v3 ADDS (and why v2 still produced the off-by-one signature)
 * -----------------------------------------------------------------
 * v2 fixed the *peak* arithmetic and the in-flight filter, but the three waits
 * it inherited from v1 were still the v1 waits, and v2 kept calling
 * `settleOne`:
 *
 *   `await until(() => !q.isActive(id))`
 *
 * is FALSE-for-the-wrong-reason: it is true both when a job has finished AND
 * when it has not started yet, and `addGarment` is fire-and-forget, so the wait
 * returned on the first poll — before `enqueue` → `pump` → `fetch` had even
 * happened. Every subsequent window was therefore shifted by one, and the probe
 * read the NEXT garment's call.
 *
 * v3 removes the ambiguity at the source instead of compensating for it:
 *   1. `waitForActiveThenSettle(id)` — observe the job as live FIRST (which is
 *      the only thing that can prove a job existed), then wait for it to stop,
 *      then wait for the garment record to reach a terminal state. No wait is
 *      ever satisfied by "nothing has happened yet".
 *   2. `isTerminal` mirrors the spec exactly (`ready` / `failed` / `reconUrl`)
 *      and no longer treats a cleared `reconStatus` as terminal — an
 *      in-flight job is "not started yet", not "skipped", and conflating the
 *      two is the same bug in a different coat.
 *   3. `settleOne` is gone. It was another non-ambiguity in disguise: it
 *      stopped waiting the instant `isActive` flicked false, which on a serial
 *      queue happens for B while C is still coming.
 *   4. `peakConcurrency` waits for every call to have ENDED before computing,
 *      re-reading the (mutating) records each time. Reporting a peak while a
 *      call is still in flight is a number that is guaranteed wrong.
 *   5. The mid-batch sampler polls from BEFORE `importPhotos` (the queue is
 *      empty then, by construction) and triggers on `queueDepth() >= 1` or the
 *      mirror showing a runner with something behind it. The v1
 *      `activeIds >= 2` condition can never fire on a concurrency-1 queue, so
 *      it reported `null` no matter what the product did.
 *   6. Cold-claim integrity: the store diff that recovers a garment id can
 *      match a leftover record from a previous run (the v1 JSON shows exactly
 *      that — 1a reported `cacheSize: 0` while 1b's garment already carried a
 *      `reconUrl`). A stale record is dropped rather than returned, because
 *      otherwise the probe hands the caller a garment whose job already ran.
 */

const app = await import("/src/store/appStore.ts");
const store = app.useAppStore;
const upload = await import("/src/services/uploadQueue.ts");
const q = await import("/src/services/jobQueue.ts");
const cache = await import("/src/services/reconCache.ts");
const jobsMirror = await import("/src/store/jobsStore.ts");
const reconSvc = await import("/src/services/garmentRecon.ts");
const { supabase, isSupabaseConfigured } = await import("/src/services/supabaseClient.ts");

const { reconClassFor, RECON_DAILY_BUDGET, getReconDailyCount } = reconSvc;

/* ------------------------------ fixtures ------------------------------- */
const ORIGIN = window.__phase2Origin ?? "";
const SAMPLE = (n) => `${ORIGIN}/_tmp_photos/photo_${n}_2026-09-18_07-49-17.jpg`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll until `fn()` is true. Returns whether it became true — never throws. */
const pollFor = async (fn, ms, every = 20) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(every);
  }
  return fn();
};

/**
 * Poll until `fn()` is true, or throw with the label. Throwing is the point:
 * a wait that quietly gives up produces a measurement from a state nobody
 * checked (see the v1 off-by-one, where the wait was satisfied instantly).
 */
const until = async (fn, label, ms = 180000) => {
  const t = performance.now();
  while (!fn()) {
    if (performance.now() - t > ms) throw new Error("timeout waiting for " + label);
    await sleep(40);
  }
};

const garment = (id) => store.getState().garments.find((g) => g.id === id);
const mirrorJob = (id) => jobsMirror.useJobsStore.getState().jobs[id] ?? null;
const mirrorStatus = (id) => mirrorJob(id)?.status ?? null;
const mirror = () =>
  Object.values(jobsMirror.useJobsStore.getState().jobs).map((j) => ({
    id: String(j.id).slice(0, 8),
    status: j.status,
    stage: j.stage ?? null,
  }));
const LIVE = new Set(["queued", "running"]);

/**
 * Every queue stage transition, recorded straight from the queue's own event
 * stream. This is the UI's progress source, so it answers "did the banner have
 * something honest to say while the batch was busy" without inferring it from
 * polling samples that can miss short stages.
 */
const queueEvents = [];
const unsubscribeEvents = q.subscribe((e) => {
  queueEvents.push({
    type: e.type,
    id: "job" in e && e.job ? String(e.job.id).slice(0, 8) : "id" in e ? String(e.id).slice(0, 8) : null,
    status: "job" in e && e.job ? e.job.status : null,
    stage: e.type === "stage" ? e.stage : "job" in e && e.job ? (e.job.stage ?? null) : null,
    at: Math.round(performance.now()),
  });
});

// Photos are fetched one at a time, never pooled: holding every JPEG plus its
// decoded canvases at once is what took the renderer down the first time.
const loadPhoto = async (n) => {
  const buf = await (await fetch(SAMPLE(n))).arrayBuffer();
  return new File([buf], `photo_${n}_2026-09-18_07-49-17.jpg`, { type: "image/jpeg" });
};

/* --------------------------- egress interception ------------------------- */
const STUB_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

const calls = [];
const realFetch = globalThis.fetch.bind(globalThis);
let stubDelayMs = 700;
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : (input && input.url) || "";
  if (!url.includes("recon-garment")) return realFetch(input, init);
  let body = {};
  try {
    body = JSON.parse((init && init.body) || "{}");
  } catch {
    /* non-JSON body: nothing to attribute */
  }
  const rec = {
    garment: body.garment_id ? String(body.garment_id).slice(0, 8) : null,
    cls: body.garment_class ?? null,
    renderer: body.renderer ?? null,
    seed: body.seed ?? null,
    at: Math.round(performance.now()),
    ended: null,
  };
  calls.push(rec);
  await sleep(stubDelayMs);
  rec.ended = Math.round(performance.now());
  return new Response(JSON.stringify({ recon_data_url: STUB_PNG }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

/** Every remote call the app made for THIS garment. Window-proof by design. */
const callsFor = (id) => {
  const key = id.slice(0, 8);
  return calls.filter((c) => c.garment === key);
};

/** Reset the client-side daily-budget guard (safe: egress is stubbed). */
const resetBudget = () =>
  localStorage.setItem(
    "fitflow-recon-calls-v1",
    JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: 0 })
  );

/**
 * Peak overlap of the stub's in-flight windows = real remote concurrency.
 *
 * Two things are load-bearing here:
 *   - an in-flight call (`ended === null`) is EXCLUDED rather than treated as
 *     starting and ending at the same instant, which collapsed the peak to 0;
 *   - the records are MUTATED in place by the stub (it writes `ended` when the
 *     response lands), so a subset captured earlier can still be missing an
 *     `ended`. Since a peak computed while something is in flight is a number
 *     that is guaranteed wrong, wait for every call to have ended and re-read
 *     the live records, up to a bounded budget.
 */
const peakConcurrency = async (subset, ms = 30000) => {
  // Re-read from the live array by identity: `calls` is where the stub writes.
  const key = new Set(subset);
  const live = () => calls.filter((c) => key.has(c));
  let pending = live().filter((c) => c.ended == null);
  if (pending.length) await sleep(5000);
  const t0 = performance.now();
  while (live().some((c) => c.ended == null) && performance.now() - t0 < ms) {
    await sleep(100);
  }

  const done = live().filter((c) => c.ended != null);
  const events = [];
  for (const c of done) {
    events.push([c.at, 1]);
    events.push([c.ended, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of events) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  return { peak, inFlight: live().length - done.length, counted: done.length };
};

/** True when call windows never overlap: the durable serial proof. */
const nonOverlapping = (subset) => {
  const sorted = [...subset].sort((a, b) => a.at - b.at);
  return sorted.every((c, i) => i === 0 || sorted[i - 1].ended == null || c.at >= sorted[i - 1].ended);
};

/* --------------------------- settle / terminal -------------------------- */

/**
 * Terminal by the SPEC's definition: `reconStatus` is `ready` or `failed`, or
 * a `reconUrl` exists. Deliberately narrower than the v2 version, which also
 * accepted a cleared (`null`) `reconStatus`:
 *
 *   `applyReconPatch(..., { reconStatus: undefined })` is how a job that
 *   decided to produce nothing lands (cancelled / budget spent / no source) —
 *   but a garment that is still WAITING has not been patched at all yet, and
 *   `undefined` is also what an untouched record carries. Accepting it made
 *   "has not started" indistinguishable from "finished with nothing", which
 *   is the same class of bug as waiting on `!isActive`. A record that really
 *   did settle without a recon is caught by `settleOneGarment`'s call-count
 *   assertion and by `waitForTerminal` timing out — reported, never assumed.
 */
const isTerminal = (id) => {
  const g = garment(id);
  return !!g && (g.reconStatus === "ready" || g.reconStatus === "failed" || !!g.reconUrl);
};

/** Wait until every id is terminal. The only honest "the work is done" signal. */
const waitForTerminal = (ids, label, ms = 240000) =>
  until(() => ids.every(isTerminal), label, ms);

/**
 * Wait for a garment's recon job to START, then finish.
 *
 * The first wait is the one v2 was missing and is not optional: `isActive` is
 * false before a job exists, so "wait until inactive" can be satisfied by
 * "nothing happened", silently shifting every measurement by one job. Seeing
 * the job live first makes that impossible — and a job that never goes live is
 * reported with the diagnostics needed to tell an analyzer-gate skip (shoes and
 * accessories return `null` from `analyzeGarmentPhoto()`, so zero calls is
 * correct) from a genuine failure to enqueue.
 */
const waitForActiveThenSettle = async (id, label) => {
  try {
    await until(() => q.isActive(id), label + " saw-active", 30000);
  } catch (e) {
    const g = garment(id);
    throw new Error(
      `job never active for ${id.slice(0, 8)} cat=${g?.category} reconClass/end: ` + e.message
    );
  }
  await until(() => !q.isActive(id), label + " settle");
  await waitForTerminal([id], label + " terminal");
};

/**
 * Settle a WHOLE batch at once, watching every id concurrently.
 *
 * This exists because settling a batch with `for (const id of ids) await
 * waitForActiveThenSettle(id)` reintroduces the very bug being fixed, one level
 * up: on a serial queue B does not start until A finishes, so B's 30 s
 * see-active window opens only after A's job — and if A takes longer than that
 * window (or B ran while the probe was still waiting on A), B is declared
 * "never active" although it demonstrably ran (its call is in `calls`).
 *
 * Watching all ids on one shared poll removes the ordering assumption
 * entirely: a garment is recorded live the moment it is live, whenever that
 * happens to be.
 */
const waitForBatch = async (ids, label, ms = 240000) => {
  const sawActive = new Set();
  const t0 = performance.now();
  await until(
    () => {
      for (const id of ids) if (!sawActive.has(id) && q.isActive(id)) sawActive.add(id);
      return sawActive.size === ids.length;
    },
    label + " saw-active(all)",
    ms
  );
  await waitForTerminal(ids, label + " terminal", ms);
  return {
    sawActive: [...sawActive].map((id) => id.slice(0, 8)),
    // Ids never observed live: reported, never silently ignored. Empty here is
    // normal for a fast serial queue only if every id was seen; a non-empty
    // list is the honest signal that the sample missed something.
    neverSeenActive: ids.filter((id) => !sawActive.has(id)).map((id) => id.slice(0, 8)),
    waitedMs: Math.round(performance.now() - t0),
  };
};

/** Drive one garment to terminal and attribute its calls by garment id. */
const settleOneGarment = async (id, label) => {
  const startedAt = performance.now();
  await waitForActiveThenSettle(id, label);
  const settledAt = performance.now();
  const mine = callsFor(id);
  const g = garment(id);
  return {
    id: id.slice(0, 8),
    calls: mine.length,
    status: g?.reconStatus ?? null,
    reconUrl: g?.reconUrl ? "set" : null,
    renderer: g?.reconRenderer ?? null,
    // Poll cadence is 40 ms, so a ~1 ms job can beat the first sample; both
    // ends of the window are recorded so that shows up as fact, not guesswork.
    observedLiveMs: Math.round(settledAt - startedAt),
    category: g?.category ?? null,
    reconClass: g?.category ? (reconClassFor(g.category) ?? null) : null,
    photoSha256: (g?.photoSha256 ?? "").slice(0, 16) || null,
    // The banner's source of truth for this garment, read after settling.
    finalMirrorStatus: mirrorStatus(id),
    finalMirrorStage: mirrorJob(id)?.stage ?? null,
  };
};

/**
 * Everything needed to tell a legitimate skip from a broken pipeline: a
 * 0-call verdict is only defensible next to the category that produced it.
 */
const diag = (id) => {
  const g = garment(id);
  const cat = g?.category ?? null;
  return {
    category: cat,
    reconClass: cat ? (reconClassFor(cat) ?? null) : null,
    hasPrint: g?.hasPrint ?? null,
    renderer: g ? (g.hasPrint ? "klein" : "tryoff") : null,
    hasPhoto: !!g?.photo,
    sha: (g?.photoSha256 ?? "").slice(0, 16) || null,
    budgetUsed: getReconDailyCount(),
    budget: RECON_DAILY_BUDGET,
  };
};

/** Call counts keyed by garment, so a stale record is impossible to miss. */
const callsByGarment = () => {
  const out = {};
  for (const c of calls) {
    if (!c.garment) continue;
    out[c.garment] = (out[c.garment] ?? 0) + 1;
  }
  return out;
};

/**
 * The honest way to read concurrency: the highest number of stub calls that
 * were in flight AT THE SAME TIME. `q.activeIds().length` is a queue-depth
 * number and says nothing about egress; two active jobs on a broken
 * parallelism gate would still be zero remote calls if neither had fired yet.
 */
const maxRemoteInFlight = () => {
  const events = [];
  for (const c of calls) {
    if (c.ended == null) continue;
    events.push([c.at, 1]);
    events.push([c.ended, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  for (const [, d] of events) {
    cur += d;
    peak = Math.max(peak, cur);
  }
  return peak;
};

/* ------------------------------ the import ----------------------------- */
const IMPORT_TIMEOUT_MS = 240000;

/**
 * `onItem` hands over a garment WITHOUT an id — the type is
 * `Omit<Garment, "id" | "createdAt">` because `addGarment` mints the id. So the
 * id is recovered by diffing the store around the (async) `addGarment` call,
 * and the batch awaits that work before resolving, because `onComplete` can
 * fire first.
 *
 * The freshness predicate excludes records that ALREADY have a recon. That is
 * not a nicety: a leftover garment (an earlier run, a persisted snapshot) that
 * gets restored or re-added during this window would otherwise be picked as
 * "the new one", and the probe would then wait on a garment whose job ran long
 * ago — which reads as `never active` and stalls for the full import budget.
 * The v1 JSON shows precisely this: CLAIM 1a reported `cacheSize: 0` while
 * CLAIM 1b's garment already matched the cold render, so the diff had matched
 * something that had a recon before this run started.
 */
const importPhotos = (files) =>
  new Promise((resolve, reject) => {
    const items = files.map((file) => ({ file, fileName: file.name }));
    const got = [];
    const idWork = [];
    const to = setTimeout(() => reject(new Error("import did not complete")), IMPORT_TIMEOUT_MS);
    upload.startImport(items, {
      onItem: (g, _tags, fileName) => {
        const entry = {
          id: null,
          file: fileName,
          sha: (g.photoSha256 || "").slice(0, 16),
          cat: g.category,
        };
        got.push(entry);
        const before = new Set(store.getState().garments.map((x) => x.id));
        idWork.push(
          store
            .getState()
            .addGarment(g, g.photo)
            .then(() => {
              const fresh = store
                .getState()
                .garments.find((x) => !before.has(x.id) && !x.reconUrl);
              if (fresh) entry.id = fresh.id;
            })
            .catch(() => {})
        );
      },
      onError: (f, m) => got.push({ file: f, error: m }),
      onComplete: (added, n) => {
        clearTimeout(to);
        Promise.all(idWork).then(() => resolve({ got, added, n }));
      },
    });
  });

/* ------------------------- samplers (probe-side) ------------------------ */

/**
 * Frame deltas while the batch drains — the UI must not freeze.
 *
 * `requestAnimationFrame` is throttled to ~0 Hz on a hidden page, so a
 * backgrounded handset screen produces a handful of samples and a p95 that
 * means nothing. That is reported (`pageVisibility`, `frames`) rather than
 * guessed at; the claim is informational either way and never gates.
 */
const startFrameSampler = () => {
  const times = [];
  let stop = false;
  const visibility = document.visibilityState ?? "unknown";
  const tick = (t) => {
    times.push(t);
    if (!stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  return {
    visibility,
    times,
    stop: () => {
      stop = true;
    },
  };
};

/**
 * Queue shape while the batch drains.
 *
 * v1 triggered on `activeIds().length >= 2`, which a concurrency-1 queue can
 * never reach by construction — the condition was unsatisfiable, so the field
 * was `null` in every run and proved nothing about the product. The observable
 * serial signature is the MIRROR: at most one runner, with something waiting
 * behind it (`queueDepth() >= 1`, or one running + at least one queued).
 *
 * The sampler is started BEFORE `importPhotos` for this claim. The queue is
 * empty at that point (the closet is wiped, the cache is cleared, the budget is
 * reset above), so a first hit is a real transition into a busy queue rather
 * than a leftover from an earlier claim.
 */
const startQueueSampler = (ids = []) => {
  const idSet = new Set(ids);
  const state = {
    maxRunning: 0,
    maxQueued: 0,
    queuedSnapshot: null,
    /** First moment the queue was observably busy: 1 running + >=1 waiting. */
    observedWhileBusy: null,
    /** True once that shape was seen — the durable serial proof. */
    sawSerial: false,
    /** Every distinct `id|stage` pair seen for a garment in this batch. */
    stages: new Set(),
  };
  const timer = setInterval(() => {
    const jobs = Object.values(jobsMirror.useJobsStore.getState().jobs);
    const running = jobs.filter((j) => j.status === "running");
    const queued = jobs.filter((j) => j.status === "queued");
    const depth = q.queueDepth();

    for (const j of jobs) {
      const id = String(j.id);
      // Filtered to this batch: another garment's stages are not evidence
      // about this one, and the mirror retains settled jobs across claims.
      if (idSet.size && !idSet.has(id)) continue;
      if (j.stage) state.stages.add(`${id.slice(0, 8)}|${j.stage}`);
    }

    state.maxRunning = Math.max(state.maxRunning, running.length);
    state.maxQueued = Math.max(state.maxQueued, queued.length);

    if (!state.queuedSnapshot && (queued.length >= 1 || depth >= 1)) {
      state.queuedSnapshot = {
        queued: queued.map((j) => String(j.id).slice(0, 8)),
        running: running.map((j) => ({ id: String(j.id).slice(0, 8), stage: j.stage ?? null })),
        mirrorDepth: queued.length,
        queueDepth: depth,
      };
    }

    // The condition v1 could never satisfy: one runner AND work behind it.
    // Either source alone is enough — the mirror is what the banner renders,
    // `queueDepth()` is the queue's own count, and a disagreement between them
    // is itself worth capturing.
    const busy = running.length >= 1 && (queued.length >= 1 || depth >= 1);
    if (busy && !state.observedWhileBusy) {
      state.sawSerial = true;
      state.observedWhileBusy = {
        at: Math.round(performance.now()),
        running: running.map((j) => ({ id: String(j.id).slice(0, 8), stage: j.stage ?? null })),
        queued: queued.map((j) => String(j.id).slice(0, 8)),
        // Named for what `activeIds()` actually returns: running PLUS queued.
        // Labelling it "running" made it look like it disagreed with
        // `mirrorRunning: 1` when the two agree perfectly (1 + 1 = 2).
        activeIdsRunningPlusQueued: q.activeIds().length,
        queueDepth: depth,
        mirrorRunning: running.length,
        mirrorQueued: queued.length,
      };
    }
  }, 20);
  return { state, stop: () => clearInterval(timer) };
};

/** End-of-run projection: nothing may still be queued or running. */
const liveJobs = () =>
  Object.values(jobsMirror.useJobsStore.getState().jobs)
    .filter((j) => LIVE.has(j.status))
    .map((j) => ({ id: String(j.id).slice(0, 8), status: j.status, stage: j.stage ?? null }));

const pct = (sorted, p) =>
  sorted.length === 0
    ? null
    : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];

/* -------------------------------- measure ------------------------------- */
const results = [];
const unmeasured = [];
let failed = null;
try {
  // Demo mode: a signed-out app renders only the auth screen, and the probe
  // drives the store directly, so this needs no credentials.
  store.getState().enterDemoMode();
  await sleep(1500);

  // Empty the closet so no garment can already hold a recon — that is what
  // silently zeroed the cold-import call count before.
  store.setState({ garments: [], looks: [], today: null });
  cache.clearReconCache();
  resetBudget();
  calls.length = 0;

  results.push({
    test: "0 preconditions",
    supabaseConfigured: isSupabaseConfigured,
    supabaseClient: !!supabase,
    garments: store.getState().garments.length,
    cacheSize: cache.reconCacheSize(),
    budgetUsed: getReconDailyCount(),
  });

  /* --- CLAIM 1: a cold import of unseen content makes exactly ONE call --- */
  const markA = calls.length; // informational only: the v1 window number
  const impA = await importPhotos([await loadPhoto(1)]);
  const gA = impA.got.find((g) => g.id);
  if (!gA) throw new Error("cold import produced no garment: " + JSON.stringify(impA.got));
  const mA = await settleOneGarment(gA.id, "cold recon to settle");
  const coldSha = garment(gA.id)?.photoSha256 ?? null;
  const coldUrl = garment(gA.id)?.reconUrl ?? null;
  const aCalls = callsFor(gA.id).length;
  const aPass =
    aCalls === 1 && garment(gA.id)?.reconStatus === "ready" && !!coldUrl;
  if (!aPass)
    unmeasured.push({
      test: "CLAIM 1a",
      verdict: "cold import did not produce exactly one call and a ready render",
      calls: aCalls,
      status: garment(gA.id)?.reconStatus ?? null,
      hasRecon: !!coldUrl,
      ...diag(gA.id),
      job: mA,
    });
  results.push({
    test: "CLAIM 1a cold import of unseen bytes",
    measured: true,
    pass: aPass,
    calls: aCalls,
    expect: 1,
    windowCalls: calls.length - markA,
    status: garment(gA.id)?.reconStatus ?? null,
    hasRecon: !!coldUrl,
    sha: coldSha?.slice(0, 16) ?? null,
    cacheSize: cache.reconCacheSize(),
    category: mA.category,
    reconClass: mA.reconClass,
    renderer: mA.renderer,
    cacheMissProvenBy: "a call was made for these bytes in this run",
    job: mA,
  });

  /* --- CLAIM 1b: identical re-import (same bytes, NEW garment) = 0 calls -- */
  const markB = calls.length;
  const impB = await importPhotos([await loadPhoto(1)]);
  const gB = impB.got.find((g) => g.id);
  if (!gB) throw new Error("re-import produced no garment: " + JSON.stringify(impB.got));
  const mB = await settleOneGarment(gB.id, "re-import to settle");
  const bCalls = callsFor(gB.id).length;
  const bShaMatches = (garment(gB.id)?.photoSha256 ?? null) === coldSha;
  const bSameRender = (garment(gB.id)?.reconUrl ?? null) === coldUrl;
  // The cache HIT is proven by three independent facts, none of which needs a
  // call-counter window: no call was issued for these bytes in this run, the
  // render is byte-identical to the cold one, and the record was marked ready.
  // A path that made no call can only have got that render from the cache.
  const bPass =
    bCalls === 0 &&
    bShaMatches &&
    bSameRender &&
    !!coldUrl &&
    garment(gB.id)?.reconStatus === "ready";
  if (!bPass)
    unmeasured.push({
      test: "CLAIM 1b",
      verdict: "re-import did not resolve from cache",
      calls: bCalls,
      shaMatchesCold: bShaMatches,
      sameRenderAsCold: bSameRender,
      coldHadRecon: !!coldUrl,
      status: garment(gB.id)?.reconStatus ?? null,
      ...diag(gB.id),
      job: mB,
    });
  results.push({
    test: "CLAIM 1b identical re-import (same file, different garment)",
    measured: true,
    pass: bPass,
    calls: bCalls,
    expect: 0,
    windowCalls: calls.length - markB,
    newGarmentId: gB.id !== gA.id,
    shaMatchesCold: bShaMatches,
    sameRenderAsCold: bSameRender,
    status: garment(gB.id)?.reconStatus ?? null,
    cacheSize: cache.reconCacheSize(),
    cacheHitProvenBy: "0 calls + byte-identical render + ready status",
    category: mB.category,
    reconClass: mB.reconClass,
    renderer: mB.renderer,
    job: mB,
  });

  /* --- CLAIM 3: two unseen photos enqueued back to back stay SERIAL ------ */
  resetBudget();
  const markC = calls.length;
  // Samplers start BEFORE the import. The queue is empty here (closet wiped,
  // cache cleared, budget reset), so the first observed busy shape is a real
  // transition and not a leftover from claims 1a/1b.
  const frames = startFrameSampler();
  const sampler = startQueueSampler();
  const cEventStart = queueEvents.length;
  let cIds = [];
  let mC = [];
  let batchWatch = null;
  try {
    const impC = await importPhotos([await loadPhoto(2), await loadPhoto(3)]);
    cIds = impC.got.filter((g) => g.id).map((g) => g.id);
    if (cIds.length !== 2) throw new Error("expected 2 imported, got " + cIds.length);
    // One shared wait for the whole batch — NOT a per-garment loop. Iterating
    // would serialise the *observation* of a serial queue: B does not start
    // until A is done, so a per-garment see-active window for B opens too late
    // and B gets declared "never active" even though it ran (its call is in
    // `calls`). This is the same off-by-one that started all of this, moved up
    // a level; `waitForBatch` observes every id on one poll instead.
    batchWatch = await waitForBatch(cIds, "serial batch to settle", 240000);
  } finally {
    sampler.stop();
    frames.stop();
  }
  mC = cIds.map((id) => ({
    id: id.slice(0, 8),
    calls: callsFor(id).length,
    status: garment(id)?.reconStatus ?? null,
    reconUrl: garment(id)?.reconUrl ? "set" : null,
    renderer: garment(id)?.reconRenderer ?? null,
    category: garment(id)?.category ?? null,
    // No start/end fields here on purpose: the garment record does not carry
    // job timing, so they would always be null — a field that looks like
    // evidence and never is. Serial ordering is proven by `calls[].at/ended`
    // plus `nonOverlapping`, which are real measurements.
  }));
  const cCalls = cIds.flatMap((id) => callsFor(id)).sort((a, b) => a.at - b.at);
  // Peak is only meaningful once every call has ENDED — it re-reads the live
  // (mutating) records and waits rather than reporting an in-flight zero.
  const { peak, inFlight, counted } = await peakConcurrency(cCalls);
  const allReady = cIds.every((id) => garment(id)?.reconStatus === "ready");
  // Exactly 2 calls for this batch is a real measured condition, not an
  // assumption: 0 would mean the cache was not cleared, 3+ would mean a
  // garment was re-processed.
  const cPass = cCalls.length === 2 && peak === 1 && allReady && sampler.state.sawSerial;
  if (!cPass)
    unmeasured.push({
      test: "CLAIM 3",
      verdict: "serial batch assertion failed",
      calls: cCalls.length,
      peak,
      inFlight,
      allReady,
      sawSerial: sampler.state.sawSerial,
      perGarment: mC,
    });
  results.push({
    test: "CLAIM 3 two unseen photos enqueued back to back",
    measured: true,
    pass: cPass,
    calls: cCalls.length,
    expect: 2,
    perGarmentCalls: Object.fromEntries(cIds.map((id) => [id.slice(0, 8), callsFor(id).length])),
    windowCalls: calls.length - markC,
    peakConcurrentRemoteCalls: peak,
    expectPeak: 1,
    peakComputedFromEndedCalls: counted,
    inFlightAtSample: inFlight,
    nonOverlapping: nonOverlapping(cCalls),
    allReady,
    order: cCalls.map((c) => c.garment),
    renderers: [...new Set(cCalls.map((c) => c.renderer))],
    classes: cCalls.map((c) => c.cls),
    sawSerial: sampler.state.sawSerial,
    observedWhileBusy: sampler.state.observedWhileBusy,
    // Which ids the shared batch watch actually caught live, and how long it
    // waited. A non-empty `neverSeenActive` would mean the sample missed a job
    // that still ran — reported, never hidden.
    batchWatch,
    maxRunningSeen: sampler.state.maxRunning,
    maxQueuedSeen: sampler.state.maxQueued,
    queuedSnapshot: sampler.state.queuedSnapshot,
    jobs: mC,
  });

  /* --- CLAIM 3c: responsiveness + the honest stage feed ------------------ */
  const deltas = frames.times.slice(1).map((t, i) => t - frames.times[i]).sort((a, b) => a - b);
  const p95 = pct(deltas, 0.95);
  const batchStageEvents = queueEvents
    .slice(cEventStart)
    .filter((e) => e.id && cIds.some((id) => id.slice(0, 8) === e.id));
  const stagesForBatch = [...new Set(batchStageEvents.filter((e) => e.stage).map((e) => e.stage))];
  const uiFramesOk = deltas.length >= 20;
  results.push({
    test: "CLAIM 3c UI stays responsive during the serial batch",
    gate: false,
    note: "informational — evidence for the gate, not one of the three gate claims",
    pass: uiFramesOk ? p95 <= 500 && stagesForBatch.length >= 2 : null,
    why: uiFramesOk
      ? undefined
      : `only ${deltas.length} rAF samples (page visibility: ${frames.visibility}) — a throttled/hidden page cannot answer this`,
    frames: deltas.length,
    p95FrameMs: p95 == null ? null : Math.round(p95),
    maxFrameMs: deltas.length ? Math.round(deltas[deltas.length - 1]) : null,
    stageTransitions: stagesForBatch.length,
    stages: stagesForBatch,
    stageEventCount: batchStageEvents.length,
    pageVisibility: frames.visibility,
  });

  /* --- CLAIM 4: the banner must not invent work ------------------------- */
  // Asserted from the store the banner actually reads, after every wait. The
  // queue's own counters stay as informational fields: they are the numbers
  // the old probe trusted alone, and the claim is about the UI, not the queue.
  const stillLive = liveJobs();
  const idleNow = {
    activeJobCount: q.activeIds().length,
    queueDepth: q.queueDepth(),
  };
  const bannerIdle = !document.querySelector('[aria-label="Cancel background work"]');
  const noLiveJobs = stillLive.length === 0;
  const c4Pass = noLiveJobs && idleNow.activeJobCount === 0 && idleNow.queueDepth === 0 && bannerIdle;
  results.push({
    test: "CLAIM 4 job projection (what the banner renders)",
    // NOT a gate for `gateSatisfied`: the gate is three claims, and the batch
    // supplies them as CLAIM 3 (serial, one remote call at a time) plus this
    // banner-honesty check. Counting BOTH toward `claimsMeasured` would make the
    // total 4 against `claimsExpected: 3`. So this one is asserted — `pass` is
    // real and its failure still fails the run through `unmeasured` — but it is
    // reported as supporting evidence alongside CLAIM 3, the same role the
    // responsiveness check fills.
    gate: false,
    pass: c4Pass,
    measured: true,
    why: c4Pass
      ? undefined
      : `mirror still shows live work: ${JSON.stringify(stillLive)} (activeJobCount=${idleNow.activeJobCount}, queueDepth=${idleNow.queueDepth}, bannerIdle=${bannerIdle})`,
    noLiveJobs,
    bannerIdle,
    busyJobs: stillLive,
    mirrorNow: mirror(),
    ...idleNow,
  });
  if (!c4Pass)
    unmeasured.push({
      test: "CLAIM 4 job projection",
      verdict: "the banner's store still projects live work after everything settled",
      busyJobs: stillLive,
      ...idleNow,
      bannerIdle,
    });
} catch (e) {
  failed = String((e && e.message) || e);
}

// Leave the page the way we found it: a later manual probe should not inherit
// a stubbed fetch (or a queue-event listener) silently.
unsubscribeEvents();
globalThis.fetch = realFetch;

const claims = results.filter((r) => typeof r.pass === "boolean" && r.gate !== false);
const ui = results.find((r) => r.test.startsWith("CLAIM 3c"));
// A failure thrown mid-run is only decisive about the claims it could not
// reach. 1a and 1b run first and are the decisive half of the gate, so they
// still count — which is precisely what makes a partial run diagnosable
// instead of a bare `ok: false`.
const abortedBeforeBatch = failed !== null && !results.some((r) => r.test.startsWith("CLAIM 3 two"));
return {
  ok: failed === null,
  failure: failed,
  abortedBeforeBatch,
  allMeasuredClaimsPass:
    claims.length > 0 &&
    claims.every((r) => r.pass === true) &&
    (failed === null || abortedBeforeBatch),
  // `claimsExpected` is 3 because the batch contributes two entries (3 and 4);
  // CLAIM 3c is explicitly informational and never counted.
  claimsMeasured: claims.length,
  claimsExpected: 3,
  unmeasured,
  gateSatisfied:
    failed === null &&
    claims.length === 3 &&
    claims.every((r) => r.pass === true) &&
    unmeasured.length === 0,
  uiResponsive: ui ? { pass: ui.pass, p95FrameMs: ui.p95FrameMs, stages: ui.stageTransitions } : null,
  totalRemoteCalls: calls.length,
  callsByGarment: callsByGarment(),
  maxRemoteInFlight: maxRemoteInFlight(),
  results,
};

/**
 * Phase 2 gate probe, part 1 of 3 — serial queue + recon cache, on device.
 *
 * Driven through CDP (tools/cdp-eval.mjs) against the real app, using the real
 * import path (`startImport` → `addGarment`), which is the only path that
 * populates `photoSha256` — and the hash is what the recon cache is keyed on.
 *
 * EGRESS IS INTERCEPTED. `supabase.functions.fetch` (the single point where a
 * recon request actually leaves the app) is replaced with a counting stub, so:
 *   - the number measured is "requests the app decided to make", which is what
 *     the gate is about ("identical re-import = 0 calls"),
 *   - the shared free recon quota (4/day) is never spent by this probe.
 * The stub answers with a real 1x1 PNG data URL, so the ready/cached plumbing
 * is exercised end to end. Render quality is NOT under test here — that was
 * Phase 1's gate, checked with real calls.
 *
 * Returns JSON evidence only; the screenshot is taken from the host while the
 * last batch is still running.
 *
 * The fixture host is read from `window.__phase2Origin` when present, so the
 * runner can point this at a dev server it started itself (see
 * tools/run-probe.mjs) instead of relying on a long-lived one. Defaults to
 * same-origin, which is correct when the page itself is served by Vite.
 */

const app = await import("/src/store/appStore.ts");
const store = app.useAppStore;
const upload = await import("/src/services/uploadQueue.ts");
const q = await import("/src/services/jobQueue.ts");
const cache = await import("/src/services/reconCache.ts");
const jobsMirror = await import("/src/store/jobsStore.ts");
const { supabase } = await import("/src/services/supabaseClient.ts");

const S = (window.__phase2 = window.__phase2 || {
  calls: [],
  phase: "setup",
  installedAt: 0,
  delayMs: 700,
  created: [],
});
S.created = [];
S.done = false;

/** Evidence goes to localStorage first: it survives a probe that dies midway. */
const persist = (tag) => {
  try {
    localStorage.setItem(
      "flowie-probe-a-v1",
      JSON.stringify({ tag, phase: S.phase, armed: S.armed ?? null, evidence, calls: S.calls })
    );
  } catch {
    /* evidence is best-effort */
  }
};
const evidence = { results: [] };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Generous, for the same reason as the import budget: tagging can burn 25s
// inside a single import, so "wait for this job to settle" must outlast it.
const until = async (fn, label, ms = 180000) => {
  const t = performance.now();
  while (!fn()) {
    if (performance.now() - t > ms) throw new Error("timeout waiting for " + label);
    await sleep(40);
  }
};
const garment = (id) => store.getState().garments.find((g) => g.id === id);
const mirror = () =>
  Object.values(jobsMirror.useJobsStore.getState().jobs).map((j) => ({
    id: String(j.id).slice(0, 8),
    status: j.status,
    stage: j.stage ?? null,
  }));

/* --------------------------- egress interception ------------------------- */
const STUB_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

if (!S.installedAt) {
  // Egress hook. supabase-js reaches the network through the GLOBAL fetch (the
  // `fetch` captured inside @supabase/supabase-js's bundled FunctionsClient),
  // so a client-level patch is not enough — measured, not assumed. Requests
  // that are not recon calls pass straight through.
  const realFetch = globalThis.fetch.bind(globalThis);
  S.installedAt = Math.round(performance.now());
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
      fn: String(url).split("/").pop(),
      garment: body.garment_id ? String(body.garment_id).slice(0, 8) : null,
      cls: body.garment_class ?? null,
      renderer: body.renderer ?? null,
      seed: body.seed ?? null,
      phase: S.phase,
      at: Math.round(performance.now()),
      ended: null,
    };
    S.calls.push(rec);
    await sleep(S.delayMs);
    rec.ended = Math.round(performance.now());
    return new Response(JSON.stringify({ recon_data_url: STUB_PNG }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

/** Reset the local daily-budget guard (safe: egress is stubbed). */
const resetBudget = () =>
  localStorage.setItem(
    "fitflow-recon-calls-v1",
    JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: 0 })
  );

/* ------------------------------- fixtures -------------------------------- */
/**
 * Served from `public/_tmp_photos/`, which `.gitignore` already excludes.
 * `references/` is gitignored (local fixtures only — the shipped samples were
 * personal photos, untracked for the public release), so copy the raw samples
 * you need into `public/_tmp_photos/` before a probe run and delete them
 * afterwards — same discipline Phase 1 used, so a staged fixture can never be
 * committed by accident.
 */
const ORIGIN = window.__phase2Origin ?? "";
const SAMPLE = (n) => `${ORIGIN}/_tmp_photos/photo_${n}_2026-09-18_07-49-17.jpg`;
/**
 * Photos are fetched one at a time and never pooled: holding every JPEG (plus
 * the pipeline's decoded canvases) at once is what took the renderer down the
 * first time this probe ran.
 */
const loadPhoto = async (n) => {
  const buf = await (await fetch(SAMPLE(n))).arrayBuffer();
  return new File([buf], `photo_${n}_2026-09-18_07-49-17.jpg`, { type: "image/jpeg" });
};

/**
 * Import through the real path and resolve when the batch reports complete.
 *
 * `onItem` hands over a garment WITHOUT an id — the type is
 * `Omit<Garment, "id" | "createdAt">` because `addGarment` mints the id itself.
 * So the probe cannot read `g.id` there: doing so yielded `undefined`, the
 * `find(g => g.id)` lookup found nothing, and the probe reported "no garment"
 * for a batch that had actually imported one. The id is recovered instead by
 * diffing the store around the `addGarment` call.
 *
 * The completion budget is generous on purpose. Tagging is bounded but slow on
 * a handset: when Gemini is unreachable the call burns its full `TAG_TIMEOUT_MS`
 * before the heuristic fallback engages, and the first import of a session also
 * pays for the worker's first spawn and a cold module graph. A probe timeout
 * must never be able to out-claim the product.
 */
const IMPORT_TIMEOUT_MS = 240000;

const importPhotos = (files, opts = {}) =>
  new Promise((resolve, reject) => {
    const items = files.map((file) => ({ file, fileName: file.name }));
    const got = [];
    // `addGarment` is async, and the store diff that recovers each id resolves
    // after it. `onComplete` can fire first, so the batch awaits these too —
    // otherwise the caller reads ids that have not been filled in yet.
    const idWork = [];
    const to = setTimeout(
      () => reject(new Error("import did not complete")),
      IMPORT_TIMEOUT_MS
    );
    upload.startImport(items, {
      onItem: (g, _tags, fileName) => {
        const entry = {
          id: null,
          file: fileName,
          sha: (g.photoSha256 || "").slice(0, 16),
          cat: g.category,
          print: !!g.hasPrint,
        };
        got.push(entry);
        if (opts.add === false) return;
        // `addGarment` mints the id, so recover it by diffing the store.
        const before = new Set(store.getState().garments.map((x) => x.id));
        idWork.push(
          store
            .getState()
            .addGarment(g, g.photo)
            .then(() => {
              const fresh = store.getState().garments.find((x) => !before.has(x.id));
              if (fresh) entry.id = fresh.id;
            })
            .catch(() => {
              /* left as a null id; the probe reports it */
            })
        );
      },
      onError: (f, m) => got.push({ file: f, error: m }),
      onComplete: (added, n) => {
        clearTimeout(to);
        Promise.all(idWork).then(() => {
          for (const g of got) if (g.id) S.created.push(g.id);
          resolve({ got, added, n });
        });
      },
    });
  });

/** Peak overlap of the stub's in-flight windows = real remote concurrency. */
const peakConcurrency = (calls) => {
  const events = [];
  for (const c of calls) {
    events.push([c.at, 1]);
    events.push([c.ended ?? c.at, -1]);
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

persist("start");
try {
resetBudget();
cache.clearReconCache();
evidence.cacheCleared = true;

/* --------- A. cold import of unseen content: exactly one call ----------- */
S.phase = "A-cold";
let mark = S.calls.length;
const impA = await importPhotos([await loadPhoto(1)]);
// The import can complete with a per-file ERROR (no decoded item => no `id`).
// Dereferencing that blindly threw "Cannot read properties of undefined" and
// masked the real result behind a confusing crash, so surface it as evidence.
const gA = impA.got.find((g) => g.id);
if (!gA) {
  evidence.results.push({
    test: "A cold import",
    calls: S.calls.length - mark,
    imported: false,
    reported: impA.got.map((g) => g.error ?? g.file),
    note: "no item was added; the rest of the probe has nothing to compare",
  });
  persist("A-no-item");
  return { ok: false, phase: S.phase, reason: "cold import produced no garment", evidence };
}
await until(() => !q.isActive(gA.id), "cold recon to settle");
evidence.results.push({
  test: "A cold import",
  calls: S.calls.length - mark,
  detail: S.calls.slice(mark),
  status: garment(gA.id).reconStatus,
  error: garment(gA.id).reconError ?? null,
  sha: garment(gA.id).photoSha256?.slice(0, 16) ?? null,
  cls: gA.cat,
  hasRecon: !!garment(gA.id).reconUrl,
  cacheSize: cache.reconCacheSize(),
});
const coldUrl = garment(gA.id).reconUrl;
const coldSha = garment(gA.id).photoSha256;
persist("A-cold");

/* ------- B. identical re-import of the SAME bytes: zero calls ----------- */
S.phase = "B-reimport";
mark = S.calls.length;
const impB = await importPhotos([await loadPhoto(1)]);
const gB = impB.got.find((g) => g.id);
await until(() => !q.isActive(gB.id), "re-import to settle");
evidence.results.push({
  test: "B identical re-import (same file, new garment)",
  calls: S.calls.length - mark,
  status: garment(gB.id).reconStatus,
  shaMatchesCold: garment(gB.id).photoSha256 === coldSha,
  sameRenderAsCold: garment(gB.id).reconUrl === coldUrl,
  newGarmentId: gB.id !== gA.id,
  cacheSize: cache.reconCacheSize(),
});
persist("B-reimport");

/* -------- C. two unseen photos at once: serial, never parallel -------- */
S.phase = "C-serial";
S.delayMs = 700;
mark = S.calls.length;
resetBudget();
const impC = await importPhotos([await loadPhoto(2), await loadPhoto(3)]);
const cIds = impC.got.filter((g) => g.id).map((g) => g.id);
let midBatch = null;
const midPoll = setInterval(() => {
  const running = q.activeIds().length;
  if (running >= 2 && !midBatch) {
    midBatch = { activeIds: running, depth: q.queueDepth(), jobs: mirror() };
  }
}, 20);
await until(() => cIds.every((id) => !q.isActive(id)), "serial batch to settle", 240000);
clearInterval(midPoll);
const cCalls = S.calls.slice(mark);
evidence.results.push({
  test: "C two unseen photos, enqueued back to back",
  calls: cCalls.length,
  peakConcurrentCalls: peakConcurrency(cCalls),
  order: cCalls.map((c) => c.garment),
  renderers: [...new Set(cCalls.map((c) => c.renderer))],
  classes: cCalls.map((c) => c.cls),
  allReady: cIds.every((id) => garment(id)?.reconStatus === "ready"),
  midBatch,
  cacheSize: cache.reconCacheSize(),
});

/* ---- D. arm a long batch: 1 running + 1 queued, for the screenshot ----- */
persist("C-serial");
S.phase = "D-armed";
S.delayMs = 5000;
resetBudget();
mark = S.calls.length;
let impD;
impD = await importPhotos([await loadPhoto(4), await loadPhoto(5)]);
const dIds = impD.got.filter((g) => g.id).map((g) => g.id);
await until(() => S.calls.length > mark, "the first call of the batch to start");
await sleep(400);

S.armed = {
  ids: dIds,
  blocker: dIds[0],
  victims: dIds.slice(1),
  callsSoFar: S.calls.length - mark,
  activeIds: q.activeIds().length,
  depth: q.queueDepth(),
  mirror: mirror(),
  stages: dIds.map((id) => ({
    id: id.slice(0, 8),
    status: garment(id)?.reconStatus ?? null,
  })),
};

persist("D-armed");
return { ok: true, tag: "D-armed", callsIssued: S.calls.length, armed: S.armed.ids.length };
} catch (e) {
  // A rejected evaluate comes back as an opaque `{}` over CDP, so the reason
  // has to be parked where it can be read afterwards.
  try {
    localStorage.setItem(
      "flowie-probe-a-error",
      String((e && e.stack) || e) + " @ " + S.phase
    );
  } catch {
    /* nothing else to do */
  }
  persist("threw");
  return { ok: false, phase: S.phase, error: String((e && e.message) || e) };
}

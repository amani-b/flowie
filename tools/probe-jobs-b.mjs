/**
 * Phase 2 gate probe, part 4 of 4 — what the app did after the kill.
 *
 * The page was reloaded mid-recon by part 3. This pass checks the two things
 * the handoff promises:
 *   1. the interrupted garment is marked honestly (`failed("interrupted")`, not
 *      a phantom `pending`), no other pending marks survive, and AT MOST ONE
 *      job is resumed;
 *   2. the recon cache survived the reload, so re-importing the same photo is
 *      still free (0 calls) in a brand-new session — the point of keying the
 *      cache on content instead of on the garment that produced it.
 * The resumed job runs against the REAL Edge Function here (no stub): after a
 * kill the app has already decided to spend that call, so the outcome is worth
 * reporting as it really is.
 */

const app = await import("/src/store/appStore.ts");
const store = app.useAppStore;
const upload = await import("/src/services/uploadQueue.ts");
const q = await import("/src/services/jobQueue.ts");
const cache = await import("/src/services/reconCache.ts");
const { supabase } = await import("/src/services/supabaseClient.ts");
const S = (window.__phase2 = window.__phase2 || { calls: [], installedAt: 0 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 30000) => {
  const t = performance.now();
  while (!fn()) {
    if (performance.now() - t > ms) throw new Error("timeout waiting for " + label);
    await sleep(50);
  };
};
const garment = (id) => store.getState().garments.find((g) => g.id === id);

/* Count what leaves the app from the moment this probe attaches (egress is the
 * GLOBAL fetch — supabase-js resolves it there). The boot resume call may
 * already be in flight — that is reported as-is. */
if (!S.installedAt) {
  const realFetch = globalThis.fetch.bind(globalThis);
  S.installedAt = Math.round(performance.now());
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input && input.url) || "";
    if (url.includes("recon-garment")) {
      let body = {};
      try {
        body = JSON.parse((init && init.body) || "{}");
      } catch {
        /* nothing to attribute */
      }
      S.calls.push({
        fn: String(url).split("/").pop(),
        garment: body.garment_id ? String(body.garment_id).slice(0, 8) : null,
        renderer: body.renderer ?? null,
        stub: false,
        at: Math.round(performance.now()),
      });
    }
    return realFetch(input, init);
  };
}

const killed = JSON.parse(localStorage.getItem("flowie-probe-kill-v1") || "null");
const bootCallsAt = S.calls.length;
const record = localStorage.getItem("fitflow-jobs-interrupted-v1");

/* Wait for boot to have run its resume pass: the interrupted garment carries
 * the sentinel, which only boot writes. */
await until(() => store.getState().garments.length > 0 || !!killed, "store to hydrate", 20000);
if (killed) {
  await until(
    () => {
      const g = garment(killed.id);
      return !!g && (g.reconError === "interrupted" || g.reconStatus === "ready" || q.isActive(killed.id));
    },
    "boot to account for the interrupted garment",
    30000
  );
}
await sleep(1500);

const afterBoot = store.getState().garments.map((g) => ({
  id: g.id.slice(0, 8),
  status: g.reconStatus ?? null,
  error: g.reconError ?? null,
  hasRecon: !!g.reconUrl,
}));

const resumedId = killed ? killed.id : null;
const resumedCalls = S.calls.filter((c) => c.garment === (resumedId || "").slice(0, 8));

/* Give the resumed job a chance to finish (real call: 90s ceiling app-side). */
if (resumedId && q.isActive(resumedId)) {
  await until(() => !q.isActive(resumedId), "resumed job to settle", 100000);
} else if (resumedCalls.length > 0) {
  await until(() => !q.isActive(resumedId), "resumed job to settle", 100000);
}
await sleep(500);

const resumedOutcome = resumedId
  ? {
      id: resumedId.slice(0, 8),
      status: garment(resumedId)?.reconStatus ?? null,
      error: garment(resumedId)?.reconError ?? null,
      hasRecon: !!garment(resumedId)?.reconUrl,
    }
  : null;

/* ---- cache survives the reload: same photo, brand-new session, 0 calls -- */
const before = S.calls.length;
/* `references/` is gitignored, so fixtures are staged here before a run
   (see probe-jobs-a.mjs). Same filename, so cache keys still line up. */
const FIXTURE = "/_tmp_photos/photo_1_2026-09-18_07-49-17.jpg";
const buf = await (await fetch(FIXTURE)).arrayBuffer();
const file = new File([buf], "photo_1_2026-09-18_07-49-17.jpg", { type: "image/jpeg" });
await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error("re-import did not complete")), 60000);
  upload.startImport([{ file, fileName: file.name }], {
    onItem: (g) => void store.getState().addGarment(g, g.photo),
    onComplete: () => {
      clearTimeout(to);
      resolve();
    },
  });
});
await until(() => !S.calls.length || S.calls.length === before || !q.activeIds().length, "re-import to settle", 40000);
await sleep(800);

const payload = {
  bootRecord: record,
  killed: killed ? killed.atKill : null,
  afterBoot,
  pendingLeft: afterBoot.filter((g) => g.status === "pending"),
  interruptedMarks: afterBoot.filter((g) => g.error === "interrupted").length,
  resumed: { id: resumedId ? resumedId.slice(0, 8) : null, calls: resumedCalls, outcome: resumedOutcome },
  callsSinceReload: S.calls.length - bootCallsAt,
  cacheHitAfterReload: {
    callsDuringReimport: S.calls.length - before,
    status: store.getState().garments.at(-1)?.reconStatus ?? null,
    hasRecon: !!store.getState().garments.at(-1)?.reconUrl,
  },
  cacheSize: cache.reconCacheSize(),
};
localStorage.setItem("flowie-probe-b-v1", JSON.stringify(payload));
return payload;

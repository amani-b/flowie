/**
 * Phase 2 gate probe, part 3 of 3 — arm then kill (the reload half).
 *
 * Starts a genuine recon job, waits until it is really in flight, records what
 * the wearer would be seeing, and then reloads the page mid-job. That is a
 * real kill: `jobsStore` writes the interrupted record from the real `pagehide`
 * event, so part 3's post-reload assertions test the shipped handoff rather
 * than a hand-written localStorage fixture.
 *
 * The reload destroys this CDP session on purpose — the evidence it returns is
 * written to localStorage for the post-reload probe to correlate.
 */

const app = await import("/src/store/appStore.ts");
const store = app.useAppStore;
const q = await import("/src/services/jobQueue.ts");
const jobsMirror = await import("/src/store/jobsStore.ts");
const S = window.__phase2;
if (!S) return { error: "the egress stub is not installed; run part 1 first" };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label, ms = 30000) => {
  const t = performance.now();
  while (!fn()) {
    if (performance.now() - t > ms) throw new Error("timeout waiting for " + label);
    await sleep(40);
  }
};

// A garment that already has a render, flipped to the klein renderer: a cold
// key by construction, so the job must go to the network.
const target = store.getState().garments.find((g) => g.photo && g.reconUrl);
if (!target) return { error: "no rendered garment to re-render" };

S.delayMs = 8000;
localStorage.setItem(
  "fitflow-recon-calls-v1",
  JSON.stringify({ day: new Date().toISOString().slice(0, 10), n: 0 })
);

const beforeCalls = S.calls.length;
store.getState().setGarmentPrint(target.id, true);
await until(() => q.isActive(target.id), "the re-render job to start");
await until(() => S.calls.length > beforeCalls, "the request to be issued");
await sleep(600); // let the banner render a stage + elapsed

const atKill = {
  id: target.id,
  name: target.name,
  job: jobsMirror.useJobsStore.getState().jobs[target.id] ?? null,
  reconStatus: store.getState().garments.find((g) => g.id === target.id)?.reconStatus ?? null,
  activeIds: q.activeIds(),
  depth: q.queueDepth(),
  callsIssued: S.calls.length - beforeCalls,
  renderer: S.calls[S.calls.length - 1]?.renderer ?? null,
  at: Date.now(),
};

localStorage.setItem(
  "flowie-probe-kill-v1",
  JSON.stringify({ id: target.id, name: target.name, atKill, cache: { size: null } })
);
localStorage.removeItem("flowie-probe-kill-armed");

// Real kill: a reload fires pagehide, which is what the handoff listens for.
location.reload();
await sleep(5000);
return { killed: true, atKill };

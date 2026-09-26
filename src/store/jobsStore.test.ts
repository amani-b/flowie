/**
 * @vitest-environment jsdom
 *
 * Job-store tests. `jsdom` because the interrupted-job handoff is written in
 * terms of `localStorage`, and that handoff is the part of Phase 2 that protects
 * the shared free recon quota — it deserves a test rather than a hope.
 *
 * The rule under test: a reload during a job must mark the job honestly
 * (`failed("interrupted")`) and resume AT MOST ONE. The previous behaviour —
 * persist "pending", re-run everything pending on boot — could burst the quota
 * after a stale snapshot.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  INTERRUPTED_ERROR,
  MAX_RESUME,
  installJobsMirror,
  readInterruptedJobs,
  rememberInterruptedJobs,
  useJobsStore,
} from "./jobsStore";
import {
  activeIds,
  cancel,
  enqueue,
  isActive,
  resetJobQueueForTests,
} from "../services/jobQueue";

async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

beforeEach(() => {
  window.localStorage.clear();
  resetJobQueueForTests();
  useJobsStore.setState({ jobs: {} });
  // `resetJobQueueForTests` clears the queue's listener set, which takes the
  // mirror that was auto-installed on import with it. Tear that stale
  // registration down (it only nulls the guard) and install a fresh one so the
  // mirror is actually subscribed to the new, empty listener set.
  const stale = installJobsMirror();
  stale();
  installJobsMirror();
});

describe("interrupted-job handoff", () => {
  it("stores at most MAX_RESUME ids", () => {
    rememberInterruptedJobs(["a", "b", "c"]);

    const record = readInterruptedJobs();
    expect(record?.ids).toHaveLength(MAX_RESUME);
    expect(record?.ids[0]).toBe("a");
  });

  it("is read-once: a second boot must not replay abandoned work", () => {
    rememberInterruptedJobs(["a"]);
    expect(readInterruptedJobs()?.ids).toEqual(["a"]);
    expect(readInterruptedJobs()).toBeNull();
  });

  it("clears the record rather than storing an empty list", () => {
    rememberInterruptedJobs(["a"]);
    rememberInterruptedJobs([]);

    expect(readInterruptedJobs()).toBeNull();
    expect(window.localStorage.getItem("fitflow-jobs-interrupted-v1")).toBeNull();
  });

  it("returns null for an empty or corrupt record", () => {
    expect(readInterruptedJobs()).toBeNull();

    window.localStorage.setItem("fitflow-jobs-interrupted-v1", "{not json");
    expect(readInterruptedJobs()).toBeNull();

    window.localStorage.setItem(
      "fitflow-jobs-interrupted-v1",
      JSON.stringify({ at: 1, ids: [42, null] })
    );
    expect(readInterruptedJobs()).toBeNull();
  });

  it("exposes the interrupted error as a stable sentinel", () => {
    expect(INTERRUPTED_ERROR).toBe("interrupted");
  });
});

describe("queue → store mirror", () => {
  it("mirrors queued, running and settled into the store", async () => {
    enqueue({
      id: "g1",
      kind: "recon",
      label: "Blue tee",
      run: async ({ onStage }) => {
        onStage("Uploading photo…");
        await new Promise((r) => setTimeout(r, 5));
      },
    });

    await until(() => isActive("g1"), "job to start");
    expect(useJobsStore.getState().jobs["g1"].status).toBe("running");
    expect(useJobsStore.getState().jobs["g1"].label).toBe("Blue tee");

    await until(() => !isActive("g1"), "job to settle");
    expect(useJobsStore.getState().jobs["g1"].status).toBe("ready");
    expect(useJobsStore.getState().jobs["g1"].endedAt).toBeGreaterThan(0);
  });

  it("records a failed settlement with its error text", async () => {
    enqueue({ id: "g2", kind: "recon", run: async () => { throw new Error("nope"); } });
    await until(() => !isActive("g2"), "job to settle");

    const job = useJobsStore.getState().jobs["g2"];
    expect(job.status).toBe("failed");
    expect(job.error).toBe("nope");
  });

  it("reports a cancelled job as cancelled, not failed", async () => {
    enqueue({ id: "g3", kind: "recon", run: async () => { await new Promise((r) => setTimeout(r, 30)); } });
    await until(() => isActive("g3"), "job to start");
    cancel("g3");
    await until(() => !isActive("g3"), "job to settle");

    expect(useJobsStore.getState().jobs["g3"].status).toBe("cancelled");
  });

  it("reports the jobs that were live at unload", async () => {
    enqueue({ id: "live", kind: "recon", run: async () => { await new Promise((r) => setTimeout(r, 30)); } });
    await until(() => isActive("live"), "job to start");

    expect(activeIds()).toEqual(["live"]);
    rememberInterruptedJobs(activeIds());
    expect(readInterruptedJobs()?.ids).toEqual(["live"]);
  });
});

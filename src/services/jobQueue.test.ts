/**
 * Serial-job queue tests.
 *
 * These cover the three promises Phase 2 makes to the rest of the app, each of
 * which is a user-visible behaviour rather than an internal detail:
 * 1. Serial — never more than one remote call in flight, in FIFO order.
 * 2. Cancel — a queued job makes ZERO calls, a running job is aborted, and
 *    neither is ever reported as a failure.
 * 3. Never rejects into the caller — an import loop must not break because a
 *    background job threw.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  activeIds,
  cancel,
  enqueue,
  isActive,
  queueDepth,
  resetJobQueueForTests,
  retry,
  subscribe,
  type JobEvent,
} from "./jobQueue";

/** Record every event the queue emits. */
function watch() {
  const events: JobEvent[] = [];
  const off = subscribe((e) => events.push(e));
  return { events, off };
}

/** Poll until `predicate` holds, so tests never race the internal pump. */
async function until(predicate: () => boolean, label = "condition"): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

type Settled = { id: string; status: string; error?: string; attempts: number };

/** Terminal records, in settle order. */
const settledJobs = (events: JobEvent[]): Settled[] =>
  events
    .filter((e): e is Extract<JobEvent, { type: "settled" }> => e.type === "settled")
    .map((e) => e.job as unknown as Settled);

beforeEach(() => {
  resetJobQueueForTests();
});

describe("serial execution", () => {
  it("never runs two jobs at once and preserves FIFO order", async () => {
    const order: string[] = [];
    let inFlight = 0;
    let peak = 0;

    const makeJob = (id: string) => ({
      id,
      run: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        order.push(id);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
      },
    });

    enqueue(makeJob("a"));
    enqueue(makeJob("b"));
    enqueue(makeJob("c"));

    await until(() => order.length === 3, "all three jobs");

    expect(peak).toBe(1);
    expect(order).toEqual(["a", "b", "c"]);
    expect(queueDepth()).toBe(0);
  });

  it("does not re-run a job that is already active", async () => {
    let runs = 0;
    const spec = { id: "dup", run: async () => { runs += 1; } };

    enqueue(spec);
    enqueue(spec);

    await until(() => !isActive("dup"), "job to settle");

    expect(runs).toBe(1);
  });

  it("swaps in the newest spec when a WAITING job is re-enqueued", async () => {
    const stages: string[] = [];
    enqueue({
      id: "first",
      label: "blocker",
      run: async () => { await new Promise((r) => setTimeout(r, 15)); },
    });
    enqueue({ id: "target", run: async () => { stages.push("v1"); } });
    // Still waiting, so this replaces the queued spec rather than duplicating.
    enqueue({ id: "target", run: async () => { stages.push("v2"); } });

    await until(() => stages.length > 0, "the target to run");

    expect(stages).toEqual(["v2"]);
  });
});

describe("cancellation", () => {
  it("drops a QUEUED job without ever calling run", async () => {
    let ran = false;
    const { events } = watch();

    enqueue({
      id: "blocker",
      run: async () => { await new Promise((r) => setTimeout(r, 20)); },
    });
    enqueue({ id: "victim", run: async () => { ran = true; } });

    expect(isActive("victim")).toBe(true);
    cancel("victim");

    await until(() => !isActive("blocker"), "the blocker to finish");

    expect(ran).toBe(false);
    expect(settledJobs(events).find((j) => j.id === "victim")?.status).toBe("cancelled");
  });

  it("aborts a RUNNING job and reports cancelled, never failed", async () => {
    const { events } = watch();
    let sawAbort = false;

    enqueue({
      id: "slow",
      run: async ({ signal }) => {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => {
            sawAbort = true;
            reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
          });
        });
      },
    });

    await until(() => isActive("slow"), "job to start");
    cancel("slow");
    await until(() => !isActive("slow"), "job to settle");

    expect(sawAbort).toBe(true);
    expect(settledJobs(events).find((j) => j.id === "slow")?.status).toBe("cancelled");
  });

  it("ignores a cancel for an unknown id", () => {
    expect(() => cancel("nope")).not.toThrow();
  });
});

describe("failure handling", () => {
  it("settles a throwing job as failed WITHOUT rejecting the enqueue caller", async () => {
    const { events } = watch();

    expect(() => {
      enqueue({ id: "boom", run: async () => { throw new Error("backend exploded"); } });
    }).not.toThrow();

    await until(() => !isActive("boom"), "job to settle");

    const job = settledJobs(events).find((j) => j.id === "boom");
    expect(job?.status).toBe("failed");
    expect(job?.error).toBe("backend exploded");
  });

  it("keeps running the queue when one job fails", async () => {
    const order: string[] = [];
    enqueue({ id: "bad", run: async () => { order.push("bad"); throw new Error("x"); } });
    enqueue({ id: "good", run: async () => { order.push("good"); } });

    await until(() => order.length === 2, "both jobs");

    expect(order).toEqual(["bad", "good"]);
  });

  it("survives a subscriber that throws", async () => {
    const seen: string[] = [];
    subscribe(() => { throw new Error("bad listener"); });
    subscribe((e) => { seen.push(e.type); });

    enqueue({ id: "fine", run: async () => {} });
    await until(() => seen.includes("settled"), "the settle event");

    expect(seen).toContain("queued");
  });
});

describe("retry", () => {
  it("re-runs a settled job and increments attempts", async () => {
    const { events } = watch();
    let runs = 0;
    enqueue({ id: "flaky", run: async () => { runs += 1; } });
    await until(() => !isActive("flaky"), "first run");

    expect(retry("flaky")).toBe(true);
    await until(() => runs === 2, "second run");

    const attempts = events
      .filter((e) => e.type === "queued")
      .map((e) => (e as { job: { attempts: number } }).job.attempts);
    expect(attempts).toEqual([1, 2]);
  });

  it("refuses to retry an id it has never seen, or one still active", async () => {
    expect(retry("unknown")).toBe(false);

    enqueue({ id: "busy", run: async () => { await new Promise((r) => setTimeout(r, 20)); } });
    await until(() => isActive("busy"), "job to start");
    expect(retry("busy")).toBe(false);
  });
});

describe("stage reporting", () => {
  it("emits each onStage call and settles as ready", async () => {
    const { events } = watch();

    enqueue({
      id: "staged",
      run: async ({ onStage }) => {
        onStage("Checking budget…");
        onStage("Uploading photo…");
      },
    });

    await until(() => !isActive("staged"), "the job to settle");

    const stages = events.filter((e) => e.type === "stage").map((e) => e.stage);
    expect(stages).toEqual(["Checking budget…", "Uploading photo…"]);
    expect(settledJobs(events).find((j) => j.id === "staged")?.status).toBe("ready");
  });

  it("ignores a stage from a job that already settled", async () => {
    // Guards the display path: a late onStage must not resurrect a tile's pill.
    const { events } = watch();
    let late: (s: string) => void = () => {};
    enqueue({ id: "late", run: async ({ onStage }) => { late = onStage; } });

    await until(() => !isActive("late"), "the job to settle");
    const before = events.length;
    late("too late");
    expect(events.length).toBe(before);
  });
});

describe("introspection", () => {
  it("reports active ids and queue depth truthfully", async () => {
    enqueue({ id: "running", run: async () => { await new Promise((r) => setTimeout(r, 20)); } });
    enqueue({ id: "waiting1", run: async () => {} });
    enqueue({ id: "waiting2", run: async () => {} });

    await until(() => isActive("running"), "the first job to start");

    expect(activeIds().sort()).toEqual(["running", "waiting1", "waiting2"]);
    expect(queueDepth()).toBe(2);

    await until(() => activeIds().length === 0, "the queue to drain");
    expect(queueDepth()).toBe(0);
  });
});

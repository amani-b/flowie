/**
 * @vitest-environment jsdom
 *
 * Phase 3 GATE — "no image bytes in `fitflow-store`".
 *
 * The gate in the execution spec is: **snapshot < 100 KB @ 40 garments, with no
 * `data:` bytes**. BASELINE.md measured 5 827 724 bytes (57×) for that shape,
 * because `partialize` stripped only `photo` and left every `reconUrl` data URL
 * in the JSON.
 *
 * HOW THIS MEASURES. Deliberately NOT by re-implementing `partialize` in the
 * test. A copy of the transform can silently drift from the shipped one and
 * keep passing after a regression — which is exactly how the original defect
 * survived a "verified" baseline. Instead this drives the REAL store through a
 * real `zustand/persist` write against a real `localStorage`, then reads back
 * what actually landed under the `fitflow-store` key. The bytes counted are the
 * bytes the browser would be asked to store.
 *
 * It also asserts the two things that make the byte count meaningful rather
 * than coincidental:
 *   1. no `data:` image payload appears anywhere in the snapshot;
 *   2. the image genuinely still EXISTS (IDB / memory), i.e. the gate was not
 *      passed by throwing the user's data away.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { DEMO_WARDROBE } from "../lib/mock";
import { assertSnapshotBudget, flushPendingWrites, useAppStore } from "./appStore";
import type { Garment, SavedLook } from "../types";

const STORE_KEY = "fitflow-store";
const BUDGET_BYTES = 102_400; // 100 KB, per the spec gate

/**
 * Writes are debounced 250 ms trailing (RC-1), so a synchronous read after a
 * `setState` sees nothing. Calling the store's own exported flush — rather
 * than sleeping on a real timer — keeps this test fast and, more importantly,
 * exercises the same path the `pagehide`/`visibilitychange` handlers use when
 * a real user closes the tab mid-debounce.
 */
function settle(): void {
  flushPendingWrites();
}

/** A recon result of the size the baseline modelled: 512×512 PNG ≈ 140 KB. */
const RECON_BYTES = 140_000;

/**
 * Synthesise `n` garments the way a real import leaves them: an SVG `rendering`
 * (persisted by design — it is the deterministic fallback) and, for every
 * garment that has finished recon, a data-URL `reconUrl`.
 *
 * `ready` controls that second part. Measuring BOTH shapes matters: the
 * no-recon shape was already over budget at 40 items (225 364 bytes) purely
 * from the SVGs, so fixing only `reconUrl` would not have been enough.
 */
function buildGarments(n: number, opts: { recon?: boolean } = {}): Garment[] {
  return Array.from({ length: n }, (_, i) => {
    const seed = DEMO_WARDROBE[i % DEMO_WARDROBE.length];
    const g: Garment = {
      ...seed,
      id: `g-gate-${i}`,
      name: `${seed.name} ${i}`,
      createdAt: 1_700_000_000_000 + i,
      // A short, real SVG data URL stands in for the deterministic rendering.
      rendering: "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'/>",
      renderStatus: "ready",
      // The source photo, present on every imported garment.
      photo: `data:image/jpeg;base64,${"P".repeat(4000)}`,
    };
    if (opts.recon) {
      g.reconUrl = `data:image/png;base64,${"R".repeat(RECON_BYTES)}`;
      g.reconStatus = "ready";
    }
    return g;
  });
}

/** Read exactly what `persist` wrote, as a byte count. */
function snapshotBytes(): number {
  const raw = window.localStorage.getItem(STORE_KEY);
  if (raw == null) throw new Error("nothing persisted under " + STORE_KEY);
  return new TextEncoder().encode(raw).length;
}

function snapshotText(): string {
  return window.localStorage.getItem(STORE_KEY) ?? "";
}

beforeEach(() => {
  window.localStorage.clear();
  useAppStore.setState({ garments: [], looks: [], schedules: [], today: null });
});

describe("Phase 3 gate — persisted snapshot carries no image bytes", () => {
  it("stays under 100 KB at 40 garments with recon ready", () => {
    // This is the exact shape BASELINE.md measured at 5 827 724 bytes.
    useAppStore.setState({ garments: buildGarments(40, { recon: true }) });
    settle();

    const bytes = snapshotBytes();

    // Report the number in the failure message too — a gate that only says
    // "expected < 102400" without the actual value is useless to debug.
    expect(
      bytes,
      `40 garments (recon ready) persisted ${bytes} bytes; budget ${BUDGET_BYTES}`
    ).toBeLessThan(BUDGET_BYTES);
  });

  it("stays under 100 KB at 40 garments with no recon at all", () => {
    // The SVG-only case: 225 364 bytes in the baseline, so this fails unless
    // the `rendering` data URL is stripped as well.
    useAppStore.setState({ garments: buildGarments(40) });
    settle();

    const bytes = snapshotBytes();
    expect(
      bytes,
      `40 garments (no recon) persisted ${bytes} bytes; budget ${BUDGET_BYTES}`
    ).toBeLessThan(BUDGET_BYTES);
  });

  it("contains no `data:` image payload", () => {
    useAppStore.setState({ garments: buildGarments(40, { recon: true }) });
    settle();

    const text = snapshotText();
    // `data:image` is the forbidden form. Asserting on the narrower needle
    // avoids false positives from innocent strings that happen to contain
    // "data:" in prose.
    expect(text).not.toMatch(/data:image\//);

    // And prove the assertion has teeth: the same needle IS present in the
    // in-memory records, so a `partialize` regression would be caught rather
    // than passing because the fixture never had any bytes to leak.
    const inMemory = JSON.stringify(useAppStore.getState().garments);
    expect(inMemory).toMatch(/data:image\//);
  });

  it("keeps http(s) image references, drops data: ones — same field, both ways", () => {
    const garments = buildGarments(4);
    // Live mode: a garment synced from Postgres carries a Storage URL in
    // `photo` (dataService maps `image_url` -> `photo`). That reference is the
    // client's only handle on the bytes, so it must survive.
    garments[0] = {
      ...garments[0],
      photo: "https://cdn.example.com/top.jpg",
      reconUrl: "https://cdn.example.com/top-recon.png",
      rendering: "https://cdn.example.com/top.svg",
    };
    // Demo/offline mode: the same fields carry inline `data:` payloads, which
    // must not reach localStorage.
    garments[1] = {
      ...garments[1],
      photo: `data:image/jpeg;base64,${"P".repeat(4000)}`,
    };
    useAppStore.setState({ garments });
    settle();

    const persisted = JSON.parse(snapshotText()) as {
      state: { garments: Garment[] };
    };
    const live = persisted.state.garments.find((x) => x.id === "g-gate-0")!;
    const local = persisted.state.garments.find((x) => x.id === "g-gate-1")!;

    // http(s) kept, in every field
    expect(live.photo).toBe("https://cdn.example.com/top.jpg");
    expect(live.reconUrl).toBe("https://cdn.example.com/top-recon.png");
    expect(live.rendering).toBe("https://cdn.example.com/top.svg");
    // data: dropped from the same field
    expect(local.photo).toBeUndefined();
  });

  it("does not lose the fact that a recon succeeded", () => {
    useAppStore.setState({ garments: buildGarments(4, { recon: true }) });
    settle();

    const persisted = JSON.parse(snapshotText()) as {
      state: { garments: Garment[] };
    };

    for (const g of persisted.state.garments) {
      // `reconUrl` is gone from the JSON, but `reconStatus: "ready"` must
      // survive — otherwise `runReconJob` treats the garment as never-built
      // and spends another remote call on the next view. Clearing the status
      // is how you "pass" this gate while burning the shared free quota.
      expect(g.reconStatus).toBe("ready");
      expect(g.reconUrl).toBeUndefined();
    }
  });

  it("strips image bytes out of saved-look outfit snapshots too", () => {
    // Looks embed full garment snapshots, so they inherited the identical leak.
    const [piece] = buildGarments(1, { recon: true });
    const look: SavedLook = {
      id: "look-gate-0",
      name: "Gate look",
      occasion: "casual",
      outfit: { top: piece },
      rationale: "",
      engine: "heuristic",
      createdAt: 1_700_000_000_000,
    };
    useAppStore.setState({ garments: buildGarments(40, { recon: true }), looks: [look] });
    settle();

    expect(snapshotText()).not.toMatch(/data:image\//);
    expect(snapshotBytes()).toBeLessThan(BUDGET_BYTES);
  });
});

/**
 * The guard is the part that keeps this gate from silently reopening. An
 * untested guard is decoration, so drive it directly with payloads that DO and
 * DO NOT contain image bytes and assert it distinguishes them — otherwise a
 * typo'd needle would make every future run pass vacuously.
 */
describe("dev-time snapshot assertion", () => {
  function captureWarnings(fn: () => void): string[] {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warned.push(String(args[0]));
    try {
      fn();
    } finally {
      console.warn = orig;
    }
    return warned;
  }

  it("warns when a data: image payload is present", () => {
    const warned = captureWarnings(() =>
      assertSnapshotBudget(
        "fitflow-store",
        JSON.stringify({ state: { garments: [{ reconUrl: "data:image/png;base64,AAAA" }] } })
      )
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/image bytes leaked/);
  });

  it("stays silent on a clean, within-budget snapshot", () => {
    const warned = captureWarnings(() =>
      assertSnapshotBudget(
        "fitflow-store",
        JSON.stringify({ state: { garments: [{ id: "a", reconUrl: "https://x/y.png" }] } })
      )
    );
    expect(warned).toHaveLength(0);
  });

  it("warns on size when the snapshot is over budget without a data: leak", () => {
    // A new heavy non-image field would trip this path, not the leak path.
    const big = "z".repeat(120_000);
    const warned = captureWarnings(() =>
      assertSnapshotBudget("fitflow-store", JSON.stringify({ state: { note: big } }))
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/over the .*budget/);
  });
});

/**
 * The guard is the part that keeps this gate from silently reopening. An
 * untested guard is decoration, so drive it directly with payloads that DO and
 * DO NOT contain image bytes and assert it distinguishes them — otherwise a
 * typo'd needle would make every future run pass vacuously.
 */
describe("dev-time snapshot assertion", () => {
  function captureWarnings(fn: () => void): string[] {
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => warned.push(String(args[0]));
    try {
      fn();
    } finally {
      console.warn = orig;
    }
    return warned;
  }

  it("warns when a data: image payload is present", () => {
    const warned = captureWarnings(() =>
      assertSnapshotBudget(
        "fitflow-store",
        JSON.stringify({ state: { garments: [{ reconUrl: "data:image/png;base64,AAAA" }] } })
      )
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/image bytes leaked/);
  });

  it("stays silent on a clean, within-budget snapshot", () => {
    const warned = captureWarnings(() =>
      assertSnapshotBudget(
        "fitflow-store",
        JSON.stringify({ state: { garments: [{ id: "a", reconUrl: "https://x/y.png" }] } })
      )
    );
    expect(warned).toHaveLength(0);
  });

  it("warns on size when the snapshot is over budget without a data: leak", () => {
    // A new heavy non-image field would trip this path, not the leak path.
    const big = "z".repeat(120_000);
    const warned = captureWarnings(() =>
      assertSnapshotBudget("fitflow-store", JSON.stringify({ state: { note: big } }))
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/over the .*budget/);
  });
});

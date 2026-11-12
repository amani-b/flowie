/**
 * @vitest-environment jsdom
 *
 * Phase 6 — `persist` `migrate` and `merge` at v13.
 *
 * HOW THESE RUN. Deliberately NOT by importing the two functions and calling
 * them with hand-made arguments. They are not exported, and — more importantly
 * — a unit test on them would prove nothing about the thing that actually
 * breaks: whether a real snapshot sitting in `localStorage` survives a real
 * boot. So each test writes a real snapshot under `fitflow-store`, calls the
 * store's own `persist.rehydrate()`, and asserts on the state the app would
 * then render from. The chain under test is the real one: storage read →
 * `migrate(version)` → `merge(persisted, current)` → store.
 *
 * WHY v13 SPECIFICALLY. v13 is the release that moved image bytes out of the
 * snapshot, and the note in the migration is explicit that `partialize` alone
 * would not have been enough: it only shrinks the NEXT write, so the first boot
 * after upgrade would still inflate 5.8 MB into memory. The read-side strip in
 * `migrate` is what closes that window, and it is invisible to a test that only
 * exercises writes. `persistGate.test.ts` covers the write side; this file
 * covers the read side.
 *
 * Two behaviours below are load-bearing and easy to "fix" by accident:
 *   - a v1 snapshot must fall through EVERY later migration (the chain has no
 *     early return), so a record missing `colors` cannot reach render;
 *   - stripping a `reconUrl` data URL must leave `reconStatus: "ready"`, or the
 *     garment looks like recon never succeeded and burns a fresh remote call.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { flushPendingWrites, useAppStore } from "./appStore";

const STORE_KEY = "fitflow-store";

type Snapshot = { state: Record<string, unknown>; version: number };

/** Drain the debounced writer, then park a known snapshot in storage. */
function seed(snapshot: Snapshot): void {
  flushPendingWrites();
  window.localStorage.clear();
  window.localStorage.setItem(STORE_KEY, JSON.stringify(snapshot));
}

/** Boot the way the app boots: read storage, migrate, merge. */
async function boot(): Promise<ReturnType<typeof useAppStore.getState>> {
  await useAppStore.persist.rehydrate();
  return useAppStore.getState();
}

function readStorage(): Snapshot | null {
  const raw = window.localStorage.getItem(STORE_KEY);
  return raw ? (JSON.parse(raw) as Snapshot) : null;
}

beforeEach(() => {
  // Order matters: drain first so a debounced write from a previous test cannot
  // land mid-assertion, then reset the in-memory store, then drain THAT write
  // too before the test seeds its own snapshot.
  flushPendingWrites();
  window.localStorage.clear();
  useAppStore.setState({
    garments: [],
    looks: [],
    schedules: [],
    today: null,
    tab: "home",
    ownerId: null,
    onboardedUsers: [],
  });
  flushPendingWrites();
  window.localStorage.clear();
});

describe("migrate — v13 keeps image bytes out of memory on READ, not just on write", () => {
  it("strips data: image payloads from a v12 snapshot at boot", async () => {
    seed({
      version: 12,
      state: {
        garments: [
          {
            id: "g-1",
            name: "Striped Tee",
            color: "black",
            colors: ["black"],
            pattern: "solid",
            createdAt: 1,
            // The three fields that made a real closet 5.8 MB.
            photo: "data:image/jpeg;base64,PHOTO",
            reconUrl: "data:image/png;base64,RECON",
            rendering: "data:image/svg+xml;utf8,<svg/>",
            reconStatus: "ready",
            renderStatus: "ready",
          },
        ],
        looks: [],
        schedules: [],
      },
    });

    const state = await boot();
    const g = state.garments[0];

    expect(state.garments).toHaveLength(1);
    expect(g.photo).toBeUndefined();
    expect(g.reconUrl).toBeUndefined();
    expect(g.rendering).toBeUndefined();

    // The strip must not look like a failed recon. `reconStatus: "ready"` with
    // a missing URL is the intended state — the bytes live in IndexedDB.
    expect(g.reconStatus).toBe("ready");
  });

  it("leaves http(s) references alone — the rule is the encoding, not the field", async () => {
    seed({
      version: 12,
      state: {
        garments: [
          {
            id: "g-1",
            name: "Remote Tee",
            color: "black",
            colors: ["black"],
            pattern: "solid",
            createdAt: 1,
            photo: "https://cdn.example.com/tee.jpg",
            reconUrl: "https://cdn.example.com/tee-recon.png",
          },
        ],
        looks: [],
        schedules: [],
      },
    });

    const g = (await boot()).garments[0];

    expect(g.photo).toBe("https://cdn.example.com/tee.jpg");
    expect(g.reconUrl).toBe("https://cdn.example.com/tee-recon.png");
  });
});

describe("migrate — a v1 snapshot falls through every later migration", () => {
  it("arrives with the fields added by v2, v3, v4, v5 and v12 all present", async () => {
    seed({
      version: 1,
      state: {
        garments: [{ id: "g-1", name: "Old Tee", color: "black", createdAt: 1 }],
        looks: [{ id: "l-1", outfit: { top: { id: "g-1", color: "black" } } }],
      },
    });

    const state = await boot();
    const g = state.garments[0];
    const look = state.looks[0];

    // v2 — session fields.
    expect(state.ownerId).toBeNull();
    expect(state.stylePrefs).toBeNull();
    expect(Array.isArray(state.onboardedUsers)).toBe(true);

    // v3 — colours/pattern backfilled on BOTH the garment and its look snapshot.
    // This is the assertion that fails if someone adds an early return.
    expect(g.colors).toEqual(["black"]);
    expect(g.pattern).toBe("solid");
    expect((look.outfit as Record<string, { colors?: string[]; pattern?: string }>).top.colors).toEqual([
      "black",
    ]);
    expect((look.outfit as Record<string, { colors?: string[]; pattern?: string }>).top.pattern).toBe(
      "solid"
    );

    // v4 — schedules + look tags.
    expect(state.schedules).toEqual([]);
    expect(look.tags).toEqual([]);

    // v5 — sync queues scrubbed, survivors marked synced (this is what stopped
    // the phantom boot error toast).
    expect(g.syncStatus).toBe("synced");

    // v12 — recon starts idle: never "pending", so no phantom progress bar.
    expect(g.reconStatus).toBeUndefined();
    expect(g.reconError).toBeUndefined();
  });
});

describe("migrate — retired pipeline state is dropped, not carried", () => {
  it("removes the old renderer fields and never restores a pending status", async () => {
    seed({
      version: 11,
      state: {
        garments: [
          {
            id: "g-1",
            name: "Legacy Tee",
            color: "black",
            colors: ["black"],
            pattern: "solid",
            createdAt: 1,
            studioComposite: "data:image/png;base64,OLD",
            studioCompositeStatus: "pending",
            studioFlatLay: "data:image/png;base64,OLD",
            studioRenderUrl: "https://cdn.example.com/old.png",
            studioRenderStatus: "pending",
          },
        ],
        looks: [],
        schedules: [],
      },
    });

    const g = (await boot()).garments[0];
    // The retired fields are gone from the `Garment` TYPE as well as the data,
    // so reading them back needs a cast. That is the point: the migration must
    // strip them from a snapshot written when they still existed.
    const legacy = g as unknown as Record<string, unknown>;

    expect(legacy.studioComposite).toBeUndefined();
    expect(legacy.studioCompositeStatus).toBeUndefined();
    expect(legacy.studioFlatLay).toBeUndefined();
    expect(legacy.studioRenderUrl).toBeUndefined();
    expect(legacy.studioRenderStatus).toBeUndefined();
    // The important half: a persisted "pending" must not become a live job.
    expect(g.reconStatus).not.toBe("pending");
  });

  it("drops the retired closetUpgrade slice entirely", async () => {
    seed({
      version: 8,
      state: {
        garments: [],
        looks: [],
        schedules: [],
        closetUpgrade: { queued: ["g-1"], status: "pending" },
      },
    });

    const state = await boot();

    expect("closetUpgrade" in state).toBe(false);
  });
});

describe("merge — a corrupt snapshot degrades slice-by-slice, never fatally", () => {
  it("falls back to the current tab when the stored tab is not a real tab", async () => {
    seed({
      version: 13,
      state: { garments: [], looks: [], schedules: [], tab: "definitely-not-a-tab" },
    });

    // The regression this guards: an unknown tab used to reach the router and
    // blank the app on boot.
    expect((await boot()).tab).toBe("home");
  });

  it("accepts a stored tab that is valid", async () => {
    seed({ version: 13, state: { garments: [], looks: [], schedules: [], tab: "studio" } });

    expect((await boot()).tab).toBe("studio");
  });

  it("coerces non-array collections to empty arrays instead of throwing at render", async () => {
    seed({
      version: 13,
      state: {
        garments: "not-an-array",
        looks: { nope: true },
        schedules: 42,
        onboardedUsers: null,
      },
    });

    const state = await boot();

    expect(state.garments).toEqual([]);
    expect(state.looks).toEqual([]);
    expect(state.schedules).toEqual([]);
    expect(state.onboardedUsers).toEqual([]);
  });

  it("drops garments that have no string id", async () => {
    seed({
      version: 13,
      state: {
        garments: [
          { id: "g-keep", name: "Keep", color: "black", colors: ["black"], pattern: "solid" },
          { id: 7, name: "Numeric id" },
          { name: "No id at all" },
          null,
        ],
        looks: [],
        schedules: [],
      },
    });

    const state = await boot();

    expect(state.garments.map((g) => g.id)).toEqual(["g-keep"]);
  });

  it("restores the sync queues as Sets, not the arrays that were persisted", async () => {
    seed({
      version: 13,
      state: {
        garments: [],
        looks: [],
        schedules: [],
        _syncState: {
          pendingGarments: ["g-1", "g-2"],
          pendingLooks: [],
          errorGarments: ["g-3"],
          errorLooks: ["l-1"],
        },
      },
    });

    const s = (await boot())._syncState;

    // Every selector and mutator treats these uniformly, so an array here is a
    // latent crash in `.has()`.
    expect(s.pendingGarments).toBeInstanceOf(Set);
    expect([...s.pendingGarments].sort()).toEqual(["g-1", "g-2"]);
    expect(s.errorGarments).toBeInstanceOf(Set);
    expect(s.errorLooks).toBeInstanceOf(Set);
    expect(s.errorLooks.has("l-1")).toBe(true);
  });

  it("drops a retired slice because of the VERSION, not because merge filters it", async () => {
    // Written this way on purpose. The first attempt asserted "a retired slice
    // never rehydrates" by seeding `version: 13` plus `closetUpgrade` — and it
    // failed, because the drop is version-gated inside `migrate` and `merge`
    // passes unknown top-level keys straight through. That input is not a
    // reachable state (`partialize` at v13 cannot write the key, and a snapshot
    // holding it always carries an older version), but the difference is worth
    // pinning: it is the version number doing the work, so anything that ever
    // bumps `version` without adding the matching migration would leak the slice.
    const payload = () => ({
      garments: [],
      looks: [],
      schedules: [],
      closetUpgrade: { queued: ["g-1"] },
    });

    seed({ version: 8, state: payload() });
    expect("closetUpgrade" in (await boot())).toBe(false);

    seed({ version: 13, state: payload() });
    expect("closetUpgrade" in (await boot())).toBe(true);
  });
});

describe("round trip — the migration does not fight the writer", () => {
  it("re-serialises the migrated state without re-introducing image bytes", async () => {
    seed({
      version: 12,
      state: {
        garments: [
          {
            id: "g-1",
            name: "Tee",
            color: "black",
            colors: ["black"],
            pattern: "solid",
            createdAt: 1,
            photo: "data:image/jpeg;base64,PHOTO",
            reconUrl: "data:image/png;base64,RECON",
            rendering: "data:image/svg+xml;utf8,<svg/>",
            reconStatus: "ready",
          },
        ],
        looks: [],
        schedules: [],
      },
    });

    await boot();
    flushPendingWrites();

    const written = readStorage();
    const text = JSON.stringify(written);

    expect(written?.version).toBe(13);
    expect(text).not.toContain("data:image");
    // The garment itself survived — the strip is not data loss.
    expect(text).toContain("g-1");
  });
});

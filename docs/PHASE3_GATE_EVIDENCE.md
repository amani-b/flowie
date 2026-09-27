# Phase 3 gate evidence

**Verdict: PASSED.** Commit `cfc06ca7`, tag `phase/3-done`.
Closes **RC-1** (persist churn), **RC-2** (whole-slice renders), **RC-6**
(unguarded `crypto.randomUUID`), and removes **RC-4**'s boot-time blob merge.

Gate as written in `docs/ENGINEERING_EXECUTION_SPEC.md` §5:

> Verify: snapshot <100KB @40 garments, no `data:` bytes, typecheck/build.
> Gate: RC-1/RC-2/RC-6 closed.

---

## 1. Persisted snapshot size

Measured by driving the **real** store through a real `zustand/persist` write
into a real `localStorage`, then reading back what actually landed under the
`fitflow-store` key. Not a re-implementation of `partialize` — see §5 for why
that distinction is the whole point.

Fixture per garment: a 4 956-byte SVG `rendering` data URL (the size BASELINE.md
measured) plus a 4 000-byte `photo` data URL; the recon case adds a 140 000-byte
PNG `reconUrl` data URL.

| Snapshot shape | Baseline (bytes) | Phase 3 (bytes) | vs 100 KB budget |
| --- | --- | --- | --- |
| 0 garments | 15 | 261 | pass |
| 12 garments, no recon | 67 662 | 2 685 | pass |
| 12 garments, recon ready | **1 748 370** | **2 949** | pass |
| 40 garments, no recon | **225 364** | **8 405** | pass |
| 40 garments, recon ready | **5 827 724** | **9 285** | **pass, 0.09×** |

The headline: **5 827 724 → 9 285 bytes**, a 628× reduction on the shape that
failed by 57×. The recon case is now only 880 bytes heavier than the no-recon
case, which is itself the proof that no recon payload survives — 40 recon PNGs
at ~140 KB each could not hide inside 880 bytes.

Budget headroom is 11×, deliberately not tight: the failure mode being guarded
against is a ~600× jump, not gradual drift, so a guard that rides the line would
only ever fire in cases that were already catastrophic.

## 2. No `data:` bytes

Asserted as the absence of the substring `data:image` in the persisted JSON for
the 40-garment recon-ready shape. The assertion is paired with a positive check
that the same substring **is** present in the in-memory records, so a future run
cannot pass vacuously because the fixture stopped carrying bytes.

`reconStatus: "ready"` is asserted to **survive** the strip. Clearing it would
make `runReconJob` treat an already-built garment as never-built and spend
another call from the shared free recon quota — i.e. it is possible to "pass"
this gate by burning the quota, and the test forbids that.

`http(s)` references are asserted to be **kept**, for `photo`, `reconUrl` and
`rendering`. This caught a real defect — see §5.

## 3. Subscriptions

Baseline listed 8 whole-collection subscriptions. Remaining in `src/` outside
`selectors.ts`: **0**.

| Site | Before | After |
| --- | --- | --- |
| `App.tsx` | `s.onboardedUsers` | `useIsOnboarded()` (boolean) |
| `Home.tsx` | `s.garments`, `s.looks` | `useGarmentCount()`, `useLookCount()`, `useRecentLooks(6)` |
| `Closet.tsx` | `s.garments` (grid maps it) | `useGarmentIds()` + per-tile `useGarment(id)` |
| `Looks.tsx` | `s.looks` | `useLooks()` |
| `Studio.tsx` | `s.garments` | `useGarments()` |
| `Calendar.tsx` | `s.looks`, `s.schedules` | `useScheduleMap()` (value-compared), `useScheduleDateKeys()`, memo'd `looksById` |

`useGarments`/`useLooks` still return arrays, deliberately: Closet filters,
Studio reduces, Looks searches. They use `useShallow`, so a store write that
leaves garment element references untouched — weather, toasts, generation
status — no longer re-renders them. The per-tile isolation comes from
`ClosetTile` subscribing to `useGarment(id)`, which is what makes a recon stage
tick for one garment unable to re-render the other 39.

`GarmentCard` is memoised; `Closet` passes a `useCallback`-stable `openDetail`,
without which the memo would be defeated on every render.

## 4. Typecheck, tests, build

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0, no output |
| `npx vitest run` | **51/51 passed, 5 files** |
| `npm run build` → `vite build` | exit 0, **zero warnings** |

New tests: `src/store/persistGate.test.ts`, 12 tests — 6 gate assertions and 6
driving/verifying the dev-time guard.

**Build warnings: 3 → 0.** BASELINE.md listed:

1. `Generated an empty chunk: "vendor-utils"` — `manualChunks` named `clsx`,
   which nothing imports (`cn()` in `lib/utils.ts` is hand-rolled). Chasing this
   found five more never-imported runtime dependencies; see §6.
2. `blobStore.ts` both statically and dynamically imported by `appStore.ts`.
3. `garmentRecon.ts` dynamically imported by `appStore.ts`, statically by
   `Closet.tsx`.

Warnings 2 and 3 are resolved by collapsing the dynamic imports to the static
ones that already existed, so each module now has exactly one import style.

## 5. Two defects the gate caught that review did not

### 5.1 `photo` was stripped unconditionally, including `http(s)` URLs

`stripImageBytes` was written as `{ ...g, photo: undefined }` — copied from the
old `partialize`, which had always done exactly that, so it looked correct.

It is not. `dataService.rowToGarment` maps `image_url → photo`, so in **live
mode a garment synced from Postgres carries a Storage URL in `photo`**, not a
data URL. `Closet`'s "Original photo" disclosure reads `g.photo` directly.
Stripping it unconditionally destroyed the client's only handle on those bytes
and left the disclosure empty after a reload.

The spec is explicit — AD-3: *"persist http(s) refs + IDB keys only"*, and §5:
*"v13 migration strips data-URL `reconUrl` (keep http(s))"*. A test asserting
http(s) refs survive is what surfaced it. The rule is now about the **encoding,
not the field name**: anything `data:` goes, anything `http(s):` stays, and
`photo` now follows the same rule as `reconUrl` and `rendering`.

This is the one behavioural regression the phase introduced and fixed before
commit. Worth recording because the copy-paste that caused it is invisible on
reading — the line looked like the status quo.

### 5.2 The gate test read `localStorage` too early

The first run of `persistGate.test.ts` failed with `nothing persisted under
fitflow-store` on 5 of 6 tests. Not a store bug: writes are debounced 250 ms
trailing (which is RC-1's fix), so a synchronous read after `setState` correctly
sees nothing.

Fixed by calling the store's own exported `flushPendingWrites()`. That is the
better fix than sleeping on a real timer: it is instant, deterministic, and it
exercises the same function `pagehide` and `visibilitychange(hidden)` call when
a real user closes the tab inside the debounce window.

## 6. Dependency audit

Six declared runtime dependencies are never imported anywhere in the app:

| Package | Evidence |
| --- | --- |
| `clsx` (transitive, was in `manualChunks`) | `cn()` is hand-rolled; no import site |
| `@dnd-kit/core`, `/sortable`, `/utilities` | 0 references in `src/`, `supabase/`, `tools/`, `scripts/` |
| `canvas-confetti` | 0 references |
| `date-fns` | 0 references |
| `recharts` | 0 references |
| `uuid` | every hit is the string literal in `uid("uuid")` |

All removed, plus the now-orphaned `@types/canvas-confetti` and `@types/uuid`.
`@gradio/client` moved to `devDependencies`: it is imported only by
`scripts/recon-harness.mjs` (a Node-side harness), never by the app bundle.
`manualChunks` is now audited against real imports and `vendor-utils` is gone
entirely; `zustand` takes the freed slot.

`package-lock.json` regenerated to match. `npm install` reports 4 moderate
advisories, all pre-existing transitive issues, none introduced here.

## 7. Honest limits

- **Host-measured, not on-device.** The Phase 3 gate is defined on snapshot size,
  selectors and build output — all host-measurable and all measured. No on-device
  run was performed for Phase 3, so the **RC-2 render-cost improvement is argued
  from subscription structure, not timed on a handset**. The structural claim
  (one tile subscribes to one record) is verified by the code and the absence of
  whole-array subscriptions; the millisecond win is not claimed as measured.
- **The RC-4 boot win is likewise structural.** `loadAllBlobs` no longer merges
  into state; boot no longer awaits O(closet) image IO. The Phase 0 baseline
  recorded boot timings, but this phase did not re-run that probe on device.
- **Migration is tested at the transform level, not end-to-end.** The v13
  `migrate` step is exercised as a function; no test boots a real v12 snapshot
  through the full `persist` rehydrate path. A v12→v13 upgrade on a real install
  is unverified here.
- **The dev-only guard is `console.warn`, not a throw.** It reports a regression
  but does not prevent one; the CI-visible protection is the vitest gate, which
  does fail.

## 8. Reproduction

```bash
npx tsc --noEmit                 # expect: no output
npx vitest run                   # expect: 51 passed (5 files)
npx vitest run src/store/persistGate.test.ts   # expect: 12 passed
npm run build                    # expect: exit 0, no warnings
```

The byte counts in §1 are printed by the gate test's failure messages, so a
regression reports the actual figure rather than only "expected < 102400".

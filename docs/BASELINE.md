# BASELINE — measured numbers

Everything here was executed on this machine or the connected device during
**Phase 0**. Re-measure before trusting any of it; tooling moves.

- Date: 2026-09-26
- Branch: `impl/phases-0-7` (base `garment-studio-render` @ `f441d0ac`)
- Host: Windows, bash via Git-for-Windows POSIX shim
- Device: physical Android handset, 1080×2340 (`adb shell wm size`), Brave via
  `adb reverse tcp:5173` (Chrome also installed; Brave is what was driven)

## Build / typecheck

| Metric | Value | How measured |
| --- | --- | --- |
| `npm run typecheck` | **0 errors** | 3 consecutive runs |
| typecheck wall time | 7.16 s / 6.30 s / 5.10 s | `date +%s%N` around `npx tsc --noEmit` (warm-up run is slowest) |
| `npm run build` (vite) wall | **11.6–16.0 s** over 4 runs | includes `prebuild` typecheck; most recent 12.9 s / 13.1 s. Noisy on this host — compare ranges, not single runs |
| vite transform only | 5.66 s, 1797 modules | vite's own report |
| `dist/` size | **882 KB**, 17 files | `du -sh dist` |
| gzipped JS+CSS | **214.6 KB** | concatenated then `gzip -c \| wc -c` |
| precache manifest | 15 entries, 817.74 KiB | workbox report |
| build warnings | **3** (see below) | baseline for DoD #3 "no *new* warnings" |

The 3 warnings are the pre-existing set, carried forward verbatim so later
phases can be diffed against it:

1. `Generated an empty chunk: "vendor-utils".`
2. `blobStore.ts` is both statically and dynamically imported by `appStore.ts`.
3. `garmentRecon.ts` is dynamically imported by `appStore.ts` and statically by `Closet.tsx`.

## Persisted snapshot size — **FAILS DoD #4**

Measured by replicating `appStore.ts` `partialize()` over 40 synthetic
garments built from `DEMO_WARDROBE` with the real `renderingFor()` SVG
generator, then `JSON.stringify` + `TextEncoder` byte count.

| Snapshot shape | Bytes | vs DoD #4 (< 102 400) |
| --- | --- | --- |
| 0 garments | 15 | pass |
| 12 garments, no recon | 67 662 | pass |
| 12 garments, recon ready | **1 748 370** | **fail, 17×** |
| 40 garments, no recon | **225 364** | **fail, 2.2×** |
| 40 garments, recon ready | **5 827 724** | **fail, 57×** |

Per-garment drivers:

- `rendering` (SVG data URL) = **4 956 bytes** each. Persisted by design, and
  it alone accounts for the 225 KB no-recon case.
- `reconUrl` (512×512 PNG data URL) ≈ **140 KB** each — modelled at 140 000
  base64 chars, the expected order for 512×512 PNG. Dominant term.

`rendering_is_data_url = true`, `recon_is_data_url = true` — both confirmed to
be `data:image` strings, which DoD #4 forbids outright.

**Root cause (evidence, not inference).** `partialize` at
`src/store/appStore.ts:1633` strips only `photo`:

```ts
garments: s.garments.map((g) => ({ ...g, photo: undefined })),
```

`reconUrl` is never cleared, so every recon result is written into
`localStorage` under `fitflow-store`. `saveBlob(id, "recon", url)` at
`appStore.ts:368` *also* stores the same bytes in IndexedDB, so the data is
persisted twice. `looks` and `today.outfit` strip `photo` the same way and
inherit the identical `reconUrl` leak. Note this is a real second copy, not
double-counting in the measurement — the 5.8 MB figure is genuine
`localStorage` payload.

Secondary cause: the store mutates on every recon completion, and Zustand
persists the whole snapshot synchronously on each mutation.

Fix belongs to **Phase 3** (v13 migration + no image bytes in the snapshot).
Recorded here so DoD #4 is not "passed" by widening the target.

## Store subscriptions — **FAILS DoD #5**

77 `useAppStore((s) => …)` subscriptions total, of which **8** subscribe to a
whole collection (any change to any element re-renders the consumer):

| File:line | Subscription |
| --- | --- |
| `src/App.tsx:212` | `(s) => s.onboardedUsers` (`string[]`) |
| `src/screens/Calendar.tsx:178` | `(s) => s.looks` |
| `src/screens/Calendar.tsx:179` | `(s) => s.schedules` |
| `src/screens/Closet.tsx:794` | `(s) => s.garments` |
| `src/screens/Home.tsx:61` | `(s) => s.garments` |
| `src/screens/Home.tsx:62` | `(s) => s.looks` |
| `src/screens/Looks.tsx:174` | `(s) => s.looks` |
| `src/screens/Studio.tsx:74` | `(s) => s.garments` |

Fix belongs to **Phase 3**.

## Error containment

Verified on device by throwing inside the Closet screen via a temporary
`?__throwtab=<tab>` dev flag, added for this check and **removed again** after
it passed (it is not in the tree). Screenshots in `docs/screenshots/`:

| Evidence | File |
| --- | --- |
| App boots to auth, then demo closet | `phase0-after-skipauth.png` |
| Throw contained to the tab | `phase0-boundary-closet.png` |
| Full fallback UI, "Go to Today" + "Reload" | `phase0-boundary-thrown.png` |
| Shell still alive after the throw | `phase0-boundary-recovered.png` |
| Boundary resets on tab return | `phase0-boundary-reset.png` |

The last one is the meaningful result: the top bar and bottom nav keep
rendering and stay tappable, and the copy reassures the wearer that data is
safe. A whole-app unmount would have lost the nav. This closes the RC-7
observation from §1 of the spec.

Two caveats, both honest limits of the check rather than failures:

- The boundary is sticky while the user stays on the broken tab — correct
  React behaviour, but the copy is what rescues it ("switch tabs and come
  back"), so recovery is user-driven, not automatic.
- On reset it landed on the **auth** screen, not the demo closet: the dev
  skip-auth state did not survive the remount. Unrelated to the boundary, and
  not chased in Phase 0.

## Android toolchain (re-verified on this machine)

| Item | State |
| --- | --- |
| `adb` | present, device connected and authorized |
| `node` | v22.x |
| `JAVA_HOME` / `java -version` | **JDK 21 required; PATH default reported failing — must set explicitly before Gradle** |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | set, SDK at `~/AppData/Local/Android/Sdk` |
| `build-tools` | multiple versions present |
| `sdkmanager` | to be confirmed in Phase 5 |
| Android Studio / emulator | **not installed, and must not be** |

Gradle work is Phase 5. The JDK 21 caveat is unresolved by design — treat
"PATH default fails" as unverified until then.

## Known non-issues

- `adb logcat` is flooded with `DGWClient … getaddrinfo(): No address
  associated with hostname` from Chrome. That is the device having no DNS
  resolver, not an app fault. Phase 0 error capture is in-page
  (`__flowiePerf`), not logcat, so this does not interfere.
- `npx tsx` is not installed and must not be installed (offline-first repo
  hygiene). Measurements that need TS execution go through the local
  `node_modules/.bin/esbuild`, which is already a Vite dependency.

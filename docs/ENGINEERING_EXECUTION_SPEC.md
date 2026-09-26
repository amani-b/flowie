# Flowie — Engineering Execution Specification (redo, verified)

> Authority: this document is the single source of truth for the
> performance / stability / UX / Android work programme.
> Derived from direct inspection of the repo at
> `f441d0ac` on branch `garment-studio-render` (2026-09-26).
> A previous draft of this spec (written with a different model) contained
> hallucinated symbols and was deleted. This is the clean redo.
> Status: PLAN. Nothing below is implemented yet except §1 cleanup.

- Repo root: `d:\Projects\flowie-app`
- Product: Flowie (legacy name "FitFlow AI" in some code/docs) — mobile-first
  wardrobe + AI stylist + outfit visualizer PWA.
- Non-negotiable: TryOffDiff default / FLUX.2-klein for `hasPrint` recon
  pipeline is the quality baseline. Optimise around it, never inside it.
- Cleanup already done in this redo (§1.0): deleted stale
  `docs/ENGINEERING_EXECUTION_SPEC.md` + `docs/IMPLEMENTER_HANDOFF.md`
  (hallucinated APIs), restored accidentally deleted
  `supabase/functions/enhance-garment/index.ts` +
  `supabase/functions/flatlay-tryoff/index.ts`, removed stray proxy log,
  fixed stray ```` ``` ```` first line in `.gitignore`.

## 0. How to use this document

1. Read §1 (evidence) and §2 (root causes) before touching code.
2. Execute phases in §4 in order. Each phase has an exit gate.
3. Each phase lists exact files/symbols/commands/acceptance criteria.
4. If reality contradicts this doc, record it in §9 and continue with the
   smallest adjustment. Halt only if quality / data / money is at risk.
5. Work agent-first: use your own terminal, `adb`, screenshots. Never ask the
   user to do routine engineering.

Legend: VERIFIED = read from repo. HYPOTHESIS = needs Phase 0 timing.
DECISION = locked. PLANNED = specified, not implemented.

## 1. Evidence base (VERIFIED)

### 1.0 Working-tree state at redo time

- `git status --porcelain | grep -v node_modules` is clean (only a stray
  proxy log, now removed). `tsconfig.json` / `vite.config.js` show no diff
  vs HEAD (earlier diff flags were CRLF warnings only).
- `git ls-files | grep -c node_modules` = **21909**: `node_modules/` is
  tracked in git despite `.gitignore` listing it. Every checkout/diff is
  noisy. Fix in Phase 6 (untrack, do not delete working files).
- `supabase/functions/` contains THREE functions: `recon-garment` (active),
  `enhance-garment` + `flatlay-tryoff` (retired, still tracked + still
  deployed remotely until deleted from dashboard — see §6 and Phase 6).
- `docs/` did not exist at HEAD; `supabase/.temp/` is CLI cache (untracked,
  leave alone). `dist/`, `out/`, `recon-work/`, `*-review/`, `references/`,
  `codex_video_stills/`, `flowie-app-handoff.zip` are tracked build/review
  artefacts (hygiene backlog, Phase 6).

### 1.1 Stack (`package.json`, `vite.config.js`, `tsconfig.json`)

- `react@18.2`, `react-dom@18.2`, `vite@6.3.5`, `typescript@5.7`,
  `tailwindcss@4.1.7` via `@tailwindcss/vite`, `zustand@5.0.15` + `persist`,
  `framer-motion@11.16.1`, `lucide-react@0.294`, `react-router-dom@6.8`,
  `@supabase/supabase-js@2.98`, `@gradio/client@2.7` (no `from "@gradio`
  import in `src/` — harness/edge use raw fetch; dead client dep),
  `vite-plugin-pwa@1.3`, `@dnd-kit/*`, `recharts`, `date-fns`, `uuid`,
  `canvas-confetti`, `sharp` (dev), `workbox-build`.
- Scripts only: `dev` (vite), `prebuild` (`tsc --noEmit`), `build`
  (`vite build`), `typecheck` (`tsc --noEmit`). No test runner, no lint,
  no formatter, no CI.
- `vite.config.js`: PWA `registerType autoUpdate`, `manifest:false` (uses
  `public/manifest.webmanifest`), workbox `globPatterns js/css/html/svg/png/
  webmanifest`, dev `host 0.0.0.0:5173`, `manualChunks` vendor-framer /
  vendor-supabase / vendor-lucide / vendor-react / vendor-utils
  (`['clsx','uuid','date-fns']` — `clsx` is NOT in dependencies, so that
  chunk is at best partial dead weight; verify with a real `npm run build`
  in Phase 0, do not quote old numbers).
- `tsconfig.json`: `strict`, `noEmit`, `jsx react-jsx`, `target ES2020`,
  `moduleResolution bundler`, `include ["src"]` only (edge functions and
  scripts are not typechecked).
- No `capacitor.config.*`, no `android/`, no `@capacitor/*`, no
  `.github/workflows` (VERIFIED by ls + search for `capacitor|android|
  workflows` — only `package-lock` version-string hits).

### 1.2 Entry, shell, styles (VERIFIED)

- `index.html`: `viewport-fit=cover, maximum-scale=1` (a11y issue, Phase 4),
  `theme-color #0C110D`, `manifest.webmanifest`, icons svg/192/512/180,
  Google Fonts `Manrope + Syne`, boot script reads `fitflow-store` theme
  pre-paint to set `.dark`.
- `src/index.css`: tokens `--bg/bg-deep/surface/surface-solid/ink/mut/line/
  acc/amber/cool/danger/board-1/board-2/glow` + `.dark` flip,
  `@theme inline` maps to Tailwind (`bg,bgdeep,card,ink,mut,line,acc...`),
  `.glass{blur 22px saturate 1.5}`, `.card`, `.field`, `.skeleton shimmer`,
  `@keyframes drift-a/b`, `.pulse-dot`.
- `src/main.tsx`: `#root` guard + root `ErrorBoundary` only. No global
  `onerror/unhandledrejection` logger (Phase 0 adds it).
- `src/App.tsx: Shell`: `AnimatePresence mode="wait"` + `motion.div key=tab
  initial{y16/o0} animate/exit 0.22s` wraps `<Screen/>`. No per-tab error
  boundary (root + per-`GarmentPhoto` tile only). `TopBar/BottomNav/Drawer/
  Toast/Ambient` outside. `Splash` while `authStatus==booting`.
- `src/components/Ambient.tsx`: two infinite radial glows (26s/32s) + grain
  + vignette, always mounted.
- `TopBar`/`BottomNav` use `.glass` (blur on fixed bars). `BottomNav` uses
  `layoutId="nav-pill"` spring. `TopBar` theme toggle uses
  `AnimatePresence mode="wait"`.

### 1.3 Types (VERIFIED)

- `src/types/index.ts` (there is NO `src/types.ts` — old plan cited a wrong
  path): `Garment`, `Outfit{top?,bottom?,dress?,outer?,shoes?,accessory?}`,
  `SavedLook`, `Schedule`, `WeatherNow`, `GenerationState`, `AuthUser`,
  `Profile`, `StylePrefs`, `TabId`, `ThemeMode`, `ToastMsg`, `Units`.
- `src/types/database.ts`: hand-maintained `Database` type;
  `wardrobe_items` Row has optional `render_url?/recon_url?/has_print?/
  studio_render_url?` (migration-gated).

### 1.4 Persist + boot (VERIFIED — old plan had 5+ errors here)

- Persist: `name "fitflow-store"`, `version 12`, `storage safeStorage`
  (quota-guarded, NO debounce — every `set` serialises).
- `merge` validates `tab`, coerces arrays, restores sync Sets. It does NOT
  validate garment colors and does NOT call `ensureRendering` (old plan
  wrong on both).
- `migrate` is a REAL fall-through v1→v12 chain (scrubs retired
  studio fields, backfills renderings at v6, leans snapshots at v10,
  recon rewrite at v12). Old plan's `validatedMerge/validatePersistedState/
  backfillRenderings/resumePendingRecons/reconPendingIds` do NOT exist.
- `partialize`: keeps whole garment objects incl. data-URL `reconUrl` but
  `photo: undefined`; look/today snapshots photo-stripped. Lean for photos,
  NOT for recon bytes (Phase 3 target).
- `boot()`: `restoreSession` → `completeAuth/signedOut`, guarded
  `subscribeAuth`, sync-queue sanitize, `retrySync` after 4s,
  `await rehydrateBlobs()`, resume loop for `reconStatus==pending` garments.
- `addGarment(g, photoDataUrl?) => Promise<void>`: strips incoming
  id/createdAt, mints `crypto.randomUUID()` with NO non-secure fallback
  (RC-6), `ensureRendering`, NO 200-item cap (old plan wrong), sets
  `reconStatus:pending` + `runReconJob`, then `await withTimeout(
  insertGarmentRow, 30s)` in live mode. NO `queueRecon` option, NO
  `enqueueRecon/processReconQueue/updateGarmentRow` split (invented names).
- `runReconJob`: `reconInFlight` + serial `reconChain`, dynamic import of
  `garmentRecon`, `analyzeGarmentPhoto` gate (shoes/accessory → return),
  renderer `hasPrint ? klein : tryoff`, patches via `applyReconPatch`.

### 1.5 Recon pipeline (VERIFIED)

- `src/services/garmentRecon.ts`: `reconClassFor` (top/outerwear→upper,
  bottom→lower, dress→dress, else null), stub `analyzeGarmentPhoto`,
  `RECON_DAILY_BUDGET=4` (key `fitflow-recon-calls-v1` — old plan's
  `flowie:recon-count` WRONG), `RECON_TIMEOUT_MS=90s` (old plan said 120s —
  WRONG), `RECON_SEED=42`.
- `requestGarmentRecon` never throws; guards mock-mode / no-source /
  budget; `supabase.functions.invoke("recon-garment", ...)` in
  `withTimeout(..., "Garment recon")`.
- Edge `recon-garment`: Deno, CORS `*`, `HF_TOKEN/HF_TRYOFF_SPACE_ID/
  HF_KLEIN_SPACE_ID`, `KLEIN_STEPS=20`, `buildReconPrompt` (chroma #00FF00,
  do-not-invent), Gradio `POST /upload` → `POST /queue/join`
  (client `session_hash`) → SSE `GET /queue/data?session_hash=` → result
  file → `{recon_data_url, renderer}` + `wall_ms`. 503 when secrets
  missing. No DB/Storage writes.
- `GarmentPhoto` precedence: `reconUrl` (unless failed) → `photo` →
  `rendering` → `renderingFor(g)`. `studioRender.ts` is pure SVG 768×1024,
  memoised, never throws (`safeGarment`).

### 1.6 Upload + cloud sync (VERIFIED)

- `Closet.tsx AIUploadForm.analyzeFiles`: 2-lane `queue.shift()` loop,
  `withTimeout(compressImage, 35s)` + `withTimeout(tagGarmentPhoto, 60s)`,
  cooperative `cancelRef`, `try/finally`. Confirm →
  `pending.forEach(p => addGarment(taggingToGarment(p, p.imageDataUrl)))`
  fire-and-forget.
- `compressImage` (`utils.ts`): main-thread Image+canvas, maxSide 1024,
  JPEG q0.85→0.5 / scale→0.35 loop to 1MB, white-flatten, data URL.
- `tagGarmentPhoto`: `GEMINI_MODEL gemini-3.5-flash`, `TAG_TIMEOUT_MS 25s`;
  Gemini + `extractColorsFromImage` in parallel, `clampPatternToPixels`
  (≥0.9 → solid); heuristic fallback re-wraps via `fetch(dataUrl).blob()`.
- `dataService.insertGarmentRow`: data-URL photo → `fetch().blob()` →
  `wardrobe` bucket `userId/garmentId.jpg` upsert → public URL (base64
  fallback); `wardrobe_items` upsert, one retry without render/recon/print
  columns on missing-column error (`renderUrlOk/reconUrlOk/hasPrintOk`).
- `blobStore` (`flowie-blobs` IDB v1): `saveBlob` fire-forget (data-URLs
  only); `loadBlob` EXISTS but has ZERO callers (old plan claimed Phase 3
  "starts calling loadBlob" as if new — it already exists, just unused);
  `loadAllBlobs` (boot merge), `pruneBlobs`, `deleteBlobsFor`, `clearBlobs`.
- `authService`: mock+live, `restoreSession/subscribeAuth/...`;
  `weather.ts` Open-Meteo + fallback; `stylist.ts` Gemini + heuristic.
- Selectors are whole-slice (`Closet(): useAppStore(s => s.garments)` etc.)
  — no per-id selectors. Motion: Shell `mode="wait"` 0.22s, card/board
  `layout`+spring, Closet `popLayout`, TopBar icon `mode="wait"`,
  BottomNav `layoutId` pill. `font-display` on headers — recount exact
  sites in Phase 0, do not quote the old "11 places".

## 2. Root causes (VERIFIED mechanism; magnitude = HYPOTHESIS until Phase 0)

- RC-1 persist churn: `safeStorage.setItem` JSON-stringifies the whole
  snapshot on EVERY `set` (no debounce). `partialize` keeps SVG `rendering`
  strings + data-URL `reconUrl`s (only `photo` stripped) → snapshot grows
  with closet size; recon bytes are the weight. Confirm size in Phase 0.
- RC-2 whole-slice renders: screens subscribe whole arrays
  (`useAppStore(s => s.garments)`); every garment mutation re-renders every
  grid. No per-id selectors. Fix: granular selectors + memoised tiles.
- RC-3 main-thread images: `compressImage` (canvas) +
  `extractColorsFromImage` (128px canvas) run on the main thread during
  `analyzeFiles`; serial Storage upload + serial recon chain add perceived
  freeze. No worker, no `createImageBitmap`, cancel is cooperative only
  (in-flight Gemini/HF not aborted). Fix: worker + Blob pipeline.
- RC-4 boot weight: `rehydrateBlobs()` loads ALL IDB blobs at boot and
  `boot()` resumes every `pending` recon (each can burn quota). Fix: lazy
  per-tile resolution + resume at most the single most-recent job.
- RC-5 recon waste: no content-hash dedupe — identical re-import costs a
  fresh quota call; `setGarmentPrint` clears cache by design (fine). Fix:
  content-hash cache in IDB (+ optional `recon_cache_key` column later).
- RC-6 `crypto.randomUUID()` unguarded in `addGarment` + `saveLook` while
  `uid()` has a fallback they don't use → throws on non-secure origins
  (plain-HTTP LAN to `vite --host`, i.e. phone testing). Fix: route both
  through `uid("uuid")`.
- RC-7 blank tabs: `Shell` `AnimatePresence mode="wait"` unmounts before
  mount (0.22s gap); NO per-tab boundary — a throw in the incoming screen
  leaves only `Ambient`. Root + tile boundaries exist. Fix: per-tab
  boundary in Phase 0, instant switch + keep-alive in Phase 4.
- RC-8 UX noise: Syne on functional UI, `.glass` blur on fixed bars,
  always-on Ambient animation, 9.5–11px micro-labels, sub-44px targets,
  `maximum-scale=1` blocks pinch zoom. Fix: Phase 4 token/motion/a11y pass.
- RC-9 no Android/CI/tests; RC-10 hygiene: `@gradio/client` unused in
  `src/`, `clsx` missing vs `vendor-utils` chunk, `loadBlob` dead,
  `renderingFor` imported in `GarmentPhoto` only (verify `dataService`
  claim in Phase 0 — old plan said unused import there), retired edge fns
  still deployed, review artefacts tracked.

## 3. Decisions (locked)

- AD-1 Keep recon pipeline + quality settings (renderer choice, seed 42,
  prompt text, `KLEIN_STEPS=20`, budget 4, timeout 90s). Optimise around it.
- AD-2 Blob pipeline: worker owns decode/resize/encode; pass `Blob`s, not
  base64, to tagging + Storage upload; keep data-URL compatibility.
- AD-3 Persist: NO image bytes in `fitflow-store` (http(s) refs + IDB keys
  only); debounced writes (250ms trailing); lazy per-tile resolution.
- AD-4 Jobs: first-class background job queue for recon (serial,
  AbortSignal-aware, cancel/retry, honest progress banner); `reconStatus`
  stays as a mirror for sync/UI compat.
- AD-5 Selectors: granular (`useGarment(id)` etc.); no whole-array subs
  where narrower works; memoised tiles.
- AD-6 Android = Capacitor 8 wrapping the same Vite build. No RN/Kotlin UI,
  no second codebase, no paid infra, no emulator, no Android Studio dep.
- AD-7 Native via one module (`src/lib/native.ts`), no-op on web.
  Back button centralised (drawer → sheet → home → double-tap exit).
- AD-8 Tests = Vitest + happy-dom only. Device QA agent-driven via adb.
- AD-9 Design pass is tokens/components, not a rewrite; display font to
  brand slots only.

## 4. Execution order

| Phase | Title | Gate |
| --- | --- | --- |
| 0 | Diagnose: instrumentation + baseline | Stage timings for a real import; per-tab boundary proven; `docs/BASELINE.md` with real numbers |
| 1 | Off-main-thread images, non-blocking import | Long tasks <50ms during 5-photo import; sheet closes immediately |
| 2 | Job queue + recon cache + honest progress | UI never blocks; cancel/retry work; identical re-import = 0 calls |
| 3 | Persist/selector/render cost | Snapshot <100KB @40 garments; no `data:` bytes; granular selectors |
| 4 | UI/UX pass | Checklist §7 green; zoom restored; 44px targets |
| 5 | Capacitor Android | `assembleDebug` green; installs + runs on device |
| 6 | Hygiene, tests, CI | `npm test` green; node_modules untracked; CI builds APK |
| 7 | Device QA + docs sync | Verification matrix green; spec/handoff synced |

## 5. Phases (exact files/symbols/commands)

### Phase 0 — Diagnose (no behaviour change except observability)

- Create `src/services/perfLog.ts`: `mark(label, ms)` storing
  `{label, ms, at}` ring buffer + `console.table` dump. Wrap
  `compressImage`, `tagGarmentPhoto` (incl. `viaGemini` vs pixel branch),
  `insertGarmentRow` (storage vs row), `supabase.functions.invoke`
  in `requestGarmentRecon` with `performance.now()` timings.
- Create `src/components/TabErrorBoundary.tsx`: thin wrapper around
  `ErrorBoundary` with per-tab `resetKey`; mount in `Shell` around
  `<Screen/>` (keep `mode="wait"` for now — boundary only).
- `src/main.tsx`: add `window.onerror/unhandledrejection` console logger.
- Create `scripts/perf-smoke.mjs`: node script asserting harness selftest
  path still works (`node scripts/recon-harness.mjs --selftest` needs
  `--input` — read the script first; old plan's bare `--selftest`
  command is unverified).
- Write `docs/BASELINE.md`: REAL `npm run typecheck` + `npm run build`
  output (do not copy old numbers), persist byte size with N garments,
  `font-display` site count, whole-array selector list, motion inventory.
- Verify: `npm run typecheck`, `npm run build`.
- Gate: timings visible for one real import; boundary proven by throwing
  once in a dev-only route test (revert after).

### Phase 1 — Non-blocking import (worker + Blob, sheet closes)

- Create `src/workers/compress.worker.ts` (OffscreenCanvas +
  `createImageBitmap` when available, main-thread fallback in
  `src/lib/imagePipeline.ts`): `prepareImage(file, {maxSide:1024,
  maxBytes:1MB}) => {blob, dataUrl?, sha256}`.
- `Closet.tsx analyzeFiles`: move to `src/services/uploadQueue.ts`
  (N-lane, `AbortController`; tagging gets optional `signal`).
  Close sheet on Analyse; optimistic add per finished item; keep
  Review-before-saving as explicit opt-in toggle (default off).
- `aiStylistService`: `viaGemini`/`tagGarmentPhoto`/
  `extractColorsFromImage` accept `Blob | string`; heuristic fallback no
  longer re-wraps data URLs; `dataService.uploadGarmentPhoto` +
  `insertGarmentRow` accept `Blob` (skip `fetch(dataUrl).blob()`).
- `addGarment` stays `Promise<void>` (do NOT change to return id unless
  Phase 2 needs it — old plan's signature change is deferred).
- Verify: `npm run typecheck`, `npm run build`, 5-photo import profile.
- Gate: main-thread long tasks <50ms; cancel works; no capability removed.

### Phase 2 — Job queue + recon cache + honest progress

- Create `src/services/jobQueue.ts`: serial (concurrency 1), FIFO,
  `AbortSignal`-aware, `enqueue/retry/cancel`, never rejects, listener set
  for UI. Create `src/store/jobsStore.ts`: `jobs: Record<id, Job>` +
  `pushJob/patchJob/removeJob`; persist only interrupted ids (mark
  `failed("interrupted")`, resume at most the single most-recent).
- Create `src/services/reconCache.ts`: `reconCacheKey({bytes|sha256,
  renderer, reconClass, seed})`, `lookupRecon/putRecon/invalidateRecon`
  over IDB (`blobStore` gains `reconCache` store, DB v1→v2) + memory Map.
  Kill-switch `RECON_CACHE_ENABLED=false` on wrong-image P0.
- `appStore`: delete `reconInFlight/reconChain`; `runReconJob` becomes
  cache-check → enqueue → mirror `reconStatus/reconError` (keep
  `retryRecon/setGarmentPrint` signatures); `boot()` uses interrupted-job
  rule. `garmentRecon.requestGarmentRecon` gains optional
  `{signal?, onStage?}` (additive only).
- `GarmentPhoto` pill reads job state; `App.tsx` mounts `JobBanner`
  above `BottomNav`; `DetailSheet` shows stage/elapsed + Cancel/Retry.
- Verify: `npm run typecheck`, `npm test`, `npm run build`.
- Gate: no freeze; identical re-import = 0 calls; kill resumes sanely.

### Phase 3 — Persist + selectors + render cost

- NO image bytes in `fitflow-store`: persist http(s) refs + IDB keys only;
  debounce writes 250ms trailing; v13 migration strips data-URL `reconUrl`
  (keep http(s)); dev-time snapshot-size assertion.
- Lazy images: `src/services/imageCache.ts` resolves per tile (memory LRU
  → IDB via existing `loadBlob` → http(s)); DELETE the boot-time
  `loadAllBlobs`-into-state merge (`rehydrateBlobs`); `pruneBlobs` stays.
- Selectors: `useGarment(id)`, `useJobs`-style narrow hooks; remove
  whole-array subs; `React.memo` tiles; fix `crypto.randomUUID` →
  `uid("uuid")` in `addGarment` + `saveLook`.
- Imports: single static-or-dynamic per module (fix blobStore/garmentRecon
  dual import); drop `@gradio/client` if still unused; fix `vendor-utils`
  chunk (`clsx` missing).
- Verify: snapshot <100KB @40 garments, no `data:` bytes, typecheck/build.
- Gate: RC-1/RC-2/RC-6 closed.

### Phase 4 — UI/UX pass (tokens/components, no rewrite)

- `font-display` to brand slots only (logo/splash/hero); body Manrope/system.
- Fixed bars: solid `surface-solid` instead of `.glass` blur (keep blur for
  sheets/menus if cheap); calm `Ambient` (reduce motion, honour
  `prefers-reduced-motion`); Shell: instant tab switch, remove `mode="wait"`
  gap (keep per-tab boundary + keep-alive).
- Touch targets ≥44px; `index.html`: remove `maximum-scale=1` (restore zoom);
  contrast audit; skeleton/error/empty states per screen (§7 checklist).
- Verify: typecheck/build + device walkthrough + screenshots.
- Gate: checklist green.

### Phase 5 — Capacitor Android (same build, CLI only)

- Deps: `@capacitor/core@8 @capacitor/cli@8 + camera/haptics/statusbar/
  preferences/share` as needed — minimal set. `npx cap init Flowie
  app.flowie --web-dir=dist`; `npx cap add android`.
- `capacitor.config.ts` (`appId app.flowie`, `webDir dist`);
  `src/lib/native.ts` (ONLY Capacitor import site: isNative/platform/
  statusbar/haptic/backbutton); `App.tsx` back handler
  (drawer → sheet → home → double-tap exit); `buzz()` delegates to haptics.
- `AndroidManifest`: INTERNET (+VIBRATE if needed). NO camera/storage
  perms (system picker needs none). Edge-to-edge so existing safe-area
  padding works. `scripts/capacitor.live-reload.mjs` git-ignored, never
  committed. JAVA_HOME = JDK 21 for every Gradle call.
- Verify: `npm run build`, `npx cap sync android`,
  `cd android && ./gradlew assembleDebug`, `adb install`, launch, logcat,
  back-button matrix, screenshots.
- Gate: installable APK running on the physical device.

### Phase 6 — Hygiene, tests, CI

- Untrack `node_modules` (`git rm -r --cached node_modules`, keep working
  files; .gitignore already lists it). Decide on `dist/out/recon-work/
  *-review/references/codex_video_stills/flowie-app-handoff.zip`:
  untrack or leave (record decision in §9). Delete retired edge functions
  from Supabase dashboard (keep in git history, do NOT delete from repo
  until CI is green — old plan's "delete" was ambiguous).
- Vitest + happy-dom: `imagePipeline`, `jobQueue`, `reconCache`,
  `merge/migrate/partialize` (v13), selector/render smoke. Add
  `npm test` script. No E2E downloads.
- `.github/workflows/ci.yml` (typecheck+test+build) +
  `.github/workflows/android.yml` (JDK 21 + SDK cmdline + Gradle wrapper
  → APK/AAB artefacts).
- Verify: `npm run typecheck`, `npm test`, `npm run build`,
  `git ls-files | grep -c node_modules` = 0.
- Gate: CI green from clean checkout.

### Phase 7 — Device QA + docs sync

- Full matrix (§8) on the physical device via adb (install, screenshots,
  logcat). Record results in `docs/BASELINE.md`.
- Sync `docs/ENGINEERING_EXECUTION_SPEC.md` (§9 log), update
  `docs/IMPLEMENTER_HANDOFF.md` in place (it is the single handoff text — do
  not re-inline a copy in spec §10), add `docs/ANDROID.md`
  (CLI workflow, back button, live reload, Play track).

## 6. DO NOT CHANGE (without evidence + §9 entry)

- Recon: renderer choice, `buildReconPrompt` text, `KLEIN_STEPS=20`,
  `RECON_SEED=42`, `RECON_DAILY_BUDGET=4`, `RECON_TIMEOUT_MS=90s`,
  hybrid-router rule, `hasPrint` semantics.
- `src/services/studioRender.ts` SVG output; persist key `fitflow-store`;
  `Garment` field names; RLS policies; HF Spaces; screen inventory/routes;
  PWA manifest; `COUNT_KEY="fitflow-recon-calls-v1"`.
- Never swallow errors / disable boundaries to look stable. Never commit
  secrets, `.env`, keystores, live-reload config.

## 7. UX checklist (Phase 4 gate)

- Display font only on brand slots; body text Manrope/system ≥12px
  (micro-labels ≥11px or removed).
- Fixed bars solid; no full-screen blur; Ambient calm + reduced-motion safe.
- Instant tab switch; no empty-frame gap; per-tab boundary with retry.
- All touch targets ≥44px; pinch zoom works (`maximum-scale` removed);
  contrast AA; focus visible; `aria-pressed/current` on toggles/nav.
- Each screen: loading skeleton, empty state, error state with retry.

## 8. Verification matrix (Phase 7 gate)

1. `npm run typecheck` 0 errors. 2. `npm test` green. 3. `npm run build`
   green, no NEW warnings (baseline in `docs/BASELINE.md`).
4. Persist snapshot <100KB @40 garments, zero `data:` bytes.
5. No whole-array garment subscriptions. 6. `node_modules` untracked.
7. Import 5 photos: UI responsive, sheet closes, cancel works.
8. Recon completes in background; banner honest; tab-switch safe.
9. Identical re-import = 0 recon calls (cache hit).
10. Kill mid-recon → `failed(interrupted)`, retryable, no auto re-fire
    except single most-recent.
11. Budget spent → plain "used up" copy, photo fallback, no crash.
12. `retryRecon` + `setGarmentPrint` toggle work from detail sheet.
13. Offline: tagging heuristic, styling heuristic, weather fallback all work.
14. Non-secure origin: add + save-look work (`uid("uuid")` fallback).
15. Tab switch instant, no blank frame; per-tab crash recovers via boundary.
16. APK installs, launches, back-button matrix correct, screenshots taken.
17. Recon output visually equivalent to pre-change baseline (same garments).
18. No secrets committed; live-reload config absent from git.

## 9. Discrepancy log (old plan → this redo)

- Old §1 "1689-line store, partialize strips photo+reconUrl data:, v12
  validatedMerge, boot() restoreSession/completeAuth/demo/hydrate/
  validatePersistedState/loadAllBlobs/pruneBlobs/subscribeAuth/
  refreshWeather/backfillRenderings/resumePendingRecons": PARTLY WRONG.
  `reconPendingIds/validatePersistedState/backfillRenderings/
  resumePendingRecons/validatedMerge` do not exist; merge does not call
  `ensureRendering`; `partialize` keeps data-URL `reconUrl`.
- Old `addGarment(..., {queueRecon:true})` + `enqueueRecon/queueReconJob/
  processReconQueue/insertGarmentRow→updateGarmentRow` + 200-cap: INVENTED.
  Real signature `(g, photoDataUrl?) => Promise<void>`.
- Old timeouts: recon 120s WRONG (real 90s); compress 35s + tagging 60s in
  `Closet.tsx` wrappers are real; `TAG_TIMEOUT_MS` 25s real. Old count key
  `flowie:recon-count` WRONG (real `fitflow-recon-calls-v1`).
- Old `src/types.ts` path WRONG (real `src/types/index.ts`).
- Old "build verified 4.9s/1796 modules/precache 15" UNVERIFIED in this
  session — re-measure in Phase 0, do not quote.
- Old "`loadBlob` to be called from Phase 3" MISLEADING — it exists, just
  unused. Old "`renderingFor` unused in dataService" UNCONFIRMED.
- Old "11 font-display places / scripts list / font claims": RECOUNT in
  Phase 0. Old `IMPLEMENTER_HANDOFF.md` JDK/SDK paths: RE-VERIFY on the
  machine, do not trust.
- Old "delete retired artifacts" CLARIFIED: dashboard undeploy ≠ git delete.
- Handoff text CONSOLIDATED (2026-09-26): the old §10 block and the old
  22-line `docs/IMPLEMENTER_HANDOFF.md` were two different compressions of
  the same prompt, so they could drift. Both are replaced by the single full
  corrected prompt in `docs/IMPLEMENTER_HANDOFF.md`; §10 is now a pointer.
  No engineering content was lost — the full prompt is a superset of both.
- THIRD handoff text FOUND (2026-09-26): tracked root `HANDOFF.md` (8.6 KB,
  "FitFlow AI — Project Handoff") is a THIRD, stale handoff — it claims
  "Phase 2 (next)", documents `src/components/Avatar.tsx` (no such file —
  the 2D layered avatar was replaced by `OutfitBoard.tsx` +
  `studioRender.ts` SVGs; only an `AvatarConfig` TYPE survives, in
  `src/types/index.ts:176`) and persist `v2` (real: `fitflow-store`
  `version: 12`, `appStore.ts:1295-1296`). It was pre-existing and referenced
  by §1 (`see HANDOFF.md §retired`), so it was not in the two-text
  consolidation above. Action taken: marked SUPERSEDED with a banner pointing
  at the spec + `docs/IMPLEMENTER_HANDOFF.md`; NOT deleted (git history
  retains it; Phase 6 hygiene may untrack or remove it with a §9 note). Its
  "Garment reconstruction pipeline" section is still accurate and is mirrored
  by spec §1/§6.

## 10. Implementer handoff prompt (single source)

The copy-pasteable handoff prompt lives in exactly one place:
`docs/IMPLEMENTER_HANDOFF.md`. It was regenerated from the full corrected
prompt, replacing the earlier compressed §10 block so the two texts cannot
drift. Do not inline a second copy of the handoff here — if the prompt needs
to change, edit `docs/IMPLEMENTER_HANDOFF.md` and keep this section as a
pointer. Phase 7 may refine the handoff file with the as-built decisions, but
must not fork it back into this section.



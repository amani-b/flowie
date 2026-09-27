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
- PHASE 0 EXECUTED (2026-09-26), branch `impl/phases-0-7`, all numbers in
  `docs/BASELINE.md`. Two spec assumptions were wrong, both in the pessimistic
  direction, so the downstream phases are better off than planned:
  (1) SPEC OVERSTATED the snapshot problem — it implied the whole snapshot was
  the problem, but the real driver is `reconUrl` (never cleared by
  `partialize`, ~140 KB per garment, and *also* written to IndexedDB, so it
  is genuinely double-persisted). `rendering` is a 5 KB SVG and is small
  beside it. 40 garments with recon ready = **5.8 MB**, i.e. 57× the DoD #4
  budget, not marginally over it. Phase 3 must strip `reconUrl`, not just
  `photo`; §4 Phase 3 wording is optimistic here and should be read with this
  row.
  (2) PER-TAB BOUNDARY HAD NO EXISTING RESET PATH — `ErrorBoundary` already
  accepted a `resetKey` prop, so containment needed no new component, but the
  key had to be wired to `tab` for the boundary to clear on tab return.
  Verified on device: the shell, top bar and bottom nav survive a thrown
  screen (RC-7 closed). Recovery is user-driven, not automatic.
  Also: JDK/SDK state re-checked per the old handoff's warning — `adb`, node
  and the SDK are fine, but **JAVA_HOME is still unresolved (needs JDK 21,
  PATH default reported failing)** and `sdkmanager` is still unconfirmed. Both
  stay open for Phase 5; recorded as unverified rather than assumed good.

- PHASE 2 EXECUTED (2026-09-26), branch `impl/phases-0-7`. All of §5 Phase 2 is
  implemented and statically verified (typecheck 0 errors, 34 unit tests,
  build with no new warnings); the **device gate is still open** — see the
  Phase 2 entry in §11 for exactly which claims are unmeasured and why. Three
  things reality contradicted, all recorded here rather than papered over:
  (1) A long-lived background Vite dev server is NOT usable on this host. Four
  launch strategies all produced a server that answered the first request or
  two and then silently stopped responding while still holding its port. This
  is worse than no server, because a stale process looks healthy and would have
  invalidated any gate number taken through it. Fixed by construction, not by
  retry: `tools/run-probe.mjs` owns the dev server in-process.
  (2) `tools/cdp-eval.mjs`'s hardcoded `localhost:9222` attached to a browser
  already using that port — a *different project's* dev server — so probes
  appeared to fail against a broken app. The port is now `CDP_PORT`-overridable.
  (3) Phase 1's `references/raw-samples/` fixtures are outside Vite's served
  root, so the Phase 2 probes could not fetch them. They are staged into the
  already-ignored `public/_tmp_photos/` (the same discipline Phase 1 used)
  rather than widening the served root.

- PHASE 4 EXECUTED (2026-09-27), branch `impl/phases-0-7`. Full evidence in
  `docs/PHASE4_GATE_EVIDENCE.md`; raw probe output committed under
  `docs/phase4/`. Five things this phase learned that the plan did not
  anticipate, all recorded rather than smoothed over:
  (1) KEEP-ALIVE HAS TWO TRAPS, AND THE PROBE FOUND BOTH. Adding the tab to the
  visited set from an effect — the obvious implementation — produces one commit
  where the outgoing screen is hidden and the incoming one does not exist yet:
  a literal empty frame, the exact RC-7 symptom Phase 4 exists to remove
  (measured: 4 cold switches → 4 empty frames). And `<Screen />` created fresh
  per render meant every tab switch re-rendered all five kept-alive screens,
  so keep-alive gave back most of what it bought (warm switch 43–55 ms). Both
  fixed — render-time union, memoised screen elements — and re-measured at
  `emptyFrames: 0` and 14–23 ms. Neither is visible in a diff or a screenshot.
  (2) THE LIGHT THEME FAILED AA, THE DARK THEME DID NOT. §5 Phase 4 asked for a
  "contrast audit" but the audit's real output was 13 of 30 light-theme pairs
  below 4.5:1: mid-tone accents tuned for a dark background were being used as
  text on a near-white one. Five light-theme tokens moved (see the evidence doc
  §2 for the before/after and the minimal-lightness method). The dark palette
  is untouched. `tools/audit-contrast.mjs` reads the tokens from `index.css`
  and exits non-zero on failure, so this cannot regress silently.
  (3) "EACH SCREEN: LOADING SKELETON" IS NOT LITERALLY SATISFIABLE, AND SHOULD
  NOT BE FORCED. Three of the five screens render from the persisted store
  synchronously and are only reachable after `boot()` resolves (the app shows
  `Splash` until then), so a skeleton there would never be seen by anyone.
  Only Today (weather) and Studio (generation) have a real async phase, and
  both already had skeletons. The checklist item is satisfied as "a loading
  state wherever a load exists"; the evidence doc §4 records the audit.
  (4) THE HANDSET HAS OS-LEVEL ANIMATION REMOVAL ON. The first reduced-motion
  measurement came back `matches: true` on a run that had *not* asked for it,
  which would have made the "honours prefers-reduced-motion" claim vacuous. The
  runner gained `--motion reduce|no-preference` and both states are now
  measured explicitly: `drift-a`/`drift-b` under `no-preference`,
  `animation-name: none` under `reduce`.
  (5) THE PROBE HARNESS WAS ITSELF THE FLAKIEST THING IN THE LOOP. Three
  separate failure modes, each of which looked like a broken app rather than a
  broken harness: the device tab had to be opened by hand; the CDP `adb
  forward` goes silent after a run; and an evaluate issued while `am start`'s
  navigation is still in flight has its reply dropped, which surfaces as
  "device link lost". `tools/run-probe.mjs` now opens the tab via `adb`,
  re-creates both tunnels, waits for a stable document, and prints a reason on
  every non-zero exit. It also owns one long-lived CDP session, without which
  `Emulation.*` overrides are silently dropped and reduced motion cannot be
  emulated at all.
  Also unchanged by this phase: the `node_modules` churn in `git status`
  (including a deleted `lightningcss-linux-x64-musl`) is Phase 3's dependency
  audit, not Phase 4, and remains Phase 6's job.

- PHASE 6 HYGIENE — `node_modules` UNTRACKED (2026-09-27), branch
  `impl/phases-0-7`, commit `a9208f76`, landed early (before Phase 5) at the
  user's request. The churn recorded at the end of the Phase 4 entry above is
  gone. Method: `git rm -r --cached node_modules` — `--cached` only, so every
  working file is untouched on disk; the commit staged 21,909 deletions and
  nothing else. Result: tracked files 22,106 → 197; `git ls-files node_modules`
  = 0; `git status` has zero `node_modules` entries; `git check-ignore` confirms
  `.gitignore:2:node_modules/` now applies, so a future `npm install` can no
  longer re-dirty the tree. Dependency resolution re-verified after the change
  (`zustand 5.0.15`, `vite 6.4.3`). The deleted
  `lightningcss-linux-x64-musl` noted in the Phase 4 entry is moot — it is
  untracked now, which is correct for a platform-specific optional binary.
  Root cause was NOT a stray commit: `node_modules/` was tracked long before it
  was added to `.gitignore`, and an ignore rule never applies to a path that is
  already tracked, so the directory was self-perpetuating.
  Scope was held to `node_modules` deliberately. Still tracked, and still
  awaiting the explicit untrack-or-leave decision this section calls for:
  `dist/` (3 build artefacts — also in `.gitignore`, and `dist/index.html`
  shows as modified after every local build), `phase1-review/` (8),
  `phase2-review/` (4), `phase3-review/` (12), `flatlay-review/` (2),
  `references/` (14), `codex_video_stills/` (21). `out/`, `recon-work/` and
  `flowie-app-handoff.zip` are already untracked (0 tracked each) and need no
  action; so does the superseded root `HANDOFF.md`, which stays tracked and
  banner-marked per the entry above.

- PHASE 6 HYGIENE — `dist/` UNTRACKED, REVIEW DIRS KEPT (2026-09-27), commit
  `f2387247`. The untrack-or-leave decision left open by the entry above is now
  made, on explicit user instruction. `dist/` untracked (`git rm -r --cached
  dist`; 3 files — `icon.svg`, `index.html`, `manifest.webmanifest`; `--cached`
  so the files stay on disk, and `dist/` is regenerated by `npm run build`
  anyway). This removes the last "always dirty" source: `dist/index.html`
  reappeared as modified after every local build, so the tree could never be
  reported clean. Deliberately KEPT tracked: `phase1-review/` (8),
  `phase2-review/` (4), `phase3-review/` (12), `flatlay-review/` (2),
  `references/` (14), `codex_video_stills/` (21) — 61 files of review and
  reference material that is not regenerable from source and carries
  evidentiary value for the gate records in `docs/`. `out/` (56 files),
  `recon-work/` and `flowie-app-handoff.zip` were already untracked.
  Tracked files after this pair of hygiene commits: 22,106 → 194, and
  `git status` is finally free of modified files.

- PHASE 5 EXECUTED (2026-09-27), branch `impl/phases-0-7`. Capacitor 8 wraps the
  same Vite build — no second codebase. **Gate met**: `:app:assembleDebug`
  green, the APK installs and runs on the physical handset, and the full
  back-button matrix passes 11/11 (`docs/phase5/back-button-matrix.json`,
  screenshots alongside it). Deps: core/cli 8.5.2, app 8.1.1, haptics 8.0.2,
  status-bar 8.0.3, android 8.5.2. NOTE: the §5 Phase 5 dep list omits
  **`@capacitor/android`**, without which `cap add android` fails outright.
  Five things this phase learned:
  (1) PHASE 0's TWO OPEN ITEMS ARE RESOLVED, and only one was real. JAVA_HOME
  was already correct with JDK 21 installed (Adoptium 21.0.11.10); what is stale
  is PATH `java`, which is **Java 8** — so every Gradle call must pin JAVA_HOME
  rather than trust PATH. `sdkmanager` is genuinely absent (no cmdline-tools);
  nothing here needed it, but any future SDK component install will fail.
  (2) `cap add android` MUST NOT RUN BEFORE `@capacitor/android` IS INSTALLED.
  It created a partial project under the DEFAULT identity (`namespace
  com.getcapacitor.myapp`, `applicationId com.getcapacitor.app`, `app_name
  "My App"`); the retry then refused with "platform already exists", and a later
  attempt left a second `MainActivity.java` under `app/flowie/` still declaring
  `package com.getcapacitor.myapp`, so the build died on **duplicate class**.
  Recovery is `rm -rf android` and re-add, NOT patching — the damage spans
  build.gradle, strings.xml and three Java files. The regenerated project is
  correct (`app.flowie` throughout). The template's `ExampleInstrumentedTest`
  also asserts `com.getcapacitor.app`; corrected to `app.flowie`.
  (3) `./gradlew assembleDebug` IS THE WRONG TARGET. A bare task name matches
  every module, so the library modules build AARs, which pulls in
  `extractDebugAnnotations` and four lint/compiler jars (`lint-checks`,
  `intellij-core`, `kotlin-compiler`, `groovy`). Use
  **`./gradlew :app:assembleDebug`** — the app consumes the libraries' classes
  and never needs their AARs. That took the build from failing to 41s.
  (4) EDGE-TO-EDGE NEEDS NO CONFIG AND CANNOT BE CONFIGURED. The target is
  SDK 36, and from Android 15 the platform enforces edge-to-edge, so
  `StatusBar.overlaysWebView`, `StatusBar.backgroundColor` and
  `android.backgroundColor` are documented no-ops — deliberately NOT set,
  because config that reads like it does something is worse than no config.
  Measured on device: `env(safe-area-inset-top)` = **29px**, `safe-bottom` =
  **15px** (non-zero only when the WebView really is edge-to-edge), and
  `innerHeight × dpr` = 2340 = the full screen. Only the status bar *style* is
  still settable, so it is driven from the app theme and follows dark/light —
  confirmed by screenshot in both.
  (5) THE SHEET'S OPEN STATE IS A PROP, SO THE BACK CHAIN NEEDED A REGISTRY.
  `Sheet` takes `open`/`onClose` from whichever screen rendered it, while the
  back handler is central and cannot see those local booleans. Rather than push
  a global "which sheet is open" flag through the store — which every screen
  would then have to keep in sync — overlays announce themselves to
  `src/lib/overlayStack.ts` and the handler closes the top one (LIFO).
  Two harness lessons: on this host a **Node process cannot spawn `adb` at all**
  (`spawnSync adb EBUSY`, even for `adb version`, even with the sandbox
  disabled), so `tools/probe-native-back.sh` is bash and uses Node only for CDP.
  And `App.exitApp()` calls `finishAffinity()` — the activity closes but the
  process stays cached, so a `pidof` check reports a working exit as a failure;
  assert on the foreground activity instead. The double-tap window is 2s, so the
  two back presses must not have a CDP round-trip between them.
  Not verified here: Play Store signing (debug APK only) and the full device
  matrix — both Phase 7.

## 10. Implementer handoff prompt (single source)

The copy-pasteable handoff prompt lives in exactly one place:
`docs/IMPLEMENTER_HANDOFF.md`. It was regenerated from the full corrected
prompt, replacing the earlier compressed §10 block so the two texts cannot
drift. Do not inline a second copy of the handoff here — if the prompt needs
to change, edit `docs/IMPLEMENTER_HANDOFF.md` and keep this section as a
pointer. Phase 7 may refine the handoff file with the as-built decisions, but
must not fork it back into this section.

## 11. Phase log

### Phase 1 — off-main-thread image pipeline — **GATE PASSED**

Scope as built:

| Piece | File |
| --- | --- |
| Worker (OffscreenCanvas decode + encode) | `src/workers/compress.worker.ts` |
| Main-thread-safe wrapper, worker/main fallback | `src/lib/imagePipeline.ts` |
| Pixel truth shared with the tagger | `src/lib/pixelSample.ts` |
| Blob-first import queue, cancel handle | `src/services/uploadQueue.ts` |
| Sheet closes on start, review opt-in | `src/screens/Closet.tsx` |
| Colour extraction moved off the import path | `src/services/aiStylistService.ts` |

Measured on the physical device (Brave on `localhost:5174` via
`adb reverse`, driven through CDP — `tools/cdp-eval.mjs`):

| Measurement | Result |
| --- | --- |
| Decode path, 5 real garment photos | **5/5 `worker`** |
| Main-thread long tasks during import | **0** (max 0 ms) |
| Worker chunk in the build | `compress.worker-*.js`, 6.17 kB, own chunk |
| First item visible | **687 ms** (batch still running) |
| Last item visible | **1966 ms** → 1312 ms spread, 0 errors |
| Auto-tag category accuracy, real clothing | **4/5** |
| `photo` bytes in the `fitflow-store` snapshot | **0** (5 imports → snapshot 186 KB) |

The spread is the non-blocking proof: a blocking import would show ~0 ms
between first and last item.

The 4/5 is a genuine model limitation, not a regression: the photo is a
hoodie **worn by a person**, and the tagger returned `top` (it also named it
"Colorblock half-zip hoodie", which is accurate). The four flat-lays were all
correct. This is exactly the case the opt-in review screen exists for.

### Phase 1 — verification correction (§9 entry, recorded not hidden)

The **first** Phase 1 verification pass was invalid and has been discarded.
It fed five arbitrary phone camera photos pulled from the device gallery
(`/sdcard/DCIM/Camera`, the user's personal pictures) into the import
pipeline. They were not clothing. The auto-tagger obligingly returned three
confident dark "tops" — `1000027292/91/93`, all `#292f38`-ish, all
`pattern: solid` — and I initially reported that as a tagging success. It
proved nothing, and it also put the user's personal photos into a test
fixture. The re-run used the repo's own garment assets, each inspected by eye
first:

| Fixture | Source | Truth |
| --- | --- | --- |
| `garment-olive-tee.jpg` | `out/pollinations/audit2-4-olive-tee-flat.jpg` | green tee → `top` |
| `garment-shorts.jpg` | `out/pollinations/audit2-2-shorts-flat.jpg` | black hoodie + white shorts → `bottom` |
| `garment-hoodie.jpg` | `out/pollinations/audit3-1-hoodie-flat.jpg` | half-zip hoodie, worn → `outerwear` |
| `garment-polo-shirt.png` | `flatlay-review/spike-r1-upper.png` | yellow polo → `top` |
| `garment-trousers.png` | `flatlay-review/spike-r2-lower.png` | red trousers → `bottom` |

The three bogus garments were purged from the device store. Scratch assets
lived in `public/_tmp_photos/` and are now git-ignored and deleted, so a
future probe cannot silently commit a user's camera roll again. Lesson
recorded because it is a process failure, not a code failure: a pipeline
gate is only evidence if the input is the thing the pipeline claims to
handle. Personal photos are not test fixtures for a wardrobe app.

Two further observations from the corrected run, both non-blocking:

- On the second run Gemini was unreachable and the **designed** heuristic
  fallback engaged (names became filename-derived, e.g. "garment
  trousers"). `geminiReady` is true and the key is present, so this was a
  transient call failure, not a config error. The fallback is the intended
  behaviour, and it is why the first run's names are richer than the
  second's. Worth watching in Phase 2, where retry/cancel semantics land.
- Snapshot is 186 KB with 17 garments, and `photo` contributes **0 bytes** of
  it — so Phase 1 did not regress DoD #4. The `reconUrl` term that actually
  fails it remains untouched and is still Phase 3's job.

### Phase 2 — job queue + recon cache + honest progress — CODE COMPLETE, GATE OPEN

Scope as built:

| Piece | File |
| --- | --- |
| Serial executor (concurrency 1, FIFO, cancel/retry, never rejects) | `src/services/jobQueue.ts` |
| React projection + interrupted-job handoff across reload | `src/store/jobsStore.ts` |
| Content-addressed recon cache (memory LRU + IDB) | `src/services/reconCache.ts` |
| Second IDB store `reconCache`, DB v1→v2 | `src/services/blobStore.ts` |
| Policy only: cache-check → enqueue → mirror `reconStatus` | `src/store/appStore.ts` |
| `signal` / `onStage` hooks (additive) | `src/services/garmentRecon.ts` |
| Honest banner above the nav, Cancel/Try again | `src/components/JobBanner.tsx` |
| Elapsed-time tick | `src/lib/useElapsed.ts` |
| Per-record job selectors on the tile + detail sheet | `src/components/GarmentPhoto.tsx`, `src/screens/Closet.tsx` |

Static verification, all re-run on this machine:

| Check | Result |
| --- | --- |
| `npm run typecheck` | **0 errors** |
| `npm test` (Vitest) | **34 passed**, 0 skipped, no `.only` |
| `npm run build` | exit 0; 1805 modules; **3 warnings = the exact `docs/BASELINE.md` baseline**, no new ones |

The unit suite covers the three promises the gate rests on — serial/FIFO
(never two remote calls in flight), cancel (a queued job makes **zero** calls,
a running job is aborted, and neither is ever reported as a failure), and
never-rejects (a throwing job settles as `failed` without breaking the enqueue
caller) — plus stage propagation, the interrupted-job handoff (read-once,
capped at one resume) and cache-key derivation.

**The device gate is NOT closed.** The three claims that only on-device
evidence can settle — identical re-import = 0 calls, kill-mid-recon resumes at
most one job, and the banner/UI staying responsive during a batch — are
implemented and reviewed but unmeasured. Reasons, in order of impact:

- **No stable device link.** The handset was reachable over WiFi ADB only, and
  the TLS transport dropped repeatedly mid-session (twice mid-probe), after
  which the phone left the network entirely. This is the one escalation the
  handoff reserves for a human: a USB-attached device, or a stable ADB link.
- **A long-lived Vite dev server is unusable on this host.** Launched detached
  in four different ways (`Start-Process`, `start /b`, WMI, a scheduled task)
  it served the first one or two requests and then stopped responding while
  still holding the port and the process — a failure mode that looks healthy
  from the outside and silently invalidates any measurement taken through it.
  `tools/run-probe.mjs` was added to remove the variable by owning the dev
  server in-process: it starts Vite, drives the device over CDP, and tears the
  server down, so a stale server cannot outlive a run.
- `tools/cdp-eval.mjs` now honours `CDP_PORT`. The hardcoded `9222` attached to
  an unrelated browser already listening on this machine — it drove a different
  project's dev server, which looked like a broken app rather than a wrong
  target.

Re-run when a device is attached and stable:
`node tools/run-probe.mjs tools/probe-jobs-a.mjs` (then `-b`, `-c`,
`probe-kill.mjs`). Probe A intercepts egress, so the shared 4/day recon quota
is not spent.

### Phase 3 — persist + selectors + render cost — **GATE PASSED**

Evidence: `docs/PHASE3_GATE_EVIDENCE.md` (commit `cfc06ca7`, tag
`phase/3-done`). Headline: persisted snapshot **5 827 724 → 9 285 bytes** at 40
recon-ready garments (0.09× the 100 KB budget), zero whole-collection garment
subscriptions left, build warnings **3 → 0**. Closes RC-1, RC-2, RC-6 and
removes RC-4's boot-time blob merge.

### Phase 4 — UI/UX pass — **GATE PASSED**

Evidence: `docs/PHASE4_GATE_EVIDENCE.md`; raw probe output in
`docs/phase4/a11y-probe.json` and `docs/phase4/a11y-probe-reduced-motion.json`;
screenshots `docs/phase4/{dark,light}-{home,closet,studio,looks,calendar}.png`.
Closes **RC-8** and the remainder of **RC-7**.

Scope as built:

| Piece | File |
| --- | --- |
| 44px hit-area rule, focus ring, reduced-motion block, solid `.bar` surface | `src/index.css` |
| Zoom restored (`maximum-scale` removed), `color-scheme` meta | `index.html` |
| Instant switch, lazy keep-alive, per-tab **Try again** | `src/App.tsx` |
| Solid fixed bars | `src/components/TopBar.tsx`, `src/components/BottomNav.tsx` |
| Calmer Ambient, `data-ambient-glow` freeze hooks | `src/components/Ambient.tsx` |
| Rendered-DOM audit probe | `tools/probe-a11y.mjs` |
| Token-driven WCAG audit | `tools/audit-contrast.mjs` |
| Harness: self-opening device tab, tunnel repair, stable-document gate, one CDP session, `--motion`, `--theme`, `--shots` | `tools/run-probe.mjs` |

Measured on the physical handset (all re-run on this machine):

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | **0 errors** |
| `npx vitest run` | **51 passed**, 5 files |
| `npm run build` | exit 0, 1808 modules, **zero warnings** (baseline held) |
| `node tools/audit-contrast.mjs` | **0 of 60 pairs** below target |
| Touch targets below 44×44 | **0** of 83 controls measured |
| Rendered text below 11px | **0** |
| Empty frames during tab switching | **0** of 61 sampled |
| Warm tab switch | 13.8 – 22.9 ms (median ≈ 16 ms), 5 screens kept alive |
| Syne occurrences | 26 source sites → 13; 6 distinct elements in the rendered DOM |

The phase found two defects in its own implementation (a one-frame empty gap
and a five-screen re-render per switch) that no diff or screenshot would have
shown — both are in the evidence doc §3. Its device gate is **closed**: the
probe ran end to end on the attached handset in both motion modes and both
themes.





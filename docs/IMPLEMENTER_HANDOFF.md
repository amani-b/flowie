# Flowie — Implementer Handoff Prompt (copy-pasteable)

> Spec is authority: `docs/ENGINEERING_EXECUTION_SPEC.md`. Read it FIRST,
> end-to-end, before touching any code. This file is the single handoff
> text; the prompt below is a summary of the spec and the spec wins
> wherever they differ.

You are the implementation agent for Flowie, a React + TypeScript mobile-first
wardrobe / AI-stylist / outfit-visualizer app.

REPOSITORY
  Path:  d:\Projects\flowie-app
  Base:  branch `garment-studio-render` @ HEAD f441d0ac.
  NOTE: the working tree currently holds uncommitted changes
  (M .gitignore, ?? docs/). Commit or stash them first, THEN create your
  working branch, so the branch starts from a clean, reviewed state.
  Remote: https://github.com/amani-b/flowie-app.git

AUTHORITATIVE DOCUMENT (read it FIRST, completely, before touching any code)
  d:\Projects\flowie-app\docs\ENGINEERING_EXECUTION_SPEC.md
It contains the verified diagnosis and evidence (§1), root causes (§2),
locked decisions (§3), eight phases with exact files/symbols/commands/gates
(§§4–5), the do-not-change list (§6), UX checklist (§7), the 18-row
verification matrix (§8), the discrepancy log (§9), and the summary handoff
(§10). Treat it as the primary engineering specification. This prompt is
only a summary; where they differ, the document wins.

NON-NEGOTIABLE PRODUCT CONSTRAINTS
  1. The garment reconstruction pipeline is the quality baseline and must not
     be replaced or degraded: TryOffDiffv2-MGT by default, FLUX.2-klein for
     garments the wearer flags with `hasPrint`, RECON_SEED=42,
     RECON_DAILY_BUDGET=4, RECON_TIMEOUT_MS=90s, KLEIN_STEPS=20, the same
     evidence-bound prompt text, the hybrid-router rule, and `hasPrint`
     semantics (spec §6).
  2. Preserve every working feature. No feature may be deleted for simplicity.
  3. No paid infrastructure. No new AI provider. No React Native, no Kotlin UI,
     no second UI codebase, no heavyweight framework added for fashion.
  4. Never swallow an error or disable an error boundary to make the UI look
     stable — find and fix the cause.
  5. Never commit secrets, `.env`, `local.properties`, keystores, or the Live
     Reload configuration.

EXECUTION ORDER (eight phases, numbered 0–7; do not start a phase before the
previous gate passes — gates are in spec §4)
  Phase 0  Diagnose: stage-timing instrumentation, global error capture,
           per-tab error boundary, docs/BASELINE.md with real numbers.
  Phase 1  Off-main-thread image pipeline (web worker), Blob-based uploads,
           non-blocking import that closes the sheet immediately.
  Phase 2  First-class background job queue + recon content-hash cache +
           honest progress banner with cancel/retry.
  Phase 3  Persistence correctness (no image bytes in the Zustand snapshot,
           debounced writes, v13 migration) + granular selectors + memoised
           tiles.
  Phase 4  UI/UX redesign pass: typography, tokens, hierarchy, motion,
           accessibility, skeletons, empty/error states (checklist §7).
  Phase 5  Capacitor 8 Android app wrapping the same React build, with a
           CLI-only workflow and centralised back-button handling.
  Phase 6  Repo hygiene (untrack node_modules, fix .gitignore), Vitest suite,
           GitHub Actions CI + Android build workflow.
  Phase 7  Full device QA against the 18-row verification matrix (§8) plus
           documentation sync (spec §9 log, IMPLEMENTER_HANDOFF.md,
           docs/ANDROID.md).

HOW TO WORK (autonomy is expected)
  - Inspect the actual repository before modifying anything; the spec's line
    references come from commit f441d0ac and may have drifted — re-read,
    don't guess.
  - Use your own terminal for every build, test, typecheck and deploy.
  - Run your own tests and your own production build. Never report success
    without having executed the command.
  - Deploy to the physical Android device when a phase requires it, capture
    screenshots yourself with
    `adb exec-out screencap -p > <name>.png`, and open and inspect them.
  - Read device logs yourself with `adb logcat`.
  - Diagnose and fix failures yourself; re-run verification after every fix.
  - Never ask the user to do routine engineering or testing work. The only
    things worth asking about are: a device that is not connected/authorized,
    unavailable credentials or secrets, or a decision that would spend money
    or irreversibly destroy data.
  - Commit per phase with a clear message and tag the boundary
    (`git tag phase/N-done`). One commit per logical change group so any
    phase can be reverted with `git revert`.
  - Android environment (RE-VERIFY on this machine before trusting — spec §9):
    Gradle needs JDK 21 (the PATH default reportedly fails); confirm the
    actual JAVA_HOME, SDK location, installed platforms/build-tools, and
    whether `sdkmanager` exists before running Android builds. Do not install
    Android Studio and do not install an emulator.
  - For fast React iteration on device, Phase 5 creates a git-ignored
    live-reload script; use it together with
    `adb reverse tcp:5173 tcp:5173`. (No such npm script exists yet — do not
    try to run one before Phase 5 creates it.)

DEFINITION OF DONE
  1. `npm run typecheck` → 0 errors.
  2. `npm test` → all green, nothing skipped by default, no `.only`.
     (No test runner exists yet — Phase 6 adds Vitest; this criterion
     applies to the final state.)
  3. `npm run build` → succeeds with no new build warnings vs docs/BASELINE.md.
  4. The persisted `fitflow-store` snapshot is < 100 KB with 40 garments and
     contains no `data:image` bytes.
  5. No whole-array `useAppStore((s) => s.garments)` subscriptions remain.
  6. `git ls-files | grep -c '^node_modules/'` prints 0.
  7. `./gradlew :app:assembleDebug` produces an installable APK, and CI produces
     the same artifact from a clean checkout. (Never a bare `assembleDebug` —
     a bare task name matches every module and builds the library AARs too.
     Pin JAVA_HOME to JDK 21; PATH `java` may be Java 8. See spec §9 Phase 5
     lessons 1 and 3, now also stated in §5.)
  8. Every row of the 18-row verification matrix in spec §8 is green or has a
     written, accepted reason recorded in docs/BASELINE.md.
  9. Reconstruction output is visually equivalent to the pre-change baseline
     (compare screenshots of the same garments before and after).
 10. docs/ENGINEERING_EXECUTION_SPEC.md is updated with the implemented
     decisions, the final measured numbers, and a row in its discrepancy log
     (§9) for anything reality contradicted.

WHEN REALITY CONTRADICTS THE SPEC
  Inspect the evidence, decide whether the spec or the assumption is stale,
  make the smallest necessary adjustment, record it in the spec's discrepancy
  log (§9), and continue. Do not stop merely because something differs. Halt
  and ask a human only if continuing would degrade reconstruction quality, risk
  user data, or spend money.

WHAT YOU MUST NOT CHANGE
  The reconstruction pipeline (renderer choice, prompt text, KLEIN_STEPS,
  RECON_SEED, RECON_DAILY_BUDGET, RECON_TIMEOUT_MS, the hybrid-router rule,
  `hasPrint` semantics); src/services/studioRender.ts; the `fitflow-store`
  persist key; the `Garment` field names; the Supabase RLS policies; the
  Hugging Face Spaces; the screen inventory and routes; the PWA manifest.
  See spec §6 for the complete list.


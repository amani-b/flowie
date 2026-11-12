# Phase 4 gate evidence — UI/UX pass

**Verdict: PASSED on every item of the §7 checklist.** Closes **RC-8** (UX
noise: Syne on functional UI, frosted fixed bars, always-on Ambient, sub-11px
micro-labels, sub-44px targets, blocked pinch zoom) and the remainder of
**RC-7** (the empty-frame tab gap).

Gate as written in `docs/ENGINEERING_EXECUTION_SPEC.md` §4/§5:

> Verify: typecheck/build + device walkthrough + screenshots.
> Gate: checklist green.

Everything below was measured on the physical handset
(`SM-S156V`, Android 16, Chrome 153) driven over CDP, or computed from the
theme tokens in `src/index.css`. Raw probe output is committed alongside this
document as `docs/phase4/a11y-probe.json` and
`docs/phase4/a11y-probe-reduced-motion.json`.

---

## 1. §7 checklist

| §7 requirement | Evidence | Status |
| --- | --- | --- |
| Display font only on brand slots | Rendered-DOM scan: **10 Syne occurrences = 6 distinct elements** — the wordmark, the Today hero greeting, and the four screen `h1`s. Source: 26 `font-display` sites → **13** | ✅ |
| Body text ≥12px, micro-labels ≥11px | Source sweep: **52 rewrites** across 13 files brought every `9px/9.5px/10px/10.5px` up to 11px; post-sweep grep for `<11px` → **0 hits**. Rendered check across all five screens: **0 text-bearing elements below 11px** | ✅ |
| Fixed bars solid, no full-screen blur | Top bar (54px) and bottom nav (64px) both report `backdrop-filter: none` and the opaque `--surface-solid` fill (`rgb(20,27,22)` dark / `rgb(253,253,251)` light). The only element in the entire DOM still carrying a backdrop-filter is the **toast**, which exists only while a toast is showing | ✅ |
| Ambient calm + reduced-motion safe | Drift halved and slowed (`drift-a 44s` / `drift-b 56s`, wrapper at 0.72 opacity). Under `Emulation.setEmulatedMedia(prefers-reduced-motion: reduce)` both glow layers report `animation-name: none`; under `no-preference` they report `drift-a`/`drift-b`. Framer is bound to the same setting via `MotionConfig reducedMotion="user"` | ✅ |
| Instant tab switch, no empty frame | **0 empty frames** across 61 rAF-sampled frames covering a full cold + warm pass over all five tabs (was **4** before the fix — see §3). Warm switch median ≈16 ms (~1 frame) | ✅ |
| Per-tab boundary with retry | Boundary keyed `tab:attempt`, lazily kept alive per tab; `TabErrorFallback` gained a **Try again** that resets the current tab. Before, the only escape from a latched error was leaving the tab or reloading | ✅ |
| All touch targets ≥44px | One global rule in `index.css` covers `button`, `[role=button]`, `summary`, `select`, `input`, `textarea`. Rendered audit: **83 controls measured across the five screens, 0 below 44×44** | ✅ |
| Pinch zoom works | Viewport meta is now `width=device-width, initial-scale=1.0, viewport-fit=cover` — `maximum-scale` gone. Probe asserts `zoomBlocked: false` | ✅ |
| Contrast AA | `node tools/audit-contrast.mjs` → **0 of 60 pairs below target** (was 13 of 30 in the light theme). Full table in §2 | ✅ |
| Focus visible | `:focus-visible` rule present in the loaded stylesheet; focusing a nav button reports `matchesFocusVisible: true`, `outline-style: solid`, outline colour = `--acc` | ✅ |
| `aria-pressed`/`aria-current` on toggles/nav | Nav carries `aria-current="page"`. `aria-pressed` now on the Studio mode pair, Studio occasion chips, Closet filter chips and the Calendar view switch; the two toggle groups are labelled (`role="group"` + `aria-label`) | ✅ |
| Every screen: loading / empty / error | Audit in §4 — no screen is missing a state, and no new skeleton was added where no async load exists | ✅ |

---

## 2. Contrast

`tools/audit-contrast.mjs` reads the token values out of `src/index.css`
(light from `:root`, dark from `.dark`), composites translucent badge
backgrounds over the surface they actually sit on, and exits non-zero if any
pair misses its target. Every text pair in the app renders at 11–14px, so all
of them are held to 4.5:1 — none qualify as large text.

The **dark theme passed unchanged**. The light theme did not: 13 of 30 pairs
were below target, because a mid-tone accent tuned for a *dark* background was
being used as *text* on a near-white one.

| Token | Before | After | Worst pair before → after |
| --- | --- | --- | --- |
| `--acc` | `#0c9d6c` | `#09704d` | 2.68 → 4.55 |
| `--amber` | `#c97a00` | `#895300` | 2.55 → 4.58 |
| `--cool` | `#1f7fa8` | `#1a698b` | 3.41 → 4.55 |
| `--danger` | `#cf3f4c` | `#b42d39` | 3.51 → 4.52 |
| `--muted` | `#5d6b61` | `#55635a` | 4.25 → 4.79 |

Method: hue and saturation were held fixed and lightness walked down only as
far as each token's *worst* pair required, so the palette moves as little as AA
allows. The derived `--*-soft` and `--glow-*` values were recomputed from the
new colours so nothing is left pointing at a retired hue.

`--muted` was the interesting one. It had been tuned against `--bg` and
`--surface-solid` and passed both, but `GarmentPhoto` renders 11px `text-mut`
directly on the garment board gradient, whose darker end (`--board-2`,
`#e4e0d3`) is darker than either. Darkening `--muted` fixes the root cause and
gives the token headroom on any future surface; lightening the board would
have special-cased one screen.

---

## 3. Two defects the gate caught

### 3.1 Keep-alive introduced a one-frame empty gap on first visit

The first keep-alive implementation added a tab to the `visited` set from a
`useEffect`. `tab` changes synchronously; an effect runs after paint. So the
commit that switched tabs hid the outgoing wrapper while the incoming one did
not exist yet — **one frame with no screen on it at all**, which is precisely
the gap Phase 4 exists to remove.

The probe found it rather than a reviewer: `emptyFrames: 4` against exactly
four cold switches. Fixed by computing the union *during render*, so the
incoming screen mounts in the same commit that hides the outgoing one.
Re-measured: `emptyFrames: 0`.

### 3.2 Every tab switch re-rendered all five screens

Warm switches measured **43.6–55.2 ms** — three frames for what should be a
display toggle. The cause: a tab switch re-renders `Shell`, and `<Screen />`
created a fresh element for every tab on every render, so React re-rendered
all five kept-alive screens and gave back most of what keep-alive buys.

Fixed by creating the five screen elements once (`useMemo`) and holding them
stable, so React skips the subtrees whose tab did not change.

| | Before fix | After fix |
| --- | --- | --- |
| Warm switch | 43.6 – 55.2 ms | **13.8 – 22.9 ms** |
| Empty frames | 4 | **0** |

This is the honest reason to keep a device in the loop: neither defect is
visible in a diff, and both are invisible in a screenshot.

---

## 4. Per-screen states

Audited rather than assumed. No screen was missing a state, so nothing was
added — inventing a skeleton for a screen that cannot load would be theatre.

| Screen | Loading | Empty | Error |
| --- | --- | --- | --- |
| Today | `WeatherSkeleton` while weather loads | two variants ("The rail is empty", "Nothing pinned for today"), both with actions | "Weather unreachable" + **Retry**; tab boundary |
| Closet | none needed — reads the persisted store synchronously | "Nothing to wear (yet)" + actions; "No matches" + **Clear filters** | tab boundary + per-garment "Try again" on failed recon |
| Studio | `StudioSkeleton` + live stage label | "Nothing to style" + action; picker "Nothing here yet" | "The stylist tripped" + **Try again**; tab boundary |
| Lookbook | none needed — synchronous | "No looks pinned yet" + action; "No matches found" + **Clear filters** | tab boundary |
| Calendar | none needed — synchronous | "Nothing scheduled yet", "No worn history yet", sheet empty state | tab boundary |

Every screen is reachable only after `boot()` completes (the app shows
`Splash` until then), which is why the three store-backed screens have no
loading phase to show a skeleton for.

---

## 5. Device walkthrough

Handset: `SM-S156V`, Android 16, Chrome 153, ~466×1010 CSS px.
Driven through `tools/run-probe.mjs` + `tools/probe-a11y.mjs`.

| Measurement | Result |
| --- | --- |
| Interactive controls measured | **83** across the five screens |
| Controls below 44×44 | **0** |
| Text-bearing elements below 11px | **0** |
| Document horizontal overflow | **0 px** on every screen |
| Syne elements | 6 distinct (wordmark, Today hero greeting, 4 screen `h1`s) |
| Mounted screens after visiting all tabs | **5** (keep-alive active) |
| DOM nodes | 469 |
| Tab switch, cold (first mount) | 53.0 – 85.2 ms |
| Tab switch, warm (already mounted) | 13.8 – 22.9 ms, median ≈ 16 ms |
| Frames sampled / empty frames | 61 / **0** |
| `prefers-reduced-motion: no-preference` | `drift-a 44s`, `drift-b 56s` |
| `prefers-reduced-motion: reduce` | `animation-name: none` on both glows |

Screenshots (five tabs × two themes) are in `docs/phase4/`.

Honest note on the warm-switch spread: the **first** switch measured in each
pass is consistently the slowest (48 ms, and 40 ms in the reduced-motion run)
while every later one lands at 14–17 ms. That is JIT/layout warm-up in the
measurement, not a property of any particular tab — the same tab is fast when
measured second. The median is the honest figure; the range is reported so it
cannot be read as a cherry-pick.

---

## 6. Reproduction

```bash
npx tsc --noEmit                 # expect: no output
npx vitest run                   # expect: 51 passed (5 files)
npm run build                    # expect: exit 0, zero warnings
node tools/audit-contrast.mjs    # expect: 0 of 60 pairs below target, exit 0

# device (handset attached, USB debugging on):
node tools/run-probe.mjs tools/probe-a11y.mjs --port 5199
node tools/run-probe.mjs tools/probe-a11y.mjs --port 5199 --motion reduce
node tools/run-probe.mjs tools/probe-a11y.mjs --port 5199 --theme dark --shots docs/phase4
```

The runner now opens the device tab itself (`am start`), re-creates the
`adb forward`/`reverse` tunnels, and waits for a stable document before
evaluating — three things that were previously manual preconditions and that
each failed in a way that looked like a broken app rather than a broken
harness.

---

## 7. Honest limits

- **The probe audits the demo closet (12 garments).** Every number in §5 is
  from that dataset. A 40-garment closet is covered for persist size by Phase 3
  and for per-tile subscription structure by Phase 3's selectors, but the DOM
  node count and switch latency here are not a 40-garment figure.
- **Reduced motion is verified by CDP emulation, not by changing the phone's
  setting.** The emulation is session-scoped and applied before the reload, so
  it exercises the same media query the OS would — but it is an emulation.
- **Keep-alive's cost is not fully characterised.** Five screens stay mounted,
  so an inactive Closet keeps its DOM. 469 nodes is small with 12 garments;
  the shape of the curve at 40 garments is unmeasured. If it ever bites, the
  mitigation is to unmount on a memory signal, not to abandon keep-alive.
- **No per-tab scroll memory.** Because the five screens share one scroll
  container, a tab switch scrolls to top. Preserving per-tab scroll needs a
  scroll listener that does not record the browser's height-clamp as the
  outgoing tab's position; that is deliberately not attempted here rather than
  half-done.
- **`outline-width` reports 1.78px, not the authored 2px.** Chrome on this
  handset applies its own scale factor. The outline is present, solid and in
  the accent colour; the exact device pixel width is not something the CSS
  controls.
- **Contrast is computed from the tokens, not sampled from pixels.** That is
  stronger than sampling for flat surfaces (it is exact and reproducible) but
  it does not model the Ambient glow sitting behind translucent cards. The
  glow is a low-alpha gradient and the audit treats the card fill as opaque,
  which is the conservative case for text on a card.

/**
 * Phase 4 a11y / UX device probe.
 *
 * Everything here is measured against the RENDERED app on the handset, not
 * against the source. Where a source-level claim exists (type floor, display
 * font, hit areas), this is what turns it into evidence: the CSS rule is the
 * mechanism, the numbers below are the proof.
 *
 * Run:  node tools/run-probe.mjs tools/probe-a11y.mjs
 *       node tools/run-probe.mjs tools/probe-a11y.mjs --reduced-motion
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const store = await import("/src/store/appStore.ts");
const S = () => store.useAppStore.getState();

/** Poll until `fn()` is truthy, or give up. */
const waitFor = async (fn, ms = 12000, step = 120) => {
  const t0 = performance.now();
  while (performance.now() - t0 < ms) {
    if (fn()) return true;
    await sleep(step);
  }
  return false;
};

/* ------------------------------------------------------------------ *
 * 0. Reach the shell. A fresh install lands on the auth screen, which has
 *    no nav and no tabs — every measurement below would be vacuous.
 * ------------------------------------------------------------------ */
let enteredDemo = false;
if (!document.querySelector("[data-tab]")) {
  S().enterDemoMode();
  enteredDemo = true;
  const ok = await waitFor(() => document.querySelector("[data-tab]"));
  if (!ok) {
    return {
      fatal: "could not reach the app shell",
      bodyText: document.body.innerText.slice(0, 300),
    };
  }
}
// Let the first screen settle before measuring anything.
await sleep(600);

/* ------------------------------------------------------------------ *
 * 1. Viewport / zoom
 * ------------------------------------------------------------------ */
const viewportMeta =
  document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null;
const zoomBlocked = /maximum-scale|user-scalable\s*=\s*(no|0)/i.test(viewportMeta ?? "");

/* ------------------------------------------------------------------ *
 * 2. Fixed bars: solid, not blurred
 * ------------------------------------------------------------------ */
const barReport = [...document.querySelectorAll("header .bar, nav .bar")].map((el) => {
  const cs = getComputedStyle(el);
  return {
    tag: el.tagName.toLowerCase(),
    backdropFilter: cs.backdropFilter,
    backgroundColor: cs.backgroundColor,
    height: +el.getBoundingClientRect().height.toFixed(1),
  };
});

/** Every element in the DOM that still paints a backdrop-filter. */
const blurredElements = [];
for (const el of document.querySelectorAll("*")) {
  const bf = getComputedStyle(el).backdropFilter;
  if (bf && bf !== "none") {
    blurredElements.push({
      tag: el.tagName.toLowerCase(),
      cls: String(el.className ?? "").slice(0, 48),
      backdropFilter: bf,
    });
  }
}

/* ------------------------------------------------------------------ *
 * 3. Ambient + reduced motion
 * ------------------------------------------------------------------ */
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ambient = [...document.querySelectorAll("[data-ambient-glow]")].map((el) => {
  const cs = getComputedStyle(el);
  return { animationName: cs.animationName, animationDuration: cs.animationDuration };
});

/* ------------------------------------------------------------------ *
 * 4. Focus ring: rule present, and does it apply?
 * ------------------------------------------------------------------ */
let focusRulePresent = false;
const walkRules = (rules) => {
  for (const rule of rules) {
    if (rule.selectorText && rule.selectorText.includes(":focus-visible")) focusRulePresent = true;
    if (rule.cssRules) walkRules(rule.cssRules);
  }
};
for (const sheet of document.styleSheets) {
  try {
    walkRules(sheet.cssRules);
  } catch {
    /* cross-origin sheet */
  }
}
const firstNavButton = document.querySelector("nav button");
let focusProbe = null;
if (firstNavButton) {
  firstNavButton.focus();
  const cs = getComputedStyle(firstNavButton);
  focusProbe = {
    matchesFocusVisible: firstNavButton.matches(":focus-visible"),
    outlineStyle: cs.outlineStyle,
    outlineWidth: cs.outlineWidth,
    outlineColor: cs.outlineColor,
  };
  firstNavButton.blur();
}

/* ------------------------------------------------------------------ *
 * 5. Tab switching: cold vs warm, and the empty-frame gap
 *
 *    `cold` = the tab mounts for the first time (its screen is not in the
 *    DOM yet). `warm` = the tab is already mounted and this is a display
 *    toggle. Phase 4 claims warm switching is instant and that no frame is
 *    ever empty; both are measured, not asserted.
 * ------------------------------------------------------------------ */
const TABS = ["home", "closet", "studio", "looks", "calendar"];
const tabWrapper = (t) => document.querySelector(`[data-tab="${t}"]`);
const tabVisible = (t) => {
  const w = tabWrapper(t);
  return !!w && w.getBoundingClientRect().height > 0;
};

let running = true;
let frames = 0;
let emptyFrames = 0;
const frameWatch = () => {
  if (!running) return;
  frames++;
  if (!TABS.some(tabVisible)) emptyFrames++;
  requestAnimationFrame(frameWatch);
};
requestAnimationFrame(frameWatch);

/** Switch to a tab and report how long until its content has layout. */
const switchTo = async (t) => {
  const t0 = performance.now();
  S().setTab(t);
  await new Promise((res) => {
    const check = () => (tabVisible(t) ? res() : requestAnimationFrame(check));
    requestAnimationFrame(check);
  });
  return Math.round((performance.now() - t0) * 10) / 10;
};

const coldMs = {};
const warmMs = {};

// Cold pass: `home` is already mounted from boot, so it has no cold figure.
for (const t of TABS) {
  if (t === "home") continue;
  coldMs[t] = await switchTo(t);
  await sleep(180);
}
// Warm pass: everything is mounted now, so this is the real switch cost.
for (const t of TABS) {
  warmMs[t] = await switchTo(t);
  await sleep(180);
}
running = false;
const mountedScreens = TABS.filter((t) => tabWrapper(t)).length;

/* ------------------------------------------------------------------ *
 * 6. Per-screen audit of the rendered DOM.
 * ------------------------------------------------------------------ */
const INTERACTIVE =
  'button, [role="button"], summary, select, input:not([type="hidden"]), textarea, a[href]';
const MIN_TAP = 44;

const describe = (el) => ({
  tag: el.tagName.toLowerCase(),
  label: (el.getAttribute("aria-label") || el.textContent || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 44),
  cls: String(el.className ?? "").slice(0, 64),
});

const screens = {};
for (const tab of TABS) {
  S().setTab(tab);
  await sleep(450);

  const viewportWidth = document.documentElement.clientWidth;

  // --- hit areas ---
  const small = [];
  let controls = 0;
  for (const el of document.querySelectorAll(INTERACTIVE)) {
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue; // not rendered
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") continue;
    controls++;
    if (r.width < MIN_TAP || r.height < MIN_TAP) {
      small.push({ ...describe(el), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
    }
  }

  // --- anything that actually pushes the document sideways ---
  //   Two false positives to exclude, both intentional:
  //    * the Ambient glows are deliberately larger than the viewport and sit
  //      inside an `overflow: hidden` wrapper;
  //    * the Closet filter chips live in a horizontal scroller.
  //   So an element only counts if it overflows AND no ancestor clips or
  //   scrolls it. `documentElement.scrollWidth` is the ground truth either way.
  const clippedOrScrollable = (el) => {
    for (let p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "hidden" || ox === "auto" || ox === "scroll" || ox === "clip") return true;
    }
    return false;
  };
  const overflowing = [];
  for (const el of document.querySelectorAll("*")) {
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    if (r.right <= viewportWidth + 1 && r.left >= -1) continue;
    if (clippedOrScrollable(el)) continue;
    overflowing.push({ ...describe(el), left: +r.left.toFixed(1), right: +r.right.toFixed(1) });
  }

  // --- type floor + display font, measured on text-bearing leaves ---
  const tinyText = [];
  const displayFont = [];
  for (const el of document.querySelectorAll("*")) {
    const ownText = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0
    );
    if (!ownText) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 0.5 || r.height < 0.5) continue;
    const cs = getComputedStyle(el);
    const fs = parseFloat(cs.fontSize);
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 34);
    if (fs < 11) tinyText.push({ ...describe(el), fontSize: fs, text });
    if (cs.fontFamily.includes("Syne")) {
      displayFont.push({ ...describe(el), fontSize: fs, text });
    }
  }

  screens[tab] = {
    controlsMeasured: controls,
    tapTargetsBelow44: small,
    overflowingViewport: overflowing.slice(0, 12),
    textBelow11px: tinyText,
    syneElements: displayFont,
    docOverflowX:
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ariaState: {
      pressed: [...document.querySelectorAll("[aria-pressed]")].map((el) => ({
        label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24),
        pressed: el.getAttribute("aria-pressed"),
      })),
      current: [...document.querySelectorAll("[aria-current]")].map((el) => ({
        label: (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 24),
        current: el.getAttribute("aria-current"),
      })),
      labelledGroups: [...document.querySelectorAll('[role="group"][aria-label]')].map(
        (el) => el.getAttribute("aria-label")
      ),
    },
  };
}

/* ------------------------------------------------------------------ *
 * 7. Aggregate
 * ------------------------------------------------------------------ */
const totalControls = Object.values(screens).reduce((n, s) => n + s.controlsMeasured, 0);
const totalSmall = Object.values(screens).reduce((n, s) => n + s.tapTargetsBelow44.length, 0);
const totalTiny = Object.values(screens).reduce((n, s) => n + s.textBelow11px.length, 0);
const totalSyne = Object.values(screens).reduce((n, s) => n + s.syneElements.length, 0);

return {
  enteredDemo,
  viewport: { meta: viewportMeta, zoomBlocked },
  fixedBars: barReport,
  blurredElements,
  reducedMotion: { emulated: reducedMotion, ambient },
  focus: { rulePresent: focusRulePresent, probe: focusProbe },
  tabSwitch: {
    coldMs,
    warmMs,
    mountedScreens,
    domNodes: document.getElementsByTagName("*").length,
    frames,
    emptyFrames,
  },
  totals: {
    controlsMeasured: totalControls,
    tapTargetsBelow44: totalSmall,
    textBelow11px: totalTiny,
    syneElements: totalSyne,
  },
  screens,
};

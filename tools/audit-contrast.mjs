/**
 * WCAG contrast audit for the Flowie theme tokens.
 *
 * Reads the token values straight out of `src/index.css` — light from `:root`,
 * dark from `.dark` — so the numbers cannot drift from the source of truth.
 * Nothing is hardcoded except which pairs the app actually renders, and each of
 * those names the file it comes from.
 *
 * Usage:  node tools/audit-contrast.mjs [--verbose]
 * Exit:   0 = every pair meets its target, 1 = at least one does not.
 *
 * Targets (WCAG 2.1): 4.5:1 for normal text, 3:1 for large text and for
 * non-text boundaries. Every text pair below is rendered at 11-14px, i.e. none
 * of them qualify as large text, so they are all held to 4.5:1.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(resolve(ROOT, "src/index.css"), "utf8");

/**
 * Pull `--token: value;` declarations out of the theme block for `selector`.
 *
 * Matching on a bare `indexOf(selector)` is not safe here: `.dark` also appears
 * in the `@custom-variant dark (&:where(.dark, .dark *));` line at the top of
 * the file, so a substring search silently parses `:root` a second time and
 * reports the light theme twice. Blocks are matched by selector instead, and
 * the theme blocks are identified by carrying `--bg`.
 */
function themeTokens(selector) {
  const re = /([^{}]*)\{([^{}]*)\}/g;
  for (const m of css.matchAll(re)) {
    // The captured selector carries everything since the previous block —
    // comments, blank lines, at-rules — so strip comments and take the last
    // non-empty line, which is the actual selector.
    const sel = m[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (sel !== selector) continue;
    const body = m[2];
    if (!/--bg\s*:/.test(body)) continue;
    const out = {};
    for (const d of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      out[d[1]] = d[2].trim();
    }
    return out;
  }
  throw new Error(`could not find the theme block for "${selector}" in src/index.css`);
}

const THEMES = {
  light: themeTokens(":root"),
  dark: themeTokens(".dark"),
};

/* ---------------- colour maths ---------------- */
const parse = (c) => {
  const v = c.trim();
  if (v.startsWith("#")) {
    const s = v.slice(1);
    const h = s.length === 3 ? s.split("").map((x) => x + x).join("") : s;
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const m = v.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`unsupported colour: ${v}`);
  const p = m[1].split(/[,\s/]+/).filter(Boolean).map(Number);
  return [p[0], p[1], p[2], p[3] ?? 1];
};
const toHex = (rgb) =>
  "#" + rgb.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** Source-over composite of a possibly-translucent colour onto an opaque one. */
const over = (top, bottom) => {
  const [tr, tg, tb, ta] = parse(top);
  const [br, bg, bb] = parse(bottom);
  return [
    tr * ta + br * (1 - ta),
    tg * ta + bg * (1 - ta),
    tb * ta + bb * (1 - ta),
    1,
  ];
};
const luminance = (rgb) => {
  const [r, g, b] = rgb.slice(0, 3).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/**
 * `fg` and `bg` are token names. A background written as `"soft>solid"` means
 * the translucent `--soft` token composited over the opaque `--solid` one —
 * which is what a badge actually sits on.
 */
const PAIRS = [
  // text on the page background
  ["body text", "ink", "bg", 4.5],
  ["body text on card", "ink", "surface-solid", 4.5],
  ["body text on bg-deep", "ink", "bg-deep", 4.5],
  ["body text on board-1", "ink", "board-1", 4.5],
  ["body text on board-2", "ink", "board-2", 4.5],
  // secondary text
  ["secondary text", "muted", "bg", 4.5],
  ["secondary text on card", "muted", "surface-solid", 4.5],
  ["secondary text on bg-deep", "muted", "bg-deep", 4.5],
  ["secondary text on board-1", "muted", "board-1", 4.5],
  ["secondary text on board-2", "muted", "board-2", 4.5],
  // accent text (GarmentPhoto / JobBanner / nav / badges)
  ["accent text on bg", "acc", "bg", 4.5],
  ["accent text on card", "acc", "surface-solid", 4.5],
  ["accent text on board-1", "acc", "board-1", 4.5],
  ["accent text on board-2", "acc", "board-2", 4.5],
  ["accent text on acc-soft/card", "acc", "acc-soft>surface-solid", 4.5],
  ["accent text on acc-soft/bg", "acc", "acc-soft>bg", 4.5],
  ["button label on accent fill", "acc-ink", "acc", 4.5],
  // amber (offline / warm states)
  ["amber text on bg", "amber", "bg", 4.5],
  ["amber text on board-2", "amber", "board-2", 4.5],
  ["amber text on amber-soft/bg", "amber", "amber-soft>bg", 4.5],
  ["amber text on amber-soft/card", "amber", "amber-soft>surface-solid", 4.5],
  // cool (rain states)
  ["cool text on bg", "cool", "bg", 4.5],
  ["cool text on board-2", "cool", "board-2", 4.5],
  ["cool text on cool-soft/bg", "cool", "cool-soft>bg", 4.5],
  // danger (error states)
  ["danger text on bg", "danger", "bg", 4.5],
  ["danger text on board-2", "danger", "board-2", 4.5],
  ["danger text on danger-soft/bg", "danger", "danger-soft>bg", 4.5],
  ["danger text on danger-soft/card", "danger", "danger-soft>surface-solid", 4.5],
  // non-text boundaries
  ["card border vs card", "line-strong", "surface-solid", 3],
  ["card border vs bg", "line-strong", "bg", 3],
];

const resolveColor = (t, name) => {
  const [a, b] = name.split(">");
  if (!b) return parse(t[a]);
  return over(t[a], t[b]);
};

let failures = 0;
for (const [themeName, t] of Object.entries(THEMES)) {
  console.log(`\n===== ${themeName.toUpperCase()} =====`);
  for (const [label, fg, bg, need] of PAIRS) {
    const r = ratio(resolveColor(t, fg), resolveColor(t, bg));
    const ok = r >= need;
    if (!ok) failures++;
    console.log(
      `${r.toFixed(2).padStart(6)}:1  need ${need}  ${ok ? "pass" : "FAIL"}  ${label}`
    );
  }
}
console.log(
  `\n${failures} of ${PAIRS.length * Object.keys(THEMES).length} pairs below target`
);
process.exit(failures ? 1 : 0);

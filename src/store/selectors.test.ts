/**
 * @vitest-environment jsdom
 *
 * Phase 6 — the Phase 3 render-cost rule, as a machine-checked invariant.
 *
 * Verification matrix row 5 is "no whole-array garment subscriptions". That is
 * a property of the SOURCE, and the failure mode is silent: re-introducing
 * `useAppStore((s) => s.garments)` in one screen compiles, typechecks, passes
 * every other test, and only shows up as a re-render storm on a real device with
 * a recon batch in flight. So it gets a test that reads the source.
 *
 * Three rules, all of them the module doc-comment in `selectors.ts` restated as
 * an assertion:
 *   1. nothing subscribes to a whole collection;
 *   2. nothing returns a freshly-built array/object from a selector without a
 *      comparator (`useShallow`);
 *   3. the per-tile components stay memoised — a new element reference for an
 *      untouched garment only costs a render if the tile is not memoised.
 *
 * Plus one runtime check of the invariant those rules exist to protect:
 * patching one garment must not hand every other garment a new identity.
 *
 * The comment stripper is deliberately crude (regex, not a parser). It only has
 * to be good enough to stop this file from flagging its own subject matter — the
 * doc comments in `selectors.ts` quote the anti-pattern on purpose.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { flushPendingWrites, useAppStore } from "./appStore";

/* ------------------------------ source access ---------------------------- */

const SRC_DIR = join(process.cwd(), "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const FILES = walk(SRC_DIR).map((path) => ({
  path,
  rel: relative(SRC_DIR, path).split("\\").join("/"),
  raw: readFileSync(path, "utf8"),
}));

/** Strip block and line comments so quoted anti-patterns are not "found". */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** Extract the argument text of every `callee(` call in `src`. */
function callArgs(src: string, callee: string): string[] {
  const out: string[] = [];
  let idx = src.indexOf(callee);
  while (idx !== -1) {
    let i = idx + callee.length;
    while (i < src.length && src[i] !== "(") i++;
    const start = i;
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    out.push(src.slice(start + 1, i));
    idx = src.indexOf(callee, i);
  }
  return out;
}

const COLLECTIONS = "(garments|looks|schedules)";
/** `useAppStore((s) => s.garments)` and friends — the RC-2 anti-pattern. */
const BARE_COLLECTION = new RegExp(
  `^\\s*\\(?\\s*\\w+\\s*\\)?\\s*=>\\s*s\\.${COLLECTIONS}\\s*$`
);
/** Anything that builds a new array/object on every call. */
const BUILDS_A_CONTAINER = /\.(map|filter|slice|sort|flatMap)\(|new (Set|Map|Array)\(/;

describe("rule 1 — nothing subscribes to a whole collection", () => {
  it("no useAppStore selector returns s.garments / s.looks / s.schedules directly", () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const code = stripComments(file.raw);
      for (const arg of callArgs(code, "useAppStore")) {
        if (BARE_COLLECTION.test(arg)) offenders.push(`${file.rel}: useAppStore(${arg.trim()})`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("has call sites to check at all (the scan is not vacuous)", () => {
    const total = FILES.reduce(
      (n, f) => n + callArgs(stripComments(f.raw), "useAppStore").length,
      0
    );
    // If a refactor moved every subscription behind a hook in another shape,
    // the rule above would pass by finding nothing. Pin a floor instead.
    expect(total).toBeGreaterThan(20);
  });
});

describe("rule 2 — a derived container always gets a comparator", () => {
  it("every selector that builds an array/object wraps it in useShallow", () => {
    const offenders: string[] = [];

    for (const file of FILES) {
      const code = stripComments(file.raw);
      for (const arg of callArgs(code, "useAppStore")) {
        const trimmed = arg.trim();
        if (!BUILDS_A_CONTAINER.test(trimmed)) continue;
        if (trimmed.startsWith("useShallow(")) continue;
        offenders.push(`${file.rel}: useAppStore(${trimmed.slice(0, 60)}…)`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("selectors.ts actually uses the library comparator, not a hand-rolled one", () => {
    const selectors = FILES.find((f) => f.rel === "store/selectors.ts");
    expect(selectors).toBeDefined();

    const code = stripComments(selectors!.raw);
    expect(code).toContain('from "zustand/react/shallow"');
    expect(callArgs(code, "useShallow").length).toBeGreaterThanOrEqual(8);
  });
});

describe("rule 3 — the per-tile components stay memoised", () => {
  it("GarmentCard is wrapped in memo", () => {
    const card = FILES.find((f) => f.rel === "components/GarmentCard.tsx");
    expect(card).toBeDefined();

    const code = stripComments(card!.raw);
    expect(code).toMatch(/\bmemo\(/);
    // The export must BE the memoised component, not a bare function with an
    // unused `memo` import left behind.
    expect(code).toMatch(/export\s+default\s+memo\(/);
  });
});

describe("runtime — a one-garment patch keeps every other identity", () => {
  function garment(id: string) {
    return {
      id,
      name: id,
      color: "black",
      colors: ["black"],
      pattern: "solid" as const,
      createdAt: 1,
      // No photo: `setGarmentPrint` kicks a recon job when one exists, and a
      // unit test must not reach the network.
    };
  }

  beforeEach(() => {
    flushPendingWrites();
    useAppStore.setState({ garments: [garment("g-1"), garment("g-2"), garment("g-3")] as never });
    flushPendingWrites();
  });

  it("gives the patched garment a new object and leaves the rest referentially identical", () => {
    const before = useAppStore.getState().garments;

    useAppStore.getState().setGarmentPrint("g-2", true);

    const after = useAppStore.getState().garments;

    expect(after[1]).not.toBe(before[1]);
    expect(after[1].hasPrint).toBe(true);
    // The shallow comparator in `useGarments` compares element references, so
    // these two staying identical is exactly what stops the grid re-rendering.
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  it("still produces a new array reference, so a real change is not swallowed", () => {
    const before = useAppStore.getState().garments;

    useAppStore.getState().setGarmentPrint("g-2", true);

    expect(useAppStore.getState().garments).not.toBe(before);
  });
});

/**
 * @vitest-environment jsdom
 *
 * Print-hint contract tests (accuracy track A2).
 *
 * The hint exists because the klein detail spike (spec §9) proved the hybrid
 * router right AND exposed its gap: a printed garment the wearer never
 * manually flagged loses its detail through TryOffDiff. Gemini now reads
 * "does this carry a logo/graphic/text?" on every tagging call — but the
 * read is a HINT, never a decision:
 *
 *   1. `parsePrintHint` must be strict — a hallucinated boolean must not be
 *      able to masquerade as a confident one.
 *   2. `taggingToGarment` must write the wearer-set `hasPrint` flag ONLY
 *      from an explicit wearer confirmation, never from the hint itself —
 *      the detail renderer measurably invents detail on plain garments.
 *   3. The heuristic fallback must stay silent (no opinion), because the
 *      pixel path cannot see a small logo on a solid fabric.
 */
import { describe, expect, it } from "vitest";
import {
  parsePrintHint,
  tagGarmentHeuristic,
  taggingToGarment,
  type TaggingResult,
} from "./aiStylistService";

const BASE_TAGS: TaggingResult = {
  name: "Guess shorts",
  category: "bottom",
  colors: ["#3A4A63"],
  pattern: "solid",
  colorFamily: "cool",
  warmth: 2,
  formality: 1,
  tags: [],
  confidence: 0.85,
};

describe("parsePrintHint", () => {
  it("accepts real booleans", () => {
    expect(parsePrintHint(true)).toBe(true);
    expect(parsePrintHint(false)).toBe(false);
  });

  it("treats anything else as no opinion", () => {
    expect(parsePrintHint(undefined)).toBeUndefined();
    expect(parsePrintHint(null)).toBeUndefined();
    expect(parsePrintHint("true")).toBeUndefined();
    expect(parsePrintHint(1)).toBeUndefined();
    expect(parsePrintHint({})).toBeUndefined();
  });
});

describe("taggingToGarment — hasPrint is wearer-set, never model-set", () => {
  it("writes the flag only when the wearer confirmed", () => {
    const g = taggingToGarment({ ...BASE_TAGS, printHint: true }, undefined, undefined, true);
    expect(g.hasPrint).toBe(true);
  });

  it("ignores the hint itself, even a confident true", () => {
    const g = taggingToGarment({ ...BASE_TAGS, printHint: true });
    expect(g.hasPrint).toBeUndefined();
  });

  it("leaves the flag unset when the wearer declined", () => {
    const g = taggingToGarment({ ...BASE_TAGS, printHint: true }, undefined, undefined, false);
    expect(g.hasPrint).toBeUndefined();
  });

  it("keeps the rest of the mapping intact alongside the new argument", () => {
    const g = taggingToGarment(BASE_TAGS, "data:image/jpeg;base64,AA", "sha256-abc", true);
    expect(g.name).toBe("Guess shorts");
    expect(g.photo).toBe("data:image/jpeg;base64,AA");
    expect(g.photoSha256).toBe("sha256-abc");
    expect(g.hasPrint).toBe(true);
  });
});

describe("tagGarmentHeuristic — stays silent on prints", () => {
  it("returns no print opinion without a photo to sample", async () => {
    const t = await tagGarmentHeuristic(new File(["x"], "hoodie.jpg", { type: "image/jpeg" }));
    expect(t.printHint).toBeUndefined();
  });
});

/**
 * Pure pattern-detection core: photo pixels in, pattern classification out.
 *
 * Kept dependency-free (no canvas, no DOM) so it runs identically in the
 * browser tagger and in node-based verification harnesses.
 *
 * Taxonomy is deliberately limited to what pixels can honestly distinguish:
 *  - "solid":      one dominant color (shading/folds stay solid)
 *  - "striped":    two significant colors with strong ONE-axis structure
 *  - "colorblock": two/three large regions without directional striping
 *  - "other":      busy/mottled/print-like (plaid, floral, graphic, dots…)
 *
 * Anything mottled that isn't directional striping or clean blocking lands
 * in "other" rather than guessing a print type pixels can't prove.
 */

export type PatternKind = "solid" | "striped" | "colorblock" | "other";

export interface PixelSample {
  r: number;
  g: number;
  b: number;
  /** normalized position inside the garment bounding box, 0..1 */
  x: number;
  y: number;
}

export interface PatternAnalysis {
  pattern: PatternKind;
  /** merged color bins, most prominent first */
  colors: Array<{ r: number; g: number; b: number; share: number }>;
}

/* Tunables — named so tests can reason about them. */
const BIN_SIZE = 28;
const MERGE_DIST = 34;
const SOLID_SHARE = 0.9; // top color owns this much → unambiguously solid
const RUNNER_MIN_SHARE = 0.18; // runner-up must matter to be a pattern
const DISTINCT_DIST = 38; // runner-up must look different from dominant
const BUSY_MIN_SHARE = 0.08; // each extra distinct color for a busy print
const THIRD_MIN_SHARE = 0.12; // third color weight for a 3-way colorblock
const AXIS_RATIO = 2.0; // one axis must dominate this much → striped
const MIN_SPATIAL_VAR = 60; // below this, variation is noise, not structure
const MIN_CROSSINGS = 3; // dominant axis must alternate this often → striped
const BLOCK_DIST = 70; // two-tone pair must differ this much → colorblock

type RGB = { r: number; g: number; b: number };

const dist = (a: RGB, b: RGB) =>
  Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);

export function rgbToHex(c: RGB): string {
  const t = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, "0");
  return `#${t(c.r)}${t(c.g)}${t(c.b)}`;
}

/** Quantize samples into averaged color bins, most prominent first. */
export function quantize(samples: PixelSample[]): Array<RGB & { count: number }> {
  const bins = new Map<string, RGB & { count: number }>();
  for (const s of samples) {
    const key = `${Math.floor(s.r / BIN_SIZE)},${Math.floor(s.g / BIN_SIZE)},${Math.floor(s.b / BIN_SIZE)}`;
    const hit = bins.get(key);
    if (hit) {
      hit.r += s.r;
      hit.g += s.g;
      hit.b += s.b;
      hit.count += 1;
    } else {
      bins.set(key, { r: s.r, g: s.g, b: s.b, count: 1 });
    }
  }
  const out = Array.from(bins.values()).map((v) => ({
    r: v.r / v.count,
    g: v.g / v.count,
    b: v.b / v.count,
    count: v.count,
  }));
  out.sort((a, b) => b.count - a.count);

  // Merge near-duplicate bins: anti-aliasing, shadow and highlight drift
  // around a single true garment color must not read as extra colors.
  const merged: typeof out = [];
  for (const bin of out) {
    const target = merged.find((m) => dist(m, bin) < MERGE_DIST);
    if (target) {
      const total = target.count + bin.count;
      target.r = (target.r * target.count + bin.r * bin.count) / total;
      target.g = (target.g * target.count + bin.g * bin.count) / total;
      target.b = (target.b * target.count + bin.b * bin.count) / total;
      target.count = total;
    } else {
      merged.push({ ...bin });
    }
  }
  merged.sort((a, b) => b.count - a.count);
  return merged;
}

interface AxisStats {
  rowVar: number;
  colVar: number;
  /** mean-crossings per axis: how often the band profile alternates */
  rowCross: number;
  colCross: number;
}

/**
 * Downscaling + JPEG compression blend neighboring colors, leaving
 * transition pixels (e.g. pink between red and white stripes) with real
 * weight. Such a tone sits almost exactly ON the segment between the two
 * true colors — detect that and fold its share into the nearer endpoint so
 * edge blur can't invent a third/fourth "print color".
 */
export function foldBlendArtifacts<T extends RGB & { share: number }>(
  colors: T[],
  maxDist = 25
): T[] {
  if (colors.length < 3) return colors;
  const [first, ...rest] = colors;
  // Farthest significant color from the dominant one anchors the segment.
  let anchor: T | null = null;
  for (const c of rest) {
    if (c.share < BUSY_MIN_SHARE || dist(c, first) <= DISTINCT_DIST) continue;
    if (!anchor || dist(c, first) > dist(anchor, first)) anchor = c;
  }
  if (!anchor) return colors;
  const d = { r: anchor.r - first.r, g: anchor.g - first.g, b: anchor.b - first.b };
  const len2 = d.r ** 2 + d.g ** 2 + d.b ** 2;
  if (len2 === 0) return colors;

  const folded = new Map<T, number>();
  const kept: T[] = [first, anchor];
  for (const c of rest) {
    if (c === anchor) continue;
    const v = { r: c.r - first.r, g: c.g - first.g, b: c.b - first.b };
    const t = (v.r * d.r + v.g * d.g + v.b * d.b) / len2;
    if (t <= 0 || t >= 1) {
      kept.push(c);
      continue;
    }
    const onSeg = { r: first.r + t * d.r, g: first.g + t * d.g, b: first.b + t * d.b };
    if (dist(c, onSeg) > maxDist) {
      kept.push(c);
      continue;
    }
    // Blend artifact — fold into the nearer endpoint.
    const target = t < 0.5 ? first : anchor;
    folded.set(target, (folded.get(target) ?? target.share) + c.share);
  }
  const out = kept.map((c) => {
    const extra = folded.get(c);
    return extra !== undefined ? { ...c, share: extra } : c;
  });
  out.sort((a, b) => b.share - a.share);
  return out;
}

const lum = (c: RGB) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;

/**
 * How often a 1-D luminance profile alternates around its own mean.
 * Repeating stripes cross many times; a shadow gradient or a two-tone
 * split crosses once. This is the periodicity proxy that keeps shading
 * and colorblocking out of the striped bucket.
 */
export function meanCrossings(profile: number[]): number {
  if (profile.length < 3) return 0;
  const mean = profile.reduce((a, v) => a + v, 0) / profile.length;
  const side = (v: number) => (v > mean + 4 ? 1 : v < mean - 4 ? -1 : 0);
  let cross = 0;
  let prev = side(profile[0]);
  for (let i = 1; i < profile.length; i++) {
    const s = side(profile[i]);
    if (s !== 0 && prev !== 0 && s !== prev) cross++;
    if (s !== 0) prev = s;
  }
  return cross;
}

/**
 * Directional structure: mean garment color per grid row / column, then how
 * much those means vary, plus alternation counts. Stripes vary strongly
 * along ONE axis AND alternate repeatedly; mottled prints vary along both;
 * shading gradients cross the mean once.
 */
export function axisStats(samples: PixelSample[], cells = 12): AxisStats {
  const rows: Array<RGB & { n: number }> = Array.from({ length: cells }, () => ({
    r: 0, g: 0, b: 0, n: 0,
  }));
  const cols: Array<RGB & { n: number }> = Array.from({ length: cells }, () => ({
    r: 0, g: 0, b: 0, n: 0,
  }));
  for (const s of samples) {
    const ri = Math.min(cells - 1, Math.max(0, Math.floor(s.y * cells)));
    const ci = Math.min(cells - 1, Math.max(0, Math.floor(s.x * cells)));
    const row = rows[ri];
    row.r += s.r; row.g += s.g; row.b += s.b; row.n += 1;
    const col = cols[ci];
    col.r += s.r; col.g += s.g; col.b += s.b; col.n += 1;
  }
  const profile = (bands: Array<RGB & { n: number }>) =>
    bands
      .filter((band) => band.n > 0)
      .map((band) => ({ r: band.r / band.n, g: band.g / band.n, b: band.b / band.n }));
  const analyze = (bands: Array<RGB & { n: number }>) => {
    const means = profile(bands);
    if (means.length < 2) return { variance: 0, cross: 0 };
    const avg = {
      r: means.reduce((a, m) => a + m.r, 0) / means.length,
      g: means.reduce((a, m) => a + m.g, 0) / means.length,
      b: means.reduce((a, m) => a + m.b, 0) / means.length,
    };
    return {
      variance: means.reduce((a, m) => a + dist(m, avg) ** 2, 0) / means.length,
      cross: meanCrossings(means.map(lum)),
    };
  };
  const row = analyze(rows);
  const col = analyze(cols);
  return { rowVar: row.variance, colVar: col.variance, rowCross: row.cross, colCross: col.cross };
}

export function detectPattern(samples: PixelSample[]): PatternAnalysis {
  const empty: PatternAnalysis = {
    pattern: "solid",
    colors: [{ r: 107, g: 114, b: 128, share: 1 }],
  };
  if (samples.length === 0) return empty;

  const merged = quantize(samples);
  const total = merged.reduce((a, b) => a + b.count, 0);
  let colors = merged.slice(0, 3).map((m) => ({
    r: m.r,
    g: m.g,
    b: m.b,
    share: m.count / total,
  }));
  // One color owns the garment outright → solid, no questions asked.
  if (colors.length < 2 || colors[0].share >= SOLID_SHARE) {
    return { pattern: "solid", colors };
  }

  // Fold compression/resize transition tones back into the true colors
  // they blend (pink edges between red and white stripes must not invent
  // extra "print colors").
  colors = foldBlendArtifacts(colors);
  const [f1, f2, f3] = colors;

  // True three-way colorblock: three even, distinct regions.
  if (
    f2 && f3 &&
    f2.share >= 0.25 && f3.share >= THIRD_MIN_SHARE && f1.share <= 0.6 &&
    dist(f2, f1) > DISTINCT_DIST && dist(f3, f1) > DISTINCT_DIST
  ) {
    return { pattern: "colorblock", colors };
  }

  // Busy print check: several distinct colors in real weight means a
  // graphic/floral/confetti-type print even when no pair dominates. This is
  // what keeps multicolor prints out of the solid bucket.
  const extras = colors
    .slice(1)
    .filter((c) => c.share >= BUSY_MIN_SHARE && dist(c, colors[0]) > DISTINCT_DIST);
  if (extras.length >= 2) {
    return { pattern: "other", colors };
  }

  const runnerMatters =
    colors[1] && colors[1].share >= RUNNER_MIN_SHARE && dist(colors[0], colors[1]) > DISTINCT_DIST;
  if (!runnerMatters) {
    // Runner-up is shading, fold shadow or texture noise → solid.
    return { pattern: "solid", colors };
  }

  const { rowVar, colVar, rowCross, colCross } = axisStats(samples);
  const strong = Math.max(rowVar, colVar);
  const weak = Math.min(rowVar, colVar);

  // Repeating structure on BOTH axes (plaid, gingham, small all-over
  // motifs) is a print, not striping — even though it varies strongly.
  if (rowCross >= MIN_CROSSINGS && colCross >= MIN_CROSSINGS) {
    return { pattern: "other", colors };
  }

  // Genuinely directional, repeating color change → stripes. A plain shirt
  // with a shadow across it crosses the mean once and never alternates;
  // real stripes alternate many times along exactly one axis.
  const dominantCross = Math.max(rowCross, colCross);
  if (
    dominantCross >= MIN_CROSSINGS &&
    strong >= MIN_SPATIAL_VAR &&
    strong / Math.max(weak, 1) >= AXIS_RATIO
  ) {
    return { pattern: "striped", colors };
  }

  // No directional structure. Two clean colors in big regions → colorblock.
  // A two-tone pair that isn't strongly distinct (heather, marl, wash
  // fade) is "other". (Even three-way blocks were already handled above.)
  const g1 = colors[0];
  const g2 = colors[1];
  const g3 = colors[2];
  const significant = colors.filter(
    (c, i) => i === 0 || (c.share >= RUNNER_MIN_SHARE && dist(c, g1) > DISTINCT_DIST)
  );
  if (significant.length <= 2 && (!g3 || g3.share < THIRD_MIN_SHARE)) {
    return dist(g1, g2) > BLOCK_DIST
      ? { pattern: "colorblock", colors }
      : { pattern: "other", colors };
  }
  return { pattern: "other", colors };
}

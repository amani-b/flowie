/**
 * Deterministic segmentation prototype — "StudioCut" v3.
 *
 * Pure pixel maths: no model weights, no network, no keys, no WASM. Written in
 * Node/sharp purely to tune the algorithm against real photos; the core uses
 * flat typed arrays and plain arithmetic so it ports 1:1 to Canvas2D.
 *
 * v3 structure (what v1/v2 got wrong is noted inline):
 *   1. background colour model from the frame border, kept only when a colour
 *      recurs in several SEPARATED border arcs (a table shows on three sides;
 *      a sleeve touching one edge does not)
 *   2. foreground colour model from interior pixels that are textured (fabric)
 *      or far from every background colour — so a smooth lit table inside the
 *      centre box cannot poison it
 *   3. `s` = colour score in [0,1], fused with a texture term
 *   4. DEFINITE background = flood from the border that may only step onto
 *      pixels that are both background-coloured and not a strong edge.
 *      This is the fix for v1/v2: interior background-coloured pixels (the
 *      black zip of a grey hoodie) are never seeded, because they cannot be
 *      reached from the frame without crossing the garment boundary.
 *   5. DEFINITE foreground = strongly foreground-coloured pixels that the
 *      background flood never reached
 *   6. final alpha = edge-weighted geodesic race between those two seed sets,
 *      so the frontier snaps onto real image edges
 *   7. cleanup: close, largest component, hole fill, erode, feather
 *
 * Usage: node scripts/seg-cut.mjs [stem ...] [--side=384] [--debug]
 */
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { alphaMetrics, fmtMetrics, studioComposite } from "./lib/seg-metrics.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const outDir = join(root, "out", "seg-cut");
mkdirSync(outDir, { recursive: true });

const argv = process.argv.slice(2);
const DEBUG = argv.includes("--debug");
const sideArg = argv.find((a) => a.startsWith("--side="));
const SIDE = sideArg ? parseInt(sideArg.slice(7), 10) : 384;
const stems = argv.filter((a) => !a.startsWith("--"));
if (stems.length === 0) {
  stems.push(
    "photo_1_2026-09-08_10-59-52",
    "photo_2_2026-09-08_10-59-52",
    "photo_3_2026-09-08_10-59-52"
  );
}

/* ============================== primitives ============================= */

function kmeans(samples, k, iters = 8) {
  const n = samples.length;
  if (n === 0) return [];
  const K = Math.min(k, n);
  const cent = [samples[0].slice()];
  while (cent.length < K) {
    let bestI = 0;
    let bestD = -1;
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      let d = Infinity;
      for (const c of cent) {
        const dr = s[0] - c[0];
        const dg = s[1] - c[1];
        const db = s[2] - c[2];
        const dd = dr * dr + dg * dg + db * db;
        if (dd < d) d = dd;
      }
      if (d > bestD) { bestD = d; bestI = i; }
    }
    cent.push(samples[bestI].slice());
  }
  const assign = new Int32Array(n);
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      const s = samples[i];
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < K; c++) {
        const e = cent[c];
        const dr = s[0] - e[0];
        const dg = s[1] - e[1];
        const db = s[2] - e[2];
        const dd = dr * dr + dg * dg + db * db;
        if (dd < bd) { bd = dd; best = c; }
      }
      assign[i] = best;
    }
    const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const a = assign[i];
      const s = samples[i];
      sum[a][0] += s[0]; sum[a][1] += s[1]; sum[a][2] += s[2]; sum[a][3]++;
    }
    for (let c = 0; c < K; c++)
      if (sum[c][3] > 0) {
        cent[c][0] = sum[c][0] / sum[c][3];
        cent[c][1] = sum[c][1] / sum[c][3];
        cent[c][2] = sum[c][2] / sum[c][3];
      }
  }
  return cent;
}

const CHROMA_W = 1.6e6;
function distToPal(px, ch, o, pal) {
  const pi = o * ch;
  const r = px[pi];
  const g = px[pi + 1];
  const b = px[pi + 2];
  const s = r + g + b;
  const cr = s > 0 ? r / s : 1 / 3;
  const cb = s > 0 ? b / s : 1 / 3;
  let best = Infinity;
  for (let k = 0; k < pal.length; k++) {
    const e = pal[k];
    const dr = r - e[0];
    const dg = g - e[1];
    const db = b - e[2];
    const es = e[0] + e[1] + e[2];
    const er = es > 0 ? e[0] / es : 1 / 3;
    const eb = es > 0 ? e[2] / es : 1 / 3;
    const dcr = cr - er;
    const dcb = cb - eb;
    const d = dr * dr + dg * dg + db * db + CHROMA_W * (dcr * dcr + dcb * dcb);
    if (d < best) best = d;
  }
  return best;
}

function sobelBlur(luma, w, h) {
  const N = w * h;
  const blur = new Float32Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          s += luma[Math.max(0, Math.min(h - 1, y + dy)) * w + Math.max(0, Math.min(w - 1, x + dx))];
      blur[y * w + x] = s / 9;
    }
  const at = (x, y) => blur[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
  const mag = new Float32Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  return mag;
}

function localStd(luma, w, h, r) {
  const N = w * h;
  const s1 = new Float64Array((w + 1) * (h + 1));
  const s2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let r1 = 0;
    let r2 = 0;
    for (let x = 0; x < w; x++) {
      const v = luma[y * w + x];
      r1 += v;
      r2 += v * v;
      s1[(y + 1) * (w + 1) + x + 1] = s1[y * (w + 1) + x + 1] + r1;
      s2[(y + 1) * (w + 1) + x + 1] = s2[y * (w + 1) + x + 1] + r2;
    }
  }
  const box = (S, x0, y0, x1, y1) =>
    S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
  const out = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const n = (x1 - x0) * (y1 - y0);
      const m = box(s1, x0, y0, x1, y1) / n;
      const m2 = box(s2, x0, y0, x1, y1) / n;
      out[y * w + x] = Math.sqrt(Math.max(0, m2 - m * m));
    }
  }
  return out;
}

function percentile(arr, p) {
  const a = Float32Array.from(arr);
  a.sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];
}

/**
 * Multi-source Dijkstra on a 4-neighbour grid with real-valued entry costs.
 *
 * Uses a binary heap keyed on `dist`. An earlier bucket-queue version wrapped
 * its ring buffer once path distances exceeded the bucket count, silently
 * corrupting every result; a heap has no such ceiling.
 */
function geodesic(seeds, cost, w, h) {
  const N = w * h;
  const dist = new Float32Array(N).fill(Infinity);
  const heap = [];
  const swap = (i, j) => {
    const t = heap[i];
    heap[i] = heap[j];
    heap[j] = t;
  };
  const up = (i) => {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (dist[heap[p]] <= dist[heap[i]]) break;
      swap(p, i);
      i = p;
    }
  };
  const down = (i) => {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && dist[heap[l]] < dist[heap[m]]) m = l;
      if (r < heap.length && dist[heap[r]] < dist[heap[m]]) m = r;
      if (m === i) break;
      swap(m, i);
      i = m;
    }
  };
  const push = (node) => {
    heap.push(node);
    up(heap.length - 1);
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      down(0);
    }
    return top;
  };

  for (const s of seeds) {
    if (dist[s] === 0) continue;
    dist[s] = 0;
    push(s);
  }
  while (heap.length) {
    const o = pop();
    const d = dist[o];
    const x = o % w;
    const y = (o / w) | 0;
    if (x > 0) { const m = o - 1; const nd = d + cost[m]; if (nd < dist[m]) { dist[m] = nd; push(m); } }
    if (x < w - 1) { const m = o + 1; const nd = d + cost[m]; if (nd < dist[m]) { dist[m] = nd; push(m); } }
    if (y > 0) { const m = o - w; const nd = d + cost[m]; if (nd < dist[m]) { dist[m] = nd; push(m); } }
    if (y < h - 1) { const m = o + w; const nd = d + cost[m]; if (nd < dist[m]) { dist[m] = nd; push(m); } }
  }
  return dist;
}

/** Gated BFS flood from `seeds`, stepping only onto pixels where gate=1. */
function gatedFlood(seeds, gate, w, h) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const q = [];
  for (const s of seeds) if (!seen[s] && gate[s]) { seen[s] = 1; q.push(s); }
  let head = 0;
  while (head < q.length) {
    const o = q[head++];
    const x = o % w;
    const y = (o / w) | 0;
    if (x > 0 && !seen[o - 1] && gate[o - 1]) { seen[o - 1] = 1; q.push(o - 1); }
    if (x < w - 1 && !seen[o + 1] && gate[o + 1]) { seen[o + 1] = 1; q.push(o + 1); }
    if (y > 0 && !seen[o - w] && gate[o - w]) { seen[o - w] = 1; q.push(o - w); }
    if (y < h - 1 && !seen[o + w] && gate[o + w]) { seen[o + w] = 1; q.push(o + w); }
  }
  return seen;
}

function largestComponent(mask, w, h, minArea) {
  const N = w * h;
  const comp = new Int32Array(N).fill(-1);
  const stack = [];
  let n = 0;
  const sizes = [];
  for (let i = 0; i < N; i++) {
    if (!mask[i] || comp[i] !== -1) continue;
    let size = 0;
    comp[i] = n;
    stack.push(i);
    while (stack.length) {
      const o = stack.pop();
      size++;
      const x = o % w;
      const y = (o / w) | 0;
      if (x > 0 && mask[o - 1] && comp[o - 1] === -1) { comp[o - 1] = n; stack.push(o - 1); }
      if (x < w - 1 && mask[o + 1] && comp[o + 1] === -1) { comp[o + 1] = n; stack.push(o + 1); }
      if (y > 0 && mask[o - w] && comp[o - w] === -1) { comp[o - w] = n; stack.push(o - w); }
      if (y < h - 1 && mask[o + w] && comp[o + w] === -1) { comp[o + w] = n; stack.push(o + w); }
    }
    sizes.push(size);
    n++;
  }
  let best = -1;
  let bestSize = 0;
  for (let c = 0; c < n; c++) if (sizes[c] > bestSize) { bestSize = sizes[c]; best = c; }
  const out = new Uint8Array(N);
  if (bestSize < minArea) return out;
  for (let i = 0; i < N; i++) if (comp[i] === best) out[i] = 1;
  return out;
}

function fillHoles(mask, w, h) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const q = [];
  const push = (o) => { if (!mask[o] && !seen[o]) { seen[o] = 1; q.push(o); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  let head = 0;
  while (head < q.length) {
    const o = q[head++];
    const x = o % w;
    const y = (o / w) | 0;
    if (x > 0) push(o - 1);
    if (x < w - 1) push(o + 1);
    if (y > 0) push(o - w);
    if (y < h - 1) push(o + w);
  }
  const out = mask.slice();
  for (let i = 0; i < N; i++) if (!seen[i]) out[i] = 1;
  return out;
}

function morph(mask, w, h, isErode) {
  const N = w * h;
  const out = new Uint8Array(N);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (isErode) {
        let v = 1;
        for (let dy = -1; dy <= 1 && v; dy++)
          for (let dx = -1; dx <= 1 && v; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h || !mask[ny * w + nx]) v = 0;
          }
        out[y * w + x] = v;
      } else {
        let v = 0;
        for (let dy = -1; dy <= 1 && !v; dy++)
          for (let dx = -1; dx <= 1 && !v; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) v = 1;
          }
        out[y * w + x] = v;
      }
    }
  return out;
}

/* ============================== the pipeline =========================== */

function segment(px, w, h, ch, opts = {}) {
  const N = w * h;
  const luma = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const o = i * ch;
    luma[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
  }
  const grad = sobelBlur(luma, w, h);
  const tex = localStd(luma, w, h, 3);

  /* --- 1 · background palette: border arcs, keep border-recurrent colours */
  const ARCS = 16;
  const bandW = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  const arcSamples = Array.from({ length: ARCS }, () => []);
  const onBorder = (x, y) => x < bandW || y < bandW || x >= w - bandW || y >= h - bandW;
  const arcOf = (x, y) => {
    let t;
    if (y < bandW) t = (x / w) * 0.25;
    else if (x >= w - bandW) t = 0.25 + (y / h) * 0.25;
    else if (y >= h - bandW) t = 0.5 + (1 - x / w) * 0.25;
    else t = 0.75 + (1 - y / h) * 0.25;
    return Math.min(ARCS - 1, Math.max(0, Math.floor(t * ARCS)));
  };
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      if (!onBorder(x, y)) continue;
      const o = (y * w + x) * ch;
      arcSamples[arcOf(x, y)].push([px[o], px[o + 1], px[o + 2]]);
    }
  const MERGE2 = 30 * 30;
  const bgPal = [];
  for (let a = 0; a < ARCS; a++) {
    const s = arcSamples[a];
    if (s.length < 8) continue;
    for (const c of kmeans(s, 2, 6)) {
      let host = null;
      for (const e of bgPal) {
        const dr = c[0] - e.c[0];
        const dg = c[1] - e.c[1];
        const db = c[2] - e.c[2];
        if (dr * dr + dg * dg + db * db < MERGE2) { host = e; break; }
      }
      if (host) { host.arcs.add(a); host.n += s.length; }
      else bgPal.push({ c, arcs: new Set([a]), n: s.length });
    }
  }
  bgPal.sort((a, b) => b.n - a.n);
  let kept = bgPal.filter((e) => e.arcs.size >= 2);
  if (kept.length < 2) kept = bgPal.slice(0, 4);
  const bgCols = kept.slice(0, 8).map((e) => e.c);

  /* --- 2 · foreground palette: conservative interior seeds ---------------
   * v2 seeded on the centre box alone and the lit table inside that box
   * poisoned the foreground model (fgPal picked up the table colour, after
   * which the table scored as foreground and the whole frame flipped).
   * v4 seeds only on pixels that are BOTH clearly far from every background
   * colour AND textured (fabric), then refines inside a loop that excludes
   * the border-connected background — so the table can never enter. */
  const texMed = percentile(tex, 0.55);
  const cx0 = Math.round(w * 0.15);
  const cx1 = Math.round(w * 0.85);
  const cy0 = Math.round(h * 0.12);
  const cy1 = Math.round(h * 0.9);
  const MIN_DBG = opts.minDbg ?? 6000;
  const seedSamples = (pred) => {
    const out = [];
    for (let y = cy0; y < cy1; y += 2)
      for (let x = cx0; x < cx1; x += 2) {
        const o = y * w + x;
        if (!pred(o)) continue;
        const pi = o * ch;
        out.push([px[pi], px[pi + 1], px[pi + 2]]);
      }
    return out;
  };
  let fgPal = [];
  {
    let s = seedSamples(
      (o) => distToPal(px, ch, o, bgCols) > MIN_DBG && tex[o] >= texMed
    );
    if (s.length < 150) {
      // Weaker contrast than hoped: relax to "far from background" only.
      s = seedSamples((o) => distToPal(px, ch, o, bgCols) > MIN_DBG * 0.6);
    }
    if (s.length < 80) {
      // Garment genuinely close to the background colour — fall back to the
      // centre box and let the iterative loop repair it.
      s = seedSamples(() => true);
    }
    fgPal = s.length > 0 ? kmeans(s, 5, 8) : [];
  }

  /* --- 3 · colour score ------------------------------------------------- */
  const score = new Float32Array(N);
  const computeScore = () => {
    for (let o = 0; o < N; o++) {
      const f = fgPal.length ? distToPal(px, ch, o, fgPal) : Infinity;
      const b = distToPal(px, ch, o, bgCols);
      score[o] = b / (f + b + 1e-6);
    }
  };
  computeScore();

  const texScore = new Float32Array(N);
  for (let o = 0; o < N; o++) {
    texScore[o] = Math.max(0, Math.min(1, (tex[o] - texMed * 0.7) / (texMed * 2)));
  }

  const edgeT = Math.max(1e-3, percentile(grad, 0.9));
  const S_BG = opts.sBg ?? 0.35;
  const S_FG = opts.sFg ?? 0.6;
  const bgGate = new Uint8Array(N);
  const borderSeeds = [];
  const collectBorder = () => {
    borderSeeds.length = 0;
    for (let x = 0; x < w; x++) {
      if (bgGate[x]) borderSeeds.push(x);
      if (bgGate[(h - 1) * w + x]) borderSeeds.push((h - 1) * w + x);
    }
    for (let y = 1; y < h - 1; y++) {
      if (bgGate[y * w]) borderSeeds.push(y * w);
      if (bgGate[y * w + w - 1]) borderSeeds.push(y * w + w - 1);
    }
  };

  /* --- 4 · iterate: score → definite bg → refine fg palette -------------- */
  let definiteBg = new Uint8Array(N);
  const ITERS = opts.iters ?? 3;
  for (let it = 0; it < ITERS; it++) {
    for (let o = 0; o < N; o++) bgGate[o] = score[o] < S_BG && grad[o] < edgeT ? 1 : 0;
    collectBorder();
    definiteBg = gatedFlood(borderSeeds, bgGate, w, h);
    // Refine the fg palette from pixels that are foreground-coloured, not
    // border-reachable, and textured — a leaking region cannot reinforce
    // itself because anything border-reachable is excluded outright.
    const keep = [];
    for (let o = 0; o < N; o++)
      if (!definiteBg[o] && score[o] > S_FG && tex[o] >= texMed * 0.5) keep.push(o);
    if (keep.length > N * 0.01) {
      const samp = [];
      for (let i = 0; i < keep.length; i += 3) {
        const pi = keep[i] * ch;
        samp.push([px[pi], px[pi + 1], px[pi + 2]]);
      }
      const next = kmeans(samp, 5, 8);
      if (next.length) {
        fgPal = next;
        computeScore();
      }
    }
    if (DEBUG) {
      console.log(
        `   iter ${it}: definiteBg=${((100 * definiteBg.reduce((a, v) => a + v, 0)) / N).toFixed(1)}% ` +
          `fgPalSamples=${keep.length}`
      );
    }
  }
  for (let o = 0; o < N; o++) bgGate[o] = score[o] < S_BG && grad[o] < edgeT ? 1 : 0;
  collectBorder();
  definiteBg = gatedFlood(borderSeeds, bgGate, w, h);

  /* --- 5 · definite foreground ------------------------------------------ */
  const seedsFg = [];
  for (let o = 0; o < N; o++) if (!definiteBg[o] && score[o] > S_FG) seedsFg.push(o);
  const seedsBg = [];
  for (let o = 0; o < N; o++) if (definiteBg[o]) seedsBg.push(o);

  if (DEBUG) {
    console.log(
      `   definiteBg=${((100 * seedsBg.length) / N).toFixed(1)}% ` +
        `seedsFg=${((100 * seedsFg.length) / N).toFixed(1)}% edgeT=${edgeT.toFixed(2)}`
    );
    console.log(
      `   bgCols=${bgCols.map((c) => "[" + c.map((v) => v.toFixed(0)).join(",") + "]").join(" ")}`
    );
    console.log(
      `   fgPal=${fgPal.map((c) => "[" + c.map((v) => v.toFixed(0)).join(",") + "]").join(" ")}`
    );
    // coarse ASCII score map (rows top→bottom, 28 cols) — . low, # high
    const COLS = 28;
    const ROWS = 22;
    const ramp = " .:-=+*#%@";
    for (let ry = 0; ry < ROWS; ry++) {
      let line = "";
      for (let rx = 0; rx < COLS; rx++) {
        const x0 = Math.floor((rx * w) / COLS);
        const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * w) / COLS));
        const y0 = Math.floor((ry * h) / ROWS);
        const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * h) / ROWS));
        let sum = 0;
        let n = 0;
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            sum += score[y * w + x];
            n++;
          }
        line += ramp[Math.min(9, Math.max(0, Math.round((sum / n) * 9)))];
      }
      console.log("   |" + line + "|");
    }
  }

  /* --- 6 · edge-weighted geodesic race ---------------------------------- */
  const gRef = Math.max(1, percentile(grad, 0.92));
  const cost = new Float32Array(N);
  for (let o = 0; o < N; o++) {
    const t = Math.min(1, grad[o] / gRef);
    cost[o] = 1 + Math.round(30 * t * t);
  }
  const alpha = new Float32Array(N);
  if (seedsFg.length < N * 0.005 || seedsBg.length < N * 0.005) {
    for (let o = 0; o < N; o++) alpha[o] = score[o] > 0.5 ? 1 : 0;
    return { alpha, score, texScore, grad, bgCols, fgPal, degenerate: true };
  }
  const Dfg = geodesic(seedsFg, cost, w, h);
  const Dbg = geodesic(seedsBg, cost, w, h);
  for (let o = 0; o < N; o++) {
    const f = Dfg[o];
    const b = Dbg[o];
    alpha[o] = b / (f + b + 1e-6);
  }

  return { alpha, score, texScore, grad, bgCols, fgPal, definiteBg };
}

/* ================================ driver ============================== */

const dump = async (arr, w, h, name, scale = 255) => {
  const N = w * h;
  const buf = Buffer.alloc(N);
  for (let i = 0; i < N; i++) buf[i] = Math.max(0, Math.min(255, arr[i] * scale));
  await sharp(buf, { raw: { width: w, height: h, channels: 1 } }).png().toFile(join(outDir, name));
};

for (const stem of stems) {
  const srcPath = join(srcDir, stem + ".jpg");
  if (!existsSync(srcPath)) { console.log(`SKIP ${stem}`); continue; }
  const { data: px, info } = await sharp(srcPath)
    .resize(SIDE, SIDE, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { width: w, height: h, channels: ch } = info;
  console.log(`\n== ${stem} (${w}x${h})`);

  const t0 = Date.now();
  const r = segment(px, w, h, ch, {});
  const segMs = Date.now() - t0;
  const N = w * h;

  let mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = r.alpha[i] > 0.5 ? 1 : 0;
  mask = morph(mask, w, h, false);
  mask = largestComponent(mask, w, h, Math.round(N * 0.01));
  mask = fillHoles(mask, w, h);
  mask = morph(mask, w, h, true);
  mask = morph(mask, w, h, false);

  const m = alphaMetrics(Array.from(mask, (v) => v * 255), w, h);
  console.log(`   segmented in ${segMs} ms`);
  console.log(`   ${fmtMetrics(m)}`);

  const maskBuf = Buffer.alloc(N);
  for (let i = 0; i < N; i++) maskBuf[i] = mask[i] * 255;
  await sharp(maskBuf, { raw: { width: w, height: h, channels: 1 } })
    .png()
    .toFile(join(outDir, `${stem}-alpha.png`));

  const meta = await sharp(srcPath).metadata();
  const maskFull = await sharp(maskBuf, { raw: { width: w, height: h, channels: 1 } })
    .resize(meta.width, meta.height, { fit: "fill", kernel: "lanczos3" })
    .blur(2)
    .png()
    .toBuffer();
  const cut = await sharp(srcPath)
    .ensureAlpha()
    .composite([{ input: maskFull, blend: "dest-in" }])
    .png()
    .toBuffer();
  await sharp(cut).toFile(join(outDir, `${stem}-cutout.png`));
  await studioComposite(cut, join(outDir, `${stem}-studio.jpg`));

  if (DEBUG) {
    await dump(r.score, w, h, `${stem}-dbg-score.png`);
    await dump(r.alpha, w, h, `${stem}-dbg-alpha.png`);
    await dump(r.texScore, w, h, `${stem}-dbg-tex.png`);
    await dump(r.definiteBg, w, h, `${stem}-dbg-dbg.png`);
  }
}
console.log("\ndone ->", outDir);

/**
 * StudioCut — deterministic garment segmentation.
 *
 * Pure pixel maths: no model weights, no network, no keys, no WASM, no GPU.
 * Flat typed arrays and plain arithmetic only, so this file ports 1:1 from
 * Node to Canvas2D (the browser path uses exactly the same code).
 *
 * WHY THIS SHAPE
 * --------------
 * The hard case (references/raw-samples/photo_2) is an underexposed flash
 * photo of a grey-marle hoodie spread on a white table, touching three frame
 * edges, with a bright blown-out patch of table that never appears on the
 * frame border. Pixel-level colour models fail there because:
 *   - the marle and the table are both mid-grey (luma 65-80 vs 143-150), and
 *     the blown patch is brighter than every border-sampled background tone,
 *     so it looks "foreground" to any border-derived palette;
 *   - local texture does not separate them either (marle std3 ≈ 8.7, table
 *     std3 ≈ 1.8-5.7 — overlapping);
 *   - the garment touches the frame, so "border = background" is false.
 *
 * So the classification is done on REGIONS, not pixels. Regions are found by
 * Felzenszwalb graph segmentation, whose boundaries follow image edges; their
 * mean colour is noise-free, so colour comparisons between regions are
 * reliable where per-pixel comparisons are not. Regions are then labelled by
 * a colour-similarity flood over the region adjacency graph that may only
 * cross WEAK boundaries — the blown table patch is colour-similar to the
 * adjacent table across a weak boundary and is absorbed into the background,
 * while the garment is protected by its strong boundary edge.
 *
 * A final pixel-level edge-weighted geodesic race between the labelled seeds
 * snaps the frontier onto the real image edge.
 *
 * STAGES
 *  1  features (luma, Sobel gradient, local luminance std)
 *  2  background palette from the frame border, keeping only colours that
 *     recur in several SEPARATED border arcs
 *  3  Felzenszwalb regions + per-region statistics
 *  4  region labelling: colour-similarity flood across weak boundaries only
 *  5  pixel-level edge-weighted geodesic refinement
 *  6  cleanup: close, largest component, hole fill, erode, feather
 */

/* ------------------------------- features ------------------------------ */

export function computeFeatures(px, w, h, ch) {
  const N = w * h;
  const luma = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const o = i * ch;
    luma[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
  }

  // 3x3 box blur, then Sobel: kills knit weave, keeps fabric-vs-surface steps
  const blur = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
          s += luma[yy * w + xx];
        }
      }
      blur[y * w + x] = s / 9;
    }
  }
  const at = (x, y) => blur[y * w + x];
  const grad = new Float32Array(N);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = x > 0 ? x - 1 : 0;
      const x1 = x < w - 1 ? x + 1 : w - 1;
      const y0 = y > 0 ? y - 1 : 0;
      const y1 = y < h - 1 ? y + 1 : h - 1;
      const gx =
        -at(x0, y0) - 2 * at(x0, y) - at(x0, y1) +
        at(x1, y0) + 2 * at(x1, y) + at(x1, y1);
      const gy =
        -at(x0, y0) - 2 * at(x, y0) - at(x1, y0) +
        at(x0, y1) + 2 * at(x, y1) + at(x1, y1);
      grad[y * w + x] = Math.sqrt(gx * gx + gy * gy) / 4;
    }
  }

  // local luminance std via integral images
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
  const tex = new Float32Array(N);
  const R = 3;
  for (let y = 0; y < h; y++) {
    const y0 = y - R < 0 ? 0 : y - R;
    const y1 = y + R + 1 > h ? h : y + R + 1;
    for (let x = 0; x < w; x++) {
      const x0 = x - R < 0 ? 0 : x - R;
      const x1 = x + R + 1 > w ? w : x + R + 1;
      const n = (x1 - x0) * (y1 - y0);
      const m = box(s1, x0, y0, x1, y1) / n;
      const m2 = box(s2, x0, y0, x1, y1) / n;
      tex[y * w + x] = Math.sqrt(Math.max(0, m2 - m * m));
    }
  }

  return { luma, grad, tex };
}

export function percentile(arr, p) {
  const a = Float32Array.from(arr);
  a.sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];
}

/** 3x3 box blur of an interleaved RGB buffer, `passes` times (≈ Gaussian). */
export function boxBlurRgb(px, w, h, ch, passes = 1) {
  const N = w * h;
  let src = px;
  for (let p = 0; p < passes; p++) {
    const dst = new Uint8Array(N * ch);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let s = 0;
          for (let dy = -1; dy <= 1; dy++) {
            const yy = y + dy < 0 ? 0 : y + dy >= h ? h - 1 : y + dy;
            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx < 0 ? 0 : x + dx >= w ? w - 1 : x + dx;
              s += src[(yy * w + xx) * ch + c];
            }
          }
          dst[(y * w + x) * ch + c] = s / 9;
        }
      }
    }
    src = dst;
  }
  return src;
}

/* ------------------------------ colour maths --------------------------- */

/**
 * Shading-tolerant distance between a pixel and the nearest palette entry:
 * plain RGB distance plus a weighted chromaticity term. Flash and shadow
 * scale RGB but preserve hue, so chromaticity keeps a shadowed white table
 * close to a lit one — and, crucially here, keeps the blue-tinted marle away
 * from the neutral grey room even though their RGB values nearly coincide.
 */
export const CHROMA_W = 1.6e6;

export function distToPal(px, ch, o, pal) {
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

/** Colour distance between two RGB triples, same metric as distToPal. */
export function colourDist(a, b) {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  const sa = a[0] + a[1] + a[2];
  const sb = b[0] + b[1] + b[2];
  const dcr = (sa > 0 ? a[0] / sa : 1 / 3) - (sb > 0 ? b[0] / sb : 1 / 3);
  const dcb = (sa > 0 ? a[2] / sa : 1 / 3) - (sb > 0 ? b[2] / sb : 1 / 3);
  return dr * dr + dg * dg + db * db + CHROMA_W * (dcr * dcr + dcb * dcb);
}

export function kmeans(samples, k, iters = 8) {
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
      if (d > bestD) {
        bestD = d;
        bestI = i;
      }
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
        if (dd < bd) {
          bd = dd;
          best = c;
        }
      }
      assign[i] = best;
    }
    const sum = Array.from({ length: K }, () => [0, 0, 0, 0]);
    for (let i = 0; i < n; i++) {
      const a = assign[i];
      const s = samples[i];
      sum[a][0] += s[0];
      sum[a][1] += s[1];
      sum[a][2] += s[2];
      sum[a][3]++;
    }
    for (let c = 0; c < K; c++) {
      if (sum[c][3] > 0) {
        cent[c][0] = sum[c][0] / sum[c][3];
        cent[c][1] = sum[c][1] / sum[c][3];
        cent[c][2] = sum[c][2] / sum[c][3];
      }
    }
  }
  return cent;
}

/* ------------------------- Felzenszwalb regions ------------------------ */

class DSU {
  constructor(n) {
    this.p = new Int32Array(n);
    this.sz = new Int32Array(n).fill(1);
    this.int_ = new Float32Array(n);
    for (let i = 0; i < n; i++) this.p[i] = i;
  }
  find(a) {
    let r = a;
    while (this.p[r] !== r) r = this.p[r];
    while (this.p[a] !== r) {
      const nx = this.p[a];
      this.p[a] = r;
      a = nx;
    }
    return r;
  }
  union(a, b, w) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    let big = ra;
    let small = rb;
    if (this.sz[big] < this.sz[small]) {
      big = rb;
      small = ra;
    }
    this.p[small] = big;
    this.sz[big] += this.sz[small];
    this.int_[big] = w;
  }
}

/**
 * Felzenszwalb–Huttenlocher graph segmentation. Regions are unions of pixels
 * joined by low-dissimilarity edges, and the merge predicate compares the
 * edge weight against each component's own internal variation, so a region
 * can grow across a smooth gradient but not across an edge.
 */
export function felzenszwalb(px, w, h, ch, k = 220, minSize = 0.004) {
  const N = w * h;
  const E = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * w + x;
      if (x < w - 1) {
        const a = o * ch;
        const b = (o + 1) * ch;
        const dr = px[a] - px[b];
        const dg = px[a + 1] - px[b + 1];
        const db = px[a + 2] - px[b + 2];
        E.push([Math.sqrt(dr * dr + dg * dg + db * db), o, o + 1]);
      }
      if (y < h - 1) {
        const a = o * ch;
        const b = (o + w) * ch;
        const dr = px[a] - px[b];
        const dg = px[a + 1] - px[b + 1];
        const db = px[a + 2] - px[b + 2];
        E.push([Math.sqrt(dr * dr + dg * dg + db * db), o, o + w]);
      }
    }
  }
  E.sort((p, q) => p[0] - q[0]);
  const dsu = new DSU(N);
  for (let i = 0; i < E.length; i++) {
    const [wt, a, b] = E[i];
    const ra = dsu.find(a);
    const rb = dsu.find(b);
    if (ra === rb) continue;
    const ta = dsu.int_[ra] + k / dsu.sz[ra];
    const tb = dsu.int_[rb] + k / dsu.sz[rb];
    if (wt <= ta && wt <= tb) dsu.union(a, b, wt);
  }
  // merge undersized components into the neighbour they are most similar to
  const minPx = Math.max(12, Math.round(N * minSize));
  const byRoot = new Map();
  for (let i = 0; i < N; i++) {
    const r = dsu.find(i);
    const e = byRoot.get(r);
    if (e) e.push(i);
    else byRoot.set(r, [i]);
  }
  let comps = [...byRoot.values()];
  // neighbour lookup between components
  const compOf = new Int32Array(N);
  const relabel = () => {
    comps.sort((a, b) => b.length - a.length);
    for (let c = 0; c < comps.length; c++) for (const p of comps[c]) compOf[p] = c;
  };
  relabel();
  const meanOf = (members) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (const p of members) {
      const o = p * ch;
      r += px[o];
      g += px[o + 1];
      b += px[o + 2];
    }
    const n = members.length;
    return [r / n, g / n, b / n];
  };
  for (let round = 0; round < 3; round++) {
    let merged = false;
    for (let c = comps.length - 1; c >= 0; c--) {
      const members = comps[c];
      if (!members || members.length >= minPx) continue;
      const mc = meanOf(members);
      const tally = new Map();
      for (const p of members) {
        const x = p % w;
        const y = (p / w) | 0;
        const nbs = [];
        if (x > 0) nbs.push(p - 1);
        if (x < w - 1) nbs.push(p + 1);
        if (y > 0) nbs.push(p - w);
        if (y < h - 1) nbs.push(p + w);
        for (const q of nbs) {
          const cq = compOf[q];
          if (cq !== c && comps[cq]) tally.set(cq, (tally.get(cq) ?? 0) + 1);
        }
      }
      let bestC = -1;
      let bestScore = Infinity;
      for (const [cq, cnt] of tally) {
        const d = colourDist(mc, meanOf(comps[cq])) / Math.sqrt(cnt + 1);
        if (d < bestScore) {
          bestScore = d;
          bestC = cq;
        }
      }
      if (bestC >= 0) {
        for (const p of members) comps[bestC].push(p);
        comps[c] = [];
        merged = true;
      }
    }
    comps = comps.filter((m) => m && m.length > 0);
    relabel();
    if (!merged) break;
  }
  return { compOf, comps, nComp: comps.length };
}

/* ------------------------------ geodesics ------------------------------ */

/**
 * Multi-source Dijkstra on a 4-neighbour grid with real-valued entry costs.
 * Binary heap keyed on `dist` — a bucket queue silently wrapped its ring
 * buffer once path distances exceeded the bucket count, which corrupted every
 * result while still looking plausible.
 */
export function geodesic(seeds, cost, w, h) {
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
  for (const s of seeds) {
    if (dist[s] === 0) continue;
    dist[s] = 0;
    heap.push(s);
    up(heap.length - 1);
  }
  while (heap.length) {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      down(0);
    }
    const d = dist[top];
    const x = top % w;
    const y = (top / w) | 0;
    if (x > 0) { const m = top - 1; const nd = d + cost[m]; if (nd < dist[m]) { dist[m] = nd; heap.push(m); up(heap.length - 1); } }
    if (x < w - 1) { const m = top + 1; const nd = d + cost[m]; if (nd < dist[m]) { dist[m] = nd; heap.push(m); up(heap.length - 1); } }
    if (y > 0) { const m = top - w; const nd = d + cost[m]; if (nd < dist[m]) { dist[m] = nd; heap.push(m); up(heap.length - 1); } }
    if (y < h - 1) { const m = top + w; const nd = d + cost[m]; if (nd < dist[m]) { dist[m] = nd; heap.push(m); up(heap.length - 1); } }
  }
  return dist;
}

/* ---------------------------- min-cut (Dinic) -------------------------- */

/**
 * Dinic max-flow. Used for the binary region labelling: minimising
 *   E = Σ_c [x_c·D_c(FG) + (1-x_c)·D_c(BG)] + Σ_ab w_ab·[x_a ≠ x_b]
 * is a min-cut problem, and solving it globally is what stops the label
 * frontier from slicing through a homogeneous garment (which a distance race
 * does, because the background's influence travels freely through the same
 * fabric once it has crossed one weak boundary).
 */
const DEBUG_LABELS = !!process.env.SEG_DEBUG;
function dinic(n, edges) {
  // edges: [from, to, cap, undirected?]
  const to = [];
  const cap = [];
  const head = Array.from({ length: n }, () => []);
  const addEdge = (a, b, c) => {
    head[a].push(to.length);
    to.push(b);
    cap.push(c);
    head[b].push(to.length);
    to.push(a);
    cap.push(0);
  };
  for (const [a, b, c, undirected] of edges) {
    addEdge(a, b, c);
    if (undirected) addEdge(b, a, c);
  }
  const level = new Int32Array(n);
  const iter = new Int32Array(n);
  const bfs = (s, t) => {
    level.fill(-1);
    level[s] = 0;
    const q = [s];
    for (let h = 0; h < q.length; h++) {
      const v = q[h];
      for (const e of head[v]) {
        if (cap[e] > 0 && level[to[e]] < 0) {
          level[to[e]] = level[v] + 1;
          q.push(to[e]);
        }
      }
    }
    return level[t] >= 0;
  };
  const dfs = (v, t, f) => {
    if (v === t) return f;
    for (; iter[v] < head[v].length; iter[v]++) {
      const e = head[v][iter[v]];
      const u = to[e];
      if (cap[e] > 0 && level[v] + 1 === level[u]) {
        const d = dfs(u, t, Math.min(f, cap[e]));
        if (d > 0) {
          cap[e] -= d;
          cap[e ^ 1] += d;
          return d;
        }
      }
    }
    return 0;
  };
  const s = 0;
  const t = n - 1;
  let flow = 0;
  while (bfs(s, t)) {
    iter.fill(0);
    let f;
    while ((f = dfs(s, t, Infinity)) > 0) flow += f;
  }
  // source-reachable set in the residual graph = x=1 side (foreground)
  const seen = new Uint8Array(n);
  const q = [s];
  seen[s] = 1;
  for (let h = 0; h < q.length; h++) {
    const v = q[h];
    for (const e of head[v]) {
      if (cap[e] > 0 && !seen[to[e]]) {
        seen[to[e]] = 1;
        q.push(to[e]);
      }
    }
  }
  return seen;
}

/* ------------------------------- cleanup ------------------------------- */

export function largestComponent(mask, w, h, minArea) {
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
  for (let c = 0; c < n; c++) {
    if (sizes[c] > bestSize) {
      bestSize = sizes[c];
      best = c;
    }
  }
  const out = new Uint8Array(N);
  if (bestSize < minArea) return out;
  for (let i = 0; i < N; i++) if (comp[i] === best) out[i] = 1;
  return out;
}

export function fillHoles(mask, w, h) {
  const N = w * h;
  const seen = new Uint8Array(N);
  const q = [];
  const push = (o) => {
    if (!mask[o] && !seen[o]) {
      seen[o] = 1;
      q.push(o);
    }
  };
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

/** Majority (mode) filter over a (2r+1)^2 window — despeckles without eroding. */
export function majority(mask, w, h, r) {
  const N = w * h;
  const out = new Uint8Array(N);
  const half = (2 * r + 1) * (2 * r + 1) / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[yy * w + xx]) n++;
        }
      }
      out[y * w + x] = n >= half ? 1 : 0;
    }
  }
  return out;
}

export function morph(mask, w, h, isErode) {
  const N = w * h;
  const out = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
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
  }
  return out;
}

/* ============================== the pipeline =========================== */

/** Separable 3-tap box blur over a single-channel float field, `passes` times. */
export function blur1(src, w, h, passes = 1) {
  let a = src;
  for (let p = 0; p < passes; p++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let l = a[row];
      let c = a[row];
      for (let x = 0; x < w; x++) {
        const rv = a[row + Math.min(w - 1, x + 1)];
        tmp[row + x] = (l + c + rv) / 3;
        l = c;
        c = rv;
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let u = tmp[x];
      let c = tmp[x];
      for (let y = 0; y < h; y++) {
        const dv = tmp[Math.min(h - 1, y + 1) * w + x];
        out[y * w + x] = (u + c + dv) / 3;
        u = c;
        c = dv;
      }
    }
    a = out;
  }
  return a;
}

const smoothstep = (e0, e1, x) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1e-6)));
  return t * t * (3 - 2 * t);
};

/**
 * @returns {{
 *   alpha: Float32Array,      // soft foreground coverage 0..1
 *   mask: Uint8Array,         // cleaned hard mask (0/1)
 *   regions: object,          // region decomposition + labels (for diagnostics)
 *   stats: object             // seed sizes, thresholds — for diagnostics
 * }}
 */
export function studioCut(px, w, h, ch, opts = {}) {
  const N = w * h;
  const { luma, grad, tex } = computeFeatures(px, w, h, ch);

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
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (!onBorder(x, y)) continue;
      const o = (y * w + x) * ch;
      arcSamples[arcOf(x, y)].push([px[o], px[o + 1], px[o + 2]]);
    }
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
        if (dr * dr + dg * dg + db * db < MERGE2) {
          host = e;
          break;
        }
      }
      if (host) {
        host.arcs.add(a);
        host.n += s.length;
      } else {
        bgPal.push({ c, arcs: new Set([a]), n: s.length });
      }
    }
  }
  bgPal.sort((a, b) => b.n - a.n);
  let kept = bgPal.filter((e) => e.arcs.size >= 2);
  if (kept.length < 2) kept = bgPal.slice(0, 4);
  const bgCols = kept.slice(0, 8).map((e) => e.c);

  /* --- 2 · regions ------------------------------------------------------
   * Felzenszwalb runs on a lightly blurred copy. Knit weave and JPEG noise
   * otherwise fragment the garment into hundreds of texture-sized regions
   * whose boundaries make the final silhouette ragged; blurring first lets
   * the regions follow real edges (fabric-vs-surface, seams, folds). Colour
   * statistics below are still read from the ORIGINAL pixels. */
  const regionPx = boxBlurRgb(px, w, h, ch, opts.regionBlur ?? 1);
  const reg = felzenszwalb(
    regionPx,
    w,
    h,
    ch,
    opts.regionK ?? 120,
    opts.regionMin ?? 0.0015
  );
  const R = reg.nComp;
  const compOf = reg.compOf;

  const meanCol = new Array(R);
  const area = new Int32Array(R);
  const borderArc = new Array(R);
  const borderCount = new Int32Array(R);
  const sides = new Array(R);
  for (let c = 0; c < R; c++) {
    borderArc[c] = new Set();
    sides[c] = new Set();
  }
  for (let i = 0; i < N; i++) {
    const c = compOf[i];
    area[c]++;
    const x = i % w;
    const y = (i / w) | 0;
    if (x < bandW) sides[c].add("l");
    if (x >= w - bandW) sides[c].add("r");
    if (y < bandW) sides[c].add("t");
    if (y >= h - bandW) sides[c].add("b");
    if (onBorder(x, y)) {
      borderCount[c]++;
      borderArc[c].add(arcOf(x, y));
    }
  }
  const sumCol = Array.from({ length: R }, () => [0, 0, 0]);
  for (let i = 0; i < N; i++) {
    const c = compOf[i];
    const o = i * ch;
    sumCol[c][0] += px[o];
    sumCol[c][1] += px[o + 1];
    sumCol[c][2] += px[o + 2];
  }
  for (let c = 0; c < R; c++) {
    const n = Math.max(1, area[c]);
    meanCol[c] = [sumCol[c][0] / n, sumCol[c][1] / n, sumCol[c][2] / n];
  }

  /* --- 3 · region adjacency + boundary strength ------------------------- */
  const adj = Array.from({ length: R }, () => new Map()); // neighbour -> [gradSum, count]
  const addEdge = (a, b, g) => {
    let e = adj[a].get(b);
    if (!e) {
      e = [0, 0];
      adj[a].set(b, e);
      adj[b].set(a, e);
    }
    e[0] += g;
    e[1] += 1;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const ci = compOf[i];
      if (x < w - 1) {
        const cj = compOf[i + 1];
        if (ci !== cj) addEdge(ci, cj, grad[i] + grad[i + 1]);
      }
      if (y < h - 1) {
        const cj = compOf[i + w];
        if (ci !== cj) addEdge(ci, cj, grad[i] + grad[i + w]);
      }
    }
  }
  const boundaryStrength = (a, b) => {
    const e = adj[a].get(b);
    if (!e || e[1] === 0) return Infinity;
    return e[0] / (2 * e[1]);
  };

  /* --- 4 · region labelling --------------------------------------------
   * Seeds first, strictly:
   *   BG — a region that sits substantially on the frame AND matches a
   *        border-recurrent colour, or wraps around the frame (border contact
   *        on two different SIDES, which is what a table/floor does).
   *        Counting arcs along one side was not enough: a sleeve running down
   *        the left edge spans several arcs and got seeded as background,
   *        after which a colour-similarity flood swallowed the whole garment.
   *   FG — the largest region whose mean colour is clearly off every
   *        background colour, grown to its colour-similar neighbours.
   * Then a Dijkstra race over the region graph decides everything else. The
   * cost of entering a region combines the colour change and the strength of
   * the boundary crossed, so the frontier prefers weak, colour-similar
   * transitions (the blown-out table patch joins the table) and refuses
   * strong ones (the garment keeps its edge).
   */
  const bgSeedColour = opts.bgSeedColour ?? 2600;
  const simT = opts.simT ?? 5000;
  const weakEdge = opts.weakEdge ?? percentile(grad, 0.75);
  const strongPenalty = opts.strongPenalty ?? 30;
  const labels = new Int8Array(R).fill(0); // 0 unknown, 1 bg, 2 fg
  const gRef = Math.max(1, percentile(grad, 0.92));

  const dToBgOf = new Array(R);
  for (let c = 0; c < R; c++) dToBgOf[c] = minDistToPal(meanCol[c], bgCols);

  const bgSeed = new Uint8Array(R);
  for (let c = 0; c < R; c++) {
    const frac = borderCount[c] / Math.max(1, area[c]);
    if (frac < 0.08) continue;
    if (frac > 0.2 && dToBgOf[c] < bgSeedColour) bgSeed[c] = 1;
    else if (sides[c].size >= 2 && dToBgOf[c] < bgSeedColour) bgSeed[c] = 1;
  }

  // FG model: the largest clearly off-background region, grown to its
  // colour-similar neighbours across weak boundaries. This only has to be a
  // confident SEED for the energy minimisation below, not the final answer.
  let fgRoot = -1;
  let fgRootScore = 0;
  for (let c = 0; c < R; c++) {
    if (bgSeed[c] || dToBgOf[c] < bgSeedColour * 1.3) continue;
    if (area[c] > fgRootScore) {
      fgRootScore = area[c];
      fgRoot = c;
    }
  }
  const fgGrow = new Uint8Array(R);
  if (fgRoot >= 0) {
    fgGrow[fgRoot] = 1;
    const q = [fgRoot];
    let head = 0;
    while (head < q.length) {
      const c = q[head++];
      for (const [nb] of adj[c]) {
        if (fgGrow[nb] || bgSeed[nb]) continue;
        if (boundaryStrength(c, nb) > weakEdge) continue;
        if (colourDist(meanCol[c], meanCol[nb]) > simT) continue;
        fgGrow[nb] = 1;
        q.push(nb);
      }
    }
  }

  // FG colour model from the grown seed set
  const fgSamples = [];
  for (let i = 0; i < N; i++) {
    if (!fgGrow[compOf[i]]) continue;
    if ((i & 3) !== 0) continue;
    const o = i * ch;
    fgSamples.push([px[o], px[o + 1], px[o + 2]]);
  }
  const fgCols = fgSamples.length > 200 ? kmeans(fgSamples, 4, 8) : [];

  /* --- 5 · global binary labelling by min-cut over the region graph -----
   * Energy:  Σ_c [ x_c·D_c(FG) + (1-x_c)·D_c(BG) ]
   *        + Σ_ab w_ab·[x_a ≠ x_b]
   * w_ab is large between colour-similar regions and near zero between very
   * different ones, so the cut prefers to run along real edges and refuses to
   * slice through the middle of a garment made of one fabric.
   *
   * D_c(·) is RELATIVE: dToFg/(dToFg+dToBg). An absolute, saturating cost made
   * the navy hood of photo_2 a tie — it is far from both palettes, so both
   * costs pinned at the cap and the smoothness had nothing to break the tie
   * with. Relatively, the hood is twice as close to the garment palette as to
   * the background palette, and lands on the right side.
   */
  const lambdaData = opts.lambdaData ?? 30;
  const sigma = opts.sigma ?? 2500;
  const lambdaSmooth = opts.lambdaSmooth ?? 14;
  let fgPalette = fgCols.length ? fgCols : [meanCol[fgRoot >= 0 ? fgRoot : 0]];

  const SRC = 0;
  const SNK = R + 1;
  const solveLabels = () => {
    const dToFgOf = new Array(R);
    for (let c = 0; c < R; c++) dToFgOf[c] = minDistToPal(meanCol[c], fgPalette);
    const cutEdges = [];
    // HARD = effectively infinite for this graph's capacity scale. A region
    // pinned by one of these can never cross the cut.
    const HARD = 1e7;
    for (let c = 0; c < R; c++) {
      const tot = dToFgOf[c] + dToBgOf[c] + 1e-6;
      let costFg = (dToFgOf[c] / tot) * lambdaData; // cost of assigning FG
      let costBg = (dToBgOf[c] / tot) * lambdaData; // cost of assigning BG
      // A background SEED is a hard constraint, not a hint. It was only a
      // hint before, which let the smoothness term spend a handful of units
      // to keep a colour-similar dark desk corner attached to the garment —
      // exactly the lower-left leak on photo_2. Wrapping the frame (2+ sides)
      // or sitting substantially on it while matching a border-recurrent
      // colour is decisive evidence; make the cut respect it.
      if (bgSeed[c]) costFg = HARD;
      // Anchor the garment seed too, so the minimisation cannot collapse the
      // whole frame to background when the seed is the only strong FG signal.
      if (c === fgRoot) costBg = HARD;
      // source side = foreground: cutting c→sink pays D(FG), the sink side
      // pays D(BG)
      cutEdges.push([SRC, c + 1, costBg, false]);
      cutEdges.push([c + 1, SNK, costFg, false]);
    }
    const seenPair = new Set();
    for (let a = 0; a < R; a++) {
      for (const [b, e] of adj[a]) {
        if (b < a) continue;
        const key = a * R + b;
        if (seenPair.has(key)) continue;
        seenPair.add(key);
        const cd = colourDist(meanCol[a], meanCol[b]);
        const shared = Math.min(1, e[1] / 40);
        const w = lambdaSmooth * Math.exp(-cd / sigma) * shared;
        if (w > 1e-4) cutEdges.push([a + 1, b + 1, w, true]);
      }
    }
    const fgSide = dinic(R + 2, cutEdges);
    for (let c = 0; c < R; c++) labels[c] = fgSide[c + 1] ? 2 : 1;
    return dToFgOf;
  };
  let dToFgOf = solveLabels();

  // One refinement pass: refit the foreground palette from the regions the cut
  // just chose, then re-solve. Only regions that are clearly off the
  // background palette contribute — otherwise a region straddling the
  // garment/background boundary would feed background colour into the
  // foreground model, which then legitimises the very leak we are removing.
  const REFINE = opts.refineLabels ?? 1;
  const refitFloor = opts.refitFloor ?? 9000;
  for (let pass = 0; pass < REFINE; pass++) {
    const samp = [];
    for (let i = 0; i < N; i++) {
      if (labels[compOf[i]] !== 2) continue;
      if (dToBgOf[compOf[i]] < refitFloor) continue;
      if ((i & 3) !== 0) continue;
      const o = i * ch;
      samp.push([px[o], px[o + 1], px[o + 2]]);
    }
    if (samp.length < 200) break;
    fgPalette = kmeans(samp, 5, 8);
    dToFgOf = solveLabels();
  }
  if (DEBUG_LABELS) {
    const count = (v) => labels.reduce((a, x) => a + (x === v ? 1 : 0), 0);
    console.log(`   mincut: fgRegions=${count(2)} bgRegions=${count(1)} fgPalette=${fgPalette.length}`);
  }

  /* --- 6 · optional pixel-level refinement ------------------------------
   * Felzenszwalb boundaries already follow image edges, and a global geodesic
   * re-race is a LOCAL method: it happily undoes a correct region label when
   * the label's boundary is weak (the navy hood against the dark room got
   * flooded back to background). It is therefore opt-in, and defaults off. */
  const alpha = new Float32Array(N);
  for (let i = 0; i < N; i++) alpha[i] = labels[compOf[i]] === 2 ? 1 : 0;
  if (opts.refine) {
    const cost = new Float32Array(N);
    for (let o = 0; o < N; o++) {
      const t = Math.min(1, grad[o] / gRef);
      cost[o] = 1 + Math.round(30 * t * t);
    }
    const seedsFg = [];
    const seedsBg = [];
    for (let i = 0; i < N; i++) {
      if (labels[compOf[i]] === 2) seedsFg.push(i);
      else seedsBg.push(i);
    }
    if (seedsFg.length >= N * 0.004 && seedsBg.length >= N * 0.004) {
      const Dfg = geodesic(seedsFg, cost, w, h);
      const Dbg = geodesic(seedsBg, cost, w, h);
      for (let o = 0; o < N; o++) alpha[o] = Dbg[o] / (Dfg[o] + Dbg[o] + 1e-6);
    }
  }

  /* --- 7 · cleanup ------------------------------------------------------
   * A Felzenszwalb region that straddles the garment/background boundary has
   * a MIXED mean colour, so the region-level cut cannot see the boundary
   * inside it and drags a slab of background along. Confirming every pixel
   * against the final palettes prunes those stragglers; the region label is
   * still what decides the bulk of the mask, so the per-pixel noise that
   * broke the earlier pixel-only models cannot flip whole areas.
   */
  const trim = opts.trim ?? 1.0;
  let mask = new Uint8Array(N);
  if (trim > 0) {
    for (let i = 0; i < N; i++) {
      if (labels[compOf[i]] !== 2) continue;
      const dF = distToPal(px, ch, i, fgPalette);
      const dB = distToPal(px, ch, i, bgCols);
      mask[i] = dF < dB * trim ? 1 : 0;
    }
  } else {
    for (let i = 0; i < N; i++) mask[i] = labels[compOf[i]] === 2 ? 1 : 0;
  }
  mask = morph(mask, w, h, false);
  mask = largestComponent(mask, w, h, Math.round(N * 0.005));
  mask = fillHoles(mask, w, h);
  // majority (mode) filter — removes 1-2 px speckle and edge fringe without
  // eroding genuine thin features the way an open would
  mask = majority(mask, w, h, 2);
  mask = largestComponent(mask, w, h, Math.round(N * 0.005));
  mask = fillHoles(mask, w, h);
  // final 1 px erosion: the upscale + feather below spreads the edge outward,
  // and an un-eroded mask carries a halo of background colour with it
  mask = morph(mask, w, h, true);
  for (let i = 0; i < N; i++) alpha[i] = mask[i];

  /* --- 8 · soft alpha matting ------------------------------------------
   * A binary mask cut along region boundaries reads as a jagged, scissors-cut
   * silhouette the moment it is scaled up onto the studio backdrop. Two cheap
   * stages fix that without a matting network:
   *
   *   a) blur the hard mask — turns the pixel staircase into a smooth ramp;
   *   b) inside the resulting transition band, let COLOUR decide. The
   *      per-pixel ratio dB/(dF+dB) says how much closer this pixel is to the
   *      garment palette than to the background palette, so the edge settles
   *      on the real fabric boundary instead of a fixed-width feather.
   *
   * The definite interior and exterior are re-anchored afterwards, so the blur
   * can never bleed coverage past the mask it started from.
   */
  if (opts.soft ?? 1) {
    const dFp = new Float32Array(N);
    const dBp = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      dFp[i] = distToPal(px, ch, i, fgPalette);
      dBp[i] = distToPal(px, ch, i, bgCols);
    }
    let f = new Float32Array(N);
    for (let i = 0; i < N; i++) f[i] = mask[i];
    f = blur1(f, w, h, opts.softBlur ?? 2);

    const band = opts.softBand ?? 0.22;
    const lo = 0.5 - band;
    const hi = 0.5 + band;
    const mix = opts.softMix ?? 0.45;
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = f[i];
      if (t <= lo) continue;
      if (t >= hi) { out[i] = 1; continue; }
      const r = dBp[i] / (dFp[i] + dBp[i] + 1e-6);
      out[i] = smoothstep(lo, hi, (1 - mix) * t + mix * r);
    }
    const a2 = blur1(out, w, h, 1);

    const inv = new Uint8Array(N);
    for (let i = 0; i < N; i++) inv[i] = mask[i] ? 0 : 1;
    const coreFg = morph(mask, w, h, true);
    const coreBg = morph(inv, w, h, true);
    for (let i = 0; i < N; i++) {
      alpha[i] = coreFg[i] ? 1 : coreBg[i] ? 0 : a2[i];
    }
  }

  return {
    alpha,
    mask,
    regions: { compOf, nComp: R, labels, meanCol, area, bgCols },
    stats: {
      bgPaletteSize: bgCols.length,
      bgSeedRegions: labels.reduce((a, v) => a + (v === 1 ? 1 : 0), 0),
      fgSeedRegions: labels.reduce((a, v) => a + (v === 2 ? 1 : 0), 0),
      weakEdge,
      gRef,
      luma,
      grad,
      tex,
    },
  };
}

export function minDistToPal(col, pal) {
  let best = Infinity;
  for (let k = 0; k < pal.length; k++) {
    const d = colourDist(col, pal[k]);
    if (d < best) best = d;
  }
  return best;
}

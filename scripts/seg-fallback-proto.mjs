/**
 * Prototype: deterministic classical segmentation fallback for cases where
 * ISNet returns a near-empty mask (e.g. washed-out gray hoodie on white).
 *
 * Method (pure pixel math — ports 1:1 to browser Canvas2D later):
 *   1. downscale to <=320px working size
 *   2. GrabCut-lite, two passes:
 *      - definite-bg samples: border ring -> palette (multimodal OK)
 *      - fg prior: center box (subject is centered) -> palette, then
 *        re-estimated from confident-fg pixels after pass 1
 *      - pixel rule: fg iff dFg < dBg * MARGIN (MARGIN < 1 biases ties to
 *        background; interior misses are recovered by hole-fill, leaks
 *        are unrecoverable)
 *   3. background must ALSO be border-connected; open/close, largest
 *      component, hole fill
 *   4. config sweep over --margin: pick the mask whose boundary has the
 *      best IMAGE-EDGE SUPPORT (mean Sobel magnitude along the fg/bg
 *      frontier) within coverage [8%, 85%]
 *   5. upscale mask, feather, apply to full-res photo, studio-composite it
 *
 * Usage: node scripts/seg-fallback-proto.mjs [stems...] [--margin=0.7,0.85,1.0]
 * Writes out/seg-proto/<stem>-mask.png, <stem>-studio.jpg + stats.
 */
import { mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(root, "references", "raw-samples");
const outDir = join(root, "out", "seg-proto");
mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
let MARGINS = [0.7, 0.85, 1.0];
const stems = [];
for (const a of args) {
  if (a.startsWith("--margin="))
    MARGINS = a
      .slice(9)
      .split(",")
      .map((s) => parseFloat(s));
  else stems.push(a.replace(/\.[^.]+$/, ""));
}
if (stems.length === 0)
  stems.push(
    "photo_1_2026-09-08_10-59-52",
    "photo_2_2026-09-08_10-59-52",
    "photo_3_2026-09-08_10-59-52"
  );

const W = 768;
const H = 1024;
const PAD = 0.09;

/** Quantized histogram palette of given pixel offsets. */
function paletteOf(px, ch, offsets, maxEntries = 6, coverFrac = 0.9) {
  const QB = 4;
  const hist = new Map();
  for (const pi of offsets) {
    const key =
      ((px[pi] >> QB) << 8) | ((px[pi + 1] >> QB) << 4) | (px[pi + 2] >> QB);
    let e = hist.get(key);
    if (!e) {
      e = { n: 0, r: 0, g: 0, b: 0 };
      hist.set(key, e);
    }
    e.n++;
    e.r += px[pi];
    e.g += px[pi + 1];
    e.b += px[pi + 2];
  }
  const buckets = [...hist.values()].sort((a, b) => b.n - a.n);
  const pal = [];
  let covered = 0;
  for (const b of buckets) {
    if (pal.length >= maxEntries || covered / offsets.length > coverFrac)
      break;
    pal.push([b.r / b.n, b.g / b.n, b.b / b.n]);
    covered += b.n;
  }
  return pal;
}

/**
 * Squared RGB+chromaticity distance from pixel o to nearest palette entry.
 * Chromaticity (normalized r,b) is shading-invariant: flash/shadow scale
 * RGB but preserve hue. Weight W maps a 0.04 chroma gap to ~60px
 * RGB-equivalent — enough to split lit-marle from shaded-table where
 * raw RGB overlaps (both pale gray), without disturbing saturated tones.
 */
const CHROMA_W = 1.5e6;
function distToPal(px, ch, o, pal) {
  const pi = o * ch;
  const r = px[pi];
  const g = px[pi + 1];
  const bl = px[pi + 2];
  const s = r + g + bl;
  const cr = s > 0 ? r / s : 1 / 3;
  const cb = s > 0 ? bl / s : 1 / 3;
  let best = Infinity;
  for (let k = 0; k < pal.length; k++) {
    const e = pal[k];
    const dr = r - e[0];
    const dg = g - e[1];
    const db = bl - e[2];
    const es = e[0] + e[1] + e[2];
    const er = es > 0 ? e[0] / es : 1 / 3;
    const eb = es > 0 ? e[2] / es : 1 / 3;
    const dcr = cr - er;
    const dcb = cb - eb;
    const d =
      dr * dr + dg * dg + db * db + CHROMA_W * (dcr * dcr + dcb * dcb);
    if (d < best) best = d;
  }
  return best;
}

/** Sobel magnitude on luma, working size, 3x3-blurred first. */
function gradients(px, w, h, ch) {
  const luma = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * ch;
    luma[i] = 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2];
  }
  // Box blur: kills knit-weave texture (2-4px period) while sustained
  // step edges (fabric-vs-table) survive.
  const blur = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(w - 1, x + dx));
          const ny = Math.max(0, Math.min(h - 1, y + dy));
          s += luma[ny * w + nx];
        }
      blur[y * w + x] = s / 9;
    }
  const mag = new Float32Array(w * h);
  const at = (x, y) => {
    x = Math.max(0, Math.min(w - 1, x));
    y = Math.max(0, Math.min(h - 1, y));
    return blur[y * w + x];
  };
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

/** One segmentation run at fixed MARGIN. Returns kept mask + metrics. */
function segment(px, w, h, ch, mag, MARGIN) {
  const N = w * h;
  const idx = (x, y) => (y * w + x) * ch;
  // Edge-stop threshold: 85th percentile of Sobel magnitude (adaptive
  // per photo). Only the strongest luminance edges (fabric-vs-table
  // boundary, seams) block growth; knit texture and shading gradients
  // stay traversable.
  const samp = [];
  for (let i = 0; i < N; i += 7) samp.push(mag[i]);
  samp.sort((a, b) => a - b);
  const edgeT = samp[Math.min(samp.length - 1, Math.floor(samp.length * 0.85))];
  if (process.env.SEG_DIAG) {
    let trav = 0;
    for (let i = 0; i < N; i++) if (mag[i] < edgeT) trav++;
    console.log(
      `   --- edge diag: edgeT=${edgeT.toFixed(1)} traversable=${(
        (100 * trav) /
        N
      ).toFixed(1)}%`
    );
  }
  // Definite-bg samples: border ring walked clockwise, split into 8
  // segments with their own top-3 tones, then greedy-merged WITH support
  // counts. Support = how much of the frame border an entry explains.
  const ring = [];
  for (let x = 0; x < w; x++) ring.push(idx(x, 0));
  for (let y = 1; y < h; y++) ring.push(idx(w - 1, y));
  for (let x = w - 2; x >= 0; x--) ring.push(idx(x, h - 1));
  for (let y = h - 2; y >= 1; y--) ring.push(idx(0, y));
  const bgCandidates = [];
  const SEGS = 8;
  for (let s = 0; s < SEGS; s++) {
    const chunk = ring.slice(
      Math.floor((s * ring.length) / SEGS),
      Math.floor(((s + 1) * ring.length) / SEGS)
    );
    for (const e of paletteOf(px, ch, chunk, 3, 0.8))
      bgCandidates.push(e);
  }
  const MERGE2 = 28 * 28;
  const bgPal = []; // {c:[r,g,b], support:pixels}
  for (const c of bgCandidates) {
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
    if (host) host.support += 1;
    else {
      if (bgPal.length >= 12) continue;
      bgPal.push({ c, support: 1 });
    }
  }
  // Foreground seeds: 5 boxes (center + four flanks), RAW union —
  // frequency-capped palette below keeps rare background intrusions out.
  const seedBoxes = [
    [0.3, 0.3, 0.7, 0.7],
    [0.15, 0.35, 0.4, 0.65],
    [0.6, 0.35, 0.85, 0.65],
    [0.35, 0.08, 0.65, 0.35],
    [0.35, 0.65, 0.65, 0.92],
  ];
  const seedIdx = [];
  for (const [x0, y0, x1, y1] of seedBoxes) {
    for (let y = Math.round(h * y0); y < Math.round(h * y1); y++)
      for (let x = Math.round(w * x0); x < Math.round(w * x1); x++)
        seedIdx.push(idx(x, y));
  }
  // Mutual disambiguation for tones present on BOTH sides.
  // A bg entry ALSO in the seed palette is either a garment tone touching
  // the frame edge (marle sleeve: supported by ONE border segment ->
  // drop it, it vetoes the whole garment) or a genuine background tone
  // the seed boxes also caught (white table: several segments -> keep).
  // Support = number of merged segment-palettes behind the entry.
  // EXPERIMENT: prune rare mid-bright border tones unconditionally
  // (support <= 2 AND luma >= 100). Rationale: the FG ratio test is
  // itself the firewall — a bg veto only matters for tones NEAR fg
  // tones (the marle case). Far tones (white table) cannot pass as FG
  // with or without their veto; flood traversal of veto-less white
  // stays uncertain-gated. Dark touches always survive the luma gate.
  // DIAGNOSTIC: seed-presence of every border tone and every seed tone.
  // seedFrac(entry) = fraction of subsampled seed pixels within 40 RGB.
  // Garment-touch signature: border-RARE (support <= 2) + seed-ABUNDANT.
  // Background-intrusion signature: seed-RARE + border present.
  const SEED_MATCH2 = 40 * 40;
  const seedSub = seedIdx.filter((_, k) => k % 6 === 0);
  const seedFrac = (e) => {
    let hit = 0;
    for (const o of seedSub) {
      // NOTE: seedIdx holds BYTE offsets (idx() already multiplies by ch).
      const dr = px[o] - e[0];
      const dg = px[o + 1] - e[1];
      const db = px[o + 2] - e[2];
      if (dr * dr + dg * dg + db * db < SEED_MATCH2) hit++;
    }
    return hit / seedSub.length;
  };
  if (process.env.SEG_DIAG) {
    const rows = [];
    for (const e of bgPal)
      rows.push(
        `bg sup=${e.support} seedFrac=${(100 * seedFrac(e.c)).toFixed(1)}% rgb=[${e.c
          .map((v) => v.toFixed(0))
          .join(",")}]`
      );
    const fgDiag = paletteOf(px, ch, seedIdx, 24, 0.99);
    for (const e of fgDiag)
      rows.push(
        `fg seedFrac=${(100 * seedFrac(e)).toFixed(1)}% rgb=[${e
          .map((v) => v.toFixed(0))
          .join(",")}]`
      );
    console.log("   --- seed-presence diagnostic ---\n   " + rows.join("\n   "));
  }
  // FG budget 24 entries / 0.99 coverage: the 5 seed boxes are
  // dark-dominated by count, so a tight budget crowds the broad marle
  // body tones out of the fg palette entirely (then the body can never
  // pass the FG ratio test no matter the bg vetoes). Sharpening below
  // still removes entries that add no discrimination.
  // Touch-disambiguation: a border tone that is RARE on the border
  // (support <= 2 segments) but present in the seeds is a garment tone
  // touching the frame edge -> drop its exact-match veto, else it blocks
  // growth of the whole garment through the touch. Two arms:
  // (a) seedFrac >= 15%: tone abundant in seeds (navy shadow touch);
  // (b) luma >= 100 AND seedFrac > 0.5%: mid-bright tone with ANY seed
  // presence (lit marle touch; the lit patch is tonally far from the
  // shadowed body so its seed fraction is small but nonzero).
  // Genuine background survives: dominant on the border (support > 2),
  // dark touches (fail luma, seed-rare), or seed-absent brights (white
  // table: seedFrac 0.0% — its veto is REQUIRED to contain table flood,
  // since flood traverses veto-less white as uncertain).
  const lumaOf = (e) => 0.299 * e[0] + 0.587 * e[1] + 0.114 * e[2];
  const nearAny = (e, pal, t2) => {
    for (const q of pal) {
      const dr = e[0] - q[0];
      const dg = e[1] - q[1];
      const db = e[2] - q[2];
      if (dr * dr + dg * dg + db * db < t2) return true;
    }
    return false;
  };
  const pruned = bgPal.filter((e) => {
    if (e.support > 2) return true;
    const sf = seedFrac(e.c);
    if (sf >= 0.15) return false;
    if (lumaOf(e.c) >= 100 && sf > 0.005) return false;
    return true;
  });
  const prunedObjs = pruned.length > 0 ? pruned : bgPal;
  const bgCols = prunedObjs.map((e) => e.c);
  // FG budget 24 entries / 0.99 coverage: the 5 seed boxes are
  // dark-dominated by count, so a tight budget crowds the broad marle
  // body tones out of the fg palette entirely (then the body can never
  // pass the FG ratio test no matter the bg vetoes). Sharpening below
  // still removes entries that add no discrimination.
  const fgRaw = paletteOf(px, ch, seedIdx, 24, 0.99);
  // Sharpen fg: entries sitting on surviving background tones add no
  // discrimination (zipper-black vs surround-black) -> drop.
  const FG_BG_GAP2 = 32 * 32;
  const sharpFg = fgRaw.filter((e) => !nearAny(e, bgCols, FG_BG_GAP2));
  let fgPal = sharpFg.length > 0 ? sharpFg : fgRaw;

  const isBg = new Uint8Array(N);
  const dFgArr = new Float32Array(N);
  const dBgArr = new Float32Array(N);
  for (let pass = 0; pass < 2; pass++) {
    for (let o = 0; o < N; o++) {
      const dFg = distToPal(px, ch, o, fgPal);
      const dBg = distToPal(px, ch, o, bgCols);
      if (pass === 1) {
        dFgArr[o] = dFg;
        dBgArr[o] = dBg;
      }
      isBg[o] = dFg < dBg * MARGIN ? 0 : 1;
    }
    if (pass === 0) {
      const fgIdx = [];
      for (let o = 0; o < N; o++) if (!isBg[o]) fgIdx.push(o * ch);
      if (fgIdx.length > N * 0.02) fgPal = paletteOf(px, ch, fgIdx);
    }
  }

  // Uncertainty flood: grow confident-fg into merely-ambiguous neighbors
  // (dFg < dBg*U). Edge-stopped (mag < edgeT: cannot cross the strong
  // fabric-vs-background boundary) and depth-capped (K work-px backstop:
  // far-field background is amputated even where merely "uncertain").
  const U = 1.7;
  const K = 8;
  const fgGrow = new Uint8Array(N);
  const gdepth = new Int16Array(N).fill(-1);
  const gstack = [];
  for (let o = 0; o < N; o++)
    if (!isBg[o]) {
      fgGrow[o] = 1;
      gdepth[o] = 0;
      gstack.push(o);
    }
  const gtmp = [0, 0, 0, 0];
  while (gstack.length) {
    const o = gstack.pop();
    const x = o % w;
    const y = (o / w) | 0;
    let n = 0;
    if (x > 0) gtmp[n++] = o - 1;
    if (x < w - 1) gtmp[n++] = o + 1;
    if (y > 0) gtmp[n++] = o - w;
    if (y < h - 1) gtmp[n++] = o + w;
    for (let k = 0; k < n; k++) {
      const m = gtmp[k];
      if (
        !fgGrow[m] &&
        gdepth[o] + 1 <= K &&
        mag[m] < edgeT &&
        dFgArr[m] < dBgArr[m] * U
      ) {
        fgGrow[m] = 1;
        gdepth[m] = gdepth[o] + 1;
        gstack.push(m);
      }
    }
  }
  for (let o = 0; o < N; o++) if (fgGrow[o]) isBg[o] = 0;
  if (process.env.SEG_DIAG) {
    let strict = 0,
      grown = 0;
    for (let o = 0; o < N; o++) {
      if (gdepth[o] === 0) strict++;
      if (fgGrow[o]) grown++;
    }
    console.log(
      `   --- growth diag: strict=${((100 * strict) / N).toFixed(1)}% grown=${(
        (100 * grown) /
        N
      ).toFixed(1)}%`
    );
  }

  // Explicit garment (NOT background-subtraction complement): the mask
  // IS the edge-stopped grown confident-fg. Background-subtraction
  // (garment = everything not border-flooded-bg) includes all uncertain
  // far-field by default — slabs and surround leak in with no defense.
  // Here uncertain far-field is excluded unless grown across weak edges.
  let fg = fgGrow.slice();
  const morph = (src, isErode) => {
    const out = new Uint8Array(N);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (isErode) {
          let v = 1;
          outer: for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (
                nx < 0 ||
                ny < 0 ||
                nx >= w ||
                ny >= h ||
                !src[ny * w + nx]
              ) {
                v = 0;
                break outer;
              }
            }
          out[y * w + x] = v;
        } else {
          let v = 0;
          outer: for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && ny >= 0 && nx < w && ny < h && src[ny * w + nx]) {
                v = 1;
                break outer;
              }
            }
          out[y * w + x] = v;
        }
      }
    return out;
  };
  // NO open: the grown mask is knit-lace (1-2px threads at work res)
  // and 3x3-erode shatters it into 100+ fragments. Bridge-breaking is
  // handled by the edge-stopped growth + seed-touching-component filter
  // below instead. Close only (fill weave gaps), then label.
  fg = morph(morph(fg, false), true);

  const comp = new Int32Array(N).fill(-1);
  let best = -1;
  let bestSize = 0;
  let nComp = 0;
  for (let i = 0; i < N; i++) {
    if (!fg[i] || comp[i] !== -1) continue;
    let size = 0;
    const st = [i];
    comp[i] = nComp;
    while (st.length) {
      const o = st.pop();
      size++;
      const x = o % w;
      const y = (o / w) | 0;
      if (x > 0 && fg[o - 1] && comp[o - 1] === -1) {
        comp[o - 1] = nComp;
        st.push(o - 1);
      }
      if (x < w - 1 && fg[o + 1] && comp[o + 1] === -1) {
        comp[o + 1] = nComp;
        st.push(o + 1);
      }
      if (y > 0 && fg[o - w] && comp[o - w] === -1) {
        comp[o - w] = nComp;
        st.push(o - w);
      }
      if (y < h - 1 && fg[o + w] && comp[o + w] === -1) {
        comp[o + w] = nComp;
        st.push(o + w);
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = nComp;
    }
    nComp++;
  }
  // Prefer the largest SEED-TOUCHING component over the global
  // largest: strict background regions (table slabs, surround) can form
  // large strict components via tonal overlap, but they never touch the
  // seed boxes; the garment always does. Bridges broken by the open
  // above; survivors still get judged by the edge-support gate.
  const seedTouch = new Uint8Array(nComp);
  for (const b of seedIdx) {
    const o = Math.round(b / ch);
    if (o >= 0 && o < N && fg[o] && comp[o] !== -1) seedTouch[comp[o]] = 1;
  }
  let bestSeed = -1;
  let bestSeedSize = 0;
  const compSize = new Int32Array(nComp);
  for (let i = 0; i < N; i++) if (fg[i] && comp[i] !== -1) compSize[comp[i]]++;
  for (let c = 0; c < nComp; c++)
    if (seedTouch[c] && compSize[c] > bestSeedSize) {
      bestSeedSize = compSize[c];
      bestSeed = c;
    }
  const keepComp = bestSeed !== -1 ? bestSeed : best;
  const keepSize = bestSeed !== -1 ? bestSeedSize : bestSize;
  const kept = new Uint8Array(N);
  if (keepSize >= Math.round(N * 0.005))
    for (let i = 0; i < N; i++) kept[i] = comp[i] === keepComp ? 1 : 0;

  const seen = new Uint8Array(N);
  const q = [];
  const holeSeed = (o) => {
    if (!kept[o] && !seen[o]) {
      seen[o] = 1;
      q.push(o);
    }
  };
  for (let x = 0; x < w; x++) {
    holeSeed(x);
    holeSeed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    holeSeed(y * w);
    holeSeed(y * w + w - 1);
  }
  while (q.length) {
    const o = q.pop();
    const x = o % w;
    const y = (o / w) | 0;
    if (x > 0) holeSeed(o - 1);
    if (x < w - 1) holeSeed(o + 1);
    if (y > 0) holeSeed(o - w);
    if (y < h - 1) holeSeed(o + w);
  }
  for (let i = 0; i < N; i++) if (!seen[i]) kept[i] = 1;

  let cov = 0;
  for (let i = 0; i < N; i++) cov += kept[i];
  let edgeSum = 0;
  let edgeN = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * w + x;
      if (!kept[o]) continue;
      if (
        (x > 0 && !kept[o - 1]) ||
        (x < w - 1 && !kept[o + 1]) ||
        (y > 0 && !kept[o - w]) ||
        (y < h - 1 && !kept[o + w])
      ) {
        edgeSum += mag[o];
        edgeN++;
      }
    }
  return {
    kept,
    cov: cov / N,
    edgeSupport: edgeN ? edgeSum / edgeN : 0,
    nComp,
    bgPal: bgCols,
    bgSup: prunedObjs.map((e) => e.support),
    fgPal,
  };
}

for (const stem of stems) {
  const srcPath = join(srcDir, stem + ".jpg");
  if (!existsSync(srcPath)) {
    console.log(`SKIP ${stem}: no such file`);
    continue;
  }
  const work = await sharp(srcPath)
    .resize(448, 448, { fit: "inside" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const { data: px, info } = work;
  const w = info.width;
  const h = info.height;
  const ch = info.channels;
  const mag = gradients(px, w, h, ch);

  let winner = null;
  let winMargin = 0;
  for (const MARGIN of MARGINS) {
    const r = segment(px, w, h, ch, mag, MARGIN);
    const ok = r.cov >= 0.08 && r.cov <= 0.85;
    const fmt = (pal) =>
      pal.map((p) => p.map((v) => v.toFixed(0)).join(",")).join(" | ");
    console.log(
      `   cfg margin=${MARGIN}: cov=${(100 * r.cov).toFixed(1)}% ` +
        `edge=${r.edgeSupport.toFixed(1)} comps=${r.nComp} ${ok ? "CANDIDATE" : "reject"}`
    );
    console.log(`      bgPal=[${fmt(r.bgPal)}]`);
    console.log(
      `      bgSup=[${r.bgSup.join(",")}] fgPal=[${fmt(r.fgPal)}]`
    );
    if (ok && (!winner || r.edgeSupport > winner.edgeSupport)) {
      winner = r;
      winMargin = MARGIN;
    }
  }
  if (!winner) {
    console.log(`${stem}: !! ALL configs rejected — explicit miss, no composite`);
    continue;
  }
  console.log(
    `${stem}: WIN margin=${winMargin} cov=${(100 * winner.cov).toFixed(1)}% ` +
      `edge=${winner.edgeSupport.toFixed(1)}`
  );
  const kept = winner.kept;

  const maskRaw = Buffer.alloc(w * h * 4);
  for (let i = 0; i < kept.length; i++) {
    maskRaw[i * 4 + 3] = kept[i] ? 255 : 0;
  }
  const meta = await sharp(srcPath).metadata();
  const maskFull = await sharp(maskRaw, {
    raw: { width: w, height: h, channels: 4 },
  })
    .resize(meta.width, meta.height, { fit: "fill", kernel: "lanczos3" })
    .blur(2)
    .png()
    .toBuffer();
  await sharp(maskRaw, { raw: { width: w, height: h, channels: 4 } })
    .png()
    .toFile(join(outDir, `${stem}-mask.png`));

  const cutBuf = await sharp(srcPath)
    .ensureAlpha()
    .composite([{ input: maskFull, blend: "dest-in" }])
    .png()
    .toBuffer();

  const trimmed = await sharp(cutBuf).trim({ threshold: 10 }).toBuffer();
  const tm = await sharp(trimmed)
    .toBuffer({ resolveWithObject: true })
    .then(({ data, info: ti }) => ({ data, w: ti.width, h: ti.height }));
  const maxW = Math.round(W * (1 - PAD * 2));
  const maxH = Math.round(H * (1 - PAD * 2));
  const scale = Math.min(maxW / tm.w, maxH / tm.h);
  const dw = Math.max(1, Math.round(tm.w * scale));
  const dh = Math.max(1, Math.round(tm.h * scale));
  const dx = Math.round((W - dw) / 2);
  const dy = Math.round((H - dh) / 2);
  const fitted = await sharp(trimmed).resize(dw, dh, { fit: "fill" }).toBuffer();
  const shW = Math.round(dw * 0.62);
  const shH = Math.max(16, Math.round(dh * 0.045));
  const shY = Math.min(H - shH, dy + dh + Math.round(shH * 0.4));
  const shadow = await sharp(
    Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><ellipse cx="${W / 2}" cy="${shY}" rx="${Math.round(shW / 2)}" ry="${Math.round(shH / 2)}" fill="#3A3428" fill-opacity="0.34"/></svg>`
    )
  )
    .blur(16)
    .toBuffer();
  const backdrop = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4F1EB"/><stop offset="0.62" stop-color="#ECE7DD"/><stop offset="1" stop-color="#DCD5C7"/></linearGradient><radialGradient id="gl" cx="0.5" cy="0.42" r="0.75"><stop offset="0" stop-color="#FFFFFF" stop-opacity="0.85"/><stop offset="0.55" stop-color="#FFFFFF" stop-opacity="0.25"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#bg)"/><rect width="${W}" height="${H}" fill="url(#gl)"/></svg>`
  );
  await sharp(backdrop)
    .composite([
      { input: shadow, left: 0, top: 0 },
      { input: fitted, left: dx, top: dy },
    ])
    .jpeg({ quality: 88 })
    .toFile(join(outDir, `${stem}-studio.jpg`));
  console.log(`   wrote ${stem}-studio.jpg (${dw}x${dh})`);
}
console.log("done ->", outDir);

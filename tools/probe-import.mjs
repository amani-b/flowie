// Phase 1 gate probe, step 2: the FULL import path (startImport) on real
// garment photography, so the auto-tagger is judged on actual clothing.
// The first pass fed five arbitrary phone camera photos (not clothing) and
// the tagger dutifully invented three dark "tops" from them — evidence of
// nothing. These are the repo's own garment assets, verified by eye:
//   olive-tee  -> green tee          (out/pollinations/audit2-4)
//   shorts     -> black hoodie+shorts (out/pollinations/audit2-2)
//   hoodie     -> hoodie on a person (out/pollinations/audit3-1)
//   polo-shirt -> yellow polo        (flatlay-review/spike-r1)
//   trousers   -> red trousers       (flatlay-review/spike-r2)
const EXPECT = {
  "garment-olive-tee.jpg": "top",
  "garment-shorts.jpg": "bottom",
  "garment-hoodie.jpg": "outerwear",
  "garment-polo-shirt.png": "top",
  "garment-trousers.png": "bottom",
};

const storeMod = await import("/src/store/appStore.ts");
const store = storeMod.useAppStore;
const importMod = await import("/src/services/uploadQueue.ts");
const files = Object.keys(EXPECT);

// Purge the bogus non-garment imports from the previous run.
const BAD = ["1000027292", "1000027291", "1000027293"];
const purged = [];
for (const g of [...store.getState().garments]) {
  if (BAD.includes(g.name)) {
    store.getState().removeGarment(g.id);
    purged.push(g.name);
  }
}

const items = [];
for (const n of files) {
  const buf = await (await fetch(`/_tmp_photos/${n}`)).arrayBuffer();
  const type = n.endsWith(".png") ? "image/png" : "image/jpeg";
  items.push({ file: new File([buf], n, { type }), fileName: n });
}

const tagged = [];
let added = 0;
let total = 0;
const errors = [];
// Time-to-first-item is the Phase 1 claim: the sheet closes immediately and
// items land as they finish, so the first one must appear long before the
// last, and the whole batch must outlive the caller's attention.
const arrival = [];
let firstItemMs = null;

const t0 = performance.now();
await new Promise((resolve) => {
  importMod.startImport(items, {
    onItem: (garment, _tags, fileName) => {
      const at = Math.round(performance.now() - t0);
      if (firstItemMs === null) firstItemMs = at;
      arrival.push({ fileName, atMs: at });
      added++;
      // Land it in the real closet, as the UI does on the default path.
      void store.getState().addGarment(garment, garment.photo);
      tagged.push({
        file: fileName,
        expect: EXPECT[fileName],
        got: garment.category,
        match: garment.category === EXPECT[fileName],
        name: garment.name,
        color: garment.color,
        pattern: garment.pattern,
        hasPrint: garment.hasPrint ?? null,
        photoKB: Math.round((garment.photo || "").length / 1024),
      });
    },
    onProgress: (d, n) => {
      done = d;
      total = n;
    },
    onError: (fileName, message) => errors.push({ fileName, message }),
    onComplete: () => resolve(),
  });
});
const totalMs = Math.round(performance.now() - t0);

return {
  purged,
  added,
  total,
  totalMs,
  firstItemMs,
  // The gap is the whole point: a blocking import would show ~0ms spread.
  spreadMs: totalMs - (firstItemMs ?? 0),
  arrival,
  errors,
  matches: tagged.filter((t) => t.match).length,
  of: tagged.length,
  tagged,
  garmentsNow: store.getState().garments.length,
};


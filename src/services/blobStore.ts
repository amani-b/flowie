/**
 * Garment image blob store (IndexedDB) — speed companion.
 *
 * Why this exists: the zustand persist layer serialises the whole closet to
 * localStorage (~5 MB quota) on EVERY store mutation. A 40-item closet with
 * ~200 KB recon PNGs each is ~8 MB of JSON stringify/parse per
 * write — jank on every progress tick, and a quota wall as closets grow.
 * Photos were already omitted; recon images are the remaining weight.
 *
 * This store keeps `photo` + `recon` data URLs (keyed by garment
 * id) in IndexedDB (GB-scale quota, async, off the critical path) while the
 * persisted zustand snapshot stays lean (SVG strings + recon URL strings
 * only — a few KB per garment). Tiles paint instantly from the lean state;
 * blobs merge in silently when loads land and swap the image source.
 *
 * Contract: every function is best-effort and never throws — callers never
 * await. A missing blob just means the SVG/photo fallback shows (which is
 * always correct). Remote-URL photos are never stored (the cloud is their
 * store); only `data:` URLs go in.
 */

export type BlobKind = "photo" | "recon";

const DB_NAME = "flowie-blobs";
const STORE_NAME = "blobs";
/**
 * Second store (DB v1 → v2): content-addressed recon results. Kept apart from
 * `blobs` because the two are keyed completely differently — `blobs` is keyed
 * by garment id and dies with the garment, while this store is keyed by
 * source-content hash (see `services/reconCache.ts`) and must OUTLIVE the
 * garment, so re-importing the same photo is a cache hit instead of a fresh
 * remote call. Sharing one store would also break `loadAllBlobs`/`pruneBlobs`,
 * which parse the `kind:id` key format.
 */
const CACHE_STORE_NAME = "reconCache";
const DB_VERSION = 2;

const keyFor = (id: string, kind: BlobKind): string => `${kind}:${id}`;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> | null {
  try {
    if (typeof window === "undefined" || !("indexedDB" in window)) return null;
    if (!dbPromise) {
      dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
        const req = window.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME);
          }
          // v1 → v2: additive only. An existing v1 database keeps every
          // `blobs` entry — this creates the new store alongside it.
          if (!db.objectStoreNames.contains(CACHE_STORE_NAME)) {
            db.createObjectStore(CACHE_STORE_NAME);
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error ?? new Error("IDB open failed"));
        req.onblocked = () => reject(new Error("IDB blocked"));
      }).catch((e) => {
        // Reset so a later call can retry; callers treat failure as miss.
        dbPromise = null;
        throw e;
      });
    }
    return dbPromise;
  } catch {
    return null;
  }
}

function tx(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  storeName: string = STORE_NAME
): IDBObjectStore | null {
  try {
    return db.transaction(storeName, mode).objectStore(storeName);
  } catch {
    return null;
  }
}

/** Fire-and-forget write. Only `data:` URLs are stored; anything else ignored. */
export function saveBlob(id: string, kind: BlobKind, dataUrl: string): void {
  try {
    if (!dataUrl || !dataUrl.startsWith("data:")) return;
    const open = openDb();
    if (!open) return;
    void open
      .then((db) => {
        const store = tx(db, "readwrite");
        if (!store) return;
        store.put(dataUrl, keyFor(id, kind));
      })
      .catch(() => {
        /* best-effort */
      });
  } catch {
    /* best-effort */
  }
}

/** Read one blob; resolves null on any miss/failure (fallback shows). */
export function loadBlob(id: string, kind: BlobKind): Promise<string | null> {
  const open = openDb();
  if (!open) return Promise.resolve(null);
  return open
    .then(
      (db) =>
        new Promise<string | null>((resolve) => {
          try {
            const store = tx(db, "readonly");
            if (!store) {
              resolve(null);
              return;
            }
            const req = store.get(keyFor(id, kind));
            req.onsuccess = () =>
              resolve(typeof req.result === "string" ? req.result : null);
            req.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        })
    )
    .catch(() => null);
}

/** Delete both blobs for a garment (remove-from-closet path). */
export function deleteBlobsFor(id: string): void {
  try {
    const open = openDb();
    if (!open) return;
    void open
      .then((db) => {
        const store = tx(db, "readwrite");
        if (!store) return;
        store.delete(keyFor(id, "photo"));
        store.delete(keyFor(id, "recon"));
      })
      .catch(() => {
        /* best-effort */
      });
  } catch {
    /* best-effort */
  }
}

/** Wipe the whole blob store (erase-all-data path). */
export function clearBlobs(): void {
  try {
    const open = openDb();
    if (!open) return;
    void open
      .then((db) => {
        const store = tx(db, "readwrite");
        if (!store) return;
        store.clear();
      })
      .catch(() => {
        /* best-effort */
      });
  } catch {
    /* best-effort */
  }
}

export interface BlobPair {
  photo?: string;
  recon?: string;
}

/**
 * Load every stored blob, grouped by garment id. Used at boot to merge
 * missing sources back into the lean state, and to backfill from in-state
 * values on first run after the v10 persist change.
 */
export function loadAllBlobs(): Promise<Map<string, BlobPair>> {
  const out = new Map<string, BlobPair>();
  const open = openDb();
  if (!open) return Promise.resolve(out);
  return open
    .then(
      (db) =>
        new Promise<Map<string, BlobPair>>((resolve) => {
          try {
            const store = tx(db, "readonly");
            if (!store || !("getAllKeys" in store)) {
              resolve(out);
              return;
            }
            const keyReq = store.getAllKeys();
            keyReq.onsuccess = () => {
              try {
                const keys = (keyReq.result ?? []) as IDBValidKey[];
                if (keys.length === 0) {
                  resolve(out);
                  return;
                }
                let pending = keys.length;
                const done = () => {
                  if (--pending === 0) resolve(out);
                };
                for (const k of keys) {
                  if (typeof k !== "string") {
                    done();
                    continue;
                  }
                  const getReq = store.get(k);
                  getReq.onsuccess = () => {
                    try {
                      const sep = k.indexOf(":");
                      if (sep > 0 && typeof getReq.result === "string") {
                        const kind = k.slice(0, sep);
                        const id = k.slice(sep + 1);
                        if (kind === "photo" || kind === "recon") {
                          const cur = out.get(id) ?? {};
                          (cur as Record<string, string>)[kind] = getReq.result;
                          out.set(id, cur);
                        }
                      }
                    } catch {
                      /* skip bad entry */
                    }
                    done();
                  };
                  getReq.onerror = done;
                }
              } catch {
                resolve(out);
              }
            };
            keyReq.onerror = () => resolve(out);
          } catch {
            resolve(out);
          }
        })
    )
    .catch(() => out);
}

/** Drop blobs for garments that no longer exist (quota hygiene). */
export function pruneBlobs(liveIds: Set<string>): void {
  try {
    const open = openDb();
    if (!open) return;
    void open
      .then((db) => {
        const store = tx(db, "readwrite");
        if (!store || !("getAllKeys" in store)) return;
        const keyReq = store.getAllKeys();
        keyReq.onsuccess = () => {
          try {
            const keys = ((keyReq.result ?? []) as IDBValidKey[]).filter(
              (k): k is string => typeof k === "string"
            );
            for (const k of keys) {
              const sep = k.indexOf(":");
              const id = sep > 0 ? k.slice(sep + 1) : "";
              if (id && !liveIds.has(id)) {
                try {
                  store.delete(k);
                } catch {
                  /* skip */
                }
              }
            }
          } catch {
            /* best-effort */
          }
        };
      })
      .catch(() => {
        /* best-effort */
      });
  } catch {
    /* best-effort */
  }
}

/* ------------------- content-addressed recon cache -------------------- */
// Keyed by source-content hash, NOT garment id: the whole point is that a
// different garment built from identical source bytes reuses the render.
// Values are recon data URLs. Never throws — callers treat failure as a miss
// (which just means one extra remote call, the safe direction to fail).

/** Fire-and-forget write of one cache entry. */
export function saveCacheEntry(key: string, value: string): void {
  try {
    if (!key || !value) return;
    const open = openDb();
    if (!open) return;
    void open
      .then((db) => {
        const store = tx(db, "readwrite", CACHE_STORE_NAME);
        if (!store) return;
        store.put(value, key);
      })
      .catch(() => {
        /* best-effort */
      });
  } catch {
    /* best-effort */
  }
}

/** Read one cache entry; resolves null on any miss/failure. */
export function loadCacheEntry(key: string): Promise<string | null> {
  const open = openDb();
  if (!open) return Promise.resolve(null);
  return open
    .then(
      (db) =>
        new Promise<string | null>((resolve) => {
          try {
            const store = tx(db, "readonly", CACHE_STORE_NAME);
            if (!store) {
              resolve(null);
              return;
            }
            const req = store.get(key);
            req.onsuccess = () =>
              resolve(typeof req.result === "string" ? req.result : null);
            req.onerror = () => resolve(null);
          } catch {
            resolve(null);
          }
        })
    )
    .catch(() => null);
}

/** Drop one cache entry (invalidation / wrong-image recovery). */
export function deleteCacheEntry(key: string): void {
  try {
    const open = openDb();
    if (!open) return;
    void open
      .then((db) => {
        const store = tx(db, "readwrite", CACHE_STORE_NAME);
        if (!store) return;
        store.delete(key);
      })
      .catch(() => {
        /* best-effort */
      });
  } catch {
    /* best-effort */
  }
}

/** Wipe the whole recon cache (kill-switch recovery after a wrong image). */
export function clearCacheStore(): void {
  try {
    const open = openDb();
    if (!open) return;
    void open
      .then((db) => {
        const store = tx(db, "readwrite", CACHE_STORE_NAME);
        if (!store) return;
        store.clear();
      })
      .catch(() => {
        /* best-effort */
      });
  } catch {
    /* best-effort */
  }
}

/** How many recon results are cached — diagnostics/evidence only. */
export function cacheEntryCount(): Promise<number> {
  const open = openDb();
  if (!open) return Promise.resolve(0);
  return open
    .then(
      (db) =>
        new Promise<number>((resolve) => {
          try {
            const store = tx(db, "readonly", CACHE_STORE_NAME);
            if (!store || !("count" in store)) {
              resolve(0);
              return;
            }
            const req = store.count();
            req.onsuccess = () => resolve(typeof req.result === "number" ? req.result : 0);
            req.onerror = () => resolve(0);
          } catch {
            resolve(0);
          }
        })
    )
    .catch(() => 0);
}

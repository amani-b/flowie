/**
 * Per-tile image resolution (memory LRU → IndexedDB → http(s) ref).
 *
 * Why this exists: boot used to call `loadAllBlobs()` and merge EVERY garment's
 * photo + recon data URL back into the store. That is O(closet) work before the
 * first paint, and it re-inflated in-memory state with megabytes the persister
 * then had to walk on every mutation. A tile only ever needs its own image, so
 * the work belongs to the tile, lazily, and only for what is actually on screen.
 *
 * Resolution order, cheapest first:
 *   1. `http(s)`/`blob:` reference already on the record → use it directly.
 *      This is the live/cloud case and needs no IO at all.
 *   2. Memory LRU → the tile repaints synchronously on a second mount.
 *   3. IndexedDB via `loadBlob(id, kind)` → the durable copy.
 *   4. `null` → the caller keeps showing photo/SVG. Never an error: a missing
 *      image is a normal state, not a failure.
 *
 * `data:` URLs that are already in state are passed through: they are what the
 * SVG rendering and freshly-imported photos are, and rejecting them would break
 * every first paint.
 *
 * Nothing here throws and nothing persists image bytes — it only reads.
 */

import { loadBlob, type BlobKind } from "./blobStore";

/** A resolved source is always a string the browser can put in `src`. */
export type ResolvedImage = string | null;

/** Cap on the memory layer. Images are big; a small LRU is the point. */
const MEMORY_MAX = 24;

/** Insertion-ordered Map used as a crude LRU (re-insert on read). */
const memory = new Map<string, string>();

/** In-flight reads, so two tiles for one garment share a single IDB round trip. */
const inflight = new Map<string, Promise<ResolvedImage>>();

const keyFor = (id: string, kind: BlobKind) => `${kind}:${id}`;

/**
 * A `data:` URL is a legitimate source (SVG renderings and just-imported
 * photos are exactly this). An `http(s)`/`blob:` URL is already remote or
 * object-backed. Both are returned as-is; only a *missing* value falls through
 * to storage.
 */
function isDirectSource(url: string | undefined | null): url is string {
  if (!url) return false;
  return (
    url.startsWith("data:") ||
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("blob:")
  );
}

function rememberInMemory(key: string, value: string): void {
  if (memory.has(key)) memory.delete(key);
  memory.set(key, value);
  while (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memory.delete(oldest.value);
  }
}

/** Synchronous memory hit, for a paint without a flash of the fallback. */
export function peekImage(id: string, kind: BlobKind): ResolvedImage {
  return memory.get(keyFor(id, kind)) ?? null;
}

/**
 * Resolve the best available source for one garment image.
 *
 * `current` is the value already on the record (may be a `data:` URL, an
 * `http(s)` URL, or absent). Pass it so the hot path stays IO-free.
 */
export function resolveImage(
  id: string,
  kind: BlobKind,
  current?: string | null
): Promise<ResolvedImage> {
  const key = keyFor(id, kind);

  // 1. Already usable (remote ref, blob:, or an in-state data URL).
  if (isDirectSource(current)) {
    if (current.startsWith("data:")) rememberInMemory(key, current);
    return Promise.resolve(current);
  }

  // 2. Memory LRU.
  const hot = memory.get(key);
  if (typeof hot === "string" && hot) {
    rememberInMemory(key, hot);
    return Promise.resolve(hot);
  }

  // 3. Coalesced IndexedDB read.
  const existing = inflight.get(key);
  if (existing) return existing;

  const work = loadBlob(id, kind)
    .then((stored) => {
      if (typeof stored === "string" && stored) {
        rememberInMemory(key, stored);
        return stored;
      }
      return null;
    })
    .catch(() => null)
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, work);
  return work;
}

/** Forget one entry, memory only (storage deletion is `deleteBlobsFor`). */
export function forgetImage(id: string, kind: BlobKind): void {
  memory.delete(keyFor(id, kind));
}

/** Drop the memory layer entirely — test seam / wrong-image recovery. */
export function clearImageCache(): void {
  memory.clear();
  inflight.clear();
}

/** In-memory entry count — diagnostics/evidence only. */
export function imageCacheSize(): number {
  return memory.size;
}

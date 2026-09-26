/**
 * Content-addressed cache for garment reconstruction results.
 *
 * Why this exists: recon is the expensive step — one remote call to a free
 * ZeroGPU Space with a hard daily budget (see `garmentRecon.RECON_DAILY_BUDGET`),
 * ~30–60 s each, serialised. Re-importing the same photo (re-installing,
 * re-adding a garment after a delete, importing the same file twice) used to
 * spend a fresh call every time and produce a byte-identical result. The
 * Phase 1 worker already computes a SHA-256 of the prepared image for exactly
 * this purpose (`PreparedImage.sha256`); this module turns it into a key.
 *
 * The cache is keyed by the *full set of inputs that determine the output*
 * (source bytes + renderer + recon class + seed), so a cached entry can never
 * be mistaken for a different render — toggling the print flag changes the
 * renderer and therefore the key.
 *
 * STORAGE
 * - Memory `Map` first (instant, survives nothing), IDB second (survives
 *   reload, and deliberately OUTLIVES the garment — that is what makes
 *   re-import a hit). Writes are fire-and-forget; reads never throw.
 * - Failure always degrades to a miss, i.e. one extra remote call. That is
 *   the safe direction: a miss costs quota, a false hit costs correctness.
 *
 * KILL SWITCH
 * `RECON_CACHE_ENABLED = false` disables both read and write, so every job
 * makes a real call again. Flip it on a wrong-image P0 report to confirm
 * whether the cache is implicated before doing anything more invasive, then
 * `clearReconCache()` and re-enable.
 */

import {
  loadCacheEntry,
  saveCacheEntry,
  deleteCacheEntry,
  clearCacheStore,
} from "./blobStore";
import type { ReconClass, ReconRenderer } from "./garmentRecon";

/**
 * Kill switch. `false` = cache fully bypassed (no reads, no writes) so every
 * recon job calls the backend exactly as it did before this module existed.
 */
export const RECON_CACHE_ENABLED = true;

/**
 * Bump when a backend or preprocessing change alters output for identical
 * inputs — it namespaces every key, so old entries simply stop matching
 * instead of being served as if still valid.
 */
export const RECON_CACHE_VERSION = 1;

export interface ReconCacheKeyParts {
  /** Preferred: SHA-256 of the prepared image bytes (Phase 1 pipeline). */
  sha256?: string;
  /** Fallback identity when no hash is available (legacy/manual records). */
  bytes?: number;
  renderer: ReconRenderer;
  reconClass: ReconClass;
  seed: number;
}

/**
 * Deterministic cache key. Every output-determining input is included, so
 * two entries can only collide when they should.
 *
 * `sha256` is the real identity; `bytes` is a deliberately weaker fallback
 * (used for garments imported before hashing was recorded) — a byte-length
 * collision across different images would be a wrong-image bug, which is why
 * the hash is preferred wherever it exists.
 */
export function reconCacheKey(p: ReconCacheKeyParts): string {
  const content = p.sha256 ? `sha=${p.sha256}` : `len=${p.bytes ?? 0}`;
  return [
    `v${RECON_CACHE_VERSION}`,
    content,
    `r=${p.renderer}`,
    `c=${p.reconClass}`,
    `s=${p.seed}`,
  ].join("|");
}

/** Cap on the in-memory layer; IDB remains the durable layer. */
const MEMORY_MAX = 40;

/** Insertion-ordered Map used as a crude LRU (re-insert on read). */
const memory = new Map<string, string>();

function rememberInMemory(key: string, value: string): void {
  // Re-insert so the most recently used key is last (eviction order).
  if (memory.has(key)) memory.delete(key);
  memory.set(key, value);
  while (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next();
    if (oldest.done) break;
    memory.delete(oldest.value);
  }
}

/**
 * Look up a cached recon result. Resolves null on miss, on any storage
 * failure, or when the kill switch is off.
 */
export async function lookupRecon(key: string): Promise<string | null> {
  if (!RECON_CACHE_ENABLED || !key) return null;
  const hot = memory.get(key);
  if (typeof hot === "string" && hot) {
    // Refresh recency without a second IDB round trip.
    rememberInMemory(key, hot);
    return hot;
  }
  const stored = await loadCacheEntry(key);
  if (typeof stored === "string" && stored) {
    rememberInMemory(key, stored);
    return stored;
  }
  return null;
}

/** Store a recon result. Fire-and-forget; no-op when disabled or empty. */
export function putRecon(key: string, dataUrl: string): void {
  if (!RECON_CACHE_ENABLED || !key || !dataUrl) return;
  rememberInMemory(key, dataUrl);
  saveCacheEntry(key, dataUrl);
}

/** Forget one entry, in both layers. */
export function invalidateRecon(key: string): void {
  if (!key) return;
  memory.delete(key);
  deleteCacheEntry(key);
}

/** Forget everything, in both layers (wrong-image recovery). */
export function clearReconCache(): void {
  memory.clear();
  clearCacheStore();
}

/** In-memory entry count — diagnostics/evidence only. */
export function reconCacheSize(): number {
  return memory.size;
}

/** Test seam: drop the memory layer (the kill switch is a const by design). */
export function resetReconCacheForTests(): void {
  memory.clear();
}

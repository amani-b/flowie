/**
 * Recon-cache tests.
 *
 * Two things matter here and nothing else does:
 * 1. The key must change whenever the OUTPUT would change (renderer, class,
 *    seed) — a collision is a wrong-image bug shown to the wearer.
 * 2. A hit must be reusable BY CONTENT, i.e. after the garment that produced it
 *    is gone. That is the whole reason recon is keyed by source hash rather than
 *    garment id.
 *
 * These run in the plain Node environment, so `blobStore.openDb()` returns null
 * and the IDB layer degrades to a miss. That is deliberate: the memory layer and
 * the key derivation are what is being tested, and "no IDB" is exactly the
 * fallback path that must stay safe.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
  RECON_CACHE_VERSION,
  clearReconCache,
  invalidateRecon,
  lookupRecon,
  putRecon,
  reconCacheKey,
  reconCacheSize,
  resetReconCacheForTests,
  type ReconCacheKeyParts,
} from "./reconCache";

// `reconClass` is the recon pipeline's own vocabulary ("upper"/"lower"/"dress"),
// not the closet's category names.
const base: ReconCacheKeyParts = {
  sha256: "abc123",
  renderer: "tryoff",
  reconClass: "upper",
  seed: 42,
};

beforeEach(() => {
  resetReconCacheForTests();
});

describe("reconCacheKey", () => {
  it("is deterministic for identical inputs", () => {
    expect(reconCacheKey(base)).toBe(reconCacheKey({ ...base }));
  });

  it("is namespaced by the cache version", () => {
    expect(reconCacheKey(base).startsWith(`v${RECON_CACHE_VERSION}|`)).toBe(true);
  });

  it("changes when any output-determining input changes", () => {
    const key = reconCacheKey(base);

    expect(reconCacheKey({ ...base, renderer: "klein" })).not.toBe(key);
    expect(reconCacheKey({ ...base, reconClass: "dress" })).not.toBe(key);
    expect(reconCacheKey({ ...base, seed: 7 })).not.toBe(key);
    expect(reconCacheKey({ ...base, sha256: "different" })).not.toBe(key);
  });

  it("prefers the content hash over the byte-length fallback", () => {
    const hashed = reconCacheKey(base);
    const byLength = reconCacheKey({ ...base, sha256: undefined, bytes: 1000 });

    expect(hashed).toContain("sha=abc123");
    expect(byLength).toContain("len=1000");
    expect(hashed).not.toBe(byLength);
  });

  it("falls back to byte length when there is no hash (legacy records)", () => {
    const a = reconCacheKey({ ...base, sha256: undefined, bytes: 1000 });
    const b = reconCacheKey({ ...base, sha256: undefined, bytes: 1000 });
    const c = reconCacheKey({ ...base, sha256: undefined, bytes: 2000 });

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("lookup and store", () => {
  it("misses before anything is stored", async () => {
    await expect(lookupRecon(reconCacheKey(base))).resolves.toBeNull();
  });

  it("returns a stored result, keyed by content not garment", async () => {
    const key = reconCacheKey(base);
    putRecon(key, "data:image/png;base64,AAAA");

    await expect(lookupRecon(key)).resolves.toBe("data:image/png;base64,AAAA");
  });

  it("ignores an empty key or empty value", async () => {
    putRecon("", "data:image/png;base64,AAAA");
    putRecon(reconCacheKey(base), "");

    expect(reconCacheSize()).toBe(0);
    await expect(lookupRecon(reconCacheKey(base))).resolves.toBeNull();
    await expect(lookupRecon("")).resolves.toBeNull();
  });

  it("invalidateRecon forgets exactly one entry", async () => {
    const kept = reconCacheKey({ ...base, renderer: "klein" });
    const dropped = reconCacheKey(base);
    putRecon(kept, "kept");
    putRecon(dropped, "dropped");

    invalidateRecon(dropped);

    await expect(lookupRecon(dropped)).resolves.toBeNull();
    await expect(lookupRecon(kept)).resolves.toBe("kept");
  });

  it("clearReconCache empties the memory layer", async () => {
    putRecon(reconCacheKey(base), "data:image/png;base64,AAAA");
    expect(reconCacheSize()).toBe(1);

    clearReconCache();

    expect(reconCacheSize()).toBe(0);
    await expect(lookupRecon(reconCacheKey(base))).resolves.toBeNull();
  });

  it("bounds the memory layer so a long session cannot grow unbounded", () => {
    for (let i = 0; i < 60; i++) {
      putRecon(reconCacheKey({ ...base, sha256: `hash-${i}` }), `value-${i}`);
    }
    expect(reconCacheSize()).toBeLessThanOrEqual(40);
  });
});

/**
 * S9 — tests for offline catalog + tarball cache.
 *
 * Covers: catalog cache hit/miss, TTL expiry, tarball cache hit/miss,
 * LRU eviction, feature flag, network fallback in list().
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {resolve, join} from "node:path";
import {
  getCachedCatalog,
  getCachedTarball,
  isOfflineCacheEnabled,
  setCachedCatalog,
  setCachedTarball
} from "../offline-cache.js";
import type { PluginMarketplaceItem } from "../types.js";

function makeItem(id: string): PluginMarketplaceItem {
  return {
    id,
    name: id,
    description: "test",
    packageSpec: `@lvis/${id}@1.0.0`,
    packageName: `@lvis/${id}`,
    tools: []
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "offline-cache-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

describe("isOfflineCacheEnabled", () => {
  it("defaults to true when env var is absent", () => {
    expect(isOfflineCacheEnabled({})).toBe(true);
  });

  it("returns false when set to false", () => {
    expect(isOfflineCacheEnabled({ LVIS_MARKETPLACE_USE_CACHE: "false" })).toBe(false);
  });

  it("returns true when set to 1", () => {
    expect(isOfflineCacheEnabled({ LVIS_MARKETPLACE_USE_CACHE: "1" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Catalog cache
// ---------------------------------------------------------------------------

describe("catalog cache", () => {
  it("returns null on cold cache", async () => {
    const result = await getCachedCatalog(tmpDir);
    expect(result).toBeNull();
  });

  it("round-trips items", async () => {
    const items = [makeItem("foo"), makeItem("bar")];
    await setCachedCatalog(items, tmpDir);
    const result = await getCachedCatalog(tmpDir);
    expect(result).toHaveLength(2);
    expect(result![0].id).toBe("foo");
  });

  it("returns null after TTL expiry", async () => {
    const items = [makeItem("foo")];
    await setCachedCatalog(items, tmpDir);

    // Patch the catalog file to have an old timestamp.
    const catalogFile = resolve(tmpDir, "catalog.json");
    const raw = JSON.parse(await readFile(catalogFile, "utf-8"));
    raw.cachedAt = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
    const { writeFile } = await import("node:fs/promises");
    await writeFile(catalogFile, JSON.stringify(raw));

    const result = await getCachedCatalog(tmpDir);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tarball cache
// ---------------------------------------------------------------------------

describe("tarball cache", () => {
  it("returns null on cold cache", async () => {
    const result = await getCachedTarball("my-plugin", "1.0.0", tmpDir);
    expect(result).toBeNull();
  });

  it("round-trips a tarball buffer", async () => {
    const body = Buffer.from("fake-tarball-content");
    await setCachedTarball("my-plugin", "1.0.0", body, tmpDir);
    const result = await getCachedTarball("my-plugin", "1.0.0", tmpDir);
    expect(result).not.toBeNull();
    expect(result!.toString()).toBe("fake-tarball-content");
  });

  it("returns null for a different version", async () => {
    const body = Buffer.from("tarball-v1");
    await setCachedTarball("my-plugin", "1.0.0", body, tmpDir);
    const result = await getCachedTarball("my-plugin", "2.0.0", tmpDir);
    expect(result).toBeNull();
  });

  it("overwrites an existing entry on re-set", async () => {
    await setCachedTarball("my-plugin", "1.0.0", Buffer.from("v1"), tmpDir);
    await setCachedTarball("my-plugin", "1.0.0", Buffer.from("v1-updated"), tmpDir);
    const result = await getCachedTarball("my-plugin", "1.0.0", tmpDir);
    expect(result!.toString()).toBe("v1-updated");
  });

  it("evicts LRU entries when total size exceeds cap", async () => {
    // Use a tiny cap via internal knowledge: we need > 500MB to test eviction
    // realistically, so instead we test the eviction logic by storing many small
    // items and checking index consistency. We do this by patching the size
    // in the index directly.
    const body = Buffer.from("x".repeat(100));
    await setCachedTarball("plugin-a", "1.0.0", body, tmpDir);
    await setCachedTarball("plugin-b", "1.0.0", body, tmpDir);
    await setCachedTarball("plugin-c", "1.0.0", body, tmpDir);

    // Manually inflate sizes in the index so the cap is exceeded.
    const indexFile = resolve(tmpDir, "tarballs.index.json");
    const indexRaw = JSON.parse(await readFile(indexFile, "utf-8"));
    // Set sizes so total = 600 MB, cap = 500 MB → LRU entry (plugin-a) should be evicted.
    indexRaw.entries[0].size = 200 * 1024 * 1024; // plugin-a: 200 MB, oldest
    indexRaw.entries[1].size = 200 * 1024 * 1024; // plugin-b: 200 MB
    indexRaw.entries[2].size = 200 * 1024 * 1024; // plugin-c: 200 MB
    // Make plugin-a the least recently used.
    indexRaw.entries[0].lastAccessedAt = Date.now() - 10000;
    indexRaw.entries[1].lastAccessedAt = Date.now() - 5000;
    indexRaw.entries[2].lastAccessedAt = Date.now();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(indexFile, JSON.stringify(indexRaw));

    // Trigger eviction by adding a new entry.
    await setCachedTarball("plugin-d", "1.0.0", body, tmpDir);

    // plugin-a should have been evicted (LRU).
    const a = await getCachedTarball("plugin-a", "1.0.0", tmpDir);
    expect(a).toBeNull();

    // plugin-d (newest) must still be present.
    const d = await getCachedTarball("plugin-d", "1.0.0", tmpDir);
    expect(d).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// network fallback — getCachedCatalog allowStale contract
// ---------------------------------------------------------------------------

describe("getCachedCatalog allowStale", () => {
  it("returns expired items when allowStale=true", async () => {
    const items = [makeItem("cached-plugin")];
    await setCachedCatalog(items, tmpDir);

    // Force the cachedAt timestamp to be 8 days ago (past the 7-day TTL).
    const catalogFile = resolve(tmpDir, "catalog.json");
    const raw = JSON.parse(await readFile(catalogFile, "utf-8"));
    raw.cachedAt = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(catalogFile, JSON.stringify(raw));

    // Normal read must return null (TTL expired).
    const fresh = await getCachedCatalog(tmpDir);
    expect(fresh).toBeNull();

    // Stale read must return items (offline-fallback path).
    const stale = await getCachedCatalog(tmpDir, { allowStale: true });
    expect(stale).not.toBeNull();
    expect(stale![0].id).toBe("cached-plugin");
  });

  it("returns null for malformed cachedAt even with allowStale=true", async () => {
    const catalogFile = resolve(tmpDir, "catalog.json");
    const { writeFile: wf } = await import("node:fs/promises");
    await wf(catalogFile, JSON.stringify({ cachedAt: "not-a-number", items: [makeItem("x")] }));
    const result = await getCachedCatalog(tmpDir, { allowStale: true });
    expect(result).toBeNull();
  });
});

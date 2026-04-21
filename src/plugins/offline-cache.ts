/**
 * S9 — Offline catalog + tarball cache.
 *
 * Persists the marketplace catalog (7d TTL) and plugin tarballs (LRU 500 MB)
 * under `~/.lvis/marketplace-cache/` so the app degrades gracefully when the
 * network is unavailable.
 *
 * No telemetry is emitted from cache operations.
 */
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import type { PluginMarketplaceItem } from "./types.js";

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

/**
 * Returns `true` when the offline cache is enabled.
 * Defaults to `true`; set `LVIS_MARKETPLACE_USE_CACHE=false` to disable.
 */
export function isOfflineCacheEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LVIS_MARKETPLACE_USE_CACHE;
  if (v === undefined) return true;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

// ---------------------------------------------------------------------------
// Paths + constants
// ---------------------------------------------------------------------------

const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TARBALL_CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500 MB

interface CacheRoot {
  catalogFile: string;
  tarballDir: string;
  indexFile: string;
}

function cacheRoots(base?: string): CacheRoot {
  const root = base ?? resolve(homedir(), ".lvis/marketplace-cache");
  return {
    catalogFile: resolve(root, "catalog.json"),
    tarballDir: resolve(root, "tarballs"),
    indexFile: resolve(root, "tarballs.index.json"),
  };
}

// ---------------------------------------------------------------------------
// Catalog cache
// ---------------------------------------------------------------------------

interface CatalogCacheFile {
  cachedAt: number; // unix ms
  items: PluginMarketplaceItem[];
}

/**
 * Returns cached catalog items when the cache exists and has not expired,
 * otherwise returns `null`.
 *
 * Pass `{ allowStale: true }` to return items even when the TTL has expired
 * (used as a network-failure fallback so the UI remains functional offline).
 */
export async function getCachedCatalog(
  base?: string,
  opts?: { allowStale?: boolean },
): Promise<PluginMarketplaceItem[] | null> {
  const { catalogFile } = cacheRoots(base);
  try {
    const raw = await readFile(catalogFile, "utf-8");
    const parsed = JSON.parse(raw) as CatalogCacheFile;
    if (!Array.isArray(parsed.items)) return null;
    // Reject missing/non-finite cachedAt — a malformed file must not be treated
    // as non-expired (NaN arithmetic would otherwise bypass TTL).
    if (typeof parsed.cachedAt !== "number" || !Number.isFinite(parsed.cachedAt) || parsed.cachedAt < 0) return null;
    if (!opts?.allowStale && Date.now() - parsed.cachedAt > CATALOG_TTL_MS) return null;
    return parsed.items;
  } catch {
    return null;
  }
}

/** Writes `items` to the catalog cache with the current timestamp. */
export async function setCachedCatalog(
  items: PluginMarketplaceItem[],
  base?: string,
): Promise<void> {
  const { catalogFile } = cacheRoots(base);
  try {
    await mkdir(resolve(catalogFile, ".."), { recursive: true });
    const payload: CatalogCacheFile = { cachedAt: Date.now(), items };
    await atomicWrite(catalogFile, JSON.stringify(payload, null, 2));
  } catch (err) {
    console.warn("[offline-cache] setCachedCatalog failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Tarball cache (LRU by total size)
// ---------------------------------------------------------------------------

interface TarballIndexEntry {
  slug: string;
  version: string;
  filename: string;
  size: number;
  lastAccessedAt: number; // unix ms
}

interface TarballIndex {
  entries: TarballIndexEntry[];
}

/**
 * Encodes `slug` and `version` into a safe flat filename.
 * Replaces any character that is not alphanumeric, `-`, `_`, `.`, or `@` with
 * `_` to prevent path traversal (e.g. `../` components in slug/version).
 */
function tarballFilename(slug: string, version: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9\-_.@]/g, "_");
  return `${safe(slug)}-${safe(version)}.tar.gz`;
}

/**
 * Throws if `filePath` is outside `dir` — defense-in-depth against any
 * slug/version that slips through encoding.
 */
function assertWithinDir(dir: string, filePath: string): void {
  const rel = relative(dir, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Cache path escape detected: ${filePath} is outside ${dir}`);
  }
}

async function readIndex(indexFile: string): Promise<TarballIndex> {
  try {
    const raw = await readFile(indexFile, "utf-8");
    const parsed = JSON.parse(raw) as TarballIndex;
    return Array.isArray(parsed.entries) ? parsed : { entries: [] };
  } catch {
    return { entries: [] };
  }
}

async function writeIndex(indexFile: string, index: TarballIndex): Promise<void> {
  await atomicWrite(indexFile, JSON.stringify(index, null, 2));
}

/**
 * Returns the cached tarball `Buffer` for `slug@version`, or `null` on miss.
 * Updates `lastAccessedAt` on hit (LRU tracking).
 */
export async function getCachedTarball(
  slug: string,
  version: string,
  base?: string,
): Promise<Buffer | null> {
  const { tarballDir, indexFile } = cacheRoots(base);
  const filename = tarballFilename(slug, version);
  const filePath = resolve(tarballDir, filename);
  assertWithinDir(tarballDir, filePath);
  try {
    const buf = await readFile(filePath);
    // Update LRU timestamp — best-effort, do not throw on failure.
    const index = await readIndex(indexFile);
    const entry = index.entries.find((e) => e.slug === slug && e.version === version);
    if (entry) {
      entry.lastAccessedAt = Date.now();
      await writeIndex(indexFile, index).catch(() => undefined);
    }
    return buf;
  } catch {
    return null;
  }
}

/**
 * Stores `body` as the tarball for `slug@version`.
 * Enforces the 500 MB LRU cap by evicting the least-recently-used entries.
 */
export async function setCachedTarball(
  slug: string,
  version: string,
  body: Buffer,
  base?: string,
): Promise<void> {
  const { tarballDir, indexFile } = cacheRoots(base);
  try {
    await mkdir(tarballDir, { recursive: true });
    const filename = tarballFilename(slug, version);
    const filePath = resolve(tarballDir, filename);
    assertWithinDir(tarballDir, filePath);

    // Read index, remove stale entry for this slug+version if present.
    const index = await readIndex(indexFile);
    index.entries = index.entries.filter(
      (e) => !(e.slug === slug && e.version === version),
    );

    // Persist the tarball.
    await atomicWrite(filePath, body);

    // Verify actual size on disk.
    const { size } = await stat(filePath);

    // Insert new entry.
    index.entries.push({
      slug,
      version,
      filename,
      size,
      lastAccessedAt: Date.now(),
    });

    // Evict LRU entries until total size fits within the cap.
    await evictLru(index, tarballDir, TARBALL_CACHE_MAX_BYTES);

    await mkdir(resolve(indexFile, ".."), { recursive: true });
    await writeIndex(indexFile, index);
  } catch (err) {
    console.warn("[offline-cache] setCachedTarball failed:", (err as Error).message);
  }
}

async function evictLru(
  index: TarballIndex,
  tarballDir: string,
  maxBytes: number,
): Promise<void> {
  const totalSize = () => index.entries.reduce((sum, e) => sum + e.size, 0);
  // Sort ascending by lastAccessedAt so oldest entries are first.
  index.entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  while (totalSize() > maxBytes && index.entries.length > 0) {
    const victim = index.entries.shift()!;
    const victimPath = resolve(tarballDir, victim.filename);
    await rm(victimPath, { force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Atomic write helper
// ---------------------------------------------------------------------------

async function atomicWrite(dest: string, data: string | Buffer): Promise<void> {
  // Use a unique temp path (pid + random) to avoid concurrent-writer collisions
  // and stale-tmp-from-prior-crash interference.
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, data);
    try {
      await rename(tmp, dest);
    } catch (renameErr) {
      if ((renameErr as NodeJS.ErrnoException).code === "EEXIST") {
        await rm(dest, { force: true });
        // If this rename also fails, the outer catch cleans up tmp.
        await rename(tmp, dest);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

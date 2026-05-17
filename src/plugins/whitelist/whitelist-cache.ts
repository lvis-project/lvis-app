/**
 * #893 Stage 2 — Disk cache for the marketplace whitelist registry.
 *
 * Layout under `<userData>/marketplace-whitelist/`:
 *   whitelist.json       — last good document body (utf-8 JSON)
 *   whitelist.json.sig   — sidecar signature envelope (utf-8 JSON)
 *   meta.json            — { etag?, highestSeenIssuedAt?, lastFetchAt? }
 *
 * Atomic writes: stage to `<file>.tmp.<rand>` then `rename` over the live
 * file so a crashed write never leaves a half-document on disk. Cache reads
 * tolerate missing files (returns null) but throw on malformed JSON so the
 * registry can route the corruption into audit instead of silently falling
 * back to "no cache" — silent fallback would let a partial-disk-write
 * scenario downgrade `fresh-allow` to `no-cache-and-offline`.
 */
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("whitelist-cache");

export interface WhitelistCacheMeta {
  /** Last ETag from the primary URL (for If-None-Match on next fetch). */
  etag?: string;
  /** Highest `issuedAt` ever accepted — monotonicity rollback guard. */
  highestSeenIssuedAt?: string;
  /** Wall-clock timestamp (ms) of the last successful fetch. Informational. */
  lastFetchAt?: number;
}

export interface WhitelistCacheSnapshot {
  body: string;
  signature: string;
  meta: WhitelistCacheMeta;
}

async function safeReadJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw new Error(`[whitelist-cache] read ${path}: ${(err as Error).message}`);
  }
}

async function safeReadTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`[whitelist-cache] read ${path}: ${(err as Error).message}`);
  }
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp.${randomBytes(6).toString("hex")}`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, content, { encoding: "utf-8" });
  try {
    await rename(tmp, path);
  } catch (err) {
    // Best-effort tmp cleanup; surface the underlying error.
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

/** Wraps the on-disk cache for one userData directory. */
export class WhitelistCache {
  private readonly rootDir: string;
  private readonly bodyPath: string;
  private readonly sigPath: string;
  private readonly metaPath: string;

  constructor(userDataDir: string) {
    this.rootDir = join(userDataDir, "marketplace-whitelist");
    this.bodyPath = join(this.rootDir, "whitelist.json");
    this.sigPath = join(this.rootDir, "whitelist.json.sig");
    this.metaPath = join(this.rootDir, "meta.json");
  }

  /** Load the cached snapshot or `null` when no cache exists. */
  async load(): Promise<WhitelistCacheSnapshot | null> {
    const [body, signature, meta] = await Promise.all([
      safeReadTextFile(this.bodyPath),
      safeReadTextFile(this.sigPath),
      safeReadJsonFile<WhitelistCacheMeta>(this.metaPath),
    ]);
    if (body === null || signature === null) return null;
    return {
      body,
      signature,
      meta: meta ?? {},
    };
  }

  /** Read just the meta record (etag + monotonicity floor). */
  async loadMeta(): Promise<WhitelistCacheMeta> {
    const meta = await safeReadJsonFile<WhitelistCacheMeta>(this.metaPath);
    return meta ?? {};
  }

  /** Write all three files atomically. Body + signature + meta. */
  async store(snapshot: WhitelistCacheSnapshot): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    try {
      await atomicWrite(this.bodyPath, snapshot.body);
      await atomicWrite(this.sigPath, snapshot.signature);
      await atomicWrite(this.metaPath, JSON.stringify(snapshot.meta, null, 2));
    } catch (err) {
      log.warn(`store failed: %s`, (err as Error).message);
      throw err;
    }
  }

  /** Persist just the meta record (used on 304 Not Modified path). */
  async storeMeta(meta: WhitelistCacheMeta): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await atomicWrite(this.metaPath, JSON.stringify(meta, null, 2));
  }
}

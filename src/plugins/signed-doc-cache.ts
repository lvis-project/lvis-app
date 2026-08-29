/**
 * Generic atomic disk cache for a signed remote policy document (body +
 * detached signature + fetch metadata).
 *
 * Extracted from the marketplace whitelist registry's original private
 * cache so the plugin revocation and admission registries can reuse the
 * exact same on-disk contract — atomic tmp-then-rename writes,
 * tolerant-of-missing-file reads, throw-on-malformed-JSON reads — instead
 * of re-implementing it. The callers differ only in which subdirectory of
 * `userData` they live under and what schema the body JSON encodes;
 * neither of those is this module's concern.
 *
 * Layout under `<userData>/<subDir>/`:
 *   document.json      — last good document body (utf-8 JSON)
 *   document.json.sig  — sidecar signature envelope (utf-8 JSON)
 *   meta.json          — { etag?, highestSeenIssuedAt?, lastFetchAt? }
 *
 * Atomic writes: stage to `<file>.tmp.<rand>` then `rename` over the live
 * file so a crashed write never leaves a half-document on disk. Cache reads
 * tolerate missing files (returns null) but throw on malformed JSON so the
 * caller can route the corruption into audit instead of silently falling
 * back to "no cache" — silent fallback would let a partial-disk-write
 * scenario downgrade a fresh-allow decision to a no-cache one.
 */
import { readFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createLogger } from "../lib/logger.js";
import { writeFileAtomicAtPath } from "../main/storage/feature-namespace.js";
import { isMissingPathError } from "../lib/atomic-file.js";

const log = createLogger("signed-doc-cache");

export interface SignedDocCacheMeta {
  /** Last ETag from the primary URL (for If-None-Match on next fetch). */
  etag?: string;
  /** Highest `issuedAt` ever accepted — monotonicity rollback guard. */
  highestSeenIssuedAt?: string;
  /** Wall-clock timestamp (ms) of the last successful fetch. Informational. */
  lastFetchAt?: number;
}

export interface SignedDocCacheSnapshot {
  body: string;
  signature: string;
  meta: SignedDocCacheMeta;
}

/**
 * How far into the future a document's own `issuedAt` may sit before the
 * document is discarded.
 *
 * Sized to the issuer's re-issue cadence rather than to the document TTL: an
 * accepted document advances `highestSeenIssuedAt`, which is on disk, so this
 * allowance is also the worst-case duration for which a single implausible
 * document can hold the mark above every genuine document that follows it.
 * Six hours tolerates ordinary device clock skew while keeping that
 * self-healing window to one issuance cycle.
 *
 * Module-private on purpose: the allowance is only ever consumed through
 * `checkIssuedAt`, and exporting it would invite a caller to re-derive the
 * comparison rather than use the one place that states it.
 */
const MAX_FUTURE_ISSUED_AT_MS = 6 * 60 * 60 * 1000;

/** Why `checkIssuedAt` refused a candidate document. */
export type IssuedAtRejection = "issued-in-future" | "monotonicity";

/**
 * Gate one candidate document's `issuedAt` against the two rules that govern
 * `highestSeenIssuedAt`. Returns the rejection reason, or `null` when the
 * document may be accepted and the mark advanced to it.
 *
 * Lives beside `SignedDocCacheMeta` because both rules are statements about
 * that record's `highestSeenIssuedAt` field, and all three signed-document
 * registries persist it. Keeping the rules next to the field's definition is
 * what stops one registry's notion of an acceptable `issuedAt` from drifting
 * away from another's.
 *
 * Order is deliberate. The future bound runs first so an implausibly-dated
 * document is discarded *before* anything can advance the mark to it; running
 * monotonicity first would let such a document through (it is not a rollback)
 * and leave the mark above every genuine document that follows.
 *
 * `issuedAt` is required to be a valid ISO-8601 timestamp by each document
 * schema's parser, which every caller runs before reaching here, so neither
 * comparison has to defend against `NaN`.
 */
export function checkIssuedAt(
  issuedAt: string,
  highestSeenIssuedAt: string | undefined,
  now: number,
): IssuedAtRejection | null {
  const issuedAtMs = Date.parse(issuedAt);
  if (issuedAtMs - now > MAX_FUTURE_ISSUED_AT_MS) return "issued-in-future";
  if (highestSeenIssuedAt && issuedAtMs < Date.parse(highestSeenIssuedAt)) {
    return "monotonicity";
  }
  return null;
}

async function safeReadJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw new Error(`[signed-doc-cache] read ${path}: ${(err as Error).message}`);
  }
}

async function safeReadTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (isMissingPathError(err)) return null;
    throw new Error(`[signed-doc-cache] read ${path}: ${(err as Error).message}`);
  }
}

/**
 * This cache lives under `<userData>/` rather than `~/.lvis/`, but the write
 * contract is the one thing about it that is not location-specific: the copy
 * here staged to a random name and then neither locked the name with `O_EXCL`
 * nor fsynced anything, so a cached revocation document could be lost to a
 * power cut after the caller had been told it was written.
 */

/**
 * Wraps the on-disk cache for one `<userData>/<subDir>/` directory.
 *
 * `docFilename` / `sigFilename` default to `document.json` / `document.json.sig`
 * — callers that want a self-describing on-disk name (as the whitelist wrapper
 * does, keeping its historical `whitelist.json`) pass their own.
 */
export class SignedDocumentCache {
  private readonly rootDir: string;
  private readonly bodyPath: string;
  private readonly sigPath: string;
  private readonly metaPath: string;

  constructor(
    userDataDir: string,
    subDir: string,
    docFilename = "document.json",
    sigFilename = "document.json.sig",
  ) {
    this.rootDir = join(userDataDir, subDir);
    this.bodyPath = join(this.rootDir, docFilename);
    this.sigPath = join(this.rootDir, sigFilename);
    this.metaPath = join(this.rootDir, "meta.json");
  }

  /** Load the cached snapshot or `null` when no cache exists. */
  async load(): Promise<SignedDocCacheSnapshot | null> {
    const [body, signature, meta] = await Promise.all([
      safeReadTextFile(this.bodyPath),
      safeReadTextFile(this.sigPath),
      safeReadJsonFile<SignedDocCacheMeta>(this.metaPath),
    ]);
    if (body === null || signature === null) return null;
    return {
      body,
      signature,
      meta: meta ?? {},
    };
  }

  /** Read just the meta record (etag + monotonicity floor). */
  async loadMeta(): Promise<SignedDocCacheMeta> {
    const meta = await safeReadJsonFile<SignedDocCacheMeta>(this.metaPath);
    return meta ?? {};
  }

  /** Write all three files atomically. Body + signature + meta. */
  async store(snapshot: SignedDocCacheSnapshot): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    try {
      await writeFileAtomicAtPath(this.bodyPath, snapshot.body);
      await writeFileAtomicAtPath(this.sigPath, snapshot.signature);
      await writeFileAtomicAtPath(this.metaPath, JSON.stringify(snapshot.meta, null, 2));
    } catch (err) {
      log.warn(`store failed: %s`, (err as Error).message);
      throw err;
    }
  }

  /** Persist just the meta record (used on 304 Not Modified path). */
  async storeMeta(meta: SignedDocCacheMeta): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFileAtomicAtPath(this.metaPath, JSON.stringify(meta, null, 2));
  }

  /**
   * Discard the cached document, its sidecar, and its meta.
   *
   * For a cached body that no longer parses or no longer verifies against a
   * current trust anchor: it is not evidence of anything, so keeping it means
   * re-reading and re-rejecting it on every boot, and means the meta's
   * `highestSeenIssuedAt` outlives the only document that ever justified it.
   * Missing files are not an error — the point is the post-state.
   */
  async clear(): Promise<void> {
    await Promise.all(
      [this.bodyPath, this.sigPath, this.metaPath].map((path) =>
        unlink(path).catch((err) => {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
          log.warn(`clear ${path} failed: %s`, (err as Error).message);
        }),
      ),
    );
  }
}

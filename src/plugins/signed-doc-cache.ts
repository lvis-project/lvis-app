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
import { verifyEnvelope, type PublicKeyInput } from "./envelope-verifier.js";
import type { ResolvedSignedSnapshot, SignatureEnvelope } from "./types.js";
import type { FetchSignedDocumentOptions, SignedDocumentFetchOutcome } from "./signed-doc-fetcher.js";

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

export interface LoadSignedDocumentSnapshotInput<TDoc extends { issuedAt: string }> {
  cache: SignedDocumentCache;
  /** Skip the network fetch: the cache (if any) is all the registry gets. */
  online: boolean;
  signal?: AbortSignal;
  now: () => number;
  /** Schema parser for a document body; throws on a malformed one. */
  parse: (body: string) => TDoc;
  /** Trust anchors `verifyEnvelope` may accept. */
  publicKeys: Record<string, PublicKeyInput>;
  /**
   * The signer expected today. A document signed by another key in
   * `publicKeys` is a rotation in progress (or one that stalled) — logged and
   * accepted, because `verifyEnvelope` already refused every untrusted signer.
   * Retiring an anchor means removing it from `publicKeys`, which turns this
   * into a signature failure rather than a warning.
   */
  primaryKeyId: string;
  fetch: (opts: FetchSignedDocumentOptions) => Promise<SignedDocumentFetchOutcome>;
  /**
   * What "no document" means for the gate that reads the snapshot. REQUIRED,
   * with no default, because the two registries disagree and the difference is
   * the whole contract: the revocation gate is fail-OPEN (nothing blocked while
   * no document is held) and the whitelist gate is fail-CLOSED (every secret
   * denied). The loader records the difference in the audit line; the gate
   * enforces it.
   */
  failMode: "open" | "closed";
  /** `revocation` / `whitelist` — prefixes every telemetry and audit event. */
  telemetryPrefix: string;
  telemetry: (event: string, meta?: Record<string, string>) => void;
  audit: (input: string) => void;
  /** Extra `key=value` text for the `<prefix>_loaded` audit line. */
  loadedAuditDetail?: (doc: TDoc) => string;
}

export interface LoadedSignedDocumentSnapshot<TDoc> {
  snapshot: ResolvedSignedSnapshot<TDoc, "remote" | "cache"> | null;
  /** Neither the cache nor the network produced a document. */
  unreachable: boolean;
}

/**
 * Load a signed policy document: the verified cache first, then — when
 * online — a conditional fetch whose result is verified, gated on
 * `issuedAt`, stored and served. Never throws; every failure resolves to a
 * telemetry event, an audit line and whatever snapshot the earlier step
 * produced.
 *
 * This is the one place the `issuedAt` rules are applied to BOTH paths. The
 * cached body goes through the same {@link checkIssuedAt} as a fetched one:
 * an on-disk mark gating only the remote document would leave the shorter
 * path — read a body off disk, check parse and signature, serve it — as the
 * one that never meets the mark those very bytes are stored beside, and
 * un-revoking (or re-whitelisting) by rollback is exactly what the mark
 * exists to prevent. A cached document that fails is discarded rather than
 * left on disk: keeping it means re-reading and re-refusing the same bytes on
 * every boot, and means its `highestSeenIssuedAt` outlives the only document
 * that ever justified it. The mark stays in memory for the rest of the load,
 * so the fetch is still gated by it.
 *
 * The rollback guard on the fetched document is load-bearing, not
 * defence-in-depth: a served OLDER but validly signed document (a compromised
 * CDN cache, a replayed response) would otherwise silently undo a revocation.
 * It is paired with the plausibility bound that protects the mark itself — a
 * document dated implausibly far ahead is discarded WITHOUT advancing
 * `highestSeenIssuedAt`, because the mark is written to disk and would
 * otherwise sit above every genuine document that follows, across restarts.
 */
export async function loadSignedDocumentSnapshot<TDoc extends { issuedAt: string }>(
  input: LoadSignedDocumentSnapshotInput<TDoc>,
): Promise<LoadedSignedDocumentSnapshot<TDoc>> {
  const { cache, now, telemetry, audit, telemetryPrefix: prefix } = input;
  const failNote = input.failMode === "open" ? " (fail-open: nothing blocked)" : "";
  let snapshot: ResolvedSignedSnapshot<TDoc, "remote" | "cache"> | null = null;

  const cached = await cache.load().catch((err) => {
    log.warn(`${prefix} cache load failed: ${(err as Error).message}`);
    return null;
  });
  let highestSeenIssuedAt: string | undefined = cached?.meta.highestSeenIssuedAt;

  if (cached) {
    const verified = verifyCachedSnapshot(input, cached);
    const issuedAtRejection = verified
      ? checkIssuedAt(verified.issuedAt, highestSeenIssuedAt, now())
      : null;
    if (verified && !issuedAtRejection) {
      snapshot = { doc: verified, source: "cache" };
      if (!highestSeenIssuedAt || Date.parse(verified.issuedAt) > Date.parse(highestSeenIssuedAt)) {
        highestSeenIssuedAt = verified.issuedAt;
      }
      telemetry(`${prefix}_cache_hit`);
    } else {
      telemetry(`${prefix}_cache_miss_offline`, { reason: issuedAtRejection ?? "corrupt" });
      if (issuedAtRejection) {
        audit(
          `${prefix}_cache_rejected reason=${issuedAtRejection}`
            + ` received=${verified?.issuedAt ?? "unknown"}`
            + ` highest=${highestSeenIssuedAt ?? "none"}`,
        );
      }
      await cache.clear().catch((err) => {
        log.warn(`${prefix} cache clear failed: ${(err as Error).message}`);
      });
    }
  }

  if (!input.online) {
    if (!snapshot) {
      telemetry(`${prefix}_cache_miss_offline`, { reason: "no-cache" });
      audit(`${prefix}_unreachable reason=no-cache-and-offline${failNote}`);
    }
    return { snapshot, unreachable: snapshot === null };
  }

  // Conditional GET via `If-None-Match` when an ETag is held, so the CDN can
  // short-circuit.
  try {
    const meta = await cache.loadMeta();
    const outcome = await input.fetch({
      ifNoneMatch: meta.etag,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if ("notModified" in outcome) {
      telemetry(`${prefix}_fetch_ok`, { source: outcome.source, conditional: "304" });
      await cache.storeMeta({ ...meta, lastFetchAt: now() }).catch(() => {});
      return { snapshot, unreachable: snapshot === null };
    }
    const envelope = JSON.parse(outcome.signature) as SignatureEnvelope;
    const doc = input.parse(outcome.body);
    const verify = verifyEnvelope(Buffer.from(outcome.body, "utf-8"), envelope, input.publicKeys);
    if (!verify.ok) {
      telemetry(`${prefix}_fetch_failed`, { reason: "signature_invalid" });
      audit(`${prefix}_fetch_failed reason=signature_invalid detail=${verify.reason ?? "unknown"}`);
      return { snapshot, unreachable: snapshot === null };
    }
    const issuedAtRejection = checkIssuedAt(doc.issuedAt, highestSeenIssuedAt, now());
    if (issuedAtRejection) {
      telemetry(`${prefix}_fetch_failed`, { reason: issuedAtRejection });
      audit(
        `${prefix}_fetch_failed reason=${issuedAtRejection} received=${doc.issuedAt}`
          + ` highest=${highestSeenIssuedAt ?? "none"}`
          + ` deviceClock=${new Date(now()).toISOString()}`,
      );
      return { snapshot, unreachable: snapshot === null };
    }
    await cache.store({
      body: outcome.body,
      signature: outcome.signature,
      meta: { etag: outcome.etag, highestSeenIssuedAt: doc.issuedAt, lastFetchAt: now() },
    }).catch((err) => {
      log.warn(`${prefix} cache store failed: ${(err as Error).message}`);
    });
    snapshot = { doc, source: "remote" };
    telemetry(`${prefix}_fetch_ok`, { source: outcome.source });
    const detail = input.loadedAuditDetail?.(doc);
    audit(
      `${prefix}_loaded source=${outcome.source} issuedAt=${doc.issuedAt}`
        + (detail ? ` ${detail}` : ""),
    );
    return { snapshot, unreachable: false };
  } catch (err) {
    telemetry(`${prefix}_fetch_failed`, { reason: "network" });
    audit(`${prefix}_fetch_failed reason=network detail=${(err as Error).message}`);
    // Keep whatever snapshot the cache produced. `<prefix>_fetch_failed{network}`
    // alone cannot tell an operator which of two very different states this
    // is: a device still enforcing a cached document that merely could not be
    // refreshed, or a device holding no document at all. Only the second is
    // the unreachable state, so it gets its own counter.
    if (!snapshot) {
      telemetry(`${prefix}_cache_miss_offline`, { reason: "no-cache" });
      audit(`${prefix}_unreachable reason=fetch-failed-and-no-cache${failNote}`);
    }
    return { snapshot, unreachable: snapshot === null };
  }
}

function verifyCachedSnapshot<TDoc extends { issuedAt: string }>(
  input: LoadSignedDocumentSnapshotInput<TDoc>,
  cached: SignedDocCacheSnapshot,
): TDoc | null {
  const prefix = input.telemetryPrefix;
  try {
    const doc = input.parse(cached.body);
    const envelope = JSON.parse(cached.signature) as SignatureEnvelope;
    const verify = verifyEnvelope(Buffer.from(cached.body, "utf-8"), envelope, input.publicKeys);
    if (!verify.ok) {
      log.warn(`cached ${prefix} signature invalid: ${verify.reason}`);
      return null;
    }
    if (verify.key_id && verify.key_id !== input.primaryKeyId) {
      log.warn(`cached ${prefix} signed by unexpected key_id=${verify.key_id}`);
    }
    return doc;
  } catch (err) {
    log.warn(`cached ${prefix} parse/verify failed: ${(err as Error).message}`);
    return null;
  }
}

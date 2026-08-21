/**
 * Plugin revocation registry singleton.
 *
 * Answers ONE question, synchronously, at the two points that matter:
 *   - installing a `slug@version` that the marketplace has blocked, or that
 *     is below the plugin's pinned `minVersion`, must fail with a clear
 *     reason (`marketplace.ts`, before the artifact is even downloaded);
 *   - a version already on disk that a FRESH document now blocks must not
 *     load on the next boot (`runtime/index.ts`'s `markRevoked`,
 *     mirroring the existing `markIncompatibleAppVersion` LOAD-boundary gate).
 *
 * FAIL-OPEN / FAIL-CLOSED ASYMMETRY (the central design decision here, and
 * the opposite polarity from the whitelist registry on purpose):
 *   - No document has EVER been obtained (first boot, offline, and no cache
 *     yet written) → ALLOW everything. This is an ALLOW-by-default control:
 *     being offline must not brick every installed plugin just because the
 *     kill-switch document itself couldn't be fetched. Contrast with the
 *     whitelist, which is a DENY-by-default secret-access ACL, where the
 *     safe default under the same "network is down" condition is deny.
 *   - ANY valid signed document — fresh OR cached, and regardless of its
 *     own `expiresAt` — is obeyed exactly as written. A revocation is a
 *     promise the operator made about a specific bad version; once we have
 *     seen that promise, "the CDN is down right now" is not a reason to
 *     stop honoring it. This is why, unlike `whitelist-registry.ts`, there
 *     is no stale-grace-window deny path here: staleness only emits a
 *     one-time audit warning (see `status()`), it never disables
 *     enforcement of the last known-good document.
 *
 * Load order mirrors the whitelist registry: `init()` → load disk cache →
 * verify → fetch remote (when online) → verify → monotonicity guard → swap.
 * The monotonicity guard is MORE important here than for the whitelist: an
 * attacker who could serve an OLDER signed document (before a plugin was
 * revoked) would effectively un-revoke it, so a document with an
 * `issuedAt` older than the highest one ever accepted is rejected outright.
 * The same guard runs over a document read from the cache, not only over one
 * fetched from the network — the on-disk high-water mark and the on-disk body
 * are written together, so a body that does not meet the mark stored beside it
 * is refused and deleted rather than served. Paired with it is a plausibility
 * bound: a document dated implausibly far ahead of this device's clock is
 * discarded without advancing the mark, so one such document cannot leave the
 * mark above every genuine document that follows.
 *
 * Fail-open is about a document that could not be obtained, not about a
 * registry that was never wired: `evaluate()` before `init()` still allows —
 * denying there would brick every installed plugin on a boot-ordering bug —
 * but it reports itself once through `log.error`, because a kill switch that
 * has silently become a no-op is otherwise invisible.
 */
import { createLogger } from "../../lib/logger.js";
import { verifyEnvelope } from "../envelope-verifier.js";
// Reuses the whitelist's trust domain — see the comment on
// `WHITELIST_PUBLIC_KEYS` in `marketplace-keys.ts` for why.
import {
  WHITELIST_PUBLIC_KEYS as REVOCATION_PUBLIC_KEYS,
  WHITELIST_PRIMARY_KEY_ID as REVOCATION_PRIMARY_KEY_ID,
} from "../marketplace-keys.js";
import type { PublicKeyInput } from "../envelope-verifier.js";
import type { SignatureEnvelope } from "../types.js";
import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import {
  parseRevocationDocument,
  type RevocationDocument,
} from "./revocation-schema.js";
import {
  checkIssuedAt,
  SignedDocumentCache,
  type SignedDocCacheSnapshot,
} from "../signed-doc-cache.js";
import {
  fetchSignedDocument,
  type FetchSignedDocumentOptions,
  type SignedDocSource,
  type SignedDocumentFetchOutcome,
} from "../signed-doc-fetcher.js";

const log = createLogger("revocation-registry");

// ---------------------------------------------------------------------
// Transport + disk cache
//
// Both are declared here rather than in one-export wrapper modules of
// their own, matching `admission-registry.ts`: each wrapper was a file
// that named a handful of constants and forwarded a single call to the
// shared signed-document machinery, so it added a second place for the
// transport contract to drift without adding a definition. The
// subdirectory, filenames and URLs keep their historical values, so an
// on-disk cache written by an earlier build still resolves.
// ---------------------------------------------------------------------

/**
 * Disk cache, pinned to `<userData>/marketplace-revocation/`:
 *   revocation.json       — last good document body (utf-8 JSON)
 *   revocation.json.sig   — sidecar signature envelope (utf-8 JSON)
 *   meta.json             — { etag?, highestSeenIssuedAt?, lastFetchAt? }
 */
export class RevocationCache extends SignedDocumentCache {
  constructor(userDataDir: string) {
    super(userDataDir, "marketplace-revocation", "revocation.json", "revocation.json.sig");
  }
}

type RevocationCacheSnapshot = SignedDocCacheSnapshot;

/**
 * Hosted alongside `whitelist.json` on the same issuance repo (see the
 * comment on `WHITELIST_PUBLIC_KEYS` in `marketplace-keys.ts` for why the
 * trust anchor is shared too) rather than standing up another
 * repo/domain for one more small JSON file. Primary URL is GitHub Pages;
 * the fallback is a GitHub Release asset, used on 5xx / network errors
 * against the primary.
 */
const REVOCATION_SOURCE: SignedDocSource = {
  primaryBase: "https://lvis-project.github.io/marketplace-whitelist/v1",
  fallbackBase:
    "https://github.com/lvis-project/marketplace-whitelist/releases/download/v1-latest",
  docFilename: "revocation.json",
  sigFilename: "revocation.json.sig",
};

/**
 * Fetch the revocation document + signature. Throws when both endpoints
 * fail — `init()` catches it and treats it exactly like any other fetch
 * failure: keep the cached snapshot (if any), fail-open only when there
 * has never been one.
 */
async function fetchRevocationDocument(
  opts: FetchSignedDocumentOptions = {},
): Promise<SignedDocumentFetchOutcome> {
  return fetchSignedDocument(REVOCATION_SOURCE, opts, "lvis-app/revocation-fetcher");
}

/** Caller-facing decision shape — discriminated union for exhaustive narrowing. */
export type RevocationDecision =
  | { kind: "allow" }
  | {
      kind: "block";
      /** Which rule fired — lets callers pick a slightly different user-facing copy. */
      ruleKind: "blocklist" | "min-version";
      /** English detail — the blocklist's own `reason`, or a min-version summary. */
      reason: string;
    };

export type RevocationSource = "remote" | "cache";

export interface RevocationStatus {
  /** `true` once a valid signed document has been obtained at least once (cache or remote). */
  hasDocument: boolean;
  /** `true` when the held document's own `expiresAt` has passed. Still enforced regardless. */
  stale: boolean;
  issuedAt?: string;
  expiresAt?: string;
  source?: RevocationSource;
}

export interface RevocationInitOptions {
  /** Electron `app.getPath("userData")`. The cache lives under `marketplace-revocation/`. */
  userDataDir: string;
  /** Skip the network fetch for offline tests or user-selected offline mode. */
  online: boolean;
  /** Wall-clock now provider — injected for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Audit log sink. The boot wiring passes the shared `bootAuditLogger`. */
  audit?: (input: string) => void;
  /** Telemetry sink — incremented for each fetch/cache outcome. */
  telemetry?: (event: string, meta?: Record<string, string>) => void;
  /** App-shutdown AbortSignal so a slow CDN response doesn't outlive boot. */
  signal?: AbortSignal;
}

interface ResolvedSnapshot {
  doc: RevocationDocument;
  source: RevocationSource;
}

class RevocationRegistry {
  private snapshot: ResolvedSnapshot | null = null;
  private now: () => number = Date.now;
  private publicKeys: Record<string, PublicKeyInput> = REVOCATION_PUBLIC_KEYS;
  /** `true` once `init()` has run. Read only to detect a boot-ordering bug. */
  private initialized = false;
  /** Whether the pre-`init()` use has already been reported — reported once. */
  private reportedUninitialized = false;

  constructor(publicKeys?: Record<string, PublicKeyInput>) {
    if (publicKeys) {
      this.publicKeys = publicKeys;
    }
  }

  /** Test-only — reset state between tests. NOT exported in production callers. */
  resetForTesting(): void {
    this.snapshot = null;
    this.now = Date.now;
    this.publicKeys = REVOCATION_PUBLIC_KEYS;
    this.initialized = false;
    this.reportedUninitialized = false;
  }

  /** Test-only key injection, mirrors `whitelistRegistry.setPublicKeysForTesting`. */
  setPublicKeysForTesting(publicKeys: Record<string, PublicKeyInput>): void {
    this.publicKeys = publicKeys;
  }

  /**
   * Load + activate the revocation registry. Boot wiring calls this BEFORE
   * plugins load (`pluginRuntime.startAll()`/`load()`) so the LOAD-boundary
   * gate observes a populated registry on the very first boot pass.
   *
   * The function NEVER throws — every fail path resolves to a recorded
   * state that `evaluate()` reads from `snapshot`. Throwing would crash
   * boot for a network blip, which is exactly the fail-open contract this
   * registry exists to preserve.
   */
  async init(opts: RevocationInitOptions): Promise<void> {
    this.now = opts.now ?? Date.now;
    this.initialized = true;
    const audit = opts.audit ?? (() => {});
    const telemetry = opts.telemetry ?? (() => {});

    const cache = new RevocationCache(opts.userDataDir);
    const cached = await cache.load().catch((err) => {
      log.warn(`cache load failed: ${(err as Error).message}`);
      return null;
    });
    let highestSeenIssuedAt: string | undefined = cached?.meta.highestSeenIssuedAt;

    if (cached) {
      const verified = this.verifyCachedSnapshot(cached);
      // The cached body goes through the same `issuedAt` rules as a fetched
      // one. The on-disk mark gating only the remote document would leave the
      // shorter path — read a body off disk, check parse and signature, serve
      // it — as the one that never meets the mark those very bytes are stored
      // beside, and un-revoking by rollback is precisely what the mark exists
      // to prevent.
      const issuedAtRejection = verified
        ? checkIssuedAt(verified.issuedAt, highestSeenIssuedAt, this.now())
        : null;
      if (verified && !issuedAtRejection) {
        this.snapshot = { doc: verified, source: "cache" };
        if (!highestSeenIssuedAt || Date.parse(verified.issuedAt) > Date.parse(highestSeenIssuedAt)) {
          highestSeenIssuedAt = verified.issuedAt;
        }
        telemetry("revocation_cache_hit");
      } else {
        // Corrupt, unverifiable, or refused on `issuedAt` — discarded rather
        // than left on disk. Keeping it means re-reading and re-refusing the
        // same bytes on every boot, and means its `highestSeenIssuedAt`
        // outlives the only document that ever justified it. The mark stays in
        // memory for the rest of this `init()`, so the remote fetch below is
        // still gated by it.
        telemetry("revocation_cache_miss_offline", { reason: issuedAtRejection ?? "corrupt" });
        if (issuedAtRejection) {
          audit(
            `revocation_cache_rejected reason=${issuedAtRejection}`
              + ` received=${verified?.issuedAt ?? "unknown"}`
              + ` highest=${highestSeenIssuedAt ?? "none"}`,
          );
        }
        await cache.clear().catch((err) => {
          log.warn(`cache clear failed: ${(err as Error).message}`);
        });
      }
    }

    if (!opts.online) {
      // Offline — cache (if any) is all we have. Fail-open contract: an
      // absent cache here means `evaluate()` returns "allow" for everything,
      // which is the intended behavior (see module doc), not an error state
      // worth a toast the way the whitelist's equivalent path is.
      if (!this.snapshot) {
        telemetry("revocation_cache_miss_offline", { reason: "no-cache" });
        audit(`revocation_unreachable reason=no-cache-and-offline (fail-open: nothing blocked)`);
      }
      return;
    }

    try {
      const meta = await cache.loadMeta();
      const outcome = await fetchRevocationDocument({
        ifNoneMatch: meta.etag,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      if ("notModified" in outcome) {
        telemetry("revocation_fetch_ok", { source: outcome.source, conditional: "304" });
        await cache.storeMeta({ ...meta, lastFetchAt: this.now() }).catch(() => {});
        return;
      }
      const envelope = JSON.parse(outcome.signature) as SignatureEnvelope;
      const doc = parseRevocationDocument(outcome.body);
      const verify = verifyEnvelope(
        Buffer.from(outcome.body, "utf-8"),
        envelope,
        this.publicKeys,
      );
      if (!verify.ok) {
        telemetry("revocation_fetch_failed", { reason: "signature_invalid" });
        audit(`revocation_fetch_failed reason=signature_invalid detail=${verify.reason ?? "unknown"}`);
        return;
      }
      // Rollback guard — see module doc: this is the load-bearing guard here,
      // not a defense-in-depth extra. Without it a served OLDER (but still
      // validly signed, e.g. via a compromised CDN cache or a replayed
      // response) document would silently un-revoke a plugin.
      //
      // Paired with the plausibility bound that protects the mark itself: a
      // document dated implausibly far ahead is discarded WITHOUT advancing
      // `highestSeenIssuedAt`, because the mark is written to disk and would
      // otherwise sit above every genuine document that follows, across
      // restarts — leaving the device stuck on whatever it last enforced while
      // newly issued revocations are refused.
      const issuedAtRejection = checkIssuedAt(doc.issuedAt, highestSeenIssuedAt, this.now());
      if (issuedAtRejection) {
        telemetry("revocation_fetch_failed", { reason: issuedAtRejection });
        audit(
          `revocation_fetch_failed reason=${issuedAtRejection} received=${doc.issuedAt}`
            + ` highest=${highestSeenIssuedAt ?? "none"}`
            + ` deviceClock=${new Date(this.now()).toISOString()}`,
        );
        return;
      }
      const newMeta = {
        etag: outcome.etag,
        highestSeenIssuedAt: doc.issuedAt,
        lastFetchAt: this.now(),
      };
      await cache.store({
        body: outcome.body,
        signature: outcome.signature,
        meta: newMeta,
      }).catch((err) => {
        log.warn(`cache store failed: ${(err as Error).message}`);
      });
      this.snapshot = { doc, source: "remote" };
      telemetry("revocation_fetch_ok", { source: outcome.source });
      audit(
        `revocation_loaded source=${outcome.source} issuedAt=${doc.issuedAt} `
          + `minVersions=${Object.keys(doc.minVersions).length} blocked=${doc.blocked.length}`,
      );
    } catch (err) {
      telemetry("revocation_fetch_failed", { reason: "network" });
      audit(`revocation_fetch_failed reason=network detail=${(err as Error).message}`);
      // Keep whatever snapshot the cache produced (may be null — fail-open).
      //
      // `revocation_fetch_failed{network}` alone cannot tell an operator which
      // of two very different states this is: a device still enforcing a
      // cached document that merely could not be refreshed, or a device
      // holding no document at all and therefore blocking nothing. Only the
      // second is fail-open in effect, so it gets its own counter — the same
      // one, on the same branch, that `whitelist-registry.ts` emits.
      if (!this.snapshot) {
        telemetry("revocation_cache_miss_offline", { reason: "no-cache" });
        audit(
          `revocation_unreachable reason=fetch-failed-and-no-cache (fail-open: nothing blocked)`,
        );
      }
    }

    if (this.snapshot && this.status().stale) {
      audit(
        `revocation_stale expiresAt=${this.snapshot.doc.expiresAt} `
          + `(still enforced — staleness never disables a revocation document)`,
      );
    }
  }

  /**
   * Synchronous decision for one `(pluginId, version)` pair. Called from
   * both the install path (`marketplace.ts`) and the load path
   * (`runtime/index.ts`'s `markRevoked`).
   */
  evaluate(pluginId: string, version: string): RevocationDecision {
    if (!this.initialized) this.reportUninitialized();
    if (!this.snapshot) {
      // Fail-open: no document has ever been obtained. See module doc.
      return { kind: "allow" };
    }
    const doc = this.snapshot.doc;
    const blockedEntry = doc.blocked.find(
      (entry) => entry.slug === pluginId && entry.version === version,
    );
    if (blockedEntry) {
      return { kind: "block", ruleKind: "blocklist", reason: blockedEntry.reason };
    }
    const minVersion = doc.minVersions[pluginId];
    if (minVersion && !appVersionSatisfiesMin(version, minVersion)) {
      return {
        kind: "block",
        ruleKind: "min-version",
        reason: `version ${version} is below the marketplace-pinned minimum ${minVersion}`,
      };
    }
    return { kind: "allow" };
  }

  status(): RevocationStatus {
    if (!this.snapshot) {
      return { hasDocument: false, stale: false };
    }
    const now = this.now();
    const expiresAt = Date.parse(this.snapshot.doc.expiresAt);
    return {
      hasDocument: true,
      stale: now > expiresAt,
      issuedAt: this.snapshot.doc.issuedAt,
      expiresAt: this.snapshot.doc.expiresAt,
      source: this.snapshot.source,
    };
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------

  /**
   * Report that `evaluate()` was reached before `init()` ever ran.
   *
   * Deliberately does NOT change the answer. Allow-by-default is this
   * registry's documented polarity (see the module doc) and a never-initialised
   * registry is indistinguishable, decision-wise, from one that booted offline
   * with no cache — which allows. Denying here would brick every installed
   * plugin on a boot-ordering bug, i.e. cause the outage the fail-open contract
   * exists to prevent.
   *
   * What was missing is the *signal*. A boot sequence that stops calling
   * `init()` silently converts this kill switch into a no-op: every
   * `evaluate()` allows, no counter moves, and nothing in the logs says so.
   * Reported through `log.error` rather than the injected audit sink because
   * the sink arrives via `init()` — the very call that did not happen. Reported
   * once, since `evaluate()` sits on the plugin load path and would otherwise
   * repeat per plugin per boot.
   */
  private reportUninitialized(): void {
    if (this.reportedUninitialized) return;
    this.reportedUninitialized = true;
    log.error(
      "revocation_unconfigured: evaluate() was called before init() — "
        + "no revocation document can be held, so nothing will be blocked "
        + "for the lifetime of this process",
    );
  }

  private verifyCachedSnapshot(cached: RevocationCacheSnapshot): RevocationDocument | null {
    try {
      const doc = parseRevocationDocument(cached.body);
      const envelope = JSON.parse(cached.signature) as SignatureEnvelope;
      const verify = verifyEnvelope(
        Buffer.from(cached.body, "utf-8"),
        envelope,
        this.publicKeys,
      );
      if (!verify.ok) {
        log.warn(`cached revocation signature invalid: ${verify.reason}`);
        return null;
      }
      if (verify.key_id && verify.key_id !== REVOCATION_PRIMARY_KEY_ID) {
        log.warn(`cached revocation signed by unexpected key_id=${verify.key_id}`);
      }
      return doc;
    } catch (err) {
      log.warn(`cached revocation parse/verify failed: ${(err as Error).message}`);
      return null;
    }
  }
}

/** Process-wide singleton. Boot calls `init`; install/load call `evaluate`. */
export const revocationRegistry = new RevocationRegistry();

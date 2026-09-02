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
// Reuses the whitelist's trust domain — see the comment on
// `WHITELIST_PUBLIC_KEYS` in `marketplace-keys.ts` for why.
import {
  WHITELIST_PUBLIC_KEYS as REVOCATION_PUBLIC_KEYS,
  WHITELIST_PRIMARY_KEY_ID as REVOCATION_PRIMARY_KEY_ID,
} from "../marketplace-keys.js";
import type { PublicKeyInput } from "../envelope-verifier.js";
import type { ResolvedSignedSnapshot } from "../types.js";
import { appVersionSatisfiesMin } from "../../shared/semver-compare.js";
import {
  parseRevocationDocument,
  type RevocationDocument,
} from "./revocation-schema.js";
import { loadSignedDocumentSnapshot, SignedDocumentCache } from "../signed-doc-cache.js";
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
  return fetchSignedDocument(REVOCATION_SOURCE, opts, "lvis-app/revocation-registry");
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

class RevocationRegistry {
  private snapshot: ResolvedSignedSnapshot<RevocationDocument, RevocationSource> | null = null;
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

    const { snapshot } = await loadSignedDocumentSnapshot<RevocationDocument>({
      cache: new RevocationCache(opts.userDataDir),
      online: opts.online,
      ...(opts.signal ? { signal: opts.signal } : {}),
      now: this.now,
      parse: parseRevocationDocument,
      publicKeys: this.publicKeys,
      primaryKeyId: REVOCATION_PRIMARY_KEY_ID,
      fetch: fetchRevocationDocument,
      // Fail-open: an absent document means `evaluate()` allows everything.
      // That is the intended behaviour (see module doc), not an error state
      // worth a toast the way the whitelist's equivalent path is.
      failMode: "open",
      telemetryPrefix: "revocation",
      telemetry,
      audit,
      loadedAuditDetail: (doc) =>
        `minVersions=${Object.keys(doc.minVersions).length} blocked=${doc.blocked.length}`,
    });
    this.snapshot = snapshot;

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

}

/** Process-wide singleton. Boot calls `init`; install/load call `evaluate`. */
export const revocationRegistry = new RevocationRegistry();

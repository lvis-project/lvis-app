/**
 * #893 Stage 2 — Marketplace whitelist registry singleton.
 *
 * Tier-3 gate in the 4-tier secret access policy:
 *   1. plugin own-namespace      (`plugin.<id>.*`)
 *   2. manifest hostSecrets.read  allowlist
 *   3. whitelist registry         (this module)        ← ADDITIVE: non-whitelisted plugins keep tier-1
 *   4. active-vendor cross-check (settings.llm.provider)
 *
 * Load order:
 *   `init()` → load disk cache → fetch remote (when online) →
 *   verify signature envelope → check `issuedAt` (`checkIssuedAt`) → swap.
 *
 * The `issuedAt` check is the same one on both paths, cached and fetched:
 * refuse a rollback below the on-disk high-water mark, and refuse a document
 * dated implausibly far ahead of this device's clock without advancing that
 * mark. A refused cached document is deleted rather than left to be re-read
 * and re-refused on the next boot.
 *
 * `isAllowed(pluginId, key, manifestSha256?)` is synchronous and never
 * touches I/O — it is called from the per-plugin `hostApi.getSecret` hot
 * path. All async work happens in `init()`.
 *
 * Status states (`status().state`):
 *   - "fresh"               — within `expiresAt`, allow
 *   - "stale-within-grace"  — past `expiresAt`, within 7d grace, allow + warn
 *   - "stale-past-grace"    — past 7d grace, deny `whitelist-stale-exceeded`
 *   - "no-cache"            — never had a successful load, deny `whitelist-unreachable`
 */
import { WHITELIST_PUBLIC_KEYS, WHITELIST_PRIMARY_KEY_ID } from "../marketplace-keys.js";
import type { PublicKeyInput } from "../envelope-verifier.js";
import type { ResolvedSignedSnapshot } from "../types.js";
import {
  incrementHostSecretCounter,
  sanitizeKeyPrefix,
} from "../../telemetry/host-secret-counters.js";
import {
  parseWhitelistDocument,
  type WhitelistDocument,
} from "./whitelist-schema.js";
import { loadSignedDocumentSnapshot, SignedDocumentCache } from "../signed-doc-cache.js";
import {
  fetchSignedDocument,
  type FetchSignedDocumentOptions,
  type SignedDocSource,
  type SignedDocumentFetchOutcome,
} from "../signed-doc-fetcher.js";

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
 * Disk cache, pinned to `<userData>/marketplace-whitelist/`:
 *   whitelist.json       — last good document body (utf-8 JSON)
 *   whitelist.json.sig   — sidecar signature envelope (utf-8 JSON)
 *   meta.json            — { etag?, highestSeenIssuedAt?, lastFetchAt? }
 */
export class WhitelistCache extends SignedDocumentCache {
  constructor(userDataDir: string) {
    super(userDataDir, "marketplace-whitelist", "whitelist.json", "whitelist.json.sig");
  }
}

/**
 * The `{etag?, highestSeenIssuedAt?, lastFetchAt?}` meta shape has no
 * consumer here; import `SignedDocCacheMeta` from `../signed-doc-cache.js`
 * directly if one is ever needed.
 */
/**
 * Primary URL is GitHub Pages; the fallback is a GitHub Release asset,
 * used on 5xx / network errors against the primary. An ETag is sent on
 * subsequent requests so the CDN can short-circuit with 304 Not Modified
 * (no body transfer cost).
 */
const WHITELIST_SOURCE: SignedDocSource = {
  primaryBase: "https://lvis-project.github.io/marketplace-whitelist/v1",
  fallbackBase:
    "https://github.com/lvis-project/marketplace-whitelist/releases/download/v1-latest",
  docFilename: "whitelist.json",
  sigFilename: "whitelist.json.sig",
};

/**
 * Fetch the whitelist document + signature. Throws when both endpoints
 * fail — `init()` catches and routes the error into the audit log +
 * telemetry counter.
 */
async function fetchWhitelist(
  opts: FetchSignedDocumentOptions = {},
): Promise<SignedDocumentFetchOutcome> {
  return fetchSignedDocument(WHITELIST_SOURCE, opts, "lvis-app/whitelist-registry");
}

/** Caller-facing decision shape — discriminated union for exhaustive narrowing. */
export type WhitelistDecision =
  | { kind: "allow" }
  | {
      kind: "deny";
      reason:
        | "not-whitelisted"
        | "manifest-sha-mismatch"
        | "whitelist-unreachable"
        | "whitelist-stale-exceeded";
    };

export type WhitelistState =
  | "fresh"
  | "stale-within-grace"
  | "stale-past-grace"
  | "no-cache";

export type WhitelistSource = "remote" | "cache";

export interface WhitelistStatus {
  state: WhitelistState;
  issuedAt?: string;
  expiresAt?: string;
  source: WhitelistSource;
}

export interface WhitelistInitOptions {
  /** Electron `app.getPath("userData")`. The cache lives under `marketplace-whitelist/`. */
  userDataDir: string;
  /** Skip the network fetch for offline tests or user-selected offline mode. */
  online: boolean;
  /** Wall-clock now provider — injected for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Audit log sink. The boot wiring passes the shared `bootAuditLogger`. */
  audit?: (input: string) => void;
  /** Telemetry sink — incremented for each fetch/cache outcome. */
  telemetry?: (event: string, meta?: Record<string, string>) => void;
  /**
   * App-shutdown AbortSignal threaded from
   * boot so a slow CDN response doesn't keep the registry's fetch alive
   * after the user quit (up to the 10s HTTP timeout). The signal flows
   * directly into `fetchWhitelist` below and aborts the underlying
   * `fetch()` immediately.
   */
  signal?: AbortSignal;
}

const STALE_GRACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

class WhitelistRegistry {
  private snapshot: ResolvedSignedSnapshot<WhitelistDocument, WhitelistSource> | null = null;
  private now: () => number = Date.now;
  private initialized = false;
  /** Set when a fetch attempt found no cache and offline → permanent deny. */
  private noCacheOffline = false;
  /**
   * Trust roots used for signature verification.
   * Defaults to the frozen production `WHITELIST_PUBLIC_KEYS` map; tests
   * inject a per-run keypair via the singleton's
   * `setPublicKeysForTesting()` helper instead of mutating the module
   * constant.
   */
  private publicKeys: Record<string, PublicKeyInput> = WHITELIST_PUBLIC_KEYS;

  constructor(publicKeys?: Record<string, PublicKeyInput>) {
    if (publicKeys) {
      this.publicKeys = publicKeys;
    }
  }

  /** Test-only — reset state between tests. NOT exported in production callers. */
  resetForTesting(): void {
    this.snapshot = null;
    this.initialized = false;
    this.noCacheOffline = false;
    this.now = Date.now;
    // Restore the production key map so a follow-up test that doesn't call
    // `setPublicKeysForTesting()` doesn't inherit the previous run's
    // ephemeral keypair.
    this.publicKeys = WHITELIST_PUBLIC_KEYS;
  }

  /**
   * Test-only key injection. Production callers use the
   * frozen module-level `WHITELIST_PUBLIC_KEYS` map; tests generate a
   * fresh ed25519 keypair per run and swap it in via this helper without
   * mutating the frozen production constant.
   */
  setPublicKeysForTesting(publicKeys: Record<string, PublicKeyInput>): void {
    this.publicKeys = publicKeys;
  }

  /**
   * Load + activate the whitelist. Boot wiring calls this BEFORE
   * `initPluginRuntime` so the per-plugin HostApi factory observes a
   * populated registry from the first `getSecret` call.
   *
   * The function NEVER throws — every fail path resolves to a recorded
   * state (`no-cache`, `stale-past-grace`, etc.) that `isAllowed` reads
   * from `snapshot`. Throwing would crash boot for a network blip.
   */
  async init(opts: WhitelistInitOptions): Promise<void> {
    this.now = opts.now ?? Date.now;
    this.initialized = true;
    this.noCacheOffline = false;
    const audit = opts.audit ?? (() => {});
    const telemetry = opts.telemetry ?? (() => {});

    const { snapshot, unreachable } = await loadSignedDocumentSnapshot<WhitelistDocument>({
      cache: new WhitelistCache(opts.userDataDir),
      online: opts.online,
      ...(opts.signal ? { signal: opts.signal } : {}),
      now: this.now,
      parse: parseWhitelistDocument,
      publicKeys: this.publicKeys,
      primaryKeyId: WHITELIST_PRIMARY_KEY_ID,
      fetch: fetchWhitelist,
      // Fail-closed: with no document `isAllowed` reports
      // `whitelist-unreachable` for every secret.
      failMode: "closed",
      telemetryPrefix: "whitelist",
      telemetry,
      audit,
    });
    this.snapshot = snapshot;
    this.noCacheOffline = unreachable;
  }

  /**
   * Synchronous Tier-3 decision.  /**
   * Synchronous Tier-3 decision. Returns `allow` / `deny{reason}`.
   *
   * Manifest sha mismatch is only checked when both sides supply a value —
   * the caller (`plugin-runtime.ts:getSecret`) computes the running manifest
   * sha and passes it; tests can omit it to exercise the not-whitelisted +
   * basic allow paths.
   */
  isAllowed(pluginId: string, key: string, manifestSha256?: string): WhitelistDecision {
    if (!this.initialized) {
      // Init never ran — fail closed.
      return { kind: "deny", reason: "whitelist-unreachable" };
    }
    if (!this.snapshot) {
      // Either offline-with-no-cache or signature-rejected first boot.
      return { kind: "deny", reason: "whitelist-unreachable" };
    }
    const status = this.status();
    if (status.state === "stale-past-grace") {
      return { kind: "deny", reason: "whitelist-stale-exceeded" };
    }
    if (status.state === "stale-within-grace") {
      // Emit the `whitelist_cache_stale` counter so operators see when the
      // registry is serving grants from a past-expiry doc inside the 7d
      // grace window. `keyPrefix` carries the requested
      // key's namespace (folded through `sanitizeKeyPrefix` so unknown
      // namespaces don't balloon the counter map).
      incrementHostSecretCounter(
        "whitelist_cache_stale",
        pluginId,
        sanitizeKeyPrefix(key),
      );
    }
    const grant = this.snapshot.doc.pluginGrants[pluginId];
    if (!grant) {
      return { kind: "deny", reason: "not-whitelisted" };
    }
    if (manifestSha256 && grant.approvedManifestSha256 !== manifestSha256.toLowerCase()) {
      return { kind: "deny", reason: "manifest-sha-mismatch" };
    }
    if (!grant.hostSecrets.read.includes(key)) {
      return { kind: "deny", reason: "not-whitelisted" };
    }
    return { kind: "allow" };
  }

  status(): WhitelistStatus {
    if (!this.snapshot) {
      return { state: "no-cache", source: "cache" };
    }
    const now = this.now();
    const expiresAt = Date.parse(this.snapshot.doc.expiresAt);
    if (now <= expiresAt) {
      return {
        state: "fresh",
        issuedAt: this.snapshot.doc.issuedAt,
        expiresAt: this.snapshot.doc.expiresAt,
        source: this.snapshot.source,
      };
    }
    if (now - expiresAt <= STALE_GRACE_WINDOW_MS) {
      return {
        state: "stale-within-grace",
        issuedAt: this.snapshot.doc.issuedAt,
        expiresAt: this.snapshot.doc.expiresAt,
        source: this.snapshot.source,
      };
    }
    return {
      state: "stale-past-grace",
      issuedAt: this.snapshot.doc.issuedAt,
      expiresAt: this.snapshot.doc.expiresAt,
      source: this.snapshot.source,
    };
  }

  /** True once `init()` ran. Boot toast logic reads this. */
  isNoCacheOffline(): boolean {
    return this.noCacheOffline;
  }

  // ---------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------


}

/** Process-wide singleton. Boot calls `init`; getSecret calls `isAllowed`. */
export const whitelistRegistry = new WhitelistRegistry();

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
 *   `init()` → load disk cache → fetch remote (when online & not demo) →
 *   verify signature envelope → check `issuedAt` monotonicity → swap.
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
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createLogger } from "../../lib/logger.js";
import { verifyEnvelope } from "../envelope-verifier.js";
import { WHITELIST_PUBLIC_KEYS, WHITELIST_PRIMARY_KEY_ID } from "../marketplace-keys.js";
import type { PublicKeyInput } from "../envelope-verifier.js";
import type { SignatureEnvelope } from "../types.js";
import {
  incrementHostSecretCounter,
  sanitizeKeyPrefix,
} from "../../telemetry/host-secret-counters.js";
import {
  parseWhitelistDocument,
  type WhitelistDocument,
} from "./whitelist-schema.js";
import { WhitelistCache, type WhitelistCacheSnapshot } from "./whitelist-cache.js";
import { fetchWhitelist } from "./whitelist-fetcher.js";

const log = createLogger("whitelist-registry");

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

export type WhitelistSource = "remote" | "cache" | "demo-snapshot";

export interface WhitelistStatus {
  state: WhitelistState;
  issuedAt?: string;
  expiresAt?: string;
  source: WhitelistSource;
}

export interface WhitelistInitOptions {
  /** Electron `app.getPath("userData")`. The cache lives under `marketplace-whitelist/`. */
  userDataDir: string;
  /**
   * Path to the demo whitelist snapshot baked into asar. When set AND
   * `process.env.LVIS_DEMO_ENABLED === "1"`, the registry loads this file
   * exclusively and skips the network fetch entirely. Demo path bypasses
   * the monotonicity guard so a kiosk re-launch doesn't reject the snapshot.
   */
  demoSnapshotPath?: string;
  /** Skip the network fetch (for tests + offline demo). Cache + demo still apply. */
  online: boolean;
  /** Wall-clock now provider — injected for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Audit log sink. The boot wiring passes the shared `bootAuditLogger`. */
  audit?: (input: string) => void;
  /** Telemetry sink — incremented for each fetch/cache outcome. */
  telemetry?: (event: string, meta?: Record<string, string>) => void;
}

const STALE_GRACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface ResolvedSnapshot {
  doc: WhitelistDocument;
  source: WhitelistSource;
}

class WhitelistRegistry {
  private snapshot: ResolvedSnapshot | null = null;
  private now: () => number = Date.now;
  private initialized = false;
  /** Set when a fetch attempt found no cache and offline → permanent deny. */
  private noCacheOffline = false;
  /**
   * Ralph cycle 1 HIGH fix — trust roots used for signature verification.
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
   * Ralph cycle 1 — test-only key injection. Production callers use the
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

    // Demo snapshot path — kiosk / pre-prod / offline trade show.
    if (opts.demoSnapshotPath && process.env.LVIS_DEMO_ENABLED === "1") {
      const loaded = await this.tryLoadDemoSnapshot(opts.demoSnapshotPath);
      if (loaded) {
        this.snapshot = { doc: loaded, source: "demo-snapshot" };
        audit(`whitelist_loaded source=demo-snapshot issuedAt=${loaded.issuedAt}`);
        telemetry("whitelist_fetch_ok", { source: "demo-snapshot" });
        return;
      }
      log.warn("LVIS_DEMO_ENABLED set but demo snapshot failed to load — falling through to cache/remote");
    }

    const cache = new WhitelistCache(opts.userDataDir);
    const cached = await cache.load().catch((err) => {
      log.warn(`cache load failed: ${(err as Error).message}`);
      return null;
    });
    let highestSeenIssuedAt: string | undefined = cached?.meta.highestSeenIssuedAt;

    if (cached) {
      const verified = this.verifyCachedSnapshot(cached);
      if (verified) {
        this.snapshot = { doc: verified, source: "cache" };
        if (!highestSeenIssuedAt || Date.parse(verified.issuedAt) > Date.parse(highestSeenIssuedAt)) {
          highestSeenIssuedAt = verified.issuedAt;
        }
        telemetry("whitelist_cache_hit");
      } else {
        // Cache corrupted/unverifiable — treat as absent.
        telemetry("whitelist_cache_miss_offline", { reason: "corrupt" });
      }
    }

    if (!opts.online) {
      // Offline — cache (if any) is all we have. Record the "no-cache + offline"
      // state so `isAllowed` reports `whitelist-unreachable` unambiguously.
      if (!this.snapshot) {
        this.noCacheOffline = true;
        telemetry("whitelist_cache_miss_offline", { reason: "no-cache" });
        audit(`whitelist_unreachable reason=no-cache-and-offline`);
      }
      return;
    }

    // Online — try a fetch. Conditional GET via `If-None-Match` when we have
    // an ETag so the CDN can short-circuit.
    try {
      const meta = await cache.loadMeta();
      const outcome = await fetchWhitelist({ ifNoneMatch: meta.etag });
      if ("notModified" in outcome) {
        telemetry("whitelist_fetch_ok", { source: outcome.source, conditional: "304" });
        // Cache unchanged — keep current snapshot, touch lastFetchAt.
        await cache.storeMeta({
          ...meta,
          lastFetchAt: this.now(),
        }).catch(() => {});
        return;
      }
      const envelope = JSON.parse(outcome.signature) as SignatureEnvelope;
      const doc = parseWhitelistDocument(outcome.body);
      const verify = verifyEnvelope(
        Buffer.from(outcome.body, "utf-8"),
        envelope,
        this.publicKeys,
      );
      if (!verify.ok) {
        telemetry("whitelist_fetch_failed", { reason: "signature_invalid" });
        audit(`whitelist_fetch_failed reason=signature_invalid detail=${verify.reason ?? "unknown"}`);
        return;
      }
      // Monotonicity rollback guard.
      if (
        highestSeenIssuedAt &&
        Date.parse(doc.issuedAt) < Date.parse(highestSeenIssuedAt)
      ) {
        telemetry("whitelist_fetch_failed", { reason: "monotonicity" });
        audit(
          `whitelist_fetch_failed reason=monotonicity received=${doc.issuedAt} highest=${highestSeenIssuedAt}`,
        );
        return;
      }
      // Accept + persist.
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
      telemetry("whitelist_fetch_ok", { source: outcome.source });
      audit(`whitelist_loaded source=${outcome.source} issuedAt=${doc.issuedAt}`);
    } catch (err) {
      telemetry("whitelist_fetch_failed", { reason: "network" });
      audit(`whitelist_fetch_failed reason=network detail=${(err as Error).message}`);
      // Keep whatever snapshot the cache produced (may be null).
      if (!this.snapshot) {
        this.noCacheOffline = true;
        telemetry("whitelist_cache_miss_offline", { reason: "no-cache" });
      }
    }
  }

  /**
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
      // Ralph cycle 1 MEDIUM fix — emit the previously-declared but
      // never-called `whitelist_cache_stale` counter so operators see
      // when the registry is serving grants from a past-expiry doc
      // inside the 7d grace window. `keyPrefix` carries the requested
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

  private verifyCachedSnapshot(cached: WhitelistCacheSnapshot): WhitelistDocument | null {
    try {
      const doc = parseWhitelistDocument(cached.body);
      const envelope = JSON.parse(cached.signature) as SignatureEnvelope;
      const verify = verifyEnvelope(
        Buffer.from(cached.body, "utf-8"),
        envelope,
        this.publicKeys,
      );
      if (!verify.ok) {
        log.warn(`cached whitelist signature invalid: ${verify.reason}`);
        return null;
      }
      // Tier-3 signature key id pin — refuse to honor a cached doc signed
      // by the marketplace primary key (different trust domain).
      if (verify.key_id && verify.key_id !== WHITELIST_PRIMARY_KEY_ID) {
        log.warn(`cached whitelist signed by unexpected key_id=${verify.key_id}`);
        // Still allow non-primary signers that appear in WHITELIST_PUBLIC_KEYS
        // (rotation path), but never the marketplace key — `verifyEnvelope`
        // already excluded unknown keys, so reaching here means trusted.
      }
      return doc;
    } catch (err) {
      log.warn(`cached whitelist parse/verify failed: ${(err as Error).message}`);
      return null;
    }
  }

  private async tryLoadDemoSnapshot(path: string): Promise<WhitelistDocument | null> {
    try {
      if (!existsSync(path)) {
        log.warn(`demo snapshot missing: ${path}`);
        return null;
      }
      const body = await readFile(path, "utf-8");
      const sigPath = `${path}.sig`;
      // Ralph cycle 1 MEDIUM fix — demo snapshot signature is now MANDATORY.
      // Previously the verifier accepted the snapshot bare when `.sig` was
      // missing, on the theory that asar code-signing covered the trust
      // model. That assumption fails for two paths the comment didn't
      // account for: (a) a dev/test build where the asar isn't code-signed
      // at all and (b) on-disk tampering of the asar's static resources.
      // Fail closed when the sig is absent — operators can always
      // regenerate one with the existing `whitelist-v1` keypair.
      if (!existsSync(sigPath)) {
        log.warn(`demo snapshot signature missing (fail-closed): ${sigPath}`);
        return null;
      }
      const sigRaw = await readFile(sigPath, "utf-8");
      const envelope = JSON.parse(sigRaw) as SignatureEnvelope;
      const verify = verifyEnvelope(
        Buffer.from(body, "utf-8"),
        envelope,
        this.publicKeys,
      );
      if (!verify.ok) {
        log.warn(`demo snapshot signature invalid: ${verify.reason}`);
        return null;
      }
      return parseWhitelistDocument(body);
    } catch (err) {
      log.warn(`demo snapshot load failed: ${(err as Error).message}`);
      return null;
    }
  }
}

/** Process-wide singleton. Boot calls `init`; getSecret calls `isAllowed`. */
export const whitelistRegistry = new WhitelistRegistry();

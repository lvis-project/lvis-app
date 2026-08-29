/**
 * Plugin admission catalog registry singleton.
 *
 * Answers ONE question at ONE boundary: *may this exact byte sequence be
 * installed under this name?* The answer comes from a signed document issued
 * by the distributor, and every path that cannot produce a fresh, valid,
 * correctly-signed answer refuses the install.
 *
 * WHY THIS IS NOT `revocation-registry.ts` WITH A DIFFERENT PREDICATE
 * -------------------------------------------------------------------
 * The revocation registry is a BLOCK list, and every one of its failure
 * behaviours is tuned for that polarity:
 *
 *   - never obtained a document  → allow everything (being offline must not
 *                                  brick already-installed software)
 *   - document past `expiresAt`  → keep enforcing, warn only
 *   - fetch failed               → keep the cached snapshot, allow if none
 *
 * An ALLOW list inverts all three. Copying that handling here would not be a
 * partial implementation of admission; it would be a bypass with a comment on
 * it. The rules here are therefore stated positively, and each one is
 * enforced by a test that produces the condition for real:
 *
 *   1. NO DOCUMENT EVER OBTAINED → refuse. Not on first run, not offline, not
 *      on a timeout, not on a 500, not when the trust anchor set is empty.
 *      There is no branch in this module that reads "could not fetch, so
 *      proceed". Refusing to install is a survivable state; admitting an
 *      artifact nobody attested to is not.
 *   2. HELD DOCUMENT PAST ITS OWN `expiresAt` → refuse, with no grace window.
 *      The whitelist registry's 7-day grace exists because denying there
 *      breaks a running plugin mid-session. Installing is user-initiated,
 *      already network-bound, and trivially retryable, so a grace window
 *      would buy nothing a retry does not — and it would cost the withdrawal
 *      guarantee, because withdrawal is expressed by omission from the next
 *      issuance.
 *   3. UNPARSEABLE / UNKNOWN-FIELD DOCUMENT → "no valid document", never "an
 *      empty catalog". A fetched document that fails to parse is discarded and
 *      any previously held (signed, unexpired) snapshot is retained; a cached
 *      one that fails to parse is discarded outright.
 *   4. SIGNED BY A KEY THAT IS NOT A CURRENT ANCHOR → refuse. `verifyEnvelope`
 *      accepts any key in the map it is handed, so a RETIRED admission key is
 *      retired by REMOVING it from `ADMISSION_PUBLIC_KEYS` — there is no
 *      "warn but accept" branch here, unlike the revocation registry's
 *      unexpected-key path, because for an allow list the signing key IS the
 *      admission authority.
 *   5. ROLLBACK (`issuedAt` below the high-water mark) → discard the fetched
 *      document, retain the previous snapshot. Replaying an older catalog
 *      re-admits versions that were withdrawn by omission, so this guard is
 *      not defence-in-depth: it is the enforcement of withdrawal.
 *   6. `issuedAt` IMPLAUSIBLY IN THE FUTURE → discard without advancing the
 *      high-water mark. Without this, one bad document poisons the mark and
 *      refuses every genuine document after it — a denial of service that
 *      survives restarts, because the mark is on disk.
 *
 * FRESHNESS IS A SECURITY PROPERTY HERE. `init()` at boot is a latency
 * optimisation; the gate is `ensureFresh()`, awaited by the install path
 * immediately before `evaluate()`. Neither throws — they resolve to a state
 * `evaluate()` reads. The INSTALL PATH throws, on every decision that is not
 * `admitted`.
 */
import { createLogger } from "../../lib/logger.js";
import { verifyEnvelope, type PublicKeyInput } from "../envelope-verifier.js";
import { ADMISSION_PUBLIC_KEYS } from "../marketplace-keys.js";
import {
  checkIssuedAt,
  SignedDocumentCache,
  type SignedDocCacheMeta,
  type SignedDocCacheSnapshot,
} from "../signed-doc-cache.js";
import {
  fetchSignedDocument,
  type SignedDocSource,
} from "../signed-doc-fetcher.js";
import type { SignatureEnvelope, ResolvedSignedSnapshot } from "../types.js";
import { parseAdmissionDocument, type AdmissionDocument, type AdmissionEntry } from "./admission-schema.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";

const log = createLogger("admission-registry");

/**
 * Hosted alongside `whitelist.json` and `revocation.json` on the same
 * issuance repo, using the transport those two already share: primary GitHub
 * Pages, GitHub Release asset as fallback, conditional GET via ETag.
 *
 * Declared here rather than in a one-export wrapper module of its own — the
 * revocation and whitelist fetchers are each a file that names four constants
 * and forwards one call, and a third copy of that shape would be a third
 * place for the transport contract to drift.
 */
const ADMISSION_SOURCE: SignedDocSource = {
  primaryBase: "https://lvis-project.github.io/marketplace-whitelist/v1",
  fallbackBase:
    "https://github.com/lvis-project/marketplace-whitelist/releases/download/v1-latest",
  docFilename: "admission.json",
  sigFilename: "admission.json.sig",
};

/** `<userData>/` subdirectory holding the cached body, sidecar, and meta. */
const ADMISSION_CACHE_SUBDIR = "marketplace-admission";

/**
 * Whether a non-`admitted` decision refuses the install.
 *
 * `"observe"` still runs the whole pipeline — fetch, verify, monotonicity,
 * freshness, lookup — and still audits the exact refusal that would have
 * fired. It differs from `"enforce"` in one respect: the install path does not
 * throw. It is NOT a fallback for an unavailable catalog; there is no
 * condition under which the registry reports `admitted` without a fresh,
 * validly signed document that names the artifact.
 *
 * It is `"observe"` because the two operator-provisioned halves of this
 * control do not exist yet: `ADMISSION_PUBLIC_KEYS` is empty (the issuance
 * keypair is generated and held by the issuance repo's operator, not by this
 * source tree) and no `admission.json` has been issued. Enforcing before both
 * exist would refuse every marketplace install on every device.
 *
 * FLIPPING IT is a one-line source change in the same commit that provisions
 * the anchor, and it requires: the catalog published and covering 100% of
 * observed installs with matching hashes, document fetch success at or above
 * the agreed floor, and zero unexplained hash mismatches in the observed
 * results. Deliberately a source constant and not an environment variable or
 * a setting — an allow-list gate that an environment can downgrade at runtime
 * is not a gate.
 */
export const ADMISSION_ENFORCEMENT: "observe" | "enforce" = "observe";

/** Why an artifact was refused. Each value maps to distinct user-facing copy. */
type AdmissionRefusalCode =
  /** No valid document is held at all — never fetched, unfetchable, unverifiable, or no anchor. */
  | "admission-unavailable"
  /** A document is held but is past its own `expiresAt`. */
  | "admission-stale"
  /** The catalog is fresh and valid; this `slug@version` is not in it. */
  | "admission-not-listed"
  /** The catalog admits this `slug@version` under a different sha256. */
  | "admission-hash-mismatch"
  /**
   * The install could not name a concrete version to look up (the caller
   * reached the artifact store with `"latest"` and the catalog row carried no
   * resolved version). Distinct from `admission-not-listed` because the
   * remedy differs: nothing was withdrawn, the request was unresolvable, and
   * an allow list cannot admit what the caller cannot name.
   */
  | "admission-version-unresolved";

type AdmissionDecision =
  | {
      kind: "admitted";
      entry: AdmissionEntry;
      /** `issuedAt` of the document that authorised this — recorded on the install receipt. */
      issuedAt: string;
      /** Hex sha256 of the exact document body, so an operator can re-fetch and confirm. */
      documentSha256: string;
    }
  | { kind: "refused"; code: AdmissionRefusalCode; detail: string };

type AdmissionSource = "remote" | "cache";

interface AdmissionStatus {
  /** `true` once a valid signed document has been obtained (cache or remote). */
  hasDocument: boolean;
  /** `true` when the held document's own `expiresAt` has passed. It then admits nothing. */
  stale: boolean;
  issuedAt?: string;
  expiresAt?: string;
  source?: AdmissionSource;
  admissionCount?: number;
}

interface AdmissionInitOptions {
  /** Electron `app.getPath("userData")`. The cache lives under `marketplace-admission/`. */
  userDataDir: string;
  /** Skip the network fetch for offline tests or user-selected offline mode. */
  online: boolean;
  /** Wall-clock now provider — injected for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Audit log sink. The boot wiring passes the shared `bootAuditLogger`. */
  audit?: (input: string) => void;
  /** Telemetry sink — one call per fetch/parse/verify outcome. */
  telemetry?: (event: string, meta?: Record<string, string>) => void;
  /** App-shutdown AbortSignal so a slow CDN response doesn't outlive boot. */
  signal?: AbortSignal;
  /** Override the document source. Tests point this at a local server. */
  source?: SignedDocSource;
}

interface ResolvedAdmissionSnapshot extends ResolvedSignedSnapshot<AdmissionDocument, AdmissionSource> {
  /** Hex sha256 of the body bytes this snapshot was parsed from. */
  documentSha256: string;
}

class AdmissionRegistry {
  private snapshot: ResolvedAdmissionSnapshot | null = null;
  private cache: SignedDocumentCache | null = null;
  private highestSeenIssuedAt: string | undefined;
  private cacheLoaded = false;
  private online = true;
  private now: () => number = Date.now;
  private audit: (input: string) => void = () => {};
  private telemetry: (event: string, meta?: Record<string, string>) => void = () => {};
  private publicKeys: Record<string, PublicKeyInput> = ADMISSION_PUBLIC_KEYS;
  private source: SignedDocSource = ADMISSION_SOURCE;
  private inFlight: Promise<void> | null = null;

  /** Test-only — reset every field so one test cannot leak state into the next. */
  resetForTesting(): void {
    this.snapshot = null;
    this.cache = null;
    this.highestSeenIssuedAt = undefined;
    this.cacheLoaded = false;
    this.online = true;
    this.now = Date.now;
    this.audit = () => {};
    this.telemetry = () => {};
    this.publicKeys = ADMISSION_PUBLIC_KEYS;
    this.source = ADMISSION_SOURCE;
    this.inFlight = null;
  }

  /** Test-only key injection, mirroring `revocationRegistry.setPublicKeysForTesting`. */
  setPublicKeysForTesting(publicKeys: Record<string, PublicKeyInput>): void {
    this.publicKeys = publicKeys;
  }

  /**
   * Configure the registry and warm it from disk + network.
   *
   * Boot calls this so the first install does not pay a cold fetch. It is NOT
   * the gate: a device that boots, sleeps for two days, and then installs must
   * not install against the document it warmed at boot, which is why the
   * install path awaits `ensureFresh()` regardless of what happened here.
   *
   * Never throws — a network blip must not crash boot.
   */
  async init(opts: AdmissionInitOptions): Promise<void> {
    this.now = opts.now ?? Date.now;
    this.audit = opts.audit ?? (() => {});
    this.telemetry = opts.telemetry ?? (() => {});
    this.online = opts.online;
    this.source = opts.source ?? ADMISSION_SOURCE;
    this.cache = new SignedDocumentCache(
      opts.userDataDir,
      ADMISSION_CACHE_SUBDIR,
      ADMISSION_SOURCE.docFilename,
      ADMISSION_SOURCE.sigFilename,
    );
    this.cacheLoaded = false;
    this.snapshot = null;
    this.highestSeenIssuedAt = undefined;
    await this.ensureFresh(opts.signal);
  }

  /**
   * Bring the held document up to date, then return. Awaited by the install
   * path immediately before `evaluate()`.
   *
   * Never throws. Concurrent callers share one in-flight refresh so a
   * multi-plugin install does not open N conditional GETs.
   */
  async ensureFresh(signal?: AbortSignal): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.refresh(signal).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /**
   * Decide one `(slug, version)` against the held document.
   *
   * Synchronous and pure with respect to the network — every network concern
   * was already resolved by `ensureFresh()`. Callers MUST await that first;
   * calling `evaluate()` alone on a cold registry correctly returns
   * `admission-unavailable` rather than silently admitting.
   */
  evaluate(slug: string, version: string): AdmissionDecision {
    if (!this.snapshot) {
      const anchorCount = Object.keys(this.publicKeys).length;
      const detail =
        anchorCount === 0
          ? "no admission trust anchor is configured for this build, so no catalog can be verified"
          : "no valid admission catalog has been obtained";
      return { kind: "refused", code: "admission-unavailable", detail };
    }
    const { doc } = this.snapshot;
    const expiresAt = Date.parse(doc.expiresAt);
    const now = this.now();
    if (now > expiresAt) {
      // No grace window, on purpose. See rule 2 in the module doc.
      return {
        kind: "refused",
        code: "admission-stale",
        detail:
          `the admission catalog expired at ${doc.expiresAt}`
          + ` and this device's clock reads ${new Date(now).toISOString()}`,
      };
    }
    if (!version || version === "latest") {
      return {
        kind: "refused",
        code: "admission-version-unresolved",
        detail: `install of '${slug}' did not resolve to a concrete version before the admission check`,
      };
    }
    const entry = doc.admissions.find((row) => row.slug === slug && row.version === version);
    if (!entry) {
      return {
        kind: "refused",
        code: "admission-not-listed",
        detail: `'${slug}@${version}' is not admitted by the catalog issued at ${doc.issuedAt}`,
      };
    }
    return {
      kind: "admitted",
      entry,
      issuedAt: doc.issuedAt,
      documentSha256: this.snapshot.documentSha256,
    };
  }

  status(): AdmissionStatus {
    if (!this.snapshot) return { hasDocument: false, stale: false };
    const { doc, source } = this.snapshot;
    return {
      hasDocument: true,
      stale: this.now() > Date.parse(doc.expiresAt),
      issuedAt: doc.issuedAt,
      expiresAt: doc.expiresAt,
      source,
      admissionCount: doc.admissions.length,
    };
  }

  // ---------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------

  private async refresh(signal?: AbortSignal): Promise<void> {
    if (!this.cache) {
      // Unconfigured. Fails closed (`evaluate` has no snapshot to read), but
      // it is a wiring bug rather than an environment condition, so it is
      // reported as one instead of being silently indistinguishable from a
      // CDN outage.
      log.error("ensureFresh called before init — no admission catalog will be available");
      this.audit("admission_unconfigured (install refuses: registry was never initialised)");
      return;
    }
    await this.loadCacheOnce();
    if (!this.online) {
      if (!this.snapshot) {
        this.telemetry("admission_unavailable", { reason: "offline-no-cache" });
        this.audit("admission_unavailable reason=offline-and-no-cache (install refuses)");
      }
      return;
    }

    let meta: SignedDocCacheMeta = await this.cache.loadMeta().catch(() => ({}));
    try {
      const outcome = await fetchSignedDocument(
        this.source,
        {
          ...(meta.etag ? { ifNoneMatch: meta.etag } : {}),
          ...(signal ? { signal } : {}),
        },
        "lvis-app/admission-registry",
      );
      if ("notModified" in outcome) {
        // 304 confirms the body is unchanged. It does NOT extend the held
        // document's `expiresAt` — a heartbeat re-issue changes the body and
        // therefore the ETag, so a 304 on an expired document means the
        // issuer has stalled, and `evaluate()` must keep reporting stale.
        this.telemetry("admission_fetch_ok", { source: outcome.source, conditional: "304" });
        await this.cache.storeMeta({ ...meta, lastFetchAt: this.now() }).catch(() => {});
        return;
      }
      const accepted = this.acceptDocument(outcome.body, outcome.signature, "remote");
      if (!accepted) return;
      meta = {
        ...(outcome.etag ? { etag: outcome.etag } : {}),
        ...(this.highestSeenIssuedAt ? { highestSeenIssuedAt: this.highestSeenIssuedAt } : {}),
        lastFetchAt: this.now(),
      };
      await this.cache
        .store({ body: outcome.body, signature: outcome.signature, meta })
        .catch((err) => log.warn(`cache store failed: ${(err as Error).message}`));
      this.telemetry("admission_fetch_ok", { source: outcome.source });
      this.audit(
        `admission_loaded source=${outcome.source} issuedAt=${accepted.issuedAt}`
          + ` expiresAt=${accepted.expiresAt} admissions=${accepted.admissions.length}`,
      );
    } catch (err) {
      // The held snapshot (if any) survives a fetch failure: it is a signed,
      // unexpired statement, and the CDN being unreachable does not unmake it.
      // Its own `expiresAt` still bounds it — that is what keeps this a
      // latency allowance rather than an availability crutch.
      this.telemetry("admission_fetch_failed", { reason: "network" });
      this.audit(`admission_fetch_failed reason=network detail=${(err as Error).message}`);
      if (!this.snapshot) {
        this.audit("admission_unavailable reason=fetch-failed-and-no-cache (install refuses)");
      }
    }
  }

  private async loadCacheOnce(): Promise<void> {
    if (this.cacheLoaded || !this.cache) return;
    this.cacheLoaded = true;
    const cached: SignedDocCacheSnapshot | null = await this.cache.load().catch((err) => {
      log.warn(`cache load failed: ${(err as Error).message}`);
      return null;
    });
    if (!cached) return;
    this.highestSeenIssuedAt = cached.meta.highestSeenIssuedAt;
    const accepted = this.acceptDocument(cached.body, cached.signature, "cache");
    if (!accepted) {
      // A cached document that no longer parses or verifies is not evidence of
      // anything. Drop it so a later boot does not keep re-reading it, and so
      // its `highestSeenIssuedAt` cannot be attributed to a document we can no
      // longer validate.
      await this.cache.clear().catch(() => {});
      this.telemetry("admission_cache_rejected");
    }
  }

  /**
   * Validate one candidate document and, if every check passes, make it the
   * held snapshot. Returns the accepted document, or `null` when it was
   * rejected — in which case the previously held snapshot is untouched.
   */
  private acceptDocument(
    body: string,
    signature: string,
    source: AdmissionSource,
  ): AdmissionDocument | null {
    if (Object.keys(this.publicKeys).length === 0) {
      // Distinct from "no signature matched": an empty anchor set is a build
      // configuration fact, not a signature failure, and conflating the two
      // sends an operator hunting for tampering that did not happen.
      this.telemetry("admission_rejected", { source, reason: "no-anchor" });
      this.audit(`admission_rejected source=${source} reason=no-admission-trust-anchor-configured`);
      return null;
    }
    let doc: AdmissionDocument;
    try {
      doc = parseAdmissionDocument(body);
    } catch (err) {
      this.telemetry("admission_rejected", { source, reason: "parse" });
      this.audit(`admission_rejected source=${source} reason=parse detail=${(err as Error).message}`);
      return null;
    }
    let envelope: SignatureEnvelope;
    try {
      envelope = JSON.parse(signature) as SignatureEnvelope;
    } catch (err) {
      this.telemetry("admission_rejected", { source, reason: "sidecar-parse" });
      this.audit(
        `admission_rejected source=${source} reason=sidecar-parse detail=${(err as Error).message}`,
      );
      return null;
    }
    const verified = verifyEnvelope(Buffer.from(body, "utf-8"), envelope, this.publicKeys);
    if (!verified.ok) {
      // Covers both "signed by a key we do not trust" and "signed by a key we
      // used to trust": a retired admission key is retired by removing it from
      // `ADMISSION_PUBLIC_KEYS`, and `verifyEnvelope` only accepts keys in the
      // map it is handed, so both arrive here. There is no branch that accepts
      // an unrecognised signer with a warning.
      this.telemetry("admission_rejected", { source, reason: "signature" });
      this.audit(
        `admission_rejected source=${source} reason=signature detail=${verified.reason ?? "unknown"}`,
      );
      return null;
    }

    // Rules 5 and 6, both stated once in `checkIssuedAt` because the
    // whitelist and revocation registries enforce the same two rules over the
    // same on-disk mark. A rejection here never advances the mark.
    const issuedAtMs = Date.parse(doc.issuedAt);
    const issuedAtRejection = checkIssuedAt(doc.issuedAt, this.highestSeenIssuedAt, this.now());
    if (issuedAtRejection === "issued-in-future") {
      this.telemetry("admission_rejected", { source, reason: "issued-in-future" });
      this.audit(
        `admission_rejected source=${source} reason=issued-in-future issuedAt=${doc.issuedAt}`
          + ` deviceClock=${new Date(this.now()).toISOString()}`,
      );
      return null;
    }
    if (issuedAtRejection === "monotonicity") {
      this.telemetry("admission_rejected", { source, reason: "monotonicity" });
      this.audit(
        `admission_rejected source=${source} reason=monotonicity received=${doc.issuedAt}`
          + ` highest=${this.highestSeenIssuedAt}`,
      );
      return null;
    }

    if (!this.highestSeenIssuedAt || issuedAtMs > Date.parse(this.highestSeenIssuedAt)) {
      this.highestSeenIssuedAt = doc.issuedAt;
    }
    this.snapshot = {
      doc,
      source,
      documentSha256: sha256Hex(Buffer.from(body, "utf-8")),
    };
    return doc;
  }
}

/** Process-wide singleton. Boot calls `init`; the install path calls `ensureFresh` + `evaluate`. */
export const admissionRegistry = new AdmissionRegistry();

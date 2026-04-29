/**
 * S2 — Marketplace binary delivery installer (P1 dual-path / P2 prefer-direct).
 *
 * Downloads a plugin tarball directly from the marketplace server's
 * `/api/v1/plugins/{slug}/download?version=X` endpoint, verifies the
 * `X-Plugin-SHA256` header + the `/download.sig` envelope signed with a
 * trusted ed25519 key (see §0.1 of `autopilot-impl.md`), persists the
 * verified tarball under `~/.lvis/plugins/.downloads/` and returns the
 * artifact path for the caller to stage into the installed layout.
 * (Extraction itself is the caller's responsibility.)
 *
 * This module is intentionally decoupled from the npm fallback path in
 * `marketplace.ts` — it exposes a pure function + a small HTTP interface
 * so the feature-flag dispatcher can compose both paths without leaking
 * marketplace URLs into the npm install branch.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { verifyEnvelope, type PublicKeyInput } from "./envelope-verifier.js";
import type { SignatureEnvelope, VerifyResult } from "./types.js";
import { getCachedTarball, isOfflineCacheEnabled, setCachedTarball } from "./offline-cache.js";

/**
 * Minimal HTTP surface the installer needs. Lets callers inject either
 * {@link MarketplaceApiFetcher}-backed clients or test mocks without
 * pulling the whole Marketplace service interface.
 */
export interface MarketplaceHttp {
  /**
   * GET `/api/v1/plugins/{slug}/download?version=X`. Must return the raw
   * tarball bytes + the value of the `X-Plugin-SHA256` response header (hex)
   * and a numeric `status` for 4xx/5xx branch handling.
   *
   * When `onChunk` is provided, the implementation SHOULD call it periodically
   * as bytes arrive so callers can report byte-level download progress. The
   * final call with all bytes must always be emitted regardless of throttling.
   */
  downloadArtifact(
    slug: string,
    version: string,
    onChunk?: (bytesDownloaded: number, bytesTotal: number | null) => void,
  ): Promise<{
    body: Buffer;
    sha256Header: string | null;
    status: number;
    retryAfterSeconds?: number;
  }>;
  /** GET `/api/v1/plugins/{slug}/download.sig?version=X`. */
  fetchSignatureEnvelope(slug: string, version: string): Promise<SignatureEnvelope>;
}

/**
 * Granular install progress event fired by `installFromMarketplace` via
 * `MarketplaceInstallerOptions.onProgress`. The `downloading` variant
 * carries byte-level counters; all others are point-in-time signals.
 */
export type InstallerProgressEvent =
  | { phase: "downloading"; bytesDownloaded: number; bytesTotal: number | null }
  | { phase: "verifying" }
  | { phase: "registering" };

export interface MarketplaceInstallerOptions {
  http: MarketplaceHttp;
  /** Map of `key_id → pub key` used to verify the envelope. */
  publicKeys: Record<string, PublicKeyInput>;
  /**
   * Target download root — REQUIRED. Callers must inject
   * `paths.cacheRoot` (or a sibling) explicitly so every download lands
   * under the plugin tree's own `.cache/` and the layout stays in one
   * place — no homedir() fallback that could leak outside PluginPaths.
   */
  downloadRoot: string;
  /**
   * Maximum allowed future drift for `envelope.iat`, in seconds.
   * Default: 72h (matches §0.6 revocation guard window).
   */
  maxClockSkewSec?: number;
  /**
   * Clock injected for tests; defaults to `() => Date.now() / 1000`.
   */
  nowSec?: () => number;
  /**
   * Maximum number of download attempts (including the initial one) before
   * giving up on 429/5xx/network errors. Default 3. Note: despite the legacy
   * name, this is the TOTAL attempt count, not the retry count — `maxRetries=1`
   * means a single attempt with no retry.
   */
  maxRetries?: number;
  /**
   * Override the offline cache base directory. Pass `null` to disable the
   * tarball cache entirely (useful in tests). Defaults to the global cache
   * root under `~/.lvis/marketplace-cache/`.
   */
  cacheBase?: string | null;
  /**
   * Optional granular progress callback. Fired at natural phase boundaries
   * during download → verify → persist. The `registering` event fires just
   * before the final atomic rename so callers can show a "등록 중…" label.
   * When omitted the installer runs silently (backward-compatible).
   *
   * Note: `downloading` events are NOT fired on cache hits (`fromCache=true`).
   */
  onProgress?: (event: InstallerProgressEvent) => void;
}

export interface InstalledArtifact {
  slug: string;
  version: string;
  tarballPath: string;
  sha256: string;
  signerKeyId: string;
}

export class MarketplaceInstallerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "MarketplaceInstallerError";
  }
}

const DEFAULT_MAX_SKEW_SEC = 72 * 3600;
const DEFAULT_MAX_RETRIES = 3;

/**
 * Encodes an untrusted marketplace version into a flat filename component.
 * Using a byte-preserving hex encoding avoids path separators and traversal
 * segments while keeping the mapping deterministic and collision-free.
 */
export function encodeMarketplaceVersionForFilename(version: string): string {
  const encoded = Buffer.from(version, "utf8").toString("hex");
  return encoded.length > 0 ? encoded : "empty";
}

function assertWithinDir(dir: string, filePath: string): void {
  const rel = relative(dir, filePath);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new MarketplaceInstallerError(
      "WRITE_FAILED",
      `refusing to write outside verified download root: ${filePath}`,
    );
  }
}

export function buildVerifiedTarballPaths(
  downloadRoot: string,
  slug: string,
  version: string,
  tmpSuffix = randomBytes(6).toString("hex"),
): { pluginDir: string; tarballPath: string; tmpPath: string } {
  const pluginDir = resolve(downloadRoot, slug);
  assertWithinDir(downloadRoot, pluginDir);
  const safeVersion = encodeMarketplaceVersionForFilename(version);
  const tarballPath = resolve(pluginDir, `${safeVersion}.tar.gz`);
  const tmpPath = resolve(pluginDir, `.${safeVersion}.tar.gz.${tmpSuffix}.tmp`);
  assertWithinDir(pluginDir, tarballPath);
  assertWithinDir(pluginDir, tmpPath);
  return { pluginDir, tarballPath, tmpPath };
}

/**
 * Download → verify → stage a plugin tarball. Does NOT register the plugin
 * into `registry.json` — that's the caller's responsibility (see
 * `marketplace.ts` for the registry-writing wrapper).
 */
export async function installFromMarketplace(
  slug: string,
  version: string,
  opts: MarketplaceInstallerOptions,
): Promise<InstalledArtifact> {
  const downloadRoot = opts.downloadRoot;
  const maxSkewSec = opts.maxClockSkewSec ?? DEFAULT_MAX_SKEW_SEC;
  const nowSec = opts.nowSec ?? (() => Date.now() / 1000);
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;

  // 1. Check offline tarball cache; fall back to network download.
  // Tarball cache is only active when opts.cacheBase is provided as a non-null
  // string AND the feature flag is enabled. Callers that don't set cacheBase
  // (including all pre-existing tests) bypass the cache entirely, preventing
  // stale-cache interference with signature verification tests.
  const cacheBase = typeof opts.cacheBase === "string" ? opts.cacheBase : null;
  const useCache = cacheBase !== null && isOfflineCacheEnabled();
  let body: Buffer = Buffer.alloc(0);
  let sha256Header: string | null = null;
  let fromCache = false;

  if (useCache && cacheBase) {
    const cached = await getCachedTarball(slug, version, cacheBase);
    if (cached) {
      body = cached;
      fromCache = true;
    }
  }

  let computedSha256: string;
  let signerKeyId = "cached";

  if (!fromCache) {
    const onChunk = opts.onProgress
      ? (bytesDownloaded: number, bytesTotal: number | null) => {
          opts.onProgress!({ phase: "downloading", bytesDownloaded, bytesTotal });
        }
      : undefined;
    const downloaded = await downloadWithRetry(opts.http, slug, version, maxRetries, onChunk);
    body = downloaded.body;
    sha256Header = downloaded.sha256Header;
  }

  // 2. SHA-256 cross-check against server header (skip for cache hits where
  //    no header was returned, but always compute the digest for sig verification).
  // Fire verifying event before computing the sha256 digest.
  opts.onProgress?.({ phase: "verifying" });
  computedSha256 = createHash("sha256").update(body).digest("hex");
  if (sha256Header && sha256Header.toLowerCase() !== computedSha256) {
    throw new MarketplaceInstallerError(
      "SHA256_HEADER_MISMATCH",
      `X-Plugin-SHA256 header mismatch for ${slug}@${version}: header=${sha256Header} computed=${computedSha256}`,
    );
  }

  // 3. Fetch sig envelope — always re-fetched, even on cache hits.
  //    A cached tarball byte sequence is trusted only when it passes the
  //    current envelope signature; never short-circuit this step (Copilot
  //    security flag: cache hits must not bypass envelope-verifier).
  let envelope: SignatureEnvelope;
  try {
    envelope = await opts.http.fetchSignatureEnvelope(slug, version);
  } catch (err) {
    throw new MarketplaceInstallerError(
      "ENVELOPE_FETCH_FAILED",
      `failed to fetch signature envelope: ${(err as Error).message}`,
    );
  }

  // 4. Clock-skew guard — reject envelopes whose `iat` is missing / non-finite
  //    OR implausibly far in the future (common symptom of a compromised
  //    server clock or replayed envelope with tampered timestamp). Fail closed
  //    on malformed iat so a malicious envelope can't skip the guard by
  //    emitting a non-numeric / NaN value.
  const now = nowSec();
  if (typeof envelope.iat !== "number" || !Number.isFinite(envelope.iat)) {
    throw new MarketplaceInstallerError(
      "CLOCK_SKEW",
      `envelope iat is missing or not a finite number (got ${String(envelope.iat)})`,
    );
  }
  if (envelope.iat - now > maxSkewSec) {
    throw new MarketplaceInstallerError(
      "CLOCK_SKEW",
      `envelope iat=${envelope.iat} is more than ${maxSkewSec}s in the future (now=${now})`,
    );
  }

  // 5. Verify signature.
  // Detect the empty trusted-key configuration up front. When the bundled
  // SDK key set is filtered to empty (e.g. `bun run start` keeps the
  // production SDK keys but `LVIS_DEV=1` is unset, dropping the dev/poc
  // test keys) every envelope hits a generic "no signature matched" error.
  // Surfacing the misconfiguration explicitly avoids the user chasing
  // signature corruption that isn't there.
  // Distinct code (KEYS_NOT_CONFIGURED, not SIGNATURE_INVALID) so ops
  // dashboards / SOC alerts that page on signature failures don't get false
  // positives from a launcher misconfig — the two have very different
  // operational meanings.
  if (Object.keys(opts.publicKeys).length === 0) {
    throw new MarketplaceInstallerError(
      "KEYS_NOT_CONFIGURED",
      "no trusted marketplace public keys are configured for this build — set LVIS_DEV=1 to enable the bundled dev/poc keys, or ship a packaged build with production keys",
    );
  }
  const result: VerifyResult = verifyEnvelope(body, envelope, opts.publicKeys);
  if (!result.ok) {
    throw new MarketplaceInstallerError(
      "SIGNATURE_INVALID",
      `signature verification failed: ${result.reason ?? "unknown"}`,
    );
  }
  signerKeyId = result.key_id ?? "unknown";

  // Store verified tarball in offline cache (only after successful verification).
  if (useCache && cacheBase && !fromCache) {
    await setCachedTarball(slug, version, body, cacheBase);
  }

  // 6. Persist tarball atomically: write to a temp file in the same directory
  //    then rename() into place so a crash/kill mid-write cannot leave a
  //    partial/corrupt verified tarball that looks "installed".
  opts.onProgress?.({ phase: "registering" });
  const { pluginDir, tarballPath, tmpPath } = buildVerifiedTarballPaths(
    downloadRoot,
    slug,
    version,
  );
  await mkdir(pluginDir, { recursive: true });
  try {
    await writeFile(tmpPath, body);
    try {
      await rename(tmpPath, tarballPath);
    } catch (renameErr) {
      // Windows rename() throws EEXIST when the destination already exists
      // (POSIX rename() silently overwrites). Fall back to rm-then-rename so
      // upgrading an already-installed version still succeeds.
      if ((renameErr as NodeJS.ErrnoException).code === "EEXIST") {
        await rm(tarballPath, { force: true });
        await rename(tmpPath, tarballPath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new MarketplaceInstallerError(
      "WRITE_FAILED",
      `failed to persist tarball to ${tarballPath}: ${(err as Error).message}`,
    );
  }

  return {
    slug,
    version,
    tarballPath,
    sha256: computedSha256,
    signerKeyId,
  };
}

/**
 * GET `/download` with exponential backoff on 429 responses. Honors
 * `Retry-After` when present, else falls back to `2^attempt * 500ms`.
 */
async function downloadWithRetry(
  http: MarketplaceHttp,
  slug: string,
  version: string,
  maxRetries: number,
  onChunk?: (bytesDownloaded: number, bytesTotal: number | null) => void,
): Promise<{ body: Buffer; sha256Header: string | null }> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    let res: Awaited<ReturnType<MarketplaceHttp["downloadArtifact"]>>;
    try {
      res = await http.downloadArtifact(slug, version, onChunk);
    } catch (err) {
      lastErr = err as Error;
      // Network errors: retry with backoff like 429.
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.status === 429) {
      const waitSec = res.retryAfterSeconds ?? Math.pow(2, attempt) * 0.5;
      // Track a diagnosable last error so exhausting retries on 429s does not
      // surface as "unknown error" in the RETRY_EXHAUSTED message.
      lastErr = new MarketplaceInstallerError(
        "RATE_LIMITED",
        `marketplace returned 429 for ${slug}@${version} (retry-after=${waitSec}s)`,
      );
      await sleep(Math.max(0, waitSec * 1000));
      continue;
    }
    if (res.status >= 500) {
      lastErr = new MarketplaceInstallerError(
        "SERVER_ERROR",
        `marketplace returned ${res.status} for ${slug}@${version}`,
      );
      await sleep(backoffMs(attempt));
      continue;
    }
    if (res.status >= 400) {
      throw new MarketplaceInstallerError(
        "CLIENT_ERROR",
        `marketplace returned ${res.status} for ${slug}@${version}`,
      );
    }
    return { body: res.body, sha256Header: res.sha256Header };
  }
  throw new MarketplaceInstallerError(
    "RETRY_EXHAUSTED",
    `download failed after ${maxRetries} attempts: ${lastErr?.message ?? "unknown error"}`,
  );
}

function backoffMs(attempt: number): number {
  return Math.pow(2, attempt) * 500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Feature flag helper — centralised so boot code + tests stay in sync.
 * When `true`, the marketplace-direct path is preferred over npm.
 * Default: `false` (P1 rollout — npm is default, marketplace is opt-in).
 */
export function isMarketplaceDirectPreferred(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.LVIS_MARKETPLACE_PREFER_DIRECT;
  if (!v) return false;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

/**
 * Feature flag — allow falling back to npm when marketplace-direct fails.
 * Default: `true` during P1. Flip to `false` in P2 after marketplace
 * reliability is proven by telemetry.
 */
export function isNpmFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.MARKETPLACE_NPM_FALLBACK;
  if (v === undefined) return true;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

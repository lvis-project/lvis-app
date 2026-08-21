/**
 * PluginArtifactStore — artifact-management seam.
 *
 * Pulls the artifact-management responsibilities out of the
 * 1100-line `PluginMarketplaceService` god-class so:
 *
 *   1. `marketplace.ts` becomes an orchestrator (catalog → install order →
 *      registry write) and stops owning download/extract/cache plumbing.
 *   2. The MCP marketplace install consumer instantiates a parallel store
 *      rooted at `~/.lvis/mcp/<slug>/` without copying the entire pipeline.
 *
 * What this module owns:
 *   - signed-zip download + envelope verification (delegates to
 *     `installFromMarketplace` in marketplace-installer.ts)
 *   - atomic stage → swap zip extraction (Windows-safe rename)
 *   - per-plugin install/rollback history journal (`history.json`)
 *   - per-version manifest snapshot under `cacheRoot/<slug>/<version>/`
 *
 * What it does NOT own (caller's domain):
 *   - the marketplace catalog / fetcher selection
 *   - `registry.json` updates
 *   - dependency resolution
 *   - per-plugin lifecycle locks
 *
 * The store is transport- and plugin-kind agnostic: callers supply
 * `installRoot` (where to extract) and `cacheRoot` (where to keep history
 * + version snapshots). Regular plugins point these at `~/.lvis/plugins/`;
 * MCP consumers point them at `~/.lvis/mcp/`.
 */

import AdmZip from "adm-zip";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isResolvedPathWithin } from "./plugin-storage-containment.js";
import { randomUUID } from "node:crypto";

import {
  installFromMarketplace,
  type InstallerProgressEvent,
  type MarketplaceHttp,
} from "./marketplace-installer.js";
import {
  canonicalZipEntryPathIdentity,
  sanitizeZipEntryPath,
} from "./zip-entry-path.js";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import type { PublicKeyInput } from "./envelope-verifier.js";
import {
  type PluginAccessSpec,
  type PluginMarketplaceItem,
  type PluginRegistryEntryInstallSource,
} from "./types.js";
import { stripLegacyPluginToolGrants } from "./registry.js";
import { tombstoneAndDeferredRemove } from "./installed-entry-fs.js";
import {
  buildInstallReceipt,
  restoreInstallReceiptRaw,
  type PluginAdmissionRecord,
  type PluginInstallReceipt,
} from "./plugin-install-receipt.js";
import { createLogger } from "../lib/logger.js";
import {
  BACKGROUND_ATTEMPTS,
  DIRECTORY_OP_LOCK_CODES,
  transientFsLockDelayMs,
} from "../lib/transient-fs-lock-retry.js";
import { assertSafeArtifactSlug } from "./plugin-id.js";
import {
  assertCompressedArtifactSize,
  isMarketplaceArtifactLimitProvider,
  MarketplaceArtifactLimitError,
  resolveMarketplaceArtifactLimits,
  type MarketplaceArtifactLimits,
} from "./marketplace-artifact-limits.js";
import { withMarketplaceArtifactResourceSlot } from "./marketplace-artifact-resource-gate.js";
import { getLvisAppVersion } from "../shared/app-version.js";
import { assertPluginCandidateAppCompatible } from "./update-condition.js";
import { PluginNotAdmittedError, PluginRevokedError } from "../shared/plugin-install-result.js";
import { revocationRegistry } from "./revocation/revocation-registry.js";
import {
  admissionRegistry,
  ADMISSION_ENFORCEMENT,
} from "./admission/admission-registry.js";
import {
  isCommittedPluginGenerationPublicationError,
  type CommittedPluginGenerationPublicationError,
} from "./committed-generation-publication-error.js";
export { assertSafeArtifactSlug } from "./plugin-id.js";

/** Shared last-line defense for every marketplace artifact consumer. */
export function assertMarketplaceAppUpgradeNotRequired(
  plugin: Pick<PluginMarketplaceItem, "version" | "requires" | "upgradeRequired">,
): void {
  assertPluginCandidateAppCompatible(plugin, getLvisAppVersion());
}

/**
 * Shared last-line defense: refuse to install a `slug@version` the
 * marketplace revocation registry blocks (explicit blocklist) or that falls
 * below the plugin's pinned minimum version. The install-time twin of the
 * `markRevoked` LOAD-boundary gate (`plugins/runtime/index.ts`) — a
 * version that would be rejected on the next boot must never be installed
 * in the first place.
 *
 * A catalog item with no `version` (should not happen for a real catalog
 * entry) is a no-op here rather than a throw — there is nothing to
 * evaluate, and the LOAD-boundary gate is the backstop regardless.
 */
export function assertMarketplaceNotRevoked(
  plugin: Pick<PluginMarketplaceItem, "id" | "version">,
): void {
  if (!plugin.version) return;
  const decision = revocationRegistry.evaluate(plugin.id, plugin.version);
  if (decision.kind === "block") {
    throw new PluginRevokedError(plugin.id, plugin.version, decision.reason);
  }
}
const log = createLogger("plugin-artifact-store");

/**
 * Resolve the sha256 the downloaded bytes must match, from the signed
 * admission catalog.
 *
 * This is the install-time ALLOW gate, and it is the only place the catalog is
 * consulted. It runs BEFORE any bytes move, so a refusal costs one conditional
 * GET rather than a full artifact download.
 *
 * Three things happen here that the pre-catalog path could not do:
 *
 *  1. The version is resolved to a concrete one first. `downloadVerifiedArtifact`
 *     accepts the literal `"latest"`, which an allow list cannot look up — it
 *     can only admit a name it holds. `"latest"` resolves through the catalog
 *     row's own `version`; if that is absent the install is REFUSED rather than
 *     admitted against an unspecified version.
 *  2. The hash the download is checked against comes from a SIGNED statement.
 *     Before this it came from the marketplace's unsigned catalog JSON, served
 *     by the same origin as the bytes, so it was a consistency check and not
 *     evidence — and `selectExpectedArtifactSha256` returns `undefined` for a
 *     pinned or rollback install whose exact hash the row does not carry,
 *     leaving no catalog cross-check at all for precisely those installs.
 *  3. The unsigned catalog row's hash, when it has one, is cross-checked
 *     against the signed row BEFORE the download. A disagreement means the
 *     marketplace is offering bytes the distributor did not admit, which on
 *     the happy path never happens, so it is surfaced as an integrity event
 *     rather than as a routine mismatch.
 *
 * While {@link ADMISSION_ENFORCEMENT} is `"observe"` the same decision is
 * computed and logged but not thrown, and the legacy unsigned hash is returned
 * so behaviour is unchanged. That mode never turns a refusal into an
 * admission: there is no path here that reports success on a missing catalog.
 */
async function resolveMarketplaceAdmission(
  plugin: Pick<
    PluginMarketplaceItem,
    "id" | "slug" | "version" | "artifactSha256" | "artifactSha256ByVersion"
  >,
  version: string,
  signal?: AbortSignal,
): Promise<{
  expectedArtifactSha256: string | undefined;
  admission: PluginAdmissionRecord | null;
}> {
  const slug = plugin.slug ?? plugin.id;
  const catalogSha256 = selectExpectedArtifactSha256(plugin, version);
  const resolvedVersion = version === "latest" ? (plugin.version ?? version) : version;

  await admissionRegistry.ensureFresh(signal);
  const decision = admissionRegistry.evaluate(slug, resolvedVersion);

  if (decision.kind === "refused") {
    if (ADMISSION_ENFORCEMENT === "enforce") {
      throw new PluginNotAdmittedError(plugin.id, resolvedVersion, decision.code, decision.detail);
    }
    log.warn(
      `admission would refuse '${slug}@${resolvedVersion}': ${decision.code} — ${decision.detail}`,
    );
    return { expectedArtifactSha256: catalogSha256, admission: null };
  }

  const admittedSha256 = decision.entry.artifactSha256;
  if (catalogSha256 && catalogSha256.trim().toLowerCase() !== admittedSha256) {
    const detail =
      `the marketplace catalog offers sha256=${catalogSha256} for '${slug}@${resolvedVersion}'`
      + ` but the distributor admitted sha256=${admittedSha256}`;
    if (ADMISSION_ENFORCEMENT === "enforce") {
      throw new PluginNotAdmittedError(
        plugin.id,
        resolvedVersion,
        "admission-hash-mismatch",
        detail,
      );
    }
    log.error(`admission hash mismatch (not enforced): ${detail}`);
    return { expectedArtifactSha256: catalogSha256, admission: null };
  }

  const admission: PluginAdmissionRecord = {
    issuedAt: decision.issuedAt,
    documentSha256: decision.documentSha256,
    publisher: decision.entry.publisher,
  };
  return {
    expectedArtifactSha256:
      ADMISSION_ENFORCEMENT === "enforce" ? admittedSha256 : catalogSha256,
    admission,
  };
}

/**
 * Windows transient-lock codes for the directory-swap / `rm()` paths. The set
 * itself lives in `lib/transient-fs-lock-retry.ts` alongside the narrower set
 * the file-rename ladder uses and the shared delay curve, so the two ladders
 * cannot drift apart again. macOS/Linux do not surface these for this path.
 */
const TRANSIENT_FS_LOCK_CODES = DIRECTORY_OP_LOCK_CODES;

export function isTransientFsLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" && TRANSIENT_FS_LOCK_CODES.has(code);
}

/**
 * Run a filesystem op with bounded retry for transient Windows lock
 * contention. Only {@link TRANSIENT_FS_LOCK_CODES} are retried; `ENOENT` and
 * every other error propagate immediately so the caller can distinguish
 * "source absent" (first install) from "source locked" (worth retrying) from a
 * genuine failure. With the defaults the total wait is bounded to ~1.75s
 * (9 sleeps: 50+100+150+200 then 250×5) so an install can never hang the user.
 *
 * `sleep`/`delayMs` are injectable so tests exercise the retry ladder without
 * real timers.
 */
export async function retryOnTransientFsLock<T>(
  op: () => Promise<T>,
  opts: {
    attempts?: number;
    delayMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number, code: string | undefined) => void;
  } = {},
): Promise<T> {
  const attempts = opts.attempts ?? BACKGROUND_ATTEMPTS;
  const delayMs = opts.delayMs ?? transientFsLockDelayMs;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (err) {
      if (attempt >= attempts || !isTransientFsLockError(err)) throw err;
      opts.onRetry?.(attempt, (err as NodeJS.ErrnoException).code);
      await sleep(delayMs(attempt));
    }
  }
}

export interface ArtifactStoreHistoryEntry {
  version: string;
  /** ISO timestamp. */
  installedAt: string;
}

export interface CachedRegistryEntrySnapshot {
  installSource?: PluginRegistryEntryInstallSource;
  manifestSha256?: string;
  bundleRefs?: string[];
  approvedPluginAccess?: PluginAccessSpec;
}

export interface VerifiedArtifact {
  zipBuffer: Buffer;
  artifactSha256: string;
  signerKeyId: string;
  /**
   * The catalog statement that authorised this install, or `null` when none
   * did. Carried out of the download so the install receipt records the
   * authority rather than re-deriving it from a registry that may have
   * refreshed in between.
   */
  admission: PluginAdmissionRecord | null;
}

export interface PreparedArtifactCommit<T> {
  /** Verified extraction root. It remains staged until durableCommit runs. */
  pluginRoot: string;
  files: readonly string[];
  /** Promote the payload and execute the caller's durable commit exactly once. */
  durableCommit(): Promise<T>;
}

export interface CoordinatedArtifactCommit<T> {
  result: T;
  /** Predecessor resources must drain before recovery backup cleanup. */
  retirement?: Promise<void>;
  /** Host lifecycle completion propagated for admitted self-updates. */
  completion?: Promise<void>;
  /** The caller owns the predecessor lease and must not await retirement inline. */
  retirementDeferred?: boolean;
}

export interface RequiredMarketplaceRootTextFile {
  filename: string;
  maxBytes: number;
  packageLabel: string;
}
export class ArtifactRollbackError extends AggregateError {
  readonly backupDir?: string;

  constructor(message: string, errors: unknown[], backupDir?: string) {
    super(errors, message);
    this.name = "ArtifactRollbackError";
    this.backupDir = backupDir;
  }
}

export interface ArtifactStoreOptions {
  /**
   * Where artifacts are extracted (`{installRoot}/<slug>/...`). For
   * regular plugins this is `~/.lvis/plugins/`; for MCP servers it is
   * `~/.lvis/mcp/`.
   */
  installRoot: string;
  /**
   * Per-slug history + version snapshot root. For regular plugins this
   * is `~/.lvis/plugins/.cache/`; for MCP servers it is
   * `~/.lvis/mcp/.cache/`.
   */
  cacheRoot: string;
  /**
   * Marketplace fetcher used for verified-zip download. The store does
   * not call `fetcher.listPlugins()` — that's the catalog reader's
   * concern. It does need `downloadArtifact` + `fetchSignatureEnvelope`
   * (the {@link MarketplaceHttp} surface).
   */
  fetcher: MarketplaceFetcher;
  /** Map of `key_id → ed25519 public key` used to verify the envelope. */
  publicKeys: Record<string, PublicKeyInput>;
  /**
   * Tarball offline cache base directory. Pass `null` to disable the
   * cache entirely (test mock fetcher). Pass a path to enable. When
   * `undefined`, the store uses `cacheRoot/.tarballs` so the cache stays
   * inside the same `~/.lvis/<topic>/.cache/` tree as the SoT.
   */
  tarballCacheBase?: string | null;
  /** Resource ceilings shared by download, cache, and zip extraction. */
  artifactLimits?: Partial<MarketplaceArtifactLimits>;
}

type VerifiedMarketplaceFetcher = MarketplaceFetcher & MarketplaceHttp;

function isVerifiedMarketplaceFetcher(fetcher: MarketplaceFetcher): fetcher is VerifiedMarketplaceFetcher {
  return (
    typeof (fetcher as Partial<VerifiedMarketplaceFetcher>).downloadArtifact === "function" &&
    typeof (fetcher as Partial<VerifiedMarketplaceFetcher>).fetchSignatureEnvelope === "function"
  );
}

/**
 * The catalog hash to compare the downloaded bytes against, or `undefined`
 * when the catalog offers none for this version.
 *
 * An explicit prior-version install — a rollback, or a pinned `installPlugin` —
 * used to get `undefined` unconditionally, because only the LATEST hash was
 * read off the catalog row. That left the signature alone to carry it, and a
 * signature binds the BYTES without saying which plugin or version they belong
 * to, so a different validly-signed artifact served in place of the requested
 * one would have installed.
 *
 * Exported so the selection can be tested directly: it is the decision this
 * change is about, and reaching it through a download requires standing up the
 * whole fetch path.
 */
export function selectExpectedArtifactSha256(
  plugin: Pick<PluginMarketplaceItem, "version" | "artifactSha256" | "artifactSha256ByVersion">,
  version: string,
): string | undefined {
  // A hash for the exact version wins — this is the case the latest-only read
  // could not serve.
  if (version !== "latest") {
    const exact = plugin.artifactSha256ByVersion?.[version];
    if (exact !== undefined) return exact;
  }
  // Otherwise the row's latest hash applies only when the version being
  // installed IS the latest. Returning it for some other version would compare
  // against the wrong artifact and refuse a correct one.
  if (!plugin.version || plugin.version === version || version === "latest") {
    return plugin.artifactSha256;
  }
  return undefined;
}

export class PluginArtifactStore {
  private readonly installRoot: string;
  private readonly cacheRoot: string;
  private readonly fetcher: MarketplaceFetcher;
  private readonly publicKeys: Record<string, PublicKeyInput>;
  private readonly tarballCacheBase: string | null;
  private readonly artifactLimits: Readonly<MarketplaceArtifactLimits>;
  private readonly deferredCommitCleanups = new Set<Promise<void>>();

  constructor(options: ArtifactStoreOptions) {
    this.installRoot = options.installRoot;
    this.cacheRoot = options.cacheRoot;
    this.fetcher = options.fetcher;
    this.publicKeys = options.publicKeys;
    const fetcherLimits = isMarketplaceArtifactLimitProvider(options.fetcher)
      ? options.fetcher.getArtifactLimits()
      : undefined;
    this.artifactLimits = resolveMarketplaceArtifactLimits(
      options.artifactLimits ?? fetcherLimits,
    );
    if (options.artifactLimits && fetcherLimits) {
      for (const name of Object.keys(this.artifactLimits) as Array<keyof MarketplaceArtifactLimits>) {
        if (this.artifactLimits[name] !== fetcherLimits[name]) {
          throw new RangeError(`marketplace artifact limit ${name} must match the fetcher policy`);
        }
      }
    }
    // The store owns the SoT for the tarball cache. `null` disables it
    // (test fetcher); `undefined` falls back to a sibling under cacheRoot.
    // `paths.cacheRoot` lives under the plugin tree's own `.cache/` so
    // disk usage tracks install state.
    this.tarballCacheBase =
      options.tarballCacheBase === null
        ? null
        : options.tarballCacheBase ?? resolve(options.cacheRoot, ".tarballs");
  }

  /** `{installRoot}/{slug}` — exposed for callers that need to know the path before download. */
  installDirFor(slug: string): string {
    const safeSlug = assertSafeArtifactSlug(slug);
    const installDir = resolve(this.installRoot, safeSlug);
    if (!isResolvedPathWithin(this.installRoot, installDir)) {
      throw new Error(`artifact slug "${slug}" escapes install root`);
    }
    return installDir;
  }

  /** Serialize the full download → inspect → extract lifetime across plugin kinds. */
  withArtifactResourceSlot<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withMarketplaceArtifactResourceSlot(operation, { signal });
  }

  /**
   * Owning transaction for every production marketplace package consumer.
   * The global lease spans verified download, bounded inspection, extraction,
   * and caller commit/rollback work so package kinds cannot bypass the
   * aggregate-memory bound by composing low-level methods independently.
   */
  withVerifiedArtifactTransaction<T>(
    plugin: PluginMarketplaceItem,
    version: string,
    onProgress: ((event: InstallerProgressEvent) => void) | undefined,
    operation: (verified: VerifiedArtifact) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return withMarketplaceArtifactResourceSlot(async () => {
      const verified = await this.downloadVerifiedArtifact(
        plugin,
        version,
        onProgress,
        signal,
      );
      return operation(verified);
    }, { signal });
  }

  /**
   * Read selected root text files only after the same ZIP preflight used by
   * extraction has bounded entry count, declared sizes, and compression ratio.
   */
  readRequiredRootTextFiles(
    slug: string,
    zipBuffer: Buffer,
    requests: readonly RequiredMarketplaceRootTextFile[],
  ): Readonly<Record<string, string>> {
    const safeSlug = assertSafeArtifactSlug(slug);
    const entries = this.parseAndPreflightZip(safeSlug, zipBuffer);
    const requested = new Map<string, RequiredMarketplaceRootTextFile>();
    for (const request of requests) {
      if (
        sanitizeZipEntryPath(safeSlug, request.filename) !== request.filename ||
        request.filename.includes("/") ||
        request.filename.includes("\\")
      ) {
        throw new Error(`required marketplace file must be a root filename: ${request.filename}`);
      }
      if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes <= 0) {
        throw new RangeError(`required marketplace file cap must be a positive safe integer: ${request.filename}`);
      }
      requested.set(request.filename, request);
    }

    const result: Record<string, string> = {};
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const safeEntryPath = sanitizeZipEntryPath(safeSlug, entry.entryName)?.split("\\").join("/");
      if (!safeEntryPath) continue;
      const request = requested.get(safeEntryPath);
      if (!request) continue;
      if (Object.hasOwn(result, request.filename)) {
        throw new Error(`${request.packageLabel} package "${safeSlug}" contains duplicate ${request.filename}`);
      }
      if (entry.header.size > request.maxBytes) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_ENTRY_TOO_LARGE",
          `${request.packageLabel} package ${request.filename} exceeds ${request.maxBytes} byte cap: ${entry.header.size} bytes`,
        );
      }
      const data = entry.getData();
      if (data.byteLength > request.maxBytes) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_ENTRY_TOO_LARGE",
          `${request.packageLabel} package ${request.filename} extracted past ${request.maxBytes} byte cap`,
        );
      }
      result[request.filename] = data.toString("utf-8");
    }
    for (const request of requests) {
      if (!Object.hasOwn(result, request.filename)) {
        throw new Error(
          `${request.packageLabel} package "${safeSlug}" must contain ${request.filename} at the archive root`,
        );
      }
    }
    return Object.freeze(result);
  }

  /**
   * Download + envelope-verify the signed zip for `plugin@version`.
   * Returns the raw bytes; extraction is a separate step so MCP-side
   * callers can read the manifest off the zip before deciding where to
   * extract.
   */
  async downloadVerifiedZip(
    plugin: PluginMarketplaceItem,
    version: string,
    onProgress?: (event: InstallerProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    return (await this.downloadVerifiedArtifact(plugin, version, onProgress, signal)).zipBuffer;
  }

  async downloadVerifiedArtifact(
    plugin: PluginMarketplaceItem,
    version: string,
    onProgress?: (event: InstallerProgressEvent) => void,
    signal?: AbortSignal,
  ): Promise<VerifiedArtifact> {
    assertMarketplaceAppUpgradeNotRequired(plugin);
    const slug = assertSafeArtifactSlug(plugin.slug ?? plugin.id);
    if (!isVerifiedMarketplaceFetcher(this.fetcher)) {
      throw new Error(
        `marketplace fetcher for "${plugin.id}" does not support signed artifact verification`,
      );
    }
    const { expectedArtifactSha256, admission } = await resolveMarketplaceAdmission(
      plugin,
      version,
      signal,
    );
    const verified = await installFromMarketplace(slug, version, {
      http: this.fetcher,
      publicKeys: this.publicKeys,
      downloadRoot: resolve(this.cacheRoot, "verified-downloads"),
      cacheBase: this.tarballCacheBase,
      // Under enforcement this is the signed admission row's hash, present for
      // EVERY version including pinned and rollback installs. Until then it is
      // the marketplace catalog's own hash, which is only available when the
      // requested version is the row's latest — see
      // `resolveAdmittedArtifactSha256`.
      expectedArtifactSha256,
      artifactLimits: this.artifactLimits,
      onProgress,
      signal,
    });
    assertCompressedArtifactSize(
      verified.zipBuffer.byteLength,
      this.artifactLimits.maxCompressedBytes,
      `verified marketplace artifact ${slug}@${version}`,
    );
    return {
      zipBuffer: verified.zipBuffer,
      artifactSha256: verified.sha256,
      signerKeyId: verified.signerKeyId,
      admission,
    };
  }

  /**
   * Atomically extract `zipBuffer` into `{installRoot}/{slug}/`. The
   * extraction is staged under a UUID-suffixed directory and swapped
   * into place via Windows-safe rename — concurrent installers can't
   * interleave on the same slug because the stage dir is unique.
   *
   * Throws if any zip entry escapes the install root (defense-in-depth
   * against `..` traversal that slipped through `sanitizeZipEntryPath`).
   */
  async extractZip(slug: string, zipBuffer: Buffer): Promise<string[]> {
    return (await this.extractZipWithCommit(slug, zipBuffer, async () => undefined)).files;
  }

  /**
   * Extract and promote a zip, then run a caller-supplied commit action before
   * deleting the previous install directory. If commit fails, restore the old
   * directory or remove the fresh install so external state (for example MCP
   * config registration) cannot fail after the executable payload changed.
   */
  async extractZipWithCommit<T>(
    slug: string,
    zipBuffer: Buffer,
    commit: (installDir: string, files: string[]) => Promise<T>,
    options: {
      /** Runs after verified extraction but before either live directory is renamed. */
      beforePromote?: (recoveryBackupDir: string) => Promise<void>;
      /** Clears durable cleanup ownership after removal or tombstone staging. */
      onCommittedBackupResolved?: (obsoleteDir: string) => Promise<void>;
      /** Prepare projections from the staged tree before promotion. */
      coordinateCommit?: (
        prepared: PreparedArtifactCommit<T>,
      ) => Promise<CoordinatedArtifactCommit<T>>;
    } = {},
  ): Promise<{ files: string[]; result: T; predecessorRetired: boolean }> {
    const safeSlug = assertSafeArtifactSlug(slug);
    assertCompressedArtifactSize(
      zipBuffer.byteLength,
      this.artifactLimits.maxCompressedBytes,
      `marketplace zip ${safeSlug}`,
    );
    const installDir = this.installDirFor(safeSlug);
    const stageDir = resolve(this.installRoot, `.${safeSlug}.stage-${randomUUID()}`);
    if (!isResolvedPathWithin(this.installRoot, stageDir)) {
      throw new Error(`artifact slug "${slug}" escapes install root`);
    }
    await rm(stageDir, { recursive: true, force: true });
    await mkdir(stageDir, { recursive: true });
    const extractedFiles: string[] = [];

    try {
      const entries = this.parseAndPreflightZip(safeSlug, zipBuffer);
      let extractedUncompressedBytes = 0;
      for (const entry of entries) {
        const safeEntryPath = sanitizeZipEntryPath(safeSlug, entry.entryName);
        if (!safeEntryPath) continue;
        const targetPath = resolve(stageDir, safeEntryPath);
        if (!isResolvedPathWithin(stageDir, targetPath)) {
          throw new Error(`"${safeSlug}" zip entry escapes install root: ${entry.entryName}`);
        }
        if (entry.isDirectory) {
          await mkdir(targetPath, { recursive: true });
          continue;
        }
        await mkdir(dirname(targetPath), { recursive: true });
        const data = entry.getData();
        if (data.byteLength > this.artifactLimits.maxEntryUncompressedBytes) {
          throw new MarketplaceArtifactLimitError(
            "ARCHIVE_ENTRY_TOO_LARGE",
            `marketplace zip entry ${entry.entryName} extracted past ${this.artifactLimits.maxEntryUncompressedBytes} bytes`,
          );
        }
        extractedUncompressedBytes += data.byteLength;
        if (extractedUncompressedBytes > this.artifactLimits.maxTotalUncompressedBytes) {
          throw new MarketplaceArtifactLimitError(
            "ARCHIVE_UNCOMPRESSED_TOO_LARGE",
            `marketplace zip ${safeSlug} extracted past ${this.artifactLimits.maxTotalUncompressedBytes} bytes`,
          );
        }
        await writeFile(targetPath, data);
        extractedFiles.push(safeEntryPath.split("\\").join("/"));
      }

      const oldDir = resolve(this.installRoot, `.${safeSlug}.old-${randomUUID()}`);
      let hadOldDir = false;
      const files = extractedFiles.sort();
      let durableCommitInvoked = false;
      let durableCommitCompleted = false;
      const durableCommit = async (): Promise<T> => {
        if (durableCommitInvoked) {
          throw new Error(`artifact durable commit invoked more than once: ${safeSlug}`);
        }
        durableCommitInvoked = true;
        await options.beforePromote?.(oldDir);
        try {
          await retryOnTransientFsLock(() => rename(installDir, oldDir), {
            onRetry: (attempt, code) =>
              log.warn({ safeSlug, attempt, code }, "retrying installDir->old swap under fs lock"),
          });
          hadOldDir = true;
        } catch (err) {
          if ((err as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw err;
        }
        try {
          await retryOnTransientFsLock(() => rename(stageDir, installDir), {
            onRetry: (attempt, code) =>
              log.warn({ safeSlug, attempt, code }, "retrying stage->installDir promotion under fs lock"),
          });
        } catch (renameErr) {
          if (hadOldDir) {
            try {
              await retryOnTransientFsLock(() => rename(oldDir, installDir));
            } catch (restoreErr) {
              throw new ArtifactRollbackError(
                `artifact promotion and directory restore both failed: ${safeSlug}`,
                [renameErr, restoreErr],
                oldDir,
              );
            }
          }
          throw renameErr;
        }
        try {
          const result = await commit(installDir, files);
          durableCommitCompleted = true;
          return result;
        } catch (commitErr) {
          try {
            await retryOnTransientFsLock(() => rm(installDir, { recursive: true, force: true }));
          } catch (cleanupErr) {
            throw new ArtifactRollbackError(
              `artifact commit and promoted-directory cleanup both failed: ${safeSlug}`,
              [commitErr, cleanupErr],
              hadOldDir ? oldDir : undefined,
            );
          }
          if (hadOldDir) {
            try {
              await retryOnTransientFsLock(() => rename(oldDir, installDir));
            } catch (restoreErr) {
              throw new ArtifactRollbackError(
                `artifact commit and directory restore both failed: ${safeSlug}`,
                [commitErr, restoreErr],
                oldDir,
              );
            }
          }
          throw commitErr;
        }
      };
      let committedPublicationError: CommittedPluginGenerationPublicationError | undefined;
      let coordinated: CoordinatedArtifactCommit<T>;
      try {
        coordinated = options.coordinateCommit
          ? await options.coordinateCommit(Object.freeze({
              pluginRoot: stageDir,
              files: Object.freeze([...files]),
              durableCommit,
            }))
          : { result: await durableCommit() };
      } catch (error) {
        if (!isCommittedPluginGenerationPublicationError(error) || !error.committed) {
          throw error;
        }
        committedPublicationError = error;
        coordinated = error.committed as CoordinatedArtifactCommit<T>;
      }
      if (!durableCommitCompleted) {
        throw new Error(`artifact commit coordinator returned before durable commit: ${safeSlug}`);
      }
      const cleanupCommittedBackup = async (): Promise<void> => {
        if (!hadOldDir) return;
        let cleanupResolved = false;
        try {
          await retryOnTransientFsLock(() => this.removeCommittedBackup(oldDir));
          cleanupResolved = true;
        } catch (cleanupErr) {
          try {
            const tombstone = await tombstoneAndDeferredRemove(oldDir, this.installRoot, {
              onDeferredRmError: (path, error) => {
                log.warn({ safeSlug, path, err: error }, "committed artifact tombstone retained for boot sweeper");
              },
            });
            log.warn(
              { safeSlug, oldDir, tombstone, err: cleanupErr },
              "installed artifact committed; routed obsolete directory to tombstone sweeper",
            );
            cleanupResolved = true;
          } catch (tombstoneErr) {
            log.warn(
              { safeSlug, oldDir, err: new AggregateError([cleanupErr, tombstoneErr]) },
              "installed artifact committed but obsolete directory cleanup and tombstoning failed",
            );
          }
        }
        if (cleanupResolved) {
          await options.onCommittedBackupResolved?.(oldDir).catch((err) => {
            log.warn({ safeSlug, oldDir, err }, "obsolete artifact cleanup ownership remains for boot retry");
          });
        }
      };
      let predecessorRetired = true;
      if (coordinated.retirement) {
        if (coordinated.retirementDeferred) {
          predecessorRetired = false;
          const deferredCleanup = coordinated.retirement.then(cleanupCommittedBackup);
          this.deferredCommitCleanups.add(deferredCleanup);
          void deferredCleanup.finally(() => {
            this.deferredCommitCleanups.delete(deferredCleanup);
          }).catch((error) => {
            log.error(
              { safeSlug, oldDir, err: error },
              "deferred predecessor retirement failed; retaining recovery backup",
            );
          });
        } else {
          try {
            await coordinated.retirement;
          } catch (error) {
            predecessorRetired = false;
            log.error(
              { safeSlug, oldDir, err: error },
              "predecessor generation retirement failed; retaining recovery backup",
            );
          }
        }
      }
      if (predecessorRetired) await cleanupCommittedBackup();
      if (committedPublicationError) throw committedPublicationError;
      return { files, result: coordinated.result, predecessorRetired };
    } catch (err) {
      if (existsSync(stageDir)) {
        try {
          await retryOnTransientFsLock(() => this.removeAbandonedStage(stageDir), {
            onRetry: (attempt, code) =>
              log.warn(
                { safeSlug, stageDir, attempt, code },
                "retrying failed artifact stage cleanup under fs lock",
              ),
          });
        } catch (cleanupErr) {
          try {
            const tombstone = await tombstoneAndDeferredRemove(
              stageDir,
              this.installRoot,
              {
                onDeferredRmError: (path, error) => {
                  log.warn(
                    { safeSlug, path, err: error },
                    "failed artifact stage tombstone retained for boot sweeper",
                  );
                },
              },
            );
            log.warn(
              { safeSlug, stageDir, tombstone, err: cleanupErr },
              "failed artifact stage routed to durable tombstone ownership",
            );
          } catch (tombstoneErr) {
            throw new ArtifactRollbackError(
              `artifact extraction and staged-directory cleanup both failed: ${safeSlug}`,
              [err, cleanupErr, tombstoneErr],
              stageDir,
            );
          }
        }
      }
      throw err;
    }
  }

  private parseAndPreflightZip(safeSlug: string, zipBuffer: Buffer): AdmZip.IZipEntry[] {
    assertCompressedArtifactSize(
      zipBuffer.byteLength,
      this.artifactLimits.maxCompressedBytes,
      `marketplace zip ${safeSlug}`,
    );
    let zip: AdmZip;
    try {
      zip = new AdmZip(zipBuffer);
    } catch (err) {
      throw new Error(`invalid zip format for "${safeSlug}": ${(err as Error).message}`);
    }
    const declaredEntryCount = zip.getEntryCount();
    if (declaredEntryCount > this.artifactLimits.maxEntryCount) {
      throw new MarketplaceArtifactLimitError(
        "ARCHIVE_ENTRY_LIMIT_EXCEEDED",
        `marketplace zip ${safeSlug} has ${declaredEntryCount} entries; maximum allowed is ${this.artifactLimits.maxEntryCount}`,
      );
    }
    const entries = zip.getEntries();
    if (entries.length !== declaredEntryCount) {
      throw new Error(
        `marketplace zip ${safeSlug} entry count changed while parsing: declared=${declaredEntryCount} parsed=${entries.length}`,
      );
    }
    let totalUncompressedBytes = 0;
    const archiveMembers = new Set<string>();
    for (const entry of entries) {
      const safeEntryPath = sanitizeZipEntryPath(safeSlug, entry.entryName);
      if (!safeEntryPath) continue;
      const memberKey = canonicalZipEntryPathIdentity(safeEntryPath);
      if (archiveMembers.has(memberKey)) {
        throw new Error(`"${safeSlug}" zip contains colliding entry: ${entry.entryName}`);
      }
      archiveMembers.add(memberKey);

      // ZIP external attributes preserve the Unix file type in the upper
      // 16 bits. Reject links, devices, and sockets before either reading a
      // required root file or materializing any archive member.
      const unixMode = (entry.attr >>> 16) & 0xffff;
      const unixType = unixMode & 0o170000;
      const expectedType = entry.isDirectory ? 0o040000 : 0o100000;
      if (unixType !== 0 && unixType !== expectedType) {
        throw new Error(`"${safeSlug}" zip contains unsupported member kind: ${entry.entryName}`);
      }
      const declaredBytes = entry.header.size;
      if (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0) {
        throw new Error(`marketplace zip ${safeSlug} has an invalid entry size: ${entry.entryName}`);
      }
      if (declaredBytes > this.artifactLimits.maxEntryUncompressedBytes) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_ENTRY_TOO_LARGE",
          `marketplace zip entry ${entry.entryName} is ${declaredBytes} bytes; maximum allowed is ${this.artifactLimits.maxEntryUncompressedBytes}`,
        );
      }
      const compressedBytes = entry.header.compressedSize;
      if (!Number.isSafeInteger(compressedBytes) || compressedBytes < 0) {
        throw new Error(`marketplace zip ${safeSlug} has an invalid compressed entry size: ${entry.entryName}`);
      }
      const compressionRatio = declaredBytes === 0
        ? 0
        : compressedBytes === 0
          ? Number.POSITIVE_INFINITY
          : declaredBytes / compressedBytes;
      if (compressionRatio > this.artifactLimits.maxCompressionRatio) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_COMPRESSION_RATIO_EXCEEDED",
          `marketplace zip entry ${entry.entryName} compression ratio ${compressionRatio.toFixed(1)}:1 exceeds ${this.artifactLimits.maxCompressionRatio}:1`,
        );
      }
      totalUncompressedBytes += declaredBytes;
      if (totalUncompressedBytes > this.artifactLimits.maxTotalUncompressedBytes) {
        throw new MarketplaceArtifactLimitError(
          "ARCHIVE_UNCOMPRESSED_TOO_LARGE",
          `marketplace zip ${safeSlug} expands to more than ${this.artifactLimits.maxTotalUncompressedBytes} bytes`,
        );
      }
    }
    return entries;
  }

  async writeInstallReceipt(
    slug: string,
    input: {
      version: string;
      installSource: "marketplace" | "local-dev";
      artifactSha256: string | null;
      signerKeyId: string | null;
      files: string[];
      installedAt?: string;
    },
  ): Promise<PluginInstallReceipt> {
    const safeSlug = assertSafeArtifactSlug(slug);
    const pluginRoot = this.installDirFor(safeSlug);
    const { receipt, raw } = await this.prepareInstallReceipt(safeSlug, pluginRoot, input);
    await this.persistPreparedInstallReceipt(safeSlug, raw);
    return receipt;
  }

  async prepareInstallReceipt(
    slug: string,
    pluginRoot: string,
    input: {
      version: string;
      installSource: "marketplace" | "local-dev";
      artifactSha256: string | null;
      signerKeyId: string | null;
      admission?: PluginAdmissionRecord | null;
      files: string[];
      installedAt?: string;
    },
  ): Promise<{ receipt: PluginInstallReceipt; raw: string }> {
    return buildInstallReceipt(pluginRoot, {
      pluginId: assertSafeArtifactSlug(slug),
      ...input,
    });
  }

  persistPreparedInstallReceipt(slug: string, raw: string): Promise<void> {
    return restoreInstallReceiptRaw(this.cacheRoot, assertSafeArtifactSlug(slug), raw);
  }

  /**
   * Snapshot a currently-installed manifest under
   * `{cacheRoot}/{slug}/{version}/plugin.json`. Used before overwrite
   * by `installArtifact` so {@link findRollbackTarget} can return to a
   * known-good prior version.
   *
   * Best-effort: a missing/unreadable manifest emits a warning but does
   * not throw — the install path should not be blocked by cache hygiene.
   */
  async cacheVersionFromManifest(
    slug: string,
    manifestPath: string,
    registryEntry?: CachedRegistryEntrySnapshot,
  ): Promise<void> {
    try {
      const safeSlug = assertSafeArtifactSlug(slug);
      const raw = await readFile(manifestPath, "utf-8");
      const parsed = JSON.parse(raw) as { version?: string };
      const version = parsed.version ?? "unknown";
      const dir = resolve(this.cacheRoot, safeSlug, version);
      await mkdir(dir, { recursive: true });
      await this.writeCacheFileAtomic(resolve(dir, "plugin.json"), raw);
      if (registryEntry) {
        await this.writeCacheFileAtomic(
          resolve(dir, "registry-entry.json"),
          `${JSON.stringify({
            installSource: registryEntry.installSource,
            manifestSha256: registryEntry.manifestSha256,
            bundleRefs: registryEntry.bundleRefs,
            approvedPluginAccess: stripLegacyPluginToolGrants(registryEntry.approvedPluginAccess).access,
          }, null, 2)}\n`,
        );
      }
    } catch (err) {
      log.warn(
        `cacheVersion failed for ${slug}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Atomically create a cache-metadata file: write the body to a sibling
   * `.tmp` with an owner-only mode (0o600) then rename over the target. Mirrors
   * the `~/.lvis/` atomic-write contract (project CLAUDE.md) — a crash never
   * leaves a half-written snapshot, and the restrictive mode keeps the cache
   * file out of other local users' reach (no shared-temp exposure).
   */
  private async writeCacheFileAtomic(filePath: string, body: string): Promise<void> {
    const tmp = `${filePath}.tmp`;
    await writeFile(tmp, body, { encoding: "utf-8", mode: 0o600 });
    await rename(tmp, filePath);
  }

  async readCachedRegistryEntrySnapshot(
    slug: string,
    version: string,
  ): Promise<CachedRegistryEntrySnapshot | null> {
    try {
      const safeSlug = assertSafeArtifactSlug(slug);
      const raw = await readFile(resolve(this.cacheRoot, safeSlug, version, "registry-entry.json"), "utf-8");
      const parsed = JSON.parse(raw) as Partial<CachedRegistryEntrySnapshot>;
      const approvedPluginAccess = stripLegacyPluginToolGrants(parsed.approvedPluginAccess).access;
      return {
        ...(parsed.installSource ? { installSource: parsed.installSource } : {}),
        ...(typeof parsed.manifestSha256 === "string" ? { manifestSha256: parsed.manifestSha256 } : {}),
        ...(Array.isArray(parsed.bundleRefs) ? { bundleRefs: parsed.bundleRefs } : {}),
        ...(approvedPluginAccess ? { approvedPluginAccess } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Append a history entry. `history.json` is the order-of-record for
   * which versions have been installed for a slug; rollback walks it
   * newest → oldest.
   *
   * Best-effort: history file write failures don't block install.
   */
  async appendHistory(slug: string, entry: ArtifactStoreHistoryEntry): Promise<void> {
    try {
      const safeSlug = assertSafeArtifactSlug(slug);
      const dir = resolve(this.cacheRoot, safeSlug);
      await mkdir(dir, { recursive: true });
      const entries = await this.readHistory(safeSlug);
      entries.push(entry);
      await this.writeCacheFileAtomic(this.historyPath(safeSlug), `${JSON.stringify({ entries }, null, 2)}\n`);
    } catch (err) {
      log.warn(
        `appendHistory failed for ${slug}: ${(err as Error).message}`,
      );
    }
  }

  /** Read all history entries for `slug` (chronological order). */
  async readHistory(slug: string): Promise<ArtifactStoreHistoryEntry[]> {
    try {
      const raw = await readFile(this.historyPath(slug), "utf-8");
      const parsed = JSON.parse(raw) as { entries?: ArtifactStoreHistoryEntry[] };
      return Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch {
      return [];
    }
  }

  /**
   * Walk history newest → oldest, return the first version that is
   * (a) different from `currentVersion` and (b) has a cached manifest
   * still on disk that parses as valid JSON with a matching `version`
   * field. Returns `null` when no rollback target is available.
   *
   * Bad-input guards: empty/whitespace/non-string
   * version dirs are skipped rather than surfaced as missing — they
   * were never legal history entries to begin with.
   */
  async findRollbackTarget(
    slug: string,
    currentVersion?: string,
  ): Promise<string | null> {
    const safeSlug = assertSafeArtifactSlug(slug);
    const entries = await this.readHistory(safeSlug);
    if (entries.length === 0) return null;
    for (let i = entries.length - 1; i >= 0; i--) {
      const candidate = entries[i].version;
      if (!candidate || typeof candidate !== "string" || candidate.trim().length === 0) continue;
      if (candidate === currentVersion) continue;
      const cachedManifest = resolve(this.cacheRoot, safeSlug, candidate, "plugin.json");
      try {
        const raw = await readFile(cachedManifest, "utf-8");
        const parsed = JSON.parse(raw) as { version?: string };
        if (!parsed.version) continue;
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  private historyPath(slug: string): string {
    return resolve(this.cacheRoot, assertSafeArtifactSlug(slug), "history.json");
  }

  private async removeCommittedBackup(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  private async removeAbandonedStage(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }
}

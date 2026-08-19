/**
 * Cloud marketplace fetcher — §9.5 M4
 *
 * Talks to the lvis-marketplace REST server. Read-only client: never
 * publishes, never mutates server state.
 *
 * Endpoints (server repo: lvis-marketplace):
 *   - GET /api/v1/health
 *   - GET /api/v1/catalog
 *   - GET /api/v1/plugins/{slug}
 *   - GET /api/v1/plugins/{slug}/versions/{version}/download
 *
 * All public-network calls go through {@link fetchPublicHttpResponse}
 * to inherit SSRF defense + timeouts. Private-network mode is available
 * for local development/testing against a loopback server; it still uses
 * NetworkGuard redirect-hop validation and must be opted in explicitly via
 * `allowPrivateNetwork: true`.
 */
import { createHash } from "node:crypto";
import {
  fetchPublicHttpResponse,
  NetworkGuardError,
} from "../core/network-guard.js";
import {
  MarketplaceTransientDownloadError,
  type MarketplaceArtifactDownloadOptions,
  type MarketplaceHttp,
} from "./marketplace-installer.js";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import type { MarketplaceAnnouncement } from "../shared/marketplace-announcements.js";
import { isMarketplaceAnnouncementLevel } from "../shared/marketplace-announcements.js";
import { isMarketplacePackageType } from "../shared/assistant-context.js";
import { assetFromMarketplaceCatalogFields } from "../shared/marketplace-package-assets.js";
import { mapNetworkAccessGrant } from "../shared/network-access.js";
import type {
  McpAuthMetadata,
  PluginMarketplaceItem,
  RequiresSpec,
  SignatureEnvelope,
} from "./types.js";
import { parseMcpOAuthMetadata, parseMcpRuntimeSpec } from "./mcp-runtime-spec.js";
import { STABLE_SEMVER_RE } from "./runtime/manifest-validation.js";
import {
  assertCompressedArtifactSize,
  MarketplaceArtifactLimitError,
  resolveMarketplaceArtifactLimits,
  type MarketplaceArtifactLimitProvider,
  type MarketplaceArtifactLimits,
} from "./marketplace-artifact-limits.js";

/**
 * Allowlist for npm package identifiers. Matches scoped (@scope/name) and
 * unscoped (name) package names. Rejects path traversal, CLI flags,
 * git/file protocol prefixes, and null bytes.
 */
const SAFE_PACKAGE_NAME_RE =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;

/**
 * Allowlist for plugin IDs. Must start with alphanumeric, may contain
 * dots, dashes, underscores. Max 128 chars. No path separators.
 */
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

type ResolverInstallablePackageType = "plugin" | "mcp" | "agent" | "skill";

const APP_VERSION_WITH_OPTIONAL_BUILD_RE =
  /^((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))(?:\+[0-9A-Za-z.-]+)?$/;

function isResolverInstallablePackageType(
  pluginType: NonNullable<PluginMarketplaceItem["pluginType"]>,
): pluginType is ResolverInstallablePackageType {
  return pluginType === "plugin" || pluginType === "mcp" || pluginType === "agent" || pluginType === "skill";
}

function upgradeRequiredMessage(minAppVersion: string): string {
  return `LVIS ${minAppVersion}+ is required to install this version. Update LVIS and try again.`;
}

function genericUpgradeRequiredMessage(): string {
  return "This package is unavailable in this version of LVIS. Update LVIS and try again.";
}

export interface RealCloudMarketplaceConfig {
  baseUrl: string;
  apiKey?: string;
  /**
   * Running LVIS app version. When present, catalog reads ask the marketplace
   * to select an artifact compatible with this exact host version.
   */
  appVersion?: string;
  timeoutMs?: number;
  /**
   * When true, allows guarded same-origin private/loopback marketplace calls.
   * Intended for local dev/test only - do not enable in production.
   */
  allowPrivateNetwork?: boolean;
  /** Resource ceilings for untrusted marketplace artifacts. */
  artifactLimits?: Partial<MarketplaceArtifactLimits>;
  /** Deadline for consuming one artifact body after response headers. Default 120s. */
  artifactReadTimeoutMs?: number;
  /** Deadline for consuming the small signature envelope body. Default 15s. */
  envelopeReadTimeoutMs?: number;
}

/** Loose shape for a catalog row returned by the server. */
interface ServerCatalogRow {
  id?: string | number;
  slug?: string;
  name?: string;
  display_name?: string;
  displayName?: string;
  description?: string;
  package_spec?: string;
  packageSpec?: string;
  package_name?: string;
  packageName?: string;
  category?: string;
  install_policy?: string;
  installPolicy?: string;
  dependencies?: unknown;
  plugin_access?: unknown;
  pluginAccess?: unknown;
  publisher?: string;
  latest_stable_version?: string | null;
  latestStableVersion?: string;
  latest_artifact_sha256?: string | null;
  channel?: string;
  /** Catalog-approved capabilities declared by this plugin (not dependency requirements). */
  capabilities?: unknown;
  /** S14: requires.capabilities[] (+ optional min_app_version) exposed by the server catalog. */
  requires?: {
    capabilities?: unknown;
    min_app_version?: unknown;
    minAppVersion?: unknown;
  } | null;
  /** Compatibility resolver result when catalog was requested with app_version. */
  app_version_resolution?: unknown;
  appVersionResolution?: unknown;
  /** Machine-readable update instruction for a version-incompatible host. */
  upgrade_required?: unknown;
  upgradeRequired?: unknown;
  /** Immutable artifact selected by the compatibility resolver. */
  resolved_artifact?: unknown;
  resolvedArtifact?: unknown;
  /** lvis-marketplace#52: "plugin" (default) | "mcp". */
  plugin_type?: string;
  pluginType?: string;
  /** Provider/theme/language-pack target metadata for non-plugin packages. */
  package_asset?: unknown;
  packageAsset?: unknown;
  asset?: unknown;
  provider_id?: string;
  providerId?: string;
  vendor_id?: string;
  vendorId?: string;
  llm_vendor_id?: string;
  llmVendorId?: string;
  theme_bundle_id?: string;
  themeBundleId?: string;
  bundle_id?: string;
  bundleId?: string;
  locale?: string;
  language_code?: string;
  languageCode?: string;
  language?: string;
  /** MCP runtime block when present (advisory copy; manifest is authoritative). */
  runtime?: unknown;
  mcpRuntime?: unknown;
  /** Safe MCP auth/login metadata from lvis-marketplace. */
  mcp_auth?: unknown;
  mcpAuth?: unknown;
  network_access?: unknown;
  networkAccess?: unknown;
  manifest?: unknown;
}

/** Loose shape for an announcement row returned by the server. */
interface ServerAnnouncementRow {
  id?: number | string;
  title?: string;
  body?: string;
  level?: string;
  created_at?: unknown;
  createdAt?: unknown;
  starts_at?: unknown;
  startsAt?: unknown;
  ends_at?: unknown;
  endsAt?: unknown;
}

export class CloudMarketplaceFetcher implements MarketplaceFetcher, MarketplaceHttp, MarketplaceArtifactLimitProvider {
  private readonly artifactLimits: Readonly<MarketplaceArtifactLimits>;
  private readonly artifactReadTimeoutMs: number;
  private readonly envelopeReadTimeoutMs: number;

  constructor(private config: RealCloudMarketplaceConfig) {
    this.artifactLimits = resolveMarketplaceArtifactLimits(config.artifactLimits);
    this.artifactReadTimeoutMs = config.artifactReadTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.artifactReadTimeoutMs) || this.artifactReadTimeoutMs <= 0) {
      throw new RangeError("artifactReadTimeoutMs must be a positive safe integer");
    }
    this.envelopeReadTimeoutMs = config.envelopeReadTimeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.envelopeReadTimeoutMs) || this.envelopeReadTimeoutMs <= 0) {
      throw new RangeError("envelopeReadTimeoutMs must be a positive safe integer");
    }
  }

  getArtifactLimits(): Readonly<MarketplaceArtifactLimits> {
    return this.artifactLimits;
  }

  updateAllowPrivateNetwork(value: boolean): void {
    this.config = { ...this.config, allowPrivateNetwork: value };
  }

  getCatalogCacheKey(): string | null | undefined {
    const configuredAppVersion = this.configuredAppVersion();
    if (!configuredAppVersion) return undefined;
    return this.normalizedResolverAppVersion() ?? null;
  }

  private configuredAppVersion(): string | undefined {
    const configuredAppVersion = typeof this.config.appVersion === "string"
      ? this.config.appVersion.trim()
      : "";
    return configuredAppVersion || undefined;
  }

  private normalizedResolverAppVersion(): string | undefined {
    const configuredAppVersion = this.configuredAppVersion();
    return configuredAppVersion
      ? APP_VERSION_WITH_OPTIONAL_BUILD_RE.exec(configuredAppVersion)?.[1]
      : undefined;
  }

  private withAppVersionQuery(path: string): string {
    const configuredAppVersion = this.configuredAppVersion();
    const appVersion = this.normalizedResolverAppVersion() ?? configuredAppVersion;
    return appVersion
      ? `${path}?app_version=${encodeURIComponent(appVersion)}`
      : path;
  }

  async listPlugins(): Promise<PluginMarketplaceItem[]> {
    const res = await this.request("GET", this.withAppVersionQuery("/api/v1/catalog"));
    const data = (await res.json()) as unknown;
    const rows = this.extractRows(data);
    return rows.flatMap((row) => {
      const item = this.mapItem(row);
      return item ? [item] : [];
    });
  }

  async getPluginDetail(slug: string): Promise<PluginMarketplaceItem | null> {
    try {
      const res = await this.request(
        "GET",
        this.withAppVersionQuery(`/api/v1/plugins/${encodeURIComponent(slug)}`),
      );
      const data = (await res.json()) as unknown;
      return this.mapItem(this.asRow(data));
    } catch (err) {
      if (err instanceof Error && /\b404\b/.test(err.message)) return null;
      throw err;
    }
  }

  async downloadVersion(
    slug: string,
    version: string,
  ): Promise<{ zipBuffer: Buffer; sha256: string }> {
    const res = await this.downloadArtifact(slug, version);
    if (res.status >= 400) {
      throw new Error(`marketplace ${res.status}: download failed`);
    }
    const zipBuffer = res.body;
    const sha256 = createHash("sha256").update(zipBuffer).digest("hex");
    return { zipBuffer, sha256 };
  }

  async listAnnouncements(): Promise<MarketplaceAnnouncement[]> {
    const res = await this.request("GET", "/api/v1/announcements");
    const data = (await res.json()) as unknown;
    const rows = this.extractAnnouncementRows(data);
    return rows
      .map((row) => this.mapAnnouncement(row))
      .filter((a): a is MarketplaceAnnouncement => a !== null);
  }

  async downloadArtifact(
    slug: string,
    version: string,
    onChunk?: (bytesDownloaded: number, bytesTotal: number | null) => void,
    options?: MarketplaceArtifactDownloadOptions,
  ): Promise<{
    body: Buffer;
    sha256Header: string | null;
    status: number;
    retryAfterSeconds?: number;
  }> {
    let res: Response;
    try {
      res = await this.request(
        "GET",
        `/api/v1/plugins/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`,
        { accept: "application/octet-stream" },
        { allowNonOk: true, signal: options?.signal },
      );
    } catch (err) {
      if (options?.signal?.aborted) {
        throw new MarketplaceArtifactLimitError(
          "ARTIFACT_DOWNLOAD_ABORTED",
          `marketplace artifact download aborted for ${slug}@${version}`,
        );
      }
      if (err instanceof MarketplaceNetworkPolicyError) throw err;
      throw new MarketplaceTransientDownloadError(
        `marketplace artifact transport failed for ${slug}@${version}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    const retryAfter = parseRetryAfterSeconds(res.headers?.get?.("retry-after") ?? null);

    // Status handling does not consume response content. Cancel it immediately
    // so an error page cannot spend the artifact byte/time budget or retain a
    // socket until the installer decides whether to retry.
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => undefined);
      return {
        body: Buffer.alloc(0),
        sha256Header: res.headers?.get?.("x-plugin-sha256") ?? null,
        status: res.status,
        retryAfterSeconds: retryAfter ?? undefined,
      };
    }

    // Always use the readable stream. Response.arrayBuffer() allocates the
    // entire attacker-controlled body before code can enforce a ceiling.
    if (!res.body) {
      throw new Error("marketplace artifact response has no readable body");
    }

    const contentLength = res.headers?.get?.("content-length");
    const declaredBytes = contentLength && /^\d+$/.test(contentLength)
      ? Number(contentLength)
      : null;
    let progressBytesTotal =
      declaredBytes !== null && Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
        ? declaredBytes
        : null;

    const chunks: Buffer[] = [];
    let bytesDownloaded = 0;
    // Throttle: emit at most once per 100 ms to avoid IPC flooding.
    let lastEmitMs = 0;
    const THROTTLE_MS = 100;

    const reader = res.body.getReader();
    let terminalError: MarketplaceArtifactLimitError | null = null;
    const cancelWith = (error: MarketplaceArtifactLimitError): void => {
      if (terminalError) return;
      terminalError = error;
      void reader.cancel(error).catch(() => undefined);
    };
    const timeout = setTimeout(() => {
      cancelWith(new MarketplaceArtifactLimitError(
        "ARTIFACT_DOWNLOAD_TIMEOUT",
        `marketplace artifact ${slug}@${version} body exceeded ${this.artifactReadTimeoutMs}ms deadline`,
      ));
    }, this.artifactReadTimeoutMs);
    const onAbort = () => {
      cancelWith(new MarketplaceArtifactLimitError(
        "ARTIFACT_DOWNLOAD_ABORTED",
        `marketplace artifact download aborted for ${slug}@${version}`,
      ));
    };
    if (options?.signal?.aborted) onAbort();
    else options?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (terminalError) throw terminalError;
      if (declaredBytes !== null) {
        assertCompressedArtifactSize(
          declaredBytes,
          this.artifactLimits.maxCompressedBytes,
          `marketplace artifact ${slug}@${version} content-length`,
        );
      }
      for (;;) {
        const { done, value } = await reader.read();
        if (terminalError) throw terminalError;
        if (done) break;
        if (value) {
          bytesDownloaded += value.byteLength;
          assertCompressedArtifactSize(
            bytesDownloaded,
            this.artifactLimits.maxCompressedBytes,
            `marketplace artifact ${slug}@${version}`,
          );
          if (progressBytesTotal !== null && bytesDownloaded > progressBytesTotal) {
            progressBytesTotal = null;
          }
          chunks.push(Buffer.from(value));
          const now = Date.now();
          if (onChunk && now - lastEmitMs >= THROTTLE_MS) {
            lastEmitMs = now;
            onChunk(bytesDownloaded, progressBytesTotal);
          }
        }
      }
    } catch (err) {
      await reader.cancel(err).catch(() => undefined);
      throw err;
    } finally {
      clearTimeout(timeout);
      options?.signal?.removeEventListener("abort", onAbort);
      reader.releaseLock();
    }
    // Always emit final progress so the bar reaches 100%.
    if (progressBytesTotal !== null && bytesDownloaded !== progressBytesTotal) {
      progressBytesTotal = null;
    }
    onChunk?.(bytesDownloaded, progressBytesTotal);

    return {
      body: Buffer.concat(chunks),
      sha256Header: res.headers?.get?.("x-plugin-sha256") ?? null,
      status: res.status,
      retryAfterSeconds: retryAfter ?? undefined,
    };
  }

  async fetchSignatureEnvelope(
    slug: string,
    version: string,
    options?: MarketplaceArtifactDownloadOptions,
  ): Promise<SignatureEnvelope> {
    let res: Response;
    try {
      res = await this.request(
        "GET",
        `/api/v1/plugins/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download.sig`,
        {},
        { signal: options?.signal },
      );
    } catch (err) {
      if (options?.signal?.aborted) {
        throw new MarketplaceArtifactLimitError(
          "ARTIFACT_DOWNLOAD_ABORTED",
          `marketplace signature envelope download aborted for ${slug}@${version}`,
        );
      }
      throw err;
    }
    const body = await readBoundedSignatureEnvelopeBody(
      res,
      slug,
      version,
      this.envelopeReadTimeoutMs,
      options?.signal,
    );
    try {
      return JSON.parse(body.toString("utf-8")) as SignatureEnvelope;
    } catch (err) {
      throw new Error(`marketplace signature envelope is not valid JSON: ${(err as Error).message}`);
    }
  }

  // ─── Internals ────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    extraHeaders: Record<string, string> = {},
    options: { allowNonOk?: boolean; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const base = this.config.baseUrl.replace(/\/$/, "");
    const url = `${base}${path}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      ...extraHeaders,
    };
    if (this.config.apiKey) {
      headers["authorization"] = `Bearer ${this.config.apiKey}`;
    }
    const timeoutMs = this.config.timeoutMs ?? 15_000;

    try {
      const privateNetworkScope = this.privateNetworkScopeFor(base);
      const res = await fetchPublicHttpResponse(url, {
        method,
        headers,
        timeoutMs,
        signal: options.signal,
        allowPrivateNetworks: privateNetworkScope,
        allowLoopback: privateNetworkScope,
      });
      if (!options.allowNonOk && !res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new Error(`marketplace ${res.status}: ${res.statusText}`);
      }
      return res;
    } catch (err) {
      if (err instanceof NetworkGuardError) {
        throw new MarketplaceNetworkPolicyError(`network guard: ${err.message}`, { cause: err });
      }
      throw err;
    }
  }

  private privateNetworkScopeFor(base: string): false | ((url: URL) => boolean) {
    if (!this.config.allowPrivateNetwork) return false;
    try {
      const allowedOrigin = new URL(base).origin;
      return (candidate) => candidate.origin === allowedOrigin;
    } catch {
      return false;
    }
  }

  private extractRows(data: unknown): ServerCatalogRow[] {
    if (Array.isArray(data)) return data as ServerCatalogRow[];
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.plugins)) return obj.plugins as ServerCatalogRow[];
      if (Array.isArray(obj.items)) return obj.items as ServerCatalogRow[];
    }
    return [];
  }

  private asRow(data: unknown): ServerCatalogRow {
    if (data && typeof data === "object") return data as ServerCatalogRow;
    return {};
  }

  private extractAnnouncementRows(data: unknown): ServerAnnouncementRow[] {
    if (Array.isArray(data)) return data as ServerAnnouncementRow[];
    if (data && typeof data === "object") {
      const obj = data as Record<string, unknown>;
      if (Array.isArray(obj.announcements)) {
        return obj.announcements as ServerAnnouncementRow[];
      }
      if (Array.isArray(obj.items)) return obj.items as ServerAnnouncementRow[];
    }
    return [];
  }

  /**
   * Normalizes one server announcement row. Returns `null` for rows missing
   * required fields so a single malformed entry never blanks the whole banner.
   * Required server contract fields are not defaulted into blank UI.
   */
  private mapAnnouncement(
    row: ServerAnnouncementRow,
  ): MarketplaceAnnouncement | null {
    const idRaw = row.id;
    let id: number | null = null;
    if (typeof idRaw === "number" && Number.isSafeInteger(idRaw)) {
      id = idRaw;
    } else if (typeof idRaw === "string" && /^\d+$/.test(idRaw)) {
      const parsed = Number.parseInt(idRaw, 10);
      if (Number.isSafeInteger(parsed)) {
        id = parsed;
      }
    }
    if (id === null) return null;

    const levelRaw = row.level;
    if (!isMarketplaceAnnouncementLevel(levelRaw)) {
      return null;
    }

    const createdAtRaw = row.created_at !== undefined ? row.created_at : row.createdAt;
    const startsAtRaw = row.starts_at !== undefined ? row.starts_at : row.startsAt;
    const endsAtRaw = row.ends_at !== undefined ? row.ends_at : row.endsAt;
    if (
      typeof row.title !== "string" ||
      typeof row.body !== "string" ||
      typeof createdAtRaw !== "string"
    ) {
      return null;
    }

    return {
      id,
      title: row.title,
      body: row.body,
      level: levelRaw,
      createdAt: createdAtRaw,
      startsAt: typeof startsAtRaw === "string" ? startsAtRaw : null,
      endsAt: typeof endsAtRaw === "string" ? endsAtRaw : null,
    };
  }

  private mapItem(row: ServerCatalogRow): PluginMarketplaceItem | null {
    const pluginType = this.catalogPackageType(row);
    const resolution = row.app_version_resolution ?? row.appVersionResolution;
    if (isResolverInstallablePackageType(pluginType)) {
      if (resolution === "resolved") {
        return this.mapCatalogItem(this.mapResolvedArtifactRow(row, pluginType));
      }
      if (resolution === "no_compatible_version") {
        return this.mapUpgradeRequiredItem(row, pluginType);
      }
      if (resolution !== undefined || this.configuredAppVersion() !== undefined) {
        // An app-version request is a resolver contract. Never reuse the
        // outer catalog artifact or policy when the resolver status is absent,
        // unknown, or malformed. Only an unversioned legacy read may do so.
        return null;
      }
    }
    return this.mapCatalogItem(row);
  }

  /**
   * A no-compatible-version row is informational only. Deliberately construct
   * a fresh DTO so an outer catalog version, digest, policy, or runtime can
   * never become installable while the host is below the required version.
   */
  private mapUpgradeRequiredItem(
    row: ServerCatalogRow,
    pluginType: ResolverInstallablePackageType,
  ): PluginMarketplaceItem | null {
    const id = this.catalogIdForResolvedArtifact(row);
    const name = row.name ?? row.display_name ?? row.displayName ?? id;
    if (typeof name !== "string" || name.trim().length === 0) return null;
    const displayOnlyItem = {
      id,
      slug: typeof row.slug === "string" ? row.slug : undefined,
      name,
      description: typeof row.description === "string" ? row.description : "",
      packageSpec: "",
      packageName: "",
      pluginType,
    };

    const hasSnakeCaseUpgradeRequired = Object.prototype.hasOwnProperty.call(row, "upgrade_required");
    const hasCamelCaseUpgradeRequired = Object.prototype.hasOwnProperty.call(row, "upgradeRequired");
    if (!hasSnakeCaseUpgradeRequired && !hasCamelCaseUpgradeRequired) {
      return {
        ...displayOnlyItem,
        upgradeRequired: {
          code: "upgrade_required",
          message: genericUpgradeRequiredMessage(),
        },
      };
    }

    const upgradeRequired = this.asPlainRecord(
      hasSnakeCaseUpgradeRequired ? row.upgrade_required : row.upgradeRequired,
    );
    const minAppVersion = upgradeRequired?.min_app_version;
    const message = upgradeRequired?.message;
    if (
      upgradeRequired?.code !== "upgrade_required" ||
      typeof minAppVersion !== "string" ||
      !STABLE_SEMVER_RE.test(minAppVersion) ||
      typeof message !== "string" ||
      message !== upgradeRequiredMessage(minAppVersion)
    ) {
      return null;
    }

    return {
      ...displayOnlyItem,
      upgradeRequired: {
        code: "upgrade_required",
        minAppVersion,
        message,
      },
    };
  }

  /**
   * Collect `version → sha256` from the catalog's version list.
   *
   * The catalog carries a hash for every version it lists, but only the latest
   * was ever read. That left an explicit prior-version install — a rollback or
   * a pinned `installPlugin` — with nothing to compare its bytes against.
   *
   * Rows whose version or digest is malformed are DROPPED rather than
   * defaulted: a missing entry makes the install refuse for want of an
   * expected hash, whereas a wrong entry would refuse a correct artifact, and
   * a permissive one would defeat the check entirely.
   */
  private artifactHashesByVersion(
    row: ServerCatalogRow,
  ): Readonly<Record<string, string>> | undefined {
    const versions = (row as { versions?: unknown }).versions;
    if (!Array.isArray(versions)) return undefined;
    const map: Record<string, string> = {};
    for (const entry of versions) {
      if (typeof entry !== "object" || entry === null) continue;
      const { version, artifact_sha256: sha } = entry as {
        version?: unknown;
        artifact_sha256?: unknown;
      };
      if (typeof version !== "string" || version.length === 0) continue;
      if (typeof sha !== "string" || !/^[a-f0-9]{64}$/i.test(sha)) continue;
      map[version] = sha.toLowerCase();
    }
    return Object.keys(map).length > 0 ? Object.freeze(map) : undefined;
  }

  private mapCatalogItem(row: ServerCatalogRow): PluginMarketplaceItem {
    if (typeof row.id === "string" && !SAFE_ID_RE.test(row.id)) {
      throw new Error(`marketplace row has invalid id format: "${row.id}"`);
    }

    // Prefer human-readable slug as the client-side id. The server's numeric
    // primary key is meaningless to the app and breaks install("hello-world")
    // lookups (which use slugs from lvis:// URIs and the web marketplace).
    const idRaw = row.slug ?? row.id;
    let id: string | undefined;
    if (typeof idRaw === "string") {
      id = idRaw;
    } else if (
      typeof idRaw === "number" &&
      Number.isFinite(idRaw) &&
      Number.isSafeInteger(idRaw)
    ) {
      id = String(idRaw);
    }
    const name = row.name ?? row.display_name ?? row.displayName ?? id;
    if (!id || !name) {
      throw new Error("marketplace row missing id/name");
    }

    // M3: enforce strict id format — id is used as a filesystem directory name.
    if (!SAFE_ID_RE.test(id)) {
      throw new Error(`marketplace row has invalid id format: "${id}"`);
    }

    // packageName: use explicit field if present, otherwise fall back to slug
    // (the lvis-marketplace server identifies artifacts by slug, not npm package name)
    // Validate against a strict allowlist to prevent npm argument injection
    // and path traversal via slug-derived node_modules resolution.
    const packageNameCandidate =
      row.package_name ?? row.packageName ?? row.slug ?? id;
    if (
      !SAFE_PACKAGE_NAME_RE.test(packageNameCandidate) ||
      packageNameCandidate.startsWith("-")
    ) {
      throw new Error(
        `marketplace row "${id}" has unsafe packageName: "${packageNameCandidate}"`,
      );
    }
    const packageName = packageNameCandidate;

    // packageSpec: prefer explicit; otherwise build from packageName + version
    const version =
      (row.latest_stable_version ?? row.latestStableVersion) ?? undefined;
    const packageSpec =
      row.package_spec ??
      row.packageSpec ??
      (version ? `${packageName}@${version}` : packageName);

    const item: PluginMarketplaceItem = {
      id,
      slug: typeof row.slug === "string" ? row.slug : undefined,
      name,
      description: row.description ?? "",
      packageSpec,
      packageName,
    };

    const installPolicy = row.install_policy ?? row.installPolicy;
    if (installPolicy === "admin") {
      item.installPolicy = "admin";
    } else if (installPolicy === "user") {
      item.installPolicy = "user";
    }
    const dependenciesRaw = row.dependencies;
    if (Array.isArray(dependenciesRaw)) {
      item.dependencies = dependenciesRaw.filter((dep): dep is string | { pluginId: string; versionRange?: string; required?: boolean } => {
        if (typeof dep === "string") return dep.trim().length > 0;
        if (!dep || typeof dep !== "object" || Array.isArray(dep)) return false;
        const candidate = dep as Record<string, unknown>;
        return typeof candidate.pluginId === "string" && candidate.pluginId.trim().length > 0
          && (candidate.versionRange === undefined || typeof candidate.versionRange === "string")
          && (candidate.required === undefined || typeof candidate.required === "boolean");
      });
    }
    const pluginAccessRaw = row.plugin_access ?? row.pluginAccess;
    if (pluginAccessRaw && typeof pluginAccessRaw === "object" && !Array.isArray(pluginAccessRaw)) {
      const candidate = pluginAccessRaw as {
        plugins?: unknown;
        agentApprovalScopes?: unknown;
      };
      if (Array.isArray(candidate.plugins)) {
        const plugins = candidate.plugins.flatMap((entry) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
          const record = entry as Record<string, unknown>;
          if (typeof record.pluginId !== "string" || record.pluginId.trim().length === 0) return [];
          const events = Array.isArray(record.events)
            ? record.events.filter((event): event is string => typeof event === "string" && event.trim().length > 0)
            : undefined;
          return [{
            pluginId: record.pluginId,
            events,
          }];
        });
        // §8 P0 — parse agentApprovalScopes from catalog row (added in
        // lvis-plugin-sdk 3.6.0). Field is non-optional in artifact manifest
        // for plugins that declare any scopes; dropping it here causes the
        // assertInstalledManifestMatchesCatalog comparison to falsely flag
        // a mismatch on install. Match exact JSON shape from upstream.
        const agentApprovalScopes = Array.isArray(candidate.agentApprovalScopes)
          ? candidate.agentApprovalScopes.filter(
              (scope): scope is string => typeof scope === "string" && scope.trim().length > 0,
            )
          : undefined;
        item.pluginAccess = agentApprovalScopes !== undefined
          ? { plugins, agentApprovalScopes }
          : { plugins };
      }
    }
    if (row.publisher) item.publisher = row.publisher;

    const manifestRow = row.manifest && typeof row.manifest === "object" && !Array.isArray(row.manifest)
      ? row.manifest as Record<string, unknown>
      : undefined;
    const networkAccess = mapNetworkAccessGrant(
      row.network_access ?? row.networkAccess ?? manifestRow?.network_access ?? manifestRow?.networkAccess,
    );
    if (networkAccess) item.networkAccess = networkAccess;

    // S8: expose version and channel for update detection
    if (version) item.version = version;
    if (typeof row.latest_artifact_sha256 === "string" && /^[a-f0-9]{64}$/i.test(row.latest_artifact_sha256)) {
      item.artifactSha256 = row.latest_artifact_sha256.toLowerCase();
    }
    const byVersion = this.artifactHashesByVersion(row);
    if (byVersion !== undefined) {
      item.artifactSha256ByVersion = byVersion;
    }
    if (row.channel === "canary") item.channel = "canary";
    else if (version) item.channel = "stable";

    // The catalog's top-level capabilities are the trusted expected side of
    // the artifact integrity check. Keep this separate from
    // requires.capabilities, which describes dependencies the plugin needs.
    if (row.capabilities !== undefined) {
      item.capabilities = Array.isArray(row.capabilities)
        ? row.capabilities.filter(
            (capability): capability is string => typeof capability === "string",
          )
        : [];
    }

    // S14: map requires.capabilities[] (+ min_app_version) from the catalog row
    if (row.requires && typeof row.requires === "object") {
      const caps = row.requires.capabilities;
      const requires: RequiresSpec = {
        capabilities: Array.isArray(caps)
          ? caps.filter((c): c is string => typeof c === "string")
          : [],
      };
      const minAppVersion = row.requires.min_app_version ?? row.requires.minAppVersion;
      if (typeof minAppVersion === "string" && minAppVersion.length > 0) {
        requires.minAppVersion = minAppVersion;
      }
      item.requires = requires;
    }

    // lvis-marketplace#52/#456: surface plugin_type + advisory runtime block.
    // The renderer uses pluginType to filter entries; install paths always
    // re-read authoritative package files from the verified signed zip.
    const pluginTypeRaw = row.plugin_type ?? row.pluginType;
    const pluginType = isMarketplacePackageType(pluginTypeRaw)
      ? pluginTypeRaw
      : "plugin";
    item.pluginType = pluginType;
    const packageAsset = assetFromMarketplaceCatalogFields(
      pluginType,
      packageSpec,
      row as Record<string, unknown>,
    );
    if (packageAsset) item.packageAsset = packageAsset;
    if (pluginType === "mcp") {
      const runtime = parseMcpRuntimeSpec(row.runtime ?? row.mcpRuntime);
      if (runtime) item.mcpRuntime = runtime;
      const auth = this.mapMcpAuth(row.mcp_auth ?? row.mcpAuth, runtime);
      if (auth) item.mcpAuth = auth;
    }

    return item;
  }

  private catalogPackageType(
    row: ServerCatalogRow,
  ): NonNullable<PluginMarketplaceItem["pluginType"]> {
    const pluginTypeRaw = row.plugin_type ?? row.pluginType;
    return isMarketplacePackageType(pluginTypeRaw)
      ? pluginTypeRaw
      : "plugin";
  }

  /**
   * Turns an explicitly selected resolver artifact into the only source for
   * installation-relevant metadata. The outer catalog pointer remains
   * presentation-only and must never grant policy for another artifact.
   */
  private mapResolvedArtifactRow(
    row: ServerCatalogRow,
    pluginType: ResolverInstallablePackageType,
  ): ServerCatalogRow {
    const catalogId = this.catalogIdForResolvedArtifact(row);
    const resolved = this.asPlainRecord(
      row.resolved_artifact ?? row.resolvedArtifact,
    );
    if (!resolved) {
      throw new Error(
        `marketplace row "${catalogId}" has no valid resolved_artifact`,
      );
    }

    const version = this.requireResolverString(
      resolved.version,
      `resolved_artifact.version for "${catalogId}"`,
    );
    if (!STABLE_SEMVER_RE.test(version)) {
      throw new Error(
        `resolved_artifact.version for "${catalogId}" must be a stable SemVer`,
      );
    }
    const artifactSha256 = this.requireResolverString(
      resolved.artifact_sha256,
      `resolved_artifact.artifact_sha256 for "${catalogId}"`,
    );
    if (!/^[a-f0-9]{64}$/i.test(artifactSha256)) {
      throw new Error(
        `resolved_artifact.artifact_sha256 for "${catalogId}" must be a SHA-256 hex digest`,
      );
    }

    const manifest = this.asPlainRecord(resolved.manifest);
    if (!manifest) {
      throw new Error(
        `resolved_artifact.manifest for "${catalogId}" must be an object`,
      );
    }
    if (manifest.id !== catalogId) {
      throw new Error(
        `resolved_artifact.manifest id mismatch for "${catalogId}"`,
      );
    }
    if (manifest.version !== version) {
      throw new Error(
        `resolved_artifact.manifest version mismatch for "${catalogId}"`,
      );
    }

    const manifestRequires = this.resolvedManifestRequires(manifest, catalogId);
    const selectedMinAppVersion = this.optionalResolverString(
      resolved.min_app_version,
      `resolved_artifact.min_app_version for "${catalogId}"`,
    );
    const manifestMinAppVersion = manifestRequires
      ? this.optionalResolverString(
          manifestRequires.minAppVersion,
          `resolved_artifact.manifest.requires.minAppVersion for "${catalogId}"`,
        )
      : undefined;
    if (
      (selectedMinAppVersion && !STABLE_SEMVER_RE.test(selectedMinAppVersion)) ||
      (manifestMinAppVersion && !STABLE_SEMVER_RE.test(manifestMinAppVersion))
    ) {
      throw new Error(
        `resolved_artifact min_app_version for "${catalogId}" must be a stable SemVer`,
      );
    }
    if (selectedMinAppVersion !== manifestMinAppVersion) {
      throw new Error(
        `resolved_artifact min_app_version does not match manifest.requires.minAppVersion for "${catalogId}"`,
      );
    }

    const manifestRuntime = manifest.runtime ?? manifest.mcpRuntime;
    if (pluginType === "mcp" && !parseMcpRuntimeSpec(manifestRuntime)) {
      throw new Error(
        `resolved_artifact.manifest for MCP "${catalogId}" has no valid runtime block`,
      );
    }

    const packageName =
      typeof manifest.packageName === "string"
        ? manifest.packageName
        : typeof manifest.package_name === "string"
          ? manifest.package_name
          : undefined;
    const installPolicyRaw = manifest.installPolicy ?? manifest.install_policy;
    const installPolicy =
      typeof installPolicyRaw === "string" ? installPolicyRaw : undefined;
    const normalizedRequires = manifestRequires
      ? {
          capabilities: manifestRequires.capabilities,
          min_app_version: manifestMinAppVersion,
        }
      : undefined;

    return {
      ...row,
      latest_stable_version: version,
      latestStableVersion: undefined,
      latest_artifact_sha256: artifactSha256,
      channel: "stable",
      package_spec: undefined,
      packageSpec: undefined,
      package_name: packageName,
      packageName: undefined,
      install_policy: installPolicy,
      installPolicy: undefined,
      dependencies: manifest.dependencies,
      plugin_access: manifest.pluginAccess ?? manifest.plugin_access,
      pluginAccess: undefined,
      network_access: manifest.networkAccess ?? manifest.network_access,
      networkAccess: undefined,
      capabilities: manifest.capabilities,
      requires: normalizedRequires,
      runtime: manifestRuntime,
      mcpRuntime: undefined,
      mcp_auth: manifest.mcpAuth ?? manifest.mcp_auth,
      mcpAuth: undefined,
      manifest,
    };
  }

  private catalogIdForResolvedArtifact(row: ServerCatalogRow): string {
    if (typeof row.id === "string" && !SAFE_ID_RE.test(row.id)) {
      throw new Error(`marketplace row has invalid id format: "${row.id}"`);
    }
    const idRaw = row.slug ?? row.id;
    const id = typeof idRaw === "string"
      ? idRaw
      : typeof idRaw === "number" &&
          Number.isFinite(idRaw) &&
          Number.isSafeInteger(idRaw)
        ? String(idRaw)
        : undefined;
    if (!id) {
      throw new Error("marketplace row missing id/name");
    }
    if (!SAFE_ID_RE.test(id)) {
      throw new Error(`marketplace row has invalid id format: "${id}"`);
    }
    return id;
  }

  private resolvedManifestRequires(
    manifest: Record<string, unknown>,
    catalogId: string,
  ): Record<string, unknown> | undefined {
    if (manifest.requires === undefined) return undefined;
    const requires = this.asPlainRecord(manifest.requires);
    if (!requires || Object.hasOwn(requires, "min_app_version")) {
      throw new Error(
        `resolved_artifact.manifest.requires for "${catalogId}" must use minAppVersion when present`,
      );
    }
    return requires;
  }

  private requireResolverString(value: unknown, field: string): string {
    const result = this.optionalResolverString(value, field);
    if (result === undefined) {
      throw new Error(`${field} is required`);
    }
    return result;
  }

  private optionalResolverString(
    value: unknown,
    field: string,
  ): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim().length === 0) {
      throw new Error(`${field} must be a non-empty string when present`);
    }
    return value;
  }

  private asPlainRecord(
    value: unknown,
  ): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private mapMcpAuth(value: unknown, runtime: PluginMarketplaceItem["mcpRuntime"]): McpAuthMetadata | undefined {
    const fallbackMode = runtime?.auth ?? "none";
    const fallbackTransport = runtime?.transport;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {
        mode: fallbackMode,
        ...(fallbackTransport ? { transport: fallbackTransport } : {}),
      };
    }
    const raw = value as Record<string, unknown>;
    const mode =
      raw.mode === "none" || raw.mode === "api-key" || raw.mode === "sso" || raw.mode === "oauth"
        ? raw.mode
        : fallbackMode;
    const transport =
      raw.transport === "stdio" || raw.transport === "http"
        ? raw.transport
        : fallbackTransport;
    const oauth = parseMcpOAuthMetadata(raw);
    return {
      mode,
      ...(transport ? { transport } : {}),
      ...oauth,
    };
  }
}

class MarketplaceNetworkPolicyError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MarketplaceNetworkPolicyError";
  }
}

const MAX_SIGNATURE_ENVELOPE_BYTES = 64 * 1024;

async function readBoundedSignatureEnvelopeBody(
  response: Response,
  slug: string,
  version: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  if (!response.body) {
    throw new Error(`marketplace signature envelope ${slug}@${version} has no readable body`);
  }
  const reader = response.body.getReader();
  let terminalError: MarketplaceArtifactLimitError | null = null;
  const cancelWith = (error: MarketplaceArtifactLimitError): void => {
    if (terminalError) return;
    terminalError = error;
    void reader.cancel(error).catch(() => undefined);
  };
  const timeout = setTimeout(() => {
    cancelWith(new MarketplaceArtifactLimitError(
      "SIGNATURE_ENVELOPE_TIMEOUT",
      `marketplace signature envelope ${slug}@${version} exceeded ${timeoutMs}ms deadline`,
    ));
  }, timeoutMs);
  const onAbort = () => {
    cancelWith(new MarketplaceArtifactLimitError(
      "ARTIFACT_DOWNLOAD_ABORTED",
      `marketplace signature envelope download aborted for ${slug}@${version}`,
    ));
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  const declaredLength = response.headers.get("content-length");
  const declaredBytes = declaredLength && /^\d+$/.test(declaredLength)
    ? Number(declaredLength)
    : null;
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  try {
    if (terminalError) throw terminalError;
    if (
      declaredBytes !== null &&
      (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_SIGNATURE_ENVELOPE_BYTES)
    ) {
      throw new MarketplaceArtifactLimitError(
        "SIGNATURE_ENVELOPE_TOO_LARGE",
        `marketplace signature envelope ${slug}@${version} exceeds ${MAX_SIGNATURE_ENVELOPE_BYTES} bytes`,
      );
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (terminalError) throw terminalError;
      if (done) break;
      if (!value) continue;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_SIGNATURE_ENVELOPE_BYTES) {
        throw new MarketplaceArtifactLimitError(
          "SIGNATURE_ENVELOPE_TOO_LARGE",
          `marketplace signature envelope ${slug}@${version} exceeds ${MAX_SIGNATURE_ENVELOPE_BYTES} bytes`,
        );
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes);
  } catch (err) {
    await reader.cancel(err).catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

function parseRetryAfterSeconds(value: string | null): number | null {
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return asNumber;
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

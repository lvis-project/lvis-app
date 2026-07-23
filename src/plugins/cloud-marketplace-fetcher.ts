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
import type { MarketplaceHttp } from "./marketplace-installer.js";
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
import {
  assertCompressedArtifactSize,
  resolveMarketplaceArtifactLimits,
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

export interface RealCloudMarketplaceConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs?: number;
  /**
   * When true, allows guarded same-origin private/loopback marketplace calls.
   * Intended for local dev/test only - do not enable in production.
   */
  allowPrivateNetwork?: boolean;
  /** Resource ceilings for untrusted marketplace artifacts. */
  artifactLimits?: Partial<MarketplaceArtifactLimits>;
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
  requires?: { capabilities?: unknown[]; min_app_version?: unknown } | null;
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

export class CloudMarketplaceFetcher implements MarketplaceFetcher, MarketplaceHttp {
  private readonly artifactLimits: Readonly<MarketplaceArtifactLimits>;

  constructor(private config: RealCloudMarketplaceConfig) {
    this.artifactLimits = resolveMarketplaceArtifactLimits(config.artifactLimits);
  }




  updateAllowPrivateNetwork(value: boolean): void {
    this.config = { ...this.config, allowPrivateNetwork: value };
  }

  async listPlugins(): Promise<PluginMarketplaceItem[]> {
    const res = await this.request("GET", "/api/v1/catalog");
    const data = (await res.json()) as unknown;
    const rows = this.extractRows(data);
    return rows.map((row) => this.mapItem(row));
  }

  async getPluginDetail(slug: string): Promise<PluginMarketplaceItem | null> {
    try {
      const res = await this.request(
        "GET",
        `/api/v1/plugins/${encodeURIComponent(slug)}`,
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
  ): Promise<{
    body: Buffer;
    sha256Header: string | null;
    status: number;
    retryAfterSeconds?: number;
  }> {
    const res = await this.request(
      "GET",
      `/api/v1/plugins/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download`,
      { accept: "application/octet-stream" },
      { allowNonOk: true },
    );
    const retryAfter = parseRetryAfterSeconds(res.headers?.get?.("retry-after") ?? null);

    // Always use the readable stream. Response.arrayBuffer() allocates the
    // entire attacker-controlled body before code can enforce a ceiling.
    if (!res.body) {
      throw new Error("marketplace artifact response has no readable body");
    }

    const contentLength = res.headers?.get?.("content-length");
    const declaredBytes = contentLength && /^\d+$/.test(contentLength)
      ? Number(contentLength)
      : null;
    if (declaredBytes !== null) {
      assertCompressedArtifactSize(
        declaredBytes,
        this.artifactLimits.maxCompressedBytes,
        `marketplace artifact ${slug}@${version} content-length`,
      );
    }
    const validBytesTotal =
      declaredBytes !== null && Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
        ? declaredBytes
        : null;

    const chunks: Buffer[] = [];
    let bytesDownloaded = 0;
    // Throttle: emit at most once per 100 ms to avoid IPC flooding.
    let lastEmitMs = 0;
    const THROTTLE_MS = 100;

    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          bytesDownloaded += value.byteLength;
          assertCompressedArtifactSize(
            bytesDownloaded,
            this.artifactLimits.maxCompressedBytes,
            `marketplace artifact ${slug}@${version}`,
          );
          chunks.push(Buffer.from(value));
          const now = Date.now();
          if (onChunk && now - lastEmitMs >= THROTTLE_MS) {
            lastEmitMs = now;
            onChunk(bytesDownloaded, validBytesTotal);
          }
        }
      }
    } catch (err) {
      await reader.cancel(err).catch(() => undefined);
      throw err;
    } finally {
      reader.releaseLock();
    }
    // Always emit final progress so the bar reaches 100%.
    onChunk?.(bytesDownloaded, validBytesTotal);

    return {
      body: Buffer.concat(chunks),
      sha256Header: res.headers?.get?.("x-plugin-sha256") ?? null,
      status: res.status,
      retryAfterSeconds: retryAfter ?? undefined,
    };
  }

  async fetchSignatureEnvelope(slug: string, version: string): Promise<SignatureEnvelope> {
    const res = await this.request(
      "GET",
      `/api/v1/plugins/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/download.sig`,
    );
    return (await res.json()) as SignatureEnvelope;
  }

  // ─── Internals ────────────────────────────────────────────────

  private async request(
    method: string,
    path: string,
    extraHeaders: Record<string, string> = {},
    options: { allowNonOk?: boolean } = {},
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
        allowPrivateNetworks: privateNetworkScope,
        allowLoopback: privateNetworkScope,
      });
      if (!options.allowNonOk && !res.ok) {
        throw new Error(`marketplace ${res.status}: ${res.statusText}`);
      }
      return res;
    } catch (err) {
      if (err instanceof NetworkGuardError) {
        throw new Error(`network guard: ${err.message}`);
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

  private mapItem(row: ServerCatalogRow): PluginMarketplaceItem {
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
      const minAppVersion = row.requires.min_app_version;
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

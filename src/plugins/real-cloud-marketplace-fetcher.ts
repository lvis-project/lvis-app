/**
 * Real cloud marketplace fetcher — §9.5 M4
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
 * for local development/testing against a loopback server; it bypasses
 * the NetworkGuard and must be opted in explicitly via
 * `allowPrivateNetwork: true`.
 */
import { createHash } from "node:crypto";
import {
  fetchPublicHttpResponse,
  NetworkGuardError,
} from "../core/network-guard.js";
import type { MarketplaceHttp } from "./marketplace-installer.js";
import type { MarketplaceFetcher } from "./marketplace-fetcher.js";
import type {
  PluginMarketplaceItem,
  PluginUiExtension,
  RequiresSpec,
  SignatureEnvelope,
} from "./types.js";

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
   * When true, bypasses {@link fetchPublicHttpResponse} (SSRF guard).
   * Intended for local dev/test only — do not enable in production.
   */
  allowPrivateNetwork?: boolean;
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
  methods?: unknown;
  category?: string;
  default_config?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
  ui?: unknown;
  deployment?: string;
  publisher?: string;
  latest_stable_version?: string | null;
  latestStableVersion?: string;
  channel?: string;
  /** S14: requires.capabilities[] exposed by the server catalog. */
  requires?: { capabilities?: unknown[] } | null;
}

export class RealCloudMarketplaceFetcher implements MarketplaceFetcher, MarketplaceHttp {
  constructor(private readonly config: RealCloudMarketplaceConfig) {}

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

  async downloadArtifact(
    slug: string,
    version: string,
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
    const arrayBuffer = await res.arrayBuffer();
    const retryAfter = parseRetryAfterSeconds(res.headers?.get?.("retry-after") ?? null);
    return {
      body: Buffer.from(arrayBuffer),
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

    if (this.config.allowPrivateNetwork) {
      // Local dev/test path — do NOT use in production. Loopback servers
      // are blocked by NetworkGuard, so we bypass it here.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers,
          signal: controller.signal,
        });
        if (!options.allowNonOk && !res.ok) {
          throw new Error(`marketplace ${res.status}: ${res.statusText}`);
        }
        return res;
      } finally {
        clearTimeout(timer);
      }
    }

    try {
      const res = await fetchPublicHttpResponse(url, {
        method,
        headers,
        timeoutMs,
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
    // H1/H2: validate against strict allowlist to prevent npm argument injection
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

    const tools = Array.isArray(row.methods)
      ? (row.methods as unknown[]).filter((m): m is string => typeof m === "string")
      : [];

    const ui = Array.isArray(row.ui)
      ? (row.ui as PluginUiExtension[])
      : undefined;

    const item: PluginMarketplaceItem = {
      id,
      slug: typeof row.slug === "string" ? row.slug : undefined,
      name,
      description: row.description ?? "",
      packageSpec,
      packageName,
      tools,
    };

    const defaultConfig = row.default_config ?? row.defaultConfig;
    if (defaultConfig && typeof defaultConfig === "object") {
      item.defaultConfig = defaultConfig;
    }
    if (ui) item.ui = ui;
    if (row.deployment === "managed" || row.deployment === "user") {
      item.deployment = row.deployment;
    }
    if (row.publisher) item.publisher = row.publisher;

    // S8: expose version and channel for update detection
    if (version) item.version = version;
    if (row.channel === "canary") item.channel = "canary";
    else if (version) item.channel = "stable";

    // S14: map requires.capabilities[] from the catalog row
    if (row.requires && typeof row.requires === "object") {
      const caps = row.requires.capabilities;
      const requires: RequiresSpec = {
        capabilities: Array.isArray(caps)
          ? caps.filter((c): c is string => typeof c === "string")
          : [],
      };
      item.requires = requires;
    }

    return item;
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

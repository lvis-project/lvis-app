/**
 * Tests for CloudMarketplaceFetcher — §9.5 M4.
 *
 * We mock `fetchPublicHttpResponse` to prove both public and private-network
 * wiring paths plus the mapping/error handling behavior without making real
 * HTTP calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

// Mock must be declared BEFORE the import under test so vi.mock hoists correctly.
vi.mock("../../core/network-guard.js", () => ({
  fetchPublicHttpResponse: vi.fn(),
  NetworkGuardError: class NetworkGuardError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "NetworkGuardError";
    }
  },
}));

import { fetchPublicHttpResponse, NetworkGuardError } from "../../core/network-guard.js";
import { CloudMarketplaceFetcher } from "../cloud-marketplace-fetcher.js";
import { installFromMarketplace } from "../marketplace-installer.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { unusedNetworkFetch } from "../../__tests__/support/network-fetch-stubs.js";

const mockedFetchPublic = fetchPublicHttpResponse as unknown as ReturnType<typeof vi.fn>;

/** Build a minimal Response-like object that satisfies what the fetcher reads. */
function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? status < 400;
  const response = new Response(JSON.stringify(body), {
    status,
    statusText: ok ? "OK" : "ERR",
    headers: { "content-type": "application/json" },
  });
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    headers: response.headers,
    body: response.body,
    async json() {
      return body;
    },
  } as unknown as Response;
}

function bytesResponse(
  bytes: Uint8Array,
  options: {
    contentLength?: string;
    chunks?: number[];
    onCancel?: (reason: unknown) => void;
    stall?: boolean;
  } = {},
): Response {
  const sizes = options.chunks ?? [bytes.byteLength];
  let offset = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (options.stall) return new Promise<void>(() => undefined);
        const size = sizes.shift();
        if (size === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.slice(offset, offset + size));
        offset += size;
      },
      cancel(reason) {
        options.onCancel?.(reason);
      },
    },
    // Prevent eager prefetch from closing the synthetic source before the
    // consumer can cancel it after crossing the configured byte ceiling.
    { highWaterMark: 0 },
  );
  const headers = new Headers();
  if (options.contentLength !== undefined) {
    headers.set("content-length", options.contentLength);
  }
  return new Response(body, { status: 200, headers });
}

describe("CloudMarketplaceFetcher (public-network path)", () => {
  beforeEach(() => {
    mockedFetchPublic.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("listPlugins() parses a server catalog response", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "acme-notes",
          name: "Acme Notes",
          description: "Note plugin",
          packageName: "@acme/notes",
          packageSpec: "@acme/notes@1.2.3",
          installPolicy: "user",
          dependencies: ["calendar"],
          publisher: "Acme",
          capabilities: ["external-auth-consumer", 7, null],
          requires: {
            capabilities: ["calendar-provider", false],
          },
          network_access: {
            allowed_domains: ["api.acme.example", "login.acme.example"],
            reasoning: "Syncs notes with the Acme workspace API.",
          },
        },
      ]),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      id: "acme-notes",
      name: "Acme Notes",
      packageName: "@acme/notes",
      packageSpec: "@acme/notes@1.2.3",
      installPolicy: "user",
      dependencies: ["calendar"],
      publisher: "Acme",
      capabilities: ["external-auth-consumer"],
      requires: {
        capabilities: ["calendar-provider"],
      },
      networkAccess: {
        allowedDomains: ["api.acme.example", "login.acme.example"],
        reasoning: "Syncs notes with the Acme workspace API.",
      },
    });

    // Verify URL + Bearer header behavior
    const [url, opts] = mockedFetchPublic.mock.calls[0];
    expect(url).toBe("https://marketplace.example.com/api/v1/catalog");
    expect((opts as RequestInit).method).toBe("GET");
    // No apiKey configured → no authorization header
    const headers = (opts as RequestInit & { headers?: Record<string, string> }).headers ?? {};
    expect(headers["authorization"]).toBeUndefined();
  });

  it("maps malformed top-level capabilities to an empty approval set", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "malformed-capabilities",
          name: "Malformed Capabilities",
          description: "Test fixture",
          packageName: "@acme/malformed-capabilities",
          packageSpec: "@acme/malformed-capabilities@1.0.0",
          capabilities: "external-auth-consumer",
        },
      ]),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.capabilities).toEqual([]);
  });

  it("listPlugins() accepts {plugins: [...]} wrapper shape (actual server shape)", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        plugins: [
          {
            id: 1,
            slug: "mp-a",
            display_name: "Plugin A",
            description: "d",
            category: "other",
            download_count: 0,
            organization_allowed: false,
            latest_stable_version: "0.1.0",
            install_policy: "admin",
            dependencies: ["calendar", { "pluginId": "email", "versionRange": "^1.0.0" }],
            created_at: "2026-01-01T00:00:00",
            updated_at: "2026-01-01T00:00:00",
          },
        ],
      }),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
    });
    const plugins = await fetcher.listPlugins();
    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("mp-a");
    expect(plugins[0].name).toBe("Plugin A");
    // packageSpec synthesized from slug@version (no package_name in server response)
    expect(plugins[0].packageSpec).toBe("mp-a@0.1.0");
    expect(plugins[0].installPolicy).toBe("admin");
    expect(plugins[0].dependencies).toEqual([
      "calendar",
      { pluginId: "email", versionRange: "^1.0.0" },
    ]);
  });

  it("listPlugins() preserves MCP OAuth runtime and login metadata from the server", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        plugins: [
          {
            id: 2,
            slug: "remote-docs",
            display_name: "Remote Docs MCP",
            description: "OAuth protected MCP server.",
            latest_stable_version: "1.0.0",
            plugin_type: "mcp",
            runtime: {
              transport: "http",
              url: "https://mcp.example.com/mcp",
              auth: "oauth",
              oauth: {
                resource: "https://mcp.example.com/mcp",
                resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
                authorizationServers: ["https://auth.example.com"],
                scopes: ["docs:read"],
                clientRegistration: "client-id-metadata-document",
              },
            },
            mcp_auth: {
              mode: "oauth",
              transport: "http",
              resource: "https://mcp.example.com/mcp",
              resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
              authorizationServers: ["https://auth.example.com"],
              scopes: ["docs:read"],
            },
          },
        ],
      }),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0].pluginType).toBe("mcp");
    expect(plugins[0].mcpRuntime).toEqual({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      auth: "oauth",
      oauth: {
        resource: "https://mcp.example.com/mcp",
        resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
        authorizationServers: ["https://auth.example.com"],
        scopes: ["docs:read"],
        clientRegistration: "client-id-metadata-document",
      },
    });
    expect(plugins[0].mcpAuth).toEqual({
      mode: "oauth",
      transport: "http",
      resource: "https://mcp.example.com/mcp",
      resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
      authorizationServers: ["https://auth.example.com"],
      scopes: ["docs:read"],
    });
  });

  it("listPlugins() maps a messaging-connection row to its asset", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        plugins: [
          {
            id: "telegram-connection",
            display_name: "Telegram",
            description: "Messaging connection package",
            package_spec: "messaging-connection:telegram",
            package_name: "@lvis/telegram-connection",
            plugin_type: "messaging-connection",
            connection_id: "telegram",
            label: "Telegram",
            summary: "Reach one LVIS conversation from Telegram.",
            pairing: "one-time-code",
            credentials: [{ key: "botToken", label: "Bot token", secret: true }],
            network: { egress: ["api.telegram.org"] },
          },
        ],
      }),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
    });
    const [item] = await fetcher.listPlugins();

    expect(item?.pluginType).toBe("messaging-connection");
    expect(item?.unsupportedPackageKind).toBeUndefined();
    expect(item?.packageAsset).toEqual({
      type: "messaging-connection",
      connectionId: "telegram",
      label: "Telegram",
      summary: "Reach one LVIS conversation from Telegram.",
      pairing: "one-time-code",
      credentials: [{ key: "botToken", label: "Bot token", secret: true }],
      egress: ["api.telegram.org"],
    });
  });

  it("listPlugins() reports an unknown plugin_type as unsupported, never as a plugin", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        plugins: [
          {
            id: "future-thing",
            display_name: "Future Thing",
            description: "A kind released after this app",
            package_spec: "@lvis/future-thing@1.0.0",
            package_name: "@lvis/future-thing",
            // Longer than 16 characters on purpose: nothing may truncate it.
            plugin_type: "workflow-automation-pack",
          },
        ],
      }),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
    });
    const [item] = await fetcher.listPlugins();

    expect(item?.pluginType).toBeUndefined();
    expect(item?.unsupportedPackageKind).toBe("workflow-automation-pack");
    expect(item?.packageAsset).toBeUndefined();
    expect(item?.name).toBe("Future Thing");
  });

  it("listPlugins() still reads a row that names no kind at all as a plugin", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        plugins: [
          {
            id: "legacy-plugin",
            display_name: "Legacy Plugin",
            description: "Catalog row from before plugin_type existed",
            package_spec: "@lvis/legacy-plugin@1.0.0",
            package_name: "@lvis/legacy-plugin",
          },
        ],
      }),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
    });
    const [item] = await fetcher.listPlugins();

    expect(item?.pluginType).toBe("plugin");
    expect(item?.unsupportedPackageKind).toBeUndefined();
  });

  it("listPlugins() passes through marketplace-eligible package assets", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        plugins: [
          {
            id: "groq-provider",
            display_name: "Groq",
            description: "Provider package",
            package_spec: "@lvis/groq-provider@1.0.0",
            package_name: "@lvis/groq-provider",
            plugin_type: "provider",
            provider_id: "groq",
          },
          {
            id: "tokyo-night-theme",
            display_name: "Tokyo Night",
            description: "Theme package",
            package_spec: "@lvis/tokyo-night-theme@1.0.0",
            package_name: "@lvis/tokyo-night-theme",
            plugin_type: "theme",
            theme_bundle_id: "tokyo-night",
          },
          {
            id: "ko-language-pack",
            display_name: "Korean",
            description: "Language package",
            package_spec: "@lvis/ko-language-pack@1.0.0",
            package_name: "@lvis/ko-language-pack",
            plugin_type: "language-pack",
            locale: "ko",
          },
        ],
      }),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins.map((plugin) => plugin.pluginType)).toEqual([
      "provider",
      "theme",
      "language-pack",
    ]);
    expect(plugins.map((plugin) => plugin.packageAsset)).toEqual([
      { type: "provider", providerId: "groq" },
      {
        type: "theme",
        bundleId: "tokyo-night",
        displayName: "Tokyo Night",
        description: "Theme package",
      },
      {
        type: "language-pack",
        locale: "ko",
        displayName: "Korean",
      },
    ]);
  });

  it("listPlugins() preserves user-authored provider preset metadata from package_asset", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        plugins: [
          {
            id: "future-router-provider",
            display_name: "Future Router",
            description: "User-authored OpenAI-compatible provider preset",
            package_spec: "provider:future-router",
            package_name: "future-router-provider",
            plugin_type: "provider",
            package_asset: {
              type: "provider",
              provider_id: "future-router",
              label: "Future Router",
              base_url: "https://future.example/v1",
              default_model: "future/free",
              models: ["future/free", "future/pro"],
              api_key_placeholder: "fr-...",
              requires_api_key: false,
            },
          },
        ],
      }),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0].packageAsset).toEqual({
      type: "provider",
      providerId: "future-router",
      label: "Future Router",
      baseUrl: "https://future.example/v1",
      defaultModel: "future/free",
      modelOptions: ["future/free", "future/pro"],
      apiKeyPlaceholder: "fr-...",
      requiresApiKey: false,
    });
  });

  it("listPlugins() does not treat default-surface assets as marketplace package assets", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        plugins: [
          {
            id: "openrouter-provider",
            display_name: "OpenRouter",
            description: "Built-in provider should not be marketplace-installed.",
            package_spec: "provider:openrouter",
            plugin_type: "provider",
            provider_id: "openrouter",
          },
          {
            id: "moonstone-theme",
            display_name: "Moonstone",
            description: "Built-in theme should not be marketplace-installed.",
            package_spec: "theme:moonstone",
            plugin_type: "theme",
            theme_bundle_id: "moonstone",
          },
          {
            id: "english-language-pack",
            display_name: "English",
            description: "Built-in locale should not be marketplace-installed.",
            package_spec: "language-pack:en",
            plugin_type: "language-pack",
            locale: "en",
          },
        ],
      }),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins.map((plugin) => plugin.pluginType)).toEqual([
      "provider",
      "theme",
      "language-pack",
    ]);
    expect(plugins.map((plugin) => plugin.packageAsset)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("getPluginDetail() returns null on 404", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({ error: "not found" }, { status: 404, ok: false }),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const detail = await fetcher.getPluginDetail("ghost");
    expect(detail).toBeNull();
  });

  it("downloadVersion() returns zipBuffer + sha256", async () => {
    const payload = new TextEncoder().encode("PK\u0003\u0004fake-zip-bytes");
    const expectedSha = createHash("sha256").update(Buffer.from(payload)).digest("hex");
    mockedFetchPublic.mockResolvedValueOnce(bytesResponse(payload));

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const result = await fetcher.downloadVersion("acme-notes", "1.2.3");

    expect(Buffer.isBuffer(result.zipBuffer)).toBe(true);
    expect(result.zipBuffer.length).toBe(payload.length);
    expect(result.sha256).toBe(expectedSha);

    const [url] = mockedFetchPublic.mock.calls[0];
    expect(url).toBe(
      "https://marketplace.example.com/api/v1/plugins/acme-notes/versions/1.2.3/download",
    );
  });

  it("sets Bearer header when apiKey is configured", async () => {
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([]));
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      apiKey: "secret-token",
    });
    await fetcher.listPlugins();

    const [, opts] = mockedFetchPublic.mock.calls[0];
    const headers = (opts as RequestInit & { headers?: Record<string, string> }).headers ?? {};
    expect(headers["authorization"]).toBe("Bearer secret-token");
  });

  it("wraps NetworkGuardError with a clear message", async () => {
    mockedFetchPublic.mockRejectedValueOnce(
      new NetworkGuardError("target resolves to non-public address(es): 10.0.0.1"),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/network guard:/);
  });

  it("listAnnouncements() maps server rows (snake_case) and requires level", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 1,
          title: "Maintenance",
          body: "Scheduled downtime",
          level: "warning",
          created_at: "2026-06-12T00:00:00Z",
          starts_at: "2026-06-12T00:00:00Z",
          ends_at: null,
        },
        // Missing level is invalid and must be dropped.
        { id: 2, title: "Notice", body: "FYI", created_at: "2026-06-11T00:00:00Z" },
      ]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const announcements = await fetcher.listAnnouncements();

    expect(announcements).toEqual([
      {
        id: 1,
        title: "Maintenance",
        body: "Scheduled downtime",
        level: "warning",
        createdAt: "2026-06-12T00:00:00Z",
        startsAt: "2026-06-12T00:00:00Z",
        endsAt: null,
        actions: [],
      },
    ]);
    const [url] = mockedFetchPublic.mock.calls[0];
    expect(url).toBe("https://marketplace.example.com/api/v1/announcements");
  });

  it("listAnnouncements() carries action buttons the running build can honour", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 1,
          title: "OS tool sandbox",
          body: "Shell tools can now run inside a sandbox.",
          level: "info",
          created_at: "2026-09-03T00:00:00Z",
          actions: [
            {
              label: { ko: "샌드박스 설정 열기", en: "Open sandbox settings" },
              target: { kind: "settings", path: "permissions" },
              min_app_version: "0.9.0",
            },
            // Needs a build newer than the one configured below.
            {
              label: { ko: "미래 기능", en: "Future feature" },
              target: { kind: "settings", path: "permissions" },
              min_app_version: "9.9.9",
            },
            // A destination this app cannot reach.
            {
              label: { ko: "안내", en: "Guide" },
              target: { kind: "url", url: "http://example.com/guide" },
            },
          ],
        },
      ]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.9.1",
    });
    const announcements = await fetcher.listAnnouncements();

    expect(announcements[0].actions).toEqual([
      {
        label: { ko: "샌드박스 설정 열기", en: "Open sandbox settings" },
        target: { kind: "settings", settingsTab: "permissions" },
      },
    ]);
  });

  it("listAnnouncements() hides gated actions when no app version was configured", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 1,
          title: "OS tool sandbox",
          body: "Shell tools can now run inside a sandbox.",
          level: "info",
          created_at: "2026-09-03T00:00:00Z",
          actions: [
            {
              label: { ko: "열기", en: "Open" },
              target: { kind: "settings", path: "permissions" },
              min_app_version: "0.0.1",
            },
          ],
        },
      ]),
    );
    // Fail closed: an unknown running version cannot prove it satisfies the
    // minimum, so the button hides rather than pointing at a place that may not
    // exist in this build.
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const announcements = await fetcher.listAnnouncements();

    expect(announcements[0].actions).toEqual([]);
  });

  it("listAnnouncements() drops rows with no numeric id, missing level, or an invalid level", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        { title: "no id", body: "x", level: "info", created_at: "2026-06-12T00:00:00Z" },
        { id: 4, title: "missing level", body: "x", created_at: "2026-06-12T00:00:00Z" },
        { id: 5, title: "bad level", body: "x", level: "bogus", created_at: "2026-06-12T00:00:00Z" },
        { id: 6, title: "ok", body: "x", level: "critical", created_at: "2026-06-12T00:00:00Z" },
      ]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const announcements = await fetcher.listAnnouncements();
    expect(announcements.map((a) => a.id)).toEqual([6]);
  });

  it("listAnnouncements() drops numeric string ids outside the safe integer range", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "9007199254740992",
          title: "unsafe",
          body: "x",
          level: "info",
          created_at: "2026-06-12T00:00:00Z",
        },
        {
          id: "9007199254740991",
          title: "safe",
          body: "x",
          level: "info",
          created_at: "2026-06-12T00:00:00Z",
        },
      ]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const announcements = await fetcher.listAnnouncements();
    expect(announcements.map((a) => a.id)).toEqual([Number.MAX_SAFE_INTEGER]);
  });

  it("listAnnouncements() requires string title, body, and createdAt fields", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 7,
          title: "Typed boundary",
          body: "x",
          level: "info",
          created_at: 123,
        },
        {
          id: 8,
          title: 123,
          body: "x",
          level: "info",
          created_at: "2026-06-12T00:00:00Z",
        },
        {
          id: 9,
          title: "Missing body",
          level: "info",
          created_at: "2026-06-12T00:00:00Z",
        },
        {
          id: 10,
          title: "Valid",
          body: "x",
          level: "info",
          created_at: "2026-06-12T00:00:00Z",
        },
      ]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });

    const announcements = await fetcher.listAnnouncements();

    expect(announcements.map((a) => a.id)).toEqual([10]);
  });

  it("listAnnouncements() coerces optional timestamp fields to string or null", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        {
          id: 7,
          title: "Typed boundary",
          body: "x",
          level: "info",
          created_at: "2026-06-12T00:00:00Z",
          starts_at: { invalid: true },
          ends_at: false,
        },
      ]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });

    const announcements = await fetcher.listAnnouncements();

    expect(announcements[0]).toMatchObject({
      id: 7,
      createdAt: "2026-06-12T00:00:00Z",
      startsAt: null,
      endsAt: null,
    });
  });

  it("listAnnouncements() accepts {announcements: [...]} wrapper shape", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        announcements: [
          {
            id: 9,
            title: "T",
            body: "B",
            level: "info",
            created_at: "2026-06-12T00:00:00Z",
          },
        ],
      }),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const announcements = await fetcher.listAnnouncements();
    expect(announcements.map((a) => a.id)).toEqual([9]);
  });
});

describe("CloudMarketplaceFetcher (private-network path)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("allowPrivateNetwork=true keeps SSRF guard in front of same-origin local requests", async () => {
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([
        {
          id: "local-plugin",
          name: "Local",
          description: "d",
          packageName: "@local/x",
          packageSpec: "@local/x@0.0.1",
        },
      ]),
    );

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "http://127.0.0.1:8080",
      networkFetch: unusedNetworkFetch,
      allowPrivateNetwork: true,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("local-plugin");
    expect(mockedFetchPublic).toHaveBeenCalledOnce();
    const [url, opts] = mockedFetchPublic.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8080/api/v1/catalog");
    expect((opts.allowLoopback as (url: URL) => boolean)(new URL("http://127.0.0.1:8080/next"))).toBe(true);
    expect((opts.allowLoopback as (url: URL) => boolean)(new URL("http://127.0.0.1:9090/next"))).toBe(false);
    expect((opts.allowPrivateNetworks as (url: URL) => boolean)(new URL("http://127.0.0.1:8080/next"))).toBe(true);
  });
});

describe("CloudMarketplaceFetcher — actual server response shape", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Actual PluginSummary shape returned by lvis-marketplace server. */
  const serverPlugin = {
    id: 1,
    slug: "lvis-plugin-meeting",
    display_name: "LVIS Meeting",
    description: "Meeting recording, STT, and summary plugin.",
    category: "other",
    download_count: 0,
    organization_allowed: false,
    latest_stable_version: "0.1.0",
    install_policy: "admin",
    dependencies: ["calendar", "email", "meeting"],
    latest_artifact_sha256: "A".repeat(64),
    created_at: "2026-01-01T00:00:00",
    updated_at: "2026-01-01T00:00:00",
  };

  it("listPlugins() uses slug as the client id, display_name as name, and slug@version for packageSpec", async () => {
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([serverPlugin]));

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "http://127.0.0.1:8000",
      networkFetch: unusedNetworkFetch,
      allowPrivateNetwork: true,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins).toHaveLength(1);
    const p = plugins[0];
    // Slug is the stable client-facing identifier used by install/deeplink flows.
    expect(p.id).toBe("lvis-plugin-meeting");
    expect(p.name).toBe("LVIS Meeting");
    expect(p.description).toBe("Meeting recording, STT, and summary plugin.");
    // packageName falls back to slug when package_name is absent
    expect(p.packageName).toBe("lvis-plugin-meeting");
    // packageSpec synthesized as slug@version
    expect(p.packageSpec).toBe("lvis-plugin-meeting@0.1.0");
    expect(p.installPolicy).toBe("admin");
    expect(p.dependencies).toEqual(["calendar", "email", "meeting"]);
    expect(p.version).toBe("0.1.0");
    expect(p.artifactSha256).toBe("a".repeat(64));
    expect(p.channel).toBe("stable");
  });

  it("downloadVersion() returns zipBuffer + sha256 with actual server shape", async () => {
    const payload = new TextEncoder().encode("PK\u0003\u0004fake-zip");
    const expectedSha = createHash("sha256").update(Buffer.from(payload)).digest("hex");

    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(bytesResponse(payload));

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "http://127.0.0.1:8000",
      networkFetch: unusedNetworkFetch,
      allowPrivateNetwork: true,
    });
    const result = await fetcher.downloadVersion("lvis-plugin-meeting", "0.1.0");

    expect(Buffer.isBuffer(result.zipBuffer)).toBe(true);
    expect(result.sha256).toBe(expectedSha);
    const [url] = mockedFetchPublic.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:8000/api/v1/plugins/lvis-plugin-meeting/versions/0.1.0/download",
    );
  });

  it("rejects an oversized Content-Length before reading the response body", async () => {
    const payload = new TextEncoder().encode("12345");
    const onCancel = vi.fn();
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(
      bytesResponse(payload, { contentLength: "6", onCancel }),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      artifactLimits: { maxCompressedBytes: 5 },
    });

    await expect(fetcher.downloadArtifact("acme", "1.0.0")).rejects.toMatchObject({
      code: "ARTIFACT_TOO_LARGE",
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("rejects a streamed body that exceeds a smaller or missing Content-Length", async () => {
    const payload = new TextEncoder().encode("123456");
    for (const contentLength of ["2", undefined]) {
      const onCancel = vi.fn();
      mockedFetchPublic.mockReset();
      mockedFetchPublic.mockResolvedValueOnce(
        bytesResponse(payload, { contentLength, chunks: [3, 3], onCancel }),
      );
      const fetcher = new CloudMarketplaceFetcher({
        baseUrl: "https://marketplace.example.com",
        networkFetch: unusedNetworkFetch,
        artifactLimits: { maxCompressedBytes: 5 },
      });

      await expect(fetcher.downloadArtifact("acme", "1.0.0")).rejects.toMatchObject({
        code: "ARTIFACT_TOO_LARGE",
      });
      expect(onCancel).toHaveBeenCalledOnce();
    }
  });

  it("allows an artifact exactly at the boundary and emits final progress", async () => {
    const payload = new TextEncoder().encode("12345");
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(
      bytesResponse(payload, { contentLength: "5", chunks: [2, 3] }),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      artifactLimits: { maxCompressedBytes: 5 },
    });

    const onChunk = vi.fn();
    const result = await fetcher.downloadArtifact("acme", "1.0.0", onChunk);
    expect(result.body.toString()).toBe("12345");
    expect(onChunk).toHaveBeenLastCalledWith(5, 5);
  });

  it("switches progress to indeterminate when Content-Length understates the body", async () => {
    const payload = new TextEncoder().encode("123");
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(
      bytesResponse(payload, { contentLength: "2", chunks: [3] }),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      artifactLimits: { maxCompressedBytes: 5 },
    });

    const onChunk = vi.fn();
    await expect(fetcher.downloadArtifact("acme", "1.0.0", onChunk))
      .resolves.toMatchObject({ body: Buffer.from("123") });
    expect(onChunk).toHaveBeenLastCalledWith(3, null);
    expect(onChunk).not.toHaveBeenCalledWith(3, 2);
  });

  it("cancels a stalled body at its read deadline", async () => {
    const onCancel = vi.fn();
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(
      bytesResponse(new Uint8Array(), { stall: true, onCancel }),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      artifactReadTimeoutMs: 10,
    });

    await expect(fetcher.downloadArtifact("acme", "1.0.0")).rejects.toMatchObject({
      code: "ARTIFACT_DOWNLOAD_TIMEOUT",
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("propagates caller abort while a body read is stalled", async () => {
    const onCancel = vi.fn();
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(
      bytesResponse(new Uint8Array(), { stall: true, onCancel }),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const controller = new AbortController();
    const download = fetcher.downloadArtifact(
      "acme",
      "1.0.0",
      undefined,
      { signal: controller.signal },
    );

    controller.abort();
    await expect(download).rejects.toMatchObject({
      code: "ARTIFACT_DOWNLOAD_ABORTED",
    });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("bounds and times out the signature envelope body", async () => {
    const oversizedCancel = vi.fn();
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(
      bytesResponse(new Uint8Array(), {
        contentLength: String(64 * 1024 + 1),
        onCancel: oversizedCancel,
      }),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    await expect(fetcher.fetchSignatureEnvelope("acme", "1.0.0"))
      .rejects.toMatchObject({ code: "SIGNATURE_ENVELOPE_TOO_LARGE" });
    expect(oversizedCancel).toHaveBeenCalledOnce();

    const stalledCancel = vi.fn();
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(
      bytesResponse(new Uint8Array(), { stall: true, onCancel: stalledCancel }),
    );
    const shortDeadlineFetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      envelopeReadTimeoutMs: 10,
    });
    await expect(shortDeadlineFetcher.fetchSignatureEnvelope("acme", "1.0.0"))
      .rejects.toMatchObject({ code: "SIGNATURE_ENVELOPE_TIMEOUT" });
    expect(stalledCancel).toHaveBeenCalledOnce();
  });

  it("does not retry a deterministic missing-body response", async () => {
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const downloadRoot = mkdtempSync(join(process.cwd(), ".marketplace-protocol-integration-"));
    try {
      await expect(installFromMarketplace("acme", "1.0.0", {
        http: fetcher,
        publicKeys: {},
        downloadRoot,
        maxRetries: 3,
      })).rejects.toThrow(/no readable body/);
      expect(mockedFetchPublic).toHaveBeenCalledOnce();
    } finally {
      await cleanupTmpDir(downloadRoot);
    }
  });

  it("does not retry or reclassify a streamed limit failure through the installer", async () => {
    const payload = new TextEncoder().encode("123456");
    const onCancel = vi.fn();
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(
      bytesResponse(payload, { chunks: [3, 3], onCancel }),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      artifactLimits: { maxCompressedBytes: 5 },
    });
    const downloadRoot = mkdtempSync(join(process.cwd(), ".marketplace-limit-integration-"));
    try {
      await expect(installFromMarketplace("acme", "1.0.0", {
        http: fetcher,
        publicKeys: {},
        downloadRoot,
        maxRetries: 3,
        artifactLimits: fetcher.getArtifactLimits(),
      })).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
      expect(mockedFetchPublic).toHaveBeenCalledOnce();
      expect(onCancel).toHaveBeenCalledOnce();
    } finally {
      await cleanupTmpDir(downloadRoot);
    }
  });

  it("missing latest_stable_version (null) → packageSpec falls back to slug only", async () => {
    const pluginWithoutVersion = { ...serverPlugin, latest_stable_version: null };
    mockedFetchPublic.mockReset();
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([pluginWithoutVersion]));

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "http://127.0.0.1:8000",
      networkFetch: unusedNetworkFetch,
      allowPrivateNetwork: true,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins).toHaveLength(1);
    const p = plugins[0];
    // No version → packageSpec is just the slug
    expect(p.packageSpec).toBe("lvis-plugin-meeting");
    expect(p.version).toBeUndefined();
  });
});

describe("CloudMarketplaceFetcher — input validation (security)", () => {
  beforeEach(() => {
    mockedFetchPublic.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects slug with path traversal characters", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: "x", slug: "../../etc/passwd", name: "Evil" }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects slug that starts with dash (npm flag injection)", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: "x", slug: "--registry=https://evil.example", name: "Evil" }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects slug with file: protocol prefix", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: "x", slug: "file:/tmp/evil.tgz", name: "Evil" }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects slug with git+https: protocol", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: "x", slug: "git+https://evil/x.git", name: "Evil" }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects non-primitive id (object stringifies to [object Object])", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: { evil: true }, name: "Evil" }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/missing id\/name/);
  });

  it("rejects array id", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: [1, 2, 3], name: "Evil" }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/missing id\/name/);
  });

  it("rejects id with path separator", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: "../../../etc", name: "Evil", slug: "safe-slug" }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects unsafe numeric id (NaN)", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: NaN, name: "Evil" }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    // NaN is not finite → id becomes undefined → throws missing id
    await expect(fetcher.listPlugins()).rejects.toThrow(/missing id\/name/);
  });

  it("accepts valid scoped package name", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{
        id: "acme-notes",
        name: "Notes",
        package_name: "@acme/notes",
        packageSpec: "@acme/notes@1.0.0",
      }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const plugins = await fetcher.listPlugins();
    expect(plugins[0].packageName).toBe("@acme/notes");
  });

  it("accepts valid unscoped package name", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{
        id: "simple-plugin",
        name: "Simple",
        slug: "simple-plugin",
        latest_stable_version: "1.0.0",
      }]),
    );
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const plugins = await fetcher.listPlugins();
    expect(plugins[0].packageName).toBe("simple-plugin");
    expect(plugins[0].packageSpec).toBe("simple-plugin@1.0.0");
  });
});

describe("CloudMarketplaceFetcher.updateAllowPrivateNetwork (live config)", () => {
  beforeEach(() => {
    mockedFetchPublic.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("flips the guarded private-network scope without rebuilding the fetcher", async () => {
    mockedFetchPublic.mockResolvedValue(jsonResponse([]));

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "http://127.0.0.1:8080",
      networkFetch: unusedNetworkFetch,
      allowPrivateNetwork: false,
    });

    // 1) Initial state: SSRF guard is public-only.
    await fetcher.listPlugins();
    expect(mockedFetchPublic).toHaveBeenCalledTimes(1);
    expect(mockedFetchPublic.mock.calls[0][1].allowLoopback).toBe(false);

    // 2) Flip the live flag. Next request must keep the guard and add scope.
    fetcher.updateAllowPrivateNetwork(true);
    await fetcher.listPlugins();
    expect(mockedFetchPublic).toHaveBeenCalledTimes(2);
    expect(
      (mockedFetchPublic.mock.calls[1][1].allowLoopback as (url: URL) => boolean)(
        new URL("http://127.0.0.1:8080/next"),
      ),
    ).toBe(true);

    // 3) Flip it back. Next request must route through the guard again.
    fetcher.updateAllowPrivateNetwork(false);
    await fetcher.listPlugins();
    expect(mockedFetchPublic).toHaveBeenCalledTimes(3);
    expect(mockedFetchPublic.mock.calls[2][1].allowLoopback).toBe(false);
  });
});

describe("CloudMarketplaceFetcher app-version resolver", () => {
  beforeEach(() => {
    mockedFetchPublic.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the legacy catalog URL and normalizes stable build metadata", async () => {
    mockedFetchPublic.mockResolvedValue(jsonResponse([]));

    await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
    }).listPlugins();
    const versionedFetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9+build.7",
    });
    await versionedFetcher.listPlugins();

    expect(mockedFetchPublic.mock.calls[0]?.[0]).toBe(
      "https://marketplace.example.com/api/v1/catalog",
    );
    expect(mockedFetchPublic.mock.calls[1]?.[0]).toBe(
      "https://marketplace.example.com/api/v1/catalog?app_version=0.5.9",
    );
    expect(versionedFetcher.getCatalogCacheKey()).toBe("0.5.9");
    expect(new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9-preview",
    }).getCatalogCacheKey()).toBeNull();
  });

  it("maps a resolved artifact atomically instead of using outer pointer policy", async () => {
    const pointerDigest = "a".repeat(64);
    const selectedDigest = "b".repeat(64);
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
      plugins: [{
        id: 41,
        slug: "lvis-plugin-git",
        display_name: "Git",
        description: "Outer presentation copy",
        latest_stable_version: "9.9.9",
        latest_artifact_sha256: pointerDigest,
        package_name: "outer-package",
        package_spec: "outer-package@9.9.9",
        channel: "canary",
        install_policy: "admin",
        dependencies: ["outer-dependency"],
        plugin_access: {
          plugins: [{ pluginId: "outer-plugin", events: ["outer.event"] }],
        },
        network_access: {
          allowed_domains: ["outer.example"],
          reasoning: "outer pointer policy",
        },
        capabilities: ["outer-capability"],
        requires: {
          capabilities: ["outer-requires"],
          min_app_version: "9.0.0",
        },
        plugin_type: "mcp",
        runtime: {
          transport: "http",
          url: "https://outer.example/mcp",
          auth: "api-key",
          apiKeyHeader: "X-Outer-Key",
        },
        mcp_auth: {
          mode: "api-key",
          transport: "http",
          resource: "https://outer.example/mcp",
        },
        app_version_resolution: "resolved",
        resolved_artifact: {
          version: "0.1.12",
          artifact_sha256: selectedDigest,
          min_app_version: "0.5.9",
          manifest: {
            id: "lvis-plugin-git",
            version: "0.1.12",
            packageName: "lvis-plugin-git",
            installPolicy: "user",
            dependencies: [{
              pluginId: "selected-dependency",
              versionRange: "^2.0.0",
              required: true,
            }],
            pluginAccess: {
              plugins: [{
                pluginId: "selected-plugin",
                events: ["selected.event"],
              }],
              agentApprovalScopes: ["agent_external_api_call"],
            },
            networkAccess: {
              allowedDomains: ["selected.example"],
              reasoning: "selected artifact policy",
            },
            capabilities: ["selected-capability"],
            requires: {
              capabilities: ["selected-requires"],
              minAppVersion: "0.5.9",
            },
            runtime: {
              transport: "http",
              url: "https://selected.example/mcp",
              auth: "oauth",
              oauth: {
                resource: "https://selected.example/mcp",
                authorizationServers: ["https://auth.selected.example"],
                scopes: ["git:read"],
              },
            },
            mcpAuth: {
              mode: "oauth",
              transport: "http",
              resource: "https://selected.example/mcp",
              authorizationServers: ["https://auth.selected.example"],
              scopes: ["git:read"],
            },
          },
        },
      }],
    }));

    const plugins = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).listPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      id: "lvis-plugin-git",
      version: "0.1.12",
      artifactSha256: selectedDigest,
      packageSpec: "lvis-plugin-git@0.1.12",
      channel: "stable",
      installPolicy: "user",
      dependencies: [{
        pluginId: "selected-dependency",
        versionRange: "^2.0.0",
        required: true,
      }],
      pluginAccess: {
        plugins: [{
          pluginId: "selected-plugin",
          events: ["selected.event"],
        }],
        agentApprovalScopes: ["agent_external_api_call"],
      },
      networkAccess: {
        allowedDomains: ["selected.example"],
        reasoning: "selected artifact policy",
      },
      capabilities: ["selected-capability"],
      requires: {
        capabilities: ["selected-requires"],
        minAppVersion: "0.5.9",
      },
      mcpRuntime: {
        transport: "http",
        url: "https://selected.example/mcp",
        auth: "oauth",
        oauth: {
          resource: "https://selected.example/mcp",
          authorizationServers: ["https://auth.selected.example"],
          scopes: ["git:read"],
        },
      },
      mcpAuth: {
        mode: "oauth",
        transport: "http",
        resource: "https://selected.example/mcp",
        authorizationServers: ["https://auth.selected.example"],
        scopes: ["git:read"],
      },
    });
    expect(plugins[0]?.networkAccess?.allowedDomains).not.toContain("outer.example");
    expect(plugins[0]?.capabilities).not.toContain("outer-capability");
    expect(plugins[0]?.mcpRuntime?.transport).toBe("http");
    expect((plugins[0]?.mcpRuntime as { url?: string }).url).toBe(
      "https://selected.example/mcp",
    );
  });

  it("fails closed for malformed or inconsistent selected artifacts", async () => {
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    });
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([{
      slug: "bad-digest",
      name: "Bad digest",
      app_version_resolution: "resolved",
      resolved_artifact: {
        version: "1.0.0",
        artifact_sha256: "not-a-digest",
        manifest: { id: "bad-digest", version: "1.0.0" },
      },
    }]));
    await expect(fetcher.listPlugins()).rejects.toThrow(/artifact_sha256/);

    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([{
      slug: "bad-min",
      name: "Bad min",
      app_version_resolution: "resolved",
      resolved_artifact: {
        version: "1.0.0",
        artifact_sha256: "c".repeat(64),
        min_app_version: "0.5.9",
        manifest: {
          id: "bad-min",
          version: "1.0.0",
          requires: { minAppVersion: "0.5.8" },
        },
      },
    }]));
    await expect(fetcher.listPlugins()).rejects.toThrow(/min_app_version does not match/);

    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([{
      slug: "bad-id",
      name: "Bad id",
      app_version_resolution: "resolved",
      resolved_artifact: {
        version: "1.0.0",
        artifact_sha256: "d".repeat(64),
        manifest: { id: "other-id", version: "1.0.0" },
      },
    }]));
    await expect(fetcher.listPlugins()).rejects.toThrow(/manifest id mismatch/);
  });

  it("normalises an uppercase resolved artifact digest at the network boundary", async () => {
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    });
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([{
      slug: "upper-digest",
      name: "Upper digest",
      app_version_resolution: "resolved",
      resolved_artifact: {
        version: "1.0.0",
        artifact_sha256: "F".repeat(64),
        manifest: { id: "upper-digest", version: "1.0.0" },
      },
    }]));
    const plugins = await fetcher.listPlugins();
    expect(plugins[0]?.artifactSha256).toBe("f".repeat(64));
  });

  it("does not fall back to outer MCP runtime/auth when the selected manifest is incomplete", async () => {
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([{
      slug: "missing-mcp-runtime",
      name: "Missing MCP runtime",
      plugin_type: "mcp",
      runtime: {
        transport: "http",
        url: "https://outer.example/mcp",
        auth: "api-key",
      },
      mcp_auth: {
        mode: "api-key",
        transport: "http",
      },
      app_version_resolution: "resolved",
      resolved_artifact: {
        version: "1.0.0",
        artifact_sha256: "e".repeat(64),
        manifest: {
          id: "missing-mcp-runtime",
          version: "1.0.0",
        },
      },
    }]));

    await expect(new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).listPlugins()).rejects.toThrow(/no valid runtime block/);
  });

  it("does not inherit outer MCP auth when the resolved manifest omits mcpAuth", async () => {
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([{
      slug: "selected-runtime-no-auth",
      name: "Selected runtime without auth metadata",
      plugin_type: "mcp",
      runtime: {
        transport: "http",
        url: "https://outer.example/mcp",
        auth: "oauth",
      },
      mcp_auth: {
        mode: "oauth",
        transport: "http",
        resource: "https://outer.example/mcp",
        authorizationServers: ["https://auth.outer.example"],
        scopes: ["outer:read"],
      },
      app_version_resolution: "resolved",
      resolved_artifact: {
        version: "1.0.0",
        artifact_sha256: "f".repeat(64),
        manifest: {
          id: "selected-runtime-no-auth",
          version: "1.0.0",
          runtime: {
            transport: "http",
            url: "https://selected.example/mcp",
            auth: "none",
          },
        },
      },
    }]));

    const plugins = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).listPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.mcpRuntime).toEqual({
      transport: "http",
      url: "https://selected.example/mcp",
      auth: "none",
    });
    expect(plugins[0]?.mcpAuth).toEqual({
      mode: "none",
      transport: "http",
    });
    expect(plugins[0]?.mcpAuth).not.toMatchObject({
      resource: "https://outer.example/mcp",
    });
  });

  it("keeps update-required display rows for every installable package type", async () => {
    const upgradeRequired = {
      code: "upgrade_required",
      min_app_version: "1.2.3",
      message: "LVIS 1.2.3+ is required to install this version. Update LVIS and try again.",
    };
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
      plugins: [
        {
          slug: "incompatible-plugin",
          name: "Incompatible plugin",
          latest_stable_version: "9.9.9",
          latest_artifact_sha256: "a".repeat(64),
          package_spec: "outer-plugin@9.9.9",
          package_name: "outer-plugin",
          install_policy: "admin",
          plugin_type: "plugin",
          app_version_resolution: "no_compatible_version",
          upgrade_required: upgradeRequired,
        },
        {
          slug: "incompatible-mcp",
          name: "Incompatible MCP",
          latest_stable_version: "9.9.9",
          package_spec: "outer-mcp@9.9.9",
          plugin_type: "mcp",
          app_version_resolution: "no_compatible_version",
          upgrade_required: upgradeRequired,
        },
        {
          slug: "incompatible-agent",
          name: "Incompatible agent",
          latest_stable_version: "9.9.9",
          package_spec: "outer-agent@9.9.9",
          plugin_type: "agent",
          app_version_resolution: "no_compatible_version",
          upgrade_required: upgradeRequired,
        },
        {
          slug: "incompatible-skill",
          name: "Incompatible skill",
          latest_stable_version: "9.9.9",
          package_spec: "outer-skill@9.9.9",
          plugin_type: "skill",
          app_version_resolution: "no_compatible_version",
          upgrade_required: upgradeRequired,
        },
        {
          id: "groq-provider",
          display_name: "Groq",
          description: "Provider package",
          package_spec: "@lvis/groq-provider@1.0.0",
          package_name: "@lvis/groq-provider",
          plugin_type: "provider",
          provider_id: "groq",
          app_version_resolution: "no_compatible_version",
        },
      ],
    }));

    const plugins = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).listPlugins();

    expect(plugins).toHaveLength(5);
    for (const [id, pluginType] of Object.entries({
      "incompatible-plugin": "plugin",
      "incompatible-mcp": "mcp",
      "incompatible-agent": "agent",
      "incompatible-skill": "skill",
    })) {
      const item = plugins.find((candidate) => candidate.id === id);
      expect(item).toMatchObject({
        id,
        pluginType,
        packageSpec: "",
        packageName: "",
        upgradeRequired: {
          code: "upgrade_required",
          minAppVersion: "1.2.3",
          message: upgradeRequired.message,
        },
      });
      expect(item).not.toHaveProperty("version");
      expect(item).not.toHaveProperty("artifactSha256");
      expect(item).not.toHaveProperty("installPolicy");
    }
    expect(plugins.find((item) => item.id === "groq-provider")).toMatchObject({
      id: "groq-provider",
      pluginType: "provider",
      packageAsset: { type: "provider", providerId: "groq" },
    });
  });

  it("fails closed for versioned catalog rows without a resolver status or valid display name", async () => {
    const installableTypes = ["plugin", "mcp", "agent", "skill"] as const;
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
      plugins: [
        ...installableTypes.map((pluginType) => ({
          slug: `missing-resolution-${pluginType}`,
          name: `Missing resolution ${pluginType}`,
          plugin_type: pluginType,
          latest_stable_version: "9.9.9",
          latest_artifact_sha256: "a".repeat(64),
          package_spec: `outer-${pluginType}@9.9.9`,
          package_name: `outer-${pluginType}`,
          install_policy: "admin",
        })),
        {
          slug: "non-string-upgrade-name",
          name: { untrusted: "name" },
          plugin_type: "plugin",
          app_version_resolution: "no_compatible_version",
        },
      ],
    }));

    await expect(new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).listPlugins()).resolves.toEqual([]);
  });

  it("keeps legacy catalog and detail mapping only without appVersion", async () => {
    const legacyRow = {
      slug: "legacy-plugin",
      name: "Legacy plugin",
      plugin_type: "plugin",
      latest_stable_version: "1.0.0",
      package_spec: "legacy-plugin@1.0.0",
    };
    mockedFetchPublic
      .mockResolvedValueOnce(jsonResponse([legacyRow]))
      .mockResolvedValueOnce(jsonResponse(legacyRow));

    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    });
    const catalog = await fetcher.listPlugins();
    const detail = await fetcher.getPluginDetail("legacy-plugin");

    expect(catalog).toMatchObject([{ id: "legacy-plugin", packageSpec: "legacy-plugin@1.0.0" }]);
    expect(detail).toMatchObject({ id: "legacy-plugin", packageSpec: "legacy-plugin@1.0.0" });
    expect(mockedFetchPublic.mock.calls.map(([url]) => url)).toEqual([
      "https://marketplace.example.com/api/v1/catalog",
      "https://marketplace.example.com/api/v1/plugins/legacy-plugin",
    ]);
  });
});


describe("CloudMarketplaceFetcher app-version resolver detail", () => {
  beforeEach(() => {
    mockedFetchPublic.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds app_version to detail reads as well as catalog reads", async () => {
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
      slug: "detail-plugin",
      name: "Detail plugin",
      latest_stable_version: "1.0.0",
      app_version_resolution: "resolved",
      resolved_artifact: {
        version: "1.0.0",
        artifact_sha256: "a".repeat(64),
        manifest: {
          id: "detail-plugin",
          version: "1.0.0",
        },
      },
    }));

    const detail = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).getPluginDetail("detail-plugin");

    expect(detail?.id).toBe("detail-plugin");
    expect(mockedFetchPublic.mock.calls[0]?.[0]).toBe(
      "https://marketplace.example.com/api/v1/plugins/detail-plugin?app_version=0.5.9",
    );
  });

  it("fails closed for versioned installable details without a resolver status or valid display name", async () => {
    const installableTypes = ["plugin", "mcp", "agent", "skill"] as const;
    const fetcher = new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    });

    for (const pluginType of installableTypes) {
      const slug = `missing-detail-resolution-${pluginType}`;
      mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
        slug,
        name: `Missing detail resolution ${pluginType}`,
        plugin_type: pluginType,
        latest_stable_version: "9.9.9",
        package_spec: `outer-${pluginType}@9.9.9`,
      }));

      await expect(fetcher.getPluginDetail(slug)).resolves.toBeNull();
    }

    mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
      slug: "non-string-detail-upgrade-name",
      name: { untrusted: "name" },
      plugin_type: "plugin",
      app_version_resolution: "no_compatible_version",
    }));
    await expect(fetcher.getPluginDetail("non-string-detail-upgrade-name")).resolves.toBeNull();
  });

  it("rejects a selected non-stable version before it can form a package spec", async () => {
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse([{
      slug: "pre-release",
      name: "Pre-release",
      app_version_resolution: "resolved",
      resolved_artifact: {
        version: "1.0.0-beta.1",
        artifact_sha256: "f".repeat(64),
        manifest: { id: "pre-release", version: "1.0.0-beta.1" },
      },
    }]));

    await expect(new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).listPlugins()).rejects.toThrow(/stable SemVer/);
  });
  it("maps an explicit update-required detail without outer artifact metadata", async () => {
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
      slug: "incompatible-detail",
      name: "Incompatible detail",
      latest_stable_version: "9.9.9",
      package_spec: "outer-package@9.9.9",
      app_version_resolution: "no_compatible_version",
      upgrade_required: {
        code: "upgrade_required",
        min_app_version: "1.2.3",
        message: "LVIS 1.2.3+ is required to install this version. Update LVIS and try again.",
      },
    }));

    const detail = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9+build.7",
    }).getPluginDetail("incompatible-detail");

    expect(detail).toMatchObject({
      id: "incompatible-detail",
      packageSpec: "",
      packageName: "",
      upgradeRequired: {
        code: "upgrade_required",
        minAppVersion: "1.2.3",
      },
    });
    expect(detail).not.toHaveProperty("version");
    expect(mockedFetchPublic.mock.calls[0]?.[0]).toBe(
      "https://marketplace.example.com/api/v1/plugins/incompatible-detail?app_version=0.5.9",
    );
  });

  it("maps a no-compatible-version detail without an upgrade contract to a generic display-only row", async () => {
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
      slug: "generic-incompatible-detail",
      name: "Generic incompatible detail",
      latest_stable_version: "9.9.9",
      latest_artifact_sha256: "a".repeat(64),
      package_spec: "outer-package@9.9.9",
      package_name: "outer-package",
      install_policy: "admin",
      plugin_type: "plugin",
      requires: { min_app_version: "9.9.9" },
      runtime: { transport: "http", url: "https://outer.example/mcp" },
      app_version_resolution: "no_compatible_version",
    }));

    const detail = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).getPluginDetail("generic-incompatible-detail");

    expect(detail).toMatchObject({
      id: "generic-incompatible-detail",
      packageSpec: "",
      packageName: "",
      pluginType: "plugin",
      upgradeRequired: {
        code: "upgrade_required",
        message: "This package is unavailable in this version of LVIS. Update LVIS and try again.",
      },
    });
    expect(detail?.upgradeRequired).not.toHaveProperty("minAppVersion");
    expect(detail).not.toHaveProperty("version");
    expect(detail).not.toHaveProperty("artifactSha256");
    expect(detail).not.toHaveProperty("installPolicy");
    expect(detail).not.toHaveProperty("requires");
    expect(detail).not.toHaveProperty("mcpRuntime");
  });

  it("fails closed when the update-required contract is malformed", async () => {
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
      slug: "incompatible-detail",
      name: "Incompatible detail",
      app_version_resolution: "no_compatible_version",
      upgrade_required: {
        code: "upgrade_required",
        min_app_version: "1.2.3",
        message: "untrusted message",
      },
    }));

    await expect(new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).getPluginDetail("incompatible-detail")).resolves.toBeNull();
  });

  it("fails closed when the update-required contract is explicitly null", async () => {
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse({
      slug: "incompatible-detail",
      name: "Incompatible detail",
      app_version_resolution: "no_compatible_version",
      upgrade_required: null,
    }));

    await expect(new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
      appVersion: "0.5.9",
    }).getPluginDetail("incompatible-detail")).resolves.toBeNull();
  });

});

describe("per-version artifact hashes", () => {
  /**
   * The catalog carries a hash for every version it lists; only the latest was
   * read. An explicit prior-version install — rollback, or a pinned
   * installPlugin — therefore had NOTHING to compare its bytes against and
   * relied on the signature alone, which binds the bytes without saying which
   * plugin or version they belong to.
   */
  const SHA_LATEST = "a".repeat(64);
  const SHA_PRIOR = "b".repeat(64);

  function detailRow(versions: unknown) {
    return {
      id: "acme-notes",
      name: "Acme Notes",
      description: "Note plugin",
      packageName: "@acme/notes",
      packageSpec: "@acme/notes@2.0.0",
      version: "2.0.0",
      latest_artifact_sha256: SHA_LATEST,
      versions,
    };
  }

  it("collects a hash for every listed version, not just the latest", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse(
        detailRow([
          { version: "2.0.0", artifact_sha256: SHA_LATEST },
          { version: "1.0.0", artifact_sha256: SHA_PRIOR },
        ]),
      ),
    );

    const item = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    }).getPluginDetail("acme-notes");

    expect(item?.artifactSha256ByVersion).toEqual({
      "2.0.0": SHA_LATEST,
      "1.0.0": SHA_PRIOR,
    });
    expect(item?.artifactSha256).toBe(SHA_LATEST);
  });

  it("lower-cases digests so the comparison is not case-sensitive", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse(detailRow([{ version: "1.0.0", artifact_sha256: SHA_PRIOR.toUpperCase() }])),
    );

    const item = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    }).getPluginDetail("acme-notes");

    expect(item?.artifactSha256ByVersion?.["1.0.0"]).toBe(SHA_PRIOR);
  });

  it.each([
    ["a malformed digest", [{ version: "1.0.0", artifact_sha256: "not-a-digest" }]],
    ["a missing digest", [{ version: "1.0.0" }]],
    ["a missing version", [{ artifact_sha256: "c".repeat(64) }]],
    ["a non-object row", ["1.0.0"]],
  ])("drops %s rather than defaulting it", async (_label, versions) => {
    // A dropped entry makes the install refuse for want of an expected hash.
    // A wrong entry would refuse a CORRECT artifact, and a permissive one
    // would defeat the check — dropping is the only safe direction.
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse(detailRow(versions)));

    const item = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    }).getPluginDetail("acme-notes");

    expect(item?.artifactSha256ByVersion?.["1.0.0"]).toBeUndefined();
  });

  it("leaves the map absent when the response carries no version list", async () => {
    // Absence must stay distinguishable from "listed with no hash": the
    // install path treats a listed version without a hash as unverifiable.
    mockedFetchPublic.mockResolvedValueOnce(jsonResponse(detailRow(undefined)));

    const item = await new CloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
      networkFetch: unusedNetworkFetch,
    }).getPluginDetail("acme-notes");

    expect(item?.artifactSha256ByVersion).toBeUndefined();
    expect(item?.artifactSha256).toBe(SHA_LATEST);
  });
});

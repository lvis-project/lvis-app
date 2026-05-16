/**
 * Tests for RealCloudMarketplaceFetcher — §9.5 M4.
 *
 * We mock `fetchPublicHttpResponse` (public-network path) and the global
 * `fetch` (private-network path) to prove both wiring paths and the
 * mapping/error handling behavior without making real HTTP calls.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

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
import { RealCloudMarketplaceFetcher } from "../real-cloud-marketplace-fetcher.js";

const mockedFetchPublic = fetchPublicHttpResponse as unknown as ReturnType<typeof vi.fn>;

/** Build a minimal Response-like object that satisfies what the fetcher reads. */
function jsonResponse(body: unknown, init: { status?: number; ok?: boolean } = {}): Response {
  const status = init.status ?? 200;
  const ok = init.ok ?? status < 400;
  return {
    ok,
    status,
    statusText: ok ? "OK" : "ERR",
    async json() {
      return body;
    },
    async arrayBuffer() {
      throw new Error("not used");
    },
  } as unknown as Response;
}

function bytesResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async arrayBuffer() {
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      );
    },
    async json() {
      throw new Error("not used");
    },
  } as unknown as Response;
}

describe("RealCloudMarketplaceFetcher (public-network path)", () => {
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
          methods: ["notes.add", "notes.list"],
          installPolicy: "user",
          dependencies: ["calendar"],
          publisher: "Acme",
        },
      ]),
    );

    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]).toMatchObject({
      id: "acme-notes",
      name: "Acme Notes",
      packageName: "@acme/notes",
      packageSpec: "@acme/notes@1.2.3",
      tools: ["notes.add", "notes.list"],
      installPolicy: "user",
      dependencies: ["calendar"],
      publisher: "Acme",
    });

    // Verify URL + Bearer header behavior
    const [url, opts] = mockedFetchPublic.mock.calls[0];
    expect(url).toBe("https://marketplace.example.com/api/v1/catalog");
    expect((opts as RequestInit).method).toBe("GET");
    // No apiKey configured → no authorization header
    const headers = (opts as RequestInit & { headers?: Record<string, string> }).headers ?? {};
    expect(headers["authorization"]).toBeUndefined();
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

    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
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

    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com/",
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

  it("getPluginDetail() returns null on 404", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({ error: "not found" }, { status: 404, ok: false }),
    );
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    const detail = await fetcher.getPluginDetail("ghost");
    expect(detail).toBeNull();
  });

  it("downloadVersion() returns zipBuffer + sha256", async () => {
    const payload = new TextEncoder().encode("PK\u0003\u0004fake-zip-bytes");
    const expectedSha = createHash("sha256").update(Buffer.from(payload)).digest("hex");
    mockedFetchPublic.mockResolvedValueOnce(bytesResponse(payload));

    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
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
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
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
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/network guard:/);
  });
});

describe("RealCloudMarketplaceFetcher (private-network path)", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("allowPrivateNetwork=true bypasses SSRF guard and calls global fetch", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(
      jsonResponse([
        {
          id: "local-plugin",
          name: "Local",
          description: "d",
          packageName: "@local/x",
          packageSpec: "@local/x@0.0.1",
          methods: [],
        },
      ]),
    );
    global.fetch = fakeFetch as unknown as typeof global.fetch;
    mockedFetchPublic.mockReset();

    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "http://127.0.0.1:8080",
      allowPrivateNetwork: true,
    });
    const plugins = await fetcher.listPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0].id).toBe("local-plugin");
    // NetworkGuard path must NOT have been invoked.
    expect(mockedFetchPublic).not.toHaveBeenCalled();
    expect(fakeFetch).toHaveBeenCalledOnce();
    const [url] = fakeFetch.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:8080/api/v1/catalog");
  });
});

describe("RealCloudMarketplaceFetcher — actual server response shape", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
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
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse([serverPlugin]));
    global.fetch = fakeFetch as unknown as typeof global.fetch;

    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "http://127.0.0.1:8000",
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
    // tools defaults to [] when methods is absent
    expect(p.tools).toEqual([]);
    expect(p.installPolicy).toBe("admin");
    expect(p.dependencies).toEqual(["calendar", "email", "meeting"]);
    expect(p.version).toBe("0.1.0");
    expect(p.artifactSha256).toBe("a".repeat(64));
    expect(p.channel).toBe("stable");
  });

  it("downloadVersion() returns zipBuffer + sha256 with actual server shape", async () => {
    const payload = new TextEncoder().encode("PK\u0003\u0004fake-zip");
    const expectedSha = createHash("sha256").update(Buffer.from(payload)).digest("hex");

    const fakeFetch = vi.fn().mockResolvedValue(bytesResponse(payload));
    global.fetch = fakeFetch as unknown as typeof global.fetch;

    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "http://127.0.0.1:8000",
      allowPrivateNetwork: true,
    });
    const result = await fetcher.downloadVersion("lvis-plugin-meeting", "0.1.0");

    expect(Buffer.isBuffer(result.zipBuffer)).toBe(true);
    expect(result.sha256).toBe(expectedSha);
    const [url] = fakeFetch.mock.calls[0];
    expect(url).toBe(
      "http://127.0.0.1:8000/api/v1/plugins/lvis-plugin-meeting/versions/0.1.0/download",
    );
  });

  it("missing latest_stable_version (null) → packageSpec falls back to slug only", async () => {
    const pluginWithoutVersion = { ...serverPlugin, latest_stable_version: null };
    const fakeFetch = vi.fn().mockResolvedValue(jsonResponse([pluginWithoutVersion]));
    global.fetch = fakeFetch as unknown as typeof global.fetch;

    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "http://127.0.0.1:8000",
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

describe("RealCloudMarketplaceFetcher — input validation (security)", () => {
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
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects slug that starts with dash (npm flag injection)", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: "x", slug: "--registry=https://evil.example", name: "Evil" }]),
    );
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects slug with file: protocol prefix", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: "x", slug: "file:/tmp/evil.tgz", name: "Evil" }]),
    );
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects slug with git+https: protocol", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: "x", slug: "git+https://evil/x.git", name: "Evil" }]),
    );
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects non-primitive id (object stringifies to [object Object])", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: { evil: true }, name: "Evil" }]),
    );
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/missing id\/name/);
  });

  it("rejects array id", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: [1, 2, 3], name: "Evil" }]),
    );
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/missing id\/name/);
  });

  it("rejects id with path separator", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: "../../../etc", name: "Evil", slug: "safe-slug" }]),
    );
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    await expect(fetcher.listPlugins()).rejects.toThrow(/invalid id format/);
  });

  it("rejects unsafe numeric id (NaN)", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse([{ id: NaN, name: "Evil" }]),
    );
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
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
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
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
    const fetcher = new RealCloudMarketplaceFetcher({
      baseUrl: "https://marketplace.example.com",
    });
    const plugins = await fetcher.listPlugins();
    expect(plugins[0].packageName).toBe("simple-plugin");
    expect(plugins[0].packageSpec).toBe("simple-plugin@1.0.0");
  });
});

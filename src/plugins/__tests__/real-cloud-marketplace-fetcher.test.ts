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
vi.mock("../../core/network-guard.js", async () => {
  const actual = await vi.importActual<typeof import("../../core/network-guard.js")>(
    "../../core/network-guard.js",
  );
  return {
    ...actual,
    fetchPublicHttpResponse: vi.fn(),
  };
});

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
          deployment: "user",
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
      methods: ["notes.add", "notes.list"],
      deployment: "user",
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

  it("listPlugins() accepts {plugins: [...]} wrapper shape", async () => {
    mockedFetchPublic.mockResolvedValueOnce(
      jsonResponse({
        plugins: [
          {
            slug: "mp-a",
            display_name: "Plugin A",
            description: "d",
            package_name: "@x/a",
            latest_stable_version: "0.1.0",
            methods: [],
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
    // packageSpec synthesized from packageName + version
    expect(plugins[0].packageSpec).toBe("@x/a@0.1.0");
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

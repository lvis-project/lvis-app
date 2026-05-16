/**
 * #FU259 — MCP marketplace install consumer.
 *
 * Tests the runtime-block parser, host-token substitution, and the end-
 * to-end orchestration that materializes McpServerConfig from a verified
 * manifest. The download/extract path is exercised by the underlying
 * `PluginArtifactStore` tests; here we stub the store so we can verify
 * the install path's contract without spinning up a real fetcher.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildMcpServerConfig,
  installMcpFromMarketplace,
  readRuntimeFromInstalledManifest,
  substituteRuntimeTokens,
} from "../mcp-marketplace-install.js";
import { MAX_MCP_MANIFEST_BYTES } from "../safe-names.js";
import type { McpRuntimeSpec, PluginMarketplaceItem } from "../../plugins/types.js";
import type { PluginArtifactStore } from "../../plugins/plugin-artifact-store.js";
import type { MarketplaceFetcher } from "../../plugins/marketplace-fetcher.js";

function makeTmpDir(): string {
  const root = tmpdir();
  return mkdtempSync(join(root, "mcp-install-"));
}

describe("substituteRuntimeTokens", () => {
  it("replaces \\$PLUGIN_DIR / \\$NODE / \\$PYTHON in stdio command + args + env", () => {
    const runtime: McpRuntimeSpec = {
      transport: "stdio",
      command: "$NODE",
      args: ["$PLUGIN_DIR/dist/server.js", "--python", "$PYTHON"],
      env: { WORKDIR: "$PLUGIN_DIR" },
      auth: "api-key",
    };
    const out = substituteRuntimeTokens(runtime, {
      pluginDir: "/data/mcp/weather",
      nodePath: "/usr/bin/node",
      pythonPath: "/usr/bin/python3",
    });
    expect(out).toEqual({
      transport: "stdio",
      command: "/usr/bin/node",
      args: ["/data/mcp/weather/dist/server.js", "--python", "/usr/bin/python3"],
      env: { WORKDIR: "/data/mcp/weather" },
      auth: "api-key",
    });
  });

  it("preserves stdio apiKeyEnv metadata without substituting secret material", () => {
    const runtime: McpRuntimeSpec = {
      transport: "stdio",
      command: "uvx",
      args: ["--from", "browser-use[cli]", "browser-use", "--mcp"],
      auth: "api-key",
      apiKeyEnv: "OPENAI_API_KEY",
    };
    const out = substituteRuntimeTokens(runtime, {
      pluginDir: "/data/mcp/browser-use",
      nodePath: "/usr/bin/node",
      pythonPath: "/usr/bin/python3",
    });
    expect(out).toEqual(runtime);
    expect(JSON.stringify(out)).not.toMatch(/sk-|Bearer|secret/i);
  });

  it("does not substitute http url tokens (publisher controls endpoint)", () => {
    const runtime: McpRuntimeSpec = {
      transport: "http",
      url: "https://mcp.example.com/$PLUGIN_DIR",
    };
    const out = substituteRuntimeTokens(runtime, {
      pluginDir: "/data",
      nodePath: "node",
      pythonPath: "python",
    });
    expect((out as { url: string }).url).toBe("https://mcp.example.com/$PLUGIN_DIR");
  });
});

describe("buildMcpServerConfig", () => {
  it("emits stdio config with auth=none default", () => {
    const config = buildMcpServerConfig("weather", {
      transport: "stdio",
      command: "node",
      args: ["server.js"],
    });
    expect(config).toEqual({
      id: "weather",
      transport: "stdio",
      command: "node",
      args: ["server.js"],
      env: undefined,
      auth: "none",
    });
  });

  it("emits stdio api-key config with apiKeyEnv metadata", () => {
    const config = buildMcpServerConfig("browser-use-mcp", {
      transport: "stdio",
      command: "uvx",
      args: ["--from", "browser-use[cli]", "browser-use", "--mcp"],
      auth: "api-key",
      apiKeyEnv: "OPENAI_API_KEY",
    });
    expect(config).toEqual({
      id: "browser-use-mcp",
      transport: "stdio",
      command: "uvx",
      args: ["--from", "browser-use[cli]", "browser-use", "--mcp"],
      env: undefined,
      auth: "api-key",
      apiKeyEnv: "OPENAI_API_KEY",
    });
  });

  it("emits http config with allowPrivateNetworks pass-through", () => {
    const config = buildMcpServerConfig("internal", {
      transport: "http",
      url: "http://localhost:8765",
      auth: "sso",
      allowPrivateNetworks: true,
    });
    expect(config).toEqual({
      id: "internal",
      transport: "http",
      url: "http://localhost:8765",
      auth: "sso",
      allowPrivateNetworks: true,
    });
  });

  it("emits http api-key config with custom safe header metadata", () => {
    const config = buildMcpServerConfig("browser-use-cloud-mcp", {
      transport: "http",
      url: "https://api.browser-use.com/v3/mcp",
      auth: "api-key",
      apiKeyHeader: "x-browser-use-api-key",
    });
    expect(config).toEqual({
      id: "browser-use-cloud-mcp",
      transport: "http",
      url: "https://api.browser-use.com/v3/mcp",
      auth: "api-key",
      apiKeyHeader: "x-browser-use-api-key",
    });
  });

  it("emits http OAuth config with discovery metadata and no token material", () => {
    const config = buildMcpServerConfig("remote-docs", {
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
    expect(config).toEqual({
      id: "remote-docs",
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
    expect(JSON.stringify(config)).not.toMatch(/access[_-]?token|refresh[_-]?token|Bearer/i);
  });
});

describe("readRuntimeFromInstalledManifest", () => {
  it("returns the parsed runtime block", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      await writeFile(
        join(tmp, "plugin.json"),
        JSON.stringify({
          id: "weather",
          version: "1.0.0",
          runtime: {
            transport: "stdio",
            command: "node",
            args: ["server.js"],
            auth: "none",
          },
        }),
      );
      const runtime = await readRuntimeFromInstalledManifest(tmp);
      expect(runtime).toEqual({
        transport: "stdio",
        command: "node",
        args: ["server.js"],
        auth: "none",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns HTTP OAuth runtime metadata from a verified manifest", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      await writeFile(
        join(tmp, "plugin.json"),
        JSON.stringify({
          id: "remote-docs",
          version: "1.0.0",
          runtime: {
            transport: "http",
            url: "https://mcp.example.com/mcp",
            auth: "oauth",
            oauth: {
              resource: "https://mcp.example.com/mcp",
              resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
              authorizationServers: ["https://auth.example.com"],
              scopes: ["docs:read", "docs:search"],
              clientRegistration: "client-id-metadata-document",
            },
          },
        }),
      );
      const runtime = await readRuntimeFromInstalledManifest(tmp);
      expect(runtime).toEqual({
        transport: "http",
        url: "https://mcp.example.com/mcp",
        auth: "oauth",
        oauth: {
          resource: "https://mcp.example.com/mcp",
          resourceMetadataUrl: "https://mcp.example.com/.well-known/oauth-protected-resource/mcp",
          authorizationServers: ["https://auth.example.com"],
          scopes: ["docs:read", "docs:search"],
          clientRegistration: "client-id-metadata-document",
        },
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("returns browser-use stdio apiKeyEnv metadata from a verified manifest", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      await writeFile(
        join(tmp, "plugin.json"),
        JSON.stringify({
          id: "browser-use-mcp",
          version: "0.12.6",
          runtime: {
            transport: "stdio",
            command: "uvx",
            args: ["--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
            auth: "api-key",
            apiKeyEnv: "OPENAI_API_KEY",
          },
        }),
      );
      const runtime = await readRuntimeFromInstalledManifest(tmp);
      expect(runtime).toEqual({
        transport: "stdio",
        command: "uvx",
        args: ["--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
        auth: "api-key",
        apiKeyEnv: "OPENAI_API_KEY",
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws a clear error when runtime block is missing", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      await writeFile(
        join(tmp, "plugin.json"),
        JSON.stringify({ id: "weather", version: "1.0.0" }),
      );
      await expect(readRuntimeFromInstalledManifest(tmp)).rejects.toThrow(
        /missing a valid `runtime` block/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws when manifest file is absent", async () => {
    const tmp = makeTmpDir();
    try {
      await expect(readRuntimeFromInstalledManifest(tmp)).rejects.toThrow(/manifest not found/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("throws a byte-cap error when manifest exceeds MAX_MCP_MANIFEST_BYTES (NEW-1 HIGH)", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      // Write a file that is 1 byte over the cap using a Buffer of the right size.
      const oversized = Buffer.alloc(MAX_MCP_MANIFEST_BYTES + 1, "x");
      await writeFile(join(tmp, "plugin.json"), oversized);
      await expect(readRuntimeFromInstalledManifest(tmp)).rejects.toThrow(
        /exceeds.*byte cap/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("succeeds when manifest is exactly at MAX_MCP_MANIFEST_BYTES (NEW-1 boundary)", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      // Write a valid manifest padded with whitespace to reach the cap exactly.
      const manifest = JSON.stringify({
        id: "weather",
        version: "1.0.0",
        runtime: { transport: "stdio", command: "node", args: ["server.js"], auth: "none" },
      });
      const padding = " ".repeat(MAX_MCP_MANIFEST_BYTES - manifest.length);
      await writeFile(join(tmp, "plugin.json"), manifest + padding, "utf-8");
      const runtime = await readRuntimeFromInstalledManifest(tmp);
      expect(runtime.transport).toBe("stdio");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("installMcpFromMarketplace", () => {
  function makeStubStore(installDir: string): PluginArtifactStore {
    return {
      installDirFor: vi.fn(() => installDir),
      downloadVerifiedZip: vi.fn(async () => Buffer.alloc(0)),
      extractZip: vi.fn(async () => undefined),
      appendHistory: vi.fn(async () => undefined),
    } as unknown as PluginArtifactStore;
  }

  function makeStubFetcher(detail: PluginMarketplaceItem | null): MarketplaceFetcher {
    return {
      listPlugins: vi.fn(async () => []),
      getPluginDetail: vi.fn(async () => detail),
      downloadVersion: vi.fn(async () => ({ zipBuffer: Buffer.alloc(0), sha256: "x" })),
    };
  }

  it("rejects non-MCP catalog entries", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStubStore(tmp);
      const fetcher = makeStubFetcher({
        id: "regular-plugin",
        name: "regular-plugin",
        description: "",
        packageSpec: "regular-plugin@1.0.0",
        packageName: "regular-plugin",
        tools: [],
        version: "1.0.0",
        pluginType: "plugin",
      });
      await expect(installMcpFromMarketplace("regular-plugin", { fetcher, store })).rejects.toThrow(
        /is a plugin entry/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unknown slugs", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStubStore(tmp);
      const fetcher = makeStubFetcher(null);
      await expect(installMcpFromMarketplace("does-not-exist", { fetcher, store })).rejects.toThrow(
        /no entry for slug/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("end-to-end: downloads, extracts, reads runtime, materializes config", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      // Stub `extractZip` would normally write the manifest. Pre-write it
      // so `readRuntimeFromInstalledManifest` finds something.
      await writeFile(
        join(tmp, "plugin.json"),
        JSON.stringify({
          id: "weather",
          version: "1.0.0",
          runtime: {
            transport: "stdio",
            command: "$NODE",
            args: ["$PLUGIN_DIR/dist/server.js"],
            auth: "api-key",
          },
        }),
      );

      const store = makeStubStore(tmp);
      const fetcher = makeStubFetcher({
        id: "weather",
        name: "Weather MCP",
        description: "",
        packageSpec: "weather-mcp@1.0.0",
        packageName: "weather-mcp",
        tools: [],
        version: "1.0.0",
        pluginType: "mcp",
      });
      const result = await installMcpFromMarketplace("weather", {
        fetcher,
        store,
        nodePath: "/usr/bin/node",
        pythonPath: "/usr/bin/python3",
      });

      // Token substitution is pure string replace — `$PLUGIN_DIR` becomes
      // the OS-specific tmp path while the literal `/dist/server.js` tail
      // is preserved as-written. Node accepts the mixed-separator form on
      // Windows so this is intentional, not a bug.
      expect(result.config).toEqual({
        id: "weather",
        transport: "stdio",
        command: "/usr/bin/node",
        args: [`${tmp}/dist/server.js`],
        env: undefined,
        auth: "api-key",
      });
      expect(result.installDir).toBe(tmp);
      expect(result.needsCredential).toBe(true);
      expect(result.authMode).toBe("api-key");
      expect(store.appendHistory).toHaveBeenCalledWith(
        "weather",
        expect.objectContaining({ version: "1.0.0" }),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("end-to-end: preserves MCP OAuth login metadata from the verified package", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      await writeFile(
        join(tmp, "plugin.json"),
        JSON.stringify({
          id: "remote-docs",
          version: "1.0.0",
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
        }),
      );

      const store = makeStubStore(tmp);
      const fetcher = makeStubFetcher({
        id: "remote-docs",
        name: "Remote Docs MCP",
        description: "",
        packageSpec: "remote-docs@1.0.0",
        packageName: "remote-docs",
        tools: [],
        version: "1.0.0",
        pluginType: "mcp",
      });
      const result = await installMcpFromMarketplace("remote-docs", { fetcher, store });

      expect(result.config).toEqual({
        id: "remote-docs",
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
      expect(result.needsCredential).toBe(true);
      expect(result.authMode).toBe("oauth");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

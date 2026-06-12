/**
 * #FU259 — MCP marketplace install consumer.
 *
 * Tests the runtime-block parser, host-token substitution, and the end-
 * to-end orchestration that materializes McpServerConfig from a verified
 * manifest. The download/extract path is exercised by the underlying
 * `PluginArtifactStore` tests; here we stub the store so we can verify
 * the install path's contract without spinning up a real fetcher.
 */
import AdmZip from "adm-zip";
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildMcpServerConfig,
  installMcpFromMarketplace,
  readRuntimeFromInstalledManifest,
  readRuntimeFromVerifiedZip,
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

describe("readRuntimeFromVerifiedZip", () => {
  function zipWithPluginJson(content: Buffer | string): Buffer {
    const zip = new AdmZip();
    zip.addFile("plugin.json", Buffer.isBuffer(content) ? content : Buffer.from(content, "utf-8"));
    return zip.toBuffer();
  }

  it("reads runtime from the verified zip before extraction", () => {
    const zip = zipWithPluginJson(JSON.stringify({
      id: "weather",
      version: "1.0.0",
      runtime: { transport: "stdio", command: "node", args: ["server.js"] },
    }));
    expect(readRuntimeFromVerifiedZip("weather", zip)).toEqual({
      transport: "stdio",
      command: "node",
      args: ["server.js"],
    });
  });

  it("throws when the verified zip has no root plugin.json", () => {
    const zip = new AdmZip();
    zip.addFile("nested/plugin.json", Buffer.from("{}"));
    expect(() => readRuntimeFromVerifiedZip("weather", zip.toBuffer())).toThrow(
      /manifest not found/,
    );
  });

  it("enforces the manifest byte cap before extraction", () => {
    const zip = zipWithPluginJson(Buffer.alloc(MAX_MCP_MANIFEST_BYTES + 1, "x"));
    expect(() => readRuntimeFromVerifiedZip("weather", zip)).toThrow(/byte cap/);
  });
});

describe("installMcpFromMarketplace", () => {
  function makeMcpZip(manifest: Record<string, unknown>): Buffer {
    const zip = new AdmZip();
    zip.addFile("plugin.json", Buffer.from(JSON.stringify(manifest), "utf-8"));
    return zip.toBuffer();
  }

  function defaultManifest(): Record<string, unknown> {
    return {
      id: "weather",
      version: "1.0.0",
      runtime: {
        transport: "stdio",
        command: "$NODE",
        args: ["$PLUGIN_DIR/dist/server.js"],
        auth: "none",
      },
    };
  }

  function makeStubStore(
    installDir: string,
    manifest: Record<string, unknown> = defaultManifest(),
  ): PluginArtifactStore {
    return {
      installDirFor: vi.fn(() => installDir),
      downloadVerifiedZip: vi.fn(async () => makeMcpZip(manifest)),
      extractZip: vi.fn(async () => []),
      extractZipWithCommit: vi.fn(async (_slug, _zip, commit) => ({
        files: [],
        result: await commit(installDir, []),
      })),
      appendHistory: vi.fn(async () => undefined),
    } as unknown as PluginArtifactStore;
  }

  function makeRegisterConfig() {
    return vi.fn(async () => ({ connected: true }));
  }

  function makeStubFetcher(detail: PluginMarketplaceItem | null): MarketplaceFetcher {
    return {
      listPlugins: vi.fn(async () => []),
      getPluginDetail: vi.fn(async () => detail),
      downloadVersion: vi.fn(async () => ({ zipBuffer: Buffer.alloc(0), sha256: "x" })),
      listAnnouncements: vi.fn(async () => []),
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
      await expect(installMcpFromMarketplace("regular-plugin", {
        fetcher,
        store,
        registerConfig: makeRegisterConfig(),
      })).rejects.toThrow(
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
      await expect(installMcpFromMarketplace("does-not-exist", {
        fetcher,
        store,
        registerConfig: makeRegisterConfig(),
      })).rejects.toThrow(
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
      const store = makeStubStore(tmp, {
          id: "weather",
          version: "1.0.0",
          runtime: {
            transport: "stdio",
            command: "$NODE",
            args: ["$PLUGIN_DIR/dist/server.js"],
            auth: "api-key",
          },
      });
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
      const registerConfig = makeRegisterConfig();
      const result = await installMcpFromMarketplace("weather", {
        fetcher,
        store,
        nodePath: "/usr/bin/node",
        pythonPath: "/usr/bin/python3",
        registerConfig,
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
      expect(result.connected).toBe(true);
      expect(registerConfig).toHaveBeenCalledWith(result.config);
      expect(store.appendHistory).toHaveBeenCalledWith(
        "weather",
        expect.objectContaining({ version: "1.0.0" }),
      );
      expect(store.extractZipWithCommit).toHaveBeenCalledWith(
        "weather",
        expect.any(Buffer),
        expect.any(Function),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects $PYTHON runtime tokens unless the caller provides an explicit interpreter", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      const store = makeStubStore(tmp, {
          id: "python-mcp",
          version: "1.0.0",
          runtime: {
            transport: "stdio",
            command: "$PYTHON",
            args: ["server.py"],
            auth: "none",
          },
      });
      const fetcher = makeStubFetcher({
        id: "python-mcp",
        name: "Python MCP",
        description: "",
        packageSpec: "python-mcp@1.0.0",
        packageName: "python-mcp",
        tools: [],
        version: "1.0.0",
        pluginType: "mcp",
      });

      const registerConfig = makeRegisterConfig();
      await expect(installMcpFromMarketplace("python-mcp", {
        fetcher,
        store,
        registerConfig,
      })).rejects.toThrow(
        /does not provide an app-global Python runtime/,
      );
      expect(store.extractZipWithCommit).not.toHaveBeenCalled();
      expect(registerConfig).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unsafe slugs before marketplace lookup", async () => {
    const tmp = makeTmpDir();
    try {
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
      await expect(installMcpFromMarketplace("../weather", {
        fetcher,
        store,
        registerConfig: makeRegisterConfig(),
      })).rejects.toThrow(
        /invalid artifact slug/,
      );
      expect(fetcher.getPluginDetail).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects unpinned marketplace uvx runtimes before extraction", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStubStore(tmp, {
        id: "browser-use",
        version: "0.12.6",
        runtime: {
          transport: "stdio",
          command: "uvx",
          args: ["--from", "browser-use[cli]", "browser-use", "--mcp"],
          auth: "api-key",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      });
      const fetcher = makeStubFetcher({
        id: "browser-use",
        name: "Browser Use MCP",
        description: "",
        packageSpec: "browser-use[cli]==0.12.6",
        packageName: "browser-use",
        tools: [],
        version: "0.12.6",
        pluginType: "mcp",
      });

      const registerConfig = makeRegisterConfig();
      await expect(installMcpFromMarketplace("browser-use", {
        fetcher,
        store,
        registerConfig,
      })).rejects.toThrow(
        /must pin the executed package/,
      );
      expect(store.extractZipWithCommit).not.toHaveBeenCalled();
      expect(registerConfig).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects malformed uvx exact pins before extraction", async () => {
    for (const packageSpec of ["==0.12.6", "browser-use>=0.1==0.2"]) {
      const tmp = makeTmpDir();
      try {
        const store = makeStubStore(tmp, {
          id: "browser-use",
          version: "0.12.6",
          runtime: {
            transport: "stdio",
            command: "uvx",
            args: ["--from", packageSpec, "browser-use", "--mcp"],
            auth: "api-key",
            apiKeyEnv: "OPENAI_API_KEY",
          },
        });
        const fetcher = makeStubFetcher({
          id: "browser-use",
          name: "Browser Use MCP",
          description: "",
          packageSpec,
          packageName: "browser-use",
          tools: [],
          version: "0.12.6",
          pluginType: "mcp",
        });
        await expect(installMcpFromMarketplace("browser-use", {
          fetcher,
          store,
          registerConfig: makeRegisterConfig(),
        })).rejects.toThrow(/must pin the executed package/);
        expect(store.extractZipWithCommit).not.toHaveBeenCalled();
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("accepts exact-pinned marketplace uvx runtimes", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStubStore(tmp, {
        id: "browser-use",
        version: "0.12.6",
        runtime: {
          transport: "stdio",
          command: "uvx",
          args: ["--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
          auth: "api-key",
          apiKeyEnv: "OPENAI_API_KEY",
        },
      });
      const fetcher = makeStubFetcher({
        id: "browser-use",
        name: "Browser Use MCP",
        description: "",
        packageSpec: "browser-use[cli]==0.12.6",
        packageName: "browser-use",
        tools: [],
        version: "0.12.6",
        pluginType: "mcp",
      });

      await expect(installMcpFromMarketplace("browser-use", {
        fetcher,
        store,
        registerConfig: makeRegisterConfig(),
      })).resolves.toMatchObject({
        config: {
          id: "browser-use",
          command: "uvx",
          args: ["--from", "browser-use[cli]==0.12.6", "browser-use", "--mcp"],
        },
      });
      expect(store.extractZipWithCommit).toHaveBeenCalledWith(
        "browser-use",
        expect.any(Buffer),
        expect.any(Function),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does not record history when config registration fails after extraction promotion", async () => {
    const tmp = makeTmpDir();
    try {
      const store = makeStubStore(tmp);
      const registerConfig = vi.fn(async () => {
        throw new Error("duplicate MCP id");
      });
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

      await expect(installMcpFromMarketplace("weather", {
        fetcher,
        store,
        registerConfig,
      })).rejects.toThrow(/duplicate MCP id/);
      expect(store.appendHistory).not.toHaveBeenCalled();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("end-to-end: preserves MCP OAuth login metadata from the verified package", async () => {
    const tmp = makeTmpDir();
    try {
      await mkdir(tmp, { recursive: true });
      const store = makeStubStore(tmp, {
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
      });
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
      const result = await installMcpFromMarketplace("remote-docs", {
        fetcher,
        store,
        registerConfig: makeRegisterConfig(),
      });

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

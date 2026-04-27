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
});

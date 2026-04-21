import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdmZip from "adm-zip";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { PluginMarketplaceService } from "../marketplace.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";
import type { PluginMarketplaceItem } from "../types.js";

function makePluginZip(manifest: Record<string, unknown>): Buffer {
  const zip = new AdmZip();
  zip.addFile("plugin.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8"));
  zip.addFile(
    "dist/hostPlugin.js",
    Buffer.from("export default async function createPlugin() { return { handlers: {} }; }\n", "utf-8"),
  );
  return zip.toBuffer();
}

describe("PluginMarketplaceService install()", () => {
  let testDir: string;
  let appRoot: string;
  let registryPath: string;
  let installedDir: string;
  let cacheRoot: string;

  beforeEach(async () => {
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-marketplace-install-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    appRoot = testDir;
    registryPath = join(appRoot, "plugins", "registry.json");
    installedDir = join(appRoot, "plugins", "installed");
    cacheRoot = join(appRoot, ".cache");
    await mkdir(installedDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
  });

  function manifestPathToAbs(manifestPath: string): string {
    return isAbsolute(manifestPath)
      ? manifestPath
      : resolve(appRoot, "plugins", manifestPath);
  }

  function makeService(fetcher: MarketplaceFetcher) {
    const service = new PluginMarketplaceService(appRoot, undefined, fetcher, cacheRoot);
    (
      service as unknown as {
        installedDir: string;
      }
    ).installedDir = installedDir;

    const npmInstallMock = vi.fn(async () => {});
    (service as unknown as { runNpmInstall: typeof npmInstallMock }).runNpmInstall = npmInstallMock;

    return { service, npmInstallMock };
  }

  it("downloads and extracts a marketplace zip without using npm", async () => {
    const plugin: PluginMarketplaceItem = {
      id: "test-plugin",
      slug: "test-plugin",
      name: "Test Plugin",
      description: "A test plugin",
      version: "1.2.3",
      packageSpec: "@lvis/test-plugin@1.2.3",
      packageName: "@lvis/test-plugin",
      tools: ["ping"],
    };
    const downloadVersion = vi.fn(async () => ({
      zipBuffer: makePluginZip({
        id: plugin.id,
        name: plugin.name,
        version: plugin.version,
        entry: "./dist/hostPlugin.js",
        tools: plugin.tools,
      }),
      sha256: "deadbeef",
    }));
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion,
    };

    const { service, npmInstallMock } = makeService(fetcher);
    await expect(service.install("test-plugin")).resolves.toEqual({
      pluginId: "test-plugin",
      installed: true,
    });

    expect(downloadVersion).toHaveBeenCalledWith("test-plugin", "1.2.3");
    expect(npmInstallMock).not.toHaveBeenCalled();

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ manifestPath: string }>;
    };
    const manifest = JSON.parse(
      await readFile(manifestPathToAbs(registry.plugins[0].manifestPath), "utf-8"),
    ) as { version: string; entry: string };
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.entry).toBe("./dist/hostPlugin.js");
  });

  it("uses the local file install path for file: package specs", async () => {
    const localPackageDir = join(appRoot, "fixtures", "local-plugin");
    await mkdir(localPackageDir, { recursive: true });
    await mkdir(join(appRoot, "node_modules", "@lvis", "local-plugin", "dist"), { recursive: true });
    await writeFile(
      join(appRoot, "node_modules", "@lvis", "local-plugin", "dist", "hostPlugin.js"),
      "export default async function createPlugin() { return { handlers: {} }; }\n",
      "utf-8",
    );

    const plugin: PluginMarketplaceItem = {
      id: "local-plugin",
      name: "Local Plugin",
      description: "A local plugin",
      version: "0.2.0",
      packageSpec: "file:fixtures/local-plugin",
      packageName: "@lvis/local-plugin",
      tools: [],
    };
    const downloadVersion = vi.fn(async () => {
      throw new Error("downloadVersion should not be called for file: installs");
    });
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion,
    };

    const { service, npmInstallMock } = makeService(fetcher);
    await expect(service.install("local-plugin")).resolves.toEqual({
      pluginId: "local-plugin",
      installed: true,
    });

    expect(downloadVersion).not.toHaveBeenCalled();
    expect(npmInstallMock).toHaveBeenCalledOnce();
    expect(npmInstallMock.mock.calls[0][0]).toMatch(/^file:/);

    const registry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ manifestPath: string }>;
    };
    const manifest = JSON.parse(
      await readFile(manifestPathToAbs(registry.plugins[0].manifestPath), "utf-8"),
    ) as { version: string; packageName: string };
    expect(manifest.version).toBe("0.2.0");
    expect(manifest.packageName).toBe("@lvis/local-plugin");
  });

  it("surfaces zip extraction errors instead of silently falling back", async () => {
    const plugin: PluginMarketplaceItem = {
      id: "broken-plugin",
      slug: "broken-plugin",
      name: "Broken Plugin",
      description: "Broken zip payload",
      version: "0.0.1",
      packageSpec: "@lvis/broken-plugin@0.0.1",
      packageName: "@lvis/broken-plugin",
      tools: [],
    };
    const fetcher: MarketplaceFetcher = {
      listPlugins: async () => [plugin],
      getPluginDetail: async () => plugin,
      downloadVersion: async () => ({
        zipBuffer: Buffer.from("not-a-zip"),
        sha256: "badzip",
      }),
    };

    const { service, npmInstallMock } = makeService(fetcher);
    await expect(service.install("broken-plugin")).rejects.toThrow(/zip format/i);
    expect(npmInstallMock).not.toHaveBeenCalled();
  });
});

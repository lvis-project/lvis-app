import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginMarketplaceService, type MarketplaceFetcher } from "../marketplace.js";
import {
  makeTestPluginPaths,
  writeTestPlugin,
  writeTestPluginRegistry,
} from "./test-helpers.js";

function makeUnusedFetcher(): MarketplaceFetcher {
  return {
    listPlugins: async () => [],
    getPluginDetail: async () => null,
    downloadVersion: async () => {
      throw new Error("unused");
    },
  };
}

describe("PluginMarketplaceService.quarantinePlugin", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes the registry entry so a rejected artifact cannot load on next boot", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "lvis-mp-quarantine-"));
    roots.push(rootDir);
    const paths = makeTestPluginPaths({ rootDir });
    const fixture = {
      rootDir,
      pluginsRoot: paths.pluginsRoot,
      registryPath: paths.registryPath,
    };
    const written = await writeTestPlugin(fixture, { id: "meeting" });
    await writeTestPluginRegistry(fixture, [
      { id: "meeting", manifestPath: written.manifestPath, enabled: true },
    ]);
    const service = new PluginMarketplaceService(paths, makeUnusedFetcher());

    await expect(service.quarantinePlugin("meeting", "version mismatch")).resolves.toEqual({
      pluginId: "meeting",
      quarantined: true,
    });

    const registry = JSON.parse(await readFile(paths.registryPath, "utf-8")) as {
      plugins: Array<{ id: string }>;
    };
    expect(registry.plugins).toEqual([]);
    expect(existsSync(written.pluginDir)).toBe(false);
  });
});

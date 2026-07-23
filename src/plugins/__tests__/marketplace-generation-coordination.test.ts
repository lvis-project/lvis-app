import { existsSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginMarketplaceService } from "../marketplace.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";
import { makeTestPluginPaths } from "./test-helpers.js";

describe("PluginMarketplaceService generation coordination boundary", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, {
      recursive: true,
      force: true,
    })));
  });

  it.each([
    ["marketplace install", (service: PluginMarketplaceService) =>
      (service.install as unknown as (pluginId: string) => Promise<unknown>)("acme")],
    ["managed marketplace install", (service: PluginMarketplaceService) =>
      (service.ensureManagedInstalled as unknown as () => Promise<unknown>)()],
    ["versioned marketplace install", (service: PluginMarketplaceService) =>
      (service.installPlugin as unknown as (
        pluginId: string,
        version: string,
      ) => Promise<unknown>)("acme", "1.0.0")],
    ["marketplace rollback", (service: PluginMarketplaceService) =>
      (service.rollbackPlugin as unknown as (pluginId: string) => Promise<unknown>)("acme")],
    ["local plugin install", (service: PluginMarketplaceService) =>
      (service.installLocal as unknown as (sourcePath: string) => Promise<unknown>)("/unused")],
  ])("fails closed before %s can touch external or durable state", async (operation, invoke) => {
    const root = mkdtempSync(join(tmpdir(), "lvis-generation-coordination-"));
    roots.push(root);
    const pluginsRoot = join(root, "plugins");
    const fetcher: MarketplaceFetcher = {
      listPlugins: vi.fn(async () => []),
      getPluginDetail: vi.fn(async () => null),
      downloadVersion: vi.fn(async () => {
        throw new Error("unexpected download");
      }),
      listAnnouncements: vi.fn(async () => []),
    };
    const service = new PluginMarketplaceService(
      makeTestPluginPaths({ rootDir: root, pluginsRoot }),
      fetcher,
    );

    await expect(invoke(service)).rejects.toThrow(
      `[plugin-generation] ${operation} requires coordinated generation activation`,
    );
    expect(fetcher.listPlugins).not.toHaveBeenCalled();
    expect(fetcher.getPluginDetail).not.toHaveBeenCalled();
    expect(fetcher.downloadVersion).not.toHaveBeenCalled();
    expect(existsSync(pluginsRoot)).toBe(false);
  });
});

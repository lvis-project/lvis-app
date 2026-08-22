/**
 * The offline-copy setting has to reach the catalog cache, and it has to reach
 * it LIVE.
 *
 * `PluginMarketplaceService` is constructed once at boot. If it captured the
 * value instead of the accessor, turning the setting off in Settings would do
 * nothing until the next launch — which is the same "the switch exists but has
 * no effect" failure that made these environment-only flags worth surfacing in
 * the first place. So the test flips the answer between two `list()` calls on
 * ONE service and checks that the second call went to the network.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginMarketplaceService, type MarketplaceFetcher } from "../marketplace.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { makeTestPluginPaths, writeTestPluginRegistry } from "./test-helpers.js";

function makeCountingFetcher(): MarketplaceFetcher & { calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    listPlugins: async () => {
      calls += 1;
      return [];
    },
    getPluginDetail: async () => null,
    downloadVersion: async () => {
      throw new Error("unused");
    },
    listAnnouncements: async () => [],
  };
}

describe("PluginMarketplaceService catalog cache honours the setting", () => {
  const roots: string[] = [];

  afterEach(async () => {
    for (const root of roots.splice(0)) {
      await cleanupTmpDir(root);
    }
  });

  it("re-reads the accessor per call instead of capturing it at construction", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "lvis-mp-cache-setting-"));
    roots.push(rootDir);
    const paths = makeTestPluginPaths({ rootDir });
    await writeTestPluginRegistry({ registryPath: paths.registryPath }, []);
    const fetcher = makeCountingFetcher();
    let enabled = true;
    const service = new PluginMarketplaceService(
      paths,
      fetcher,
      undefined,
      undefined,
      () => enabled,
    );

    // First call populates the cache; second call is served from it.
    await service.list();
    await service.list();
    expect(fetcher.calls()).toBe(1);

    // The user turns the offline copy off. The cache file is still on disk —
    // the point is that it must stop being read.
    enabled = false;
    await service.list();
    expect(fetcher.calls()).toBe(2);
  });
});

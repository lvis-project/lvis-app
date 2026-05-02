/**
 * Issue #468 — marketplace install must supersede a pre-existing dev-link
 * registry entry, even when the source plugin.json (resolved through the
 * dev-link symlink) reports the same version as the catalog.
 *
 * Without the fix in `install()`, a dev-link plugin whose source has been
 * bumped to match catalog (post-backfill) would silently no-op:
 *  - `getInstalledVersion()` follows the `plugin.json` symlink → returns the
 *    catalog version → `isSameVersion === true`
 *  - `touchInstalledRegistryEntry()` keeps `installSource: "dev-link"` because
 *    of its `?? "user"` fallback
 *  - Disk stays symlinked, registry stays dev-link
 *  - Post-install `addPlugin()` then trips the trust check ("untrusted
 *    registry manifest path") and silently fails
 *
 * The fix forces a full re-install (zip extraction) when the existing entry
 * is dev-link, regardless of version match.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockMarketplaceFetcher, PluginMarketplaceService } from "../marketplace.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";

function makeService(testDir: string, marketplacePath: string): PluginMarketplaceService {
  const paths = makeTestPluginPaths({ rootDir: testDir });
  const fetcher = new MockMarketplaceFetcher(marketplacePath);
  return new PluginMarketplaceService(paths, fetcher);
}

describe("PluginMarketplaceService — dev-link supersede on marketplace install (#468)", () => {
  let testDir: string;
  let pluginsDir: string;
  let registryPath: string;
  let marketplacePath: string;

  beforeEach(async () => {
    setIsPackaged(false);
    process.env.LVIS_DEV = "1";
    testDir = join(tmpdir(), `lvis-supersede-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    pluginsDir = join(testDir, "plugins");
    registryPath = join(pluginsDir, "registry.json");
    marketplacePath = join(testDir, "marketplace.json");
    await mkdir(pluginsDir, { recursive: true });
  });

  afterEach(async () => {
    delete process.env.LVIS_DEV;
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
    _resetForTest();
  });

  it("forces full re-install when an existing dev-link entry matches catalog version", async () => {
    // Catalog reports v0.1.15 for pageindex.
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pageindex",
            name: "Pageindex",
            description: "fixture",
            version: "0.1.15",
            installPolicy: "user",
          },
        ],
      }),
      "utf-8",
    );

    // Pre-populate registry as if a dev-link install had happened: same
    // version as the catalog (0.1.15) — this is the post-backfill state that
    // tripped issue #468 in practice.
    const installRoot = join(pluginsDir, "pageindex");
    await mkdir(installRoot, { recursive: true });
    const installedManifestPath = join(installRoot, "plugin.json");
    await writeFile(
      installedManifestPath,
      JSON.stringify({
        id: "pageindex",
        name: "Pageindex",
        version: "0.1.15",
        entry: "dist/index.js",
        tools: [],
        description: "fixture",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pageindex",
            manifestPath: "pageindex/plugin.json",
            enabled: true,
            installSource: "dev-link",
          },
        ],
      }),
      "utf-8",
    );

    const service = makeService(testDir, marketplacePath);

    // Spy: distinguishes "took the no-op early-exit" (touch) from "ran the
    // full re-install" (installArtifact). The fix routes dev-link to the
    // latter.
    const touchSpy = vi.spyOn(
      service as unknown as { touchInstalledRegistryEntry: (...args: unknown[]) => Promise<void> },
      "touchInstalledRegistryEntry",
    );
    const installSpy = vi
      .spyOn(
        service as unknown as { installArtifact: (...args: unknown[]) => Promise<string> },
        "installArtifact",
      )
      .mockResolvedValue(installedManifestPath);
    vi
      .spyOn(
        (service as unknown as { artifactStore: { cacheVersionFromManifest: (...args: unknown[]) => Promise<void> } })
          .artifactStore,
        "cacheVersionFromManifest",
      )
      .mockResolvedValue();

    await service.install("pageindex", "user");

    // Forced full re-install — installArtifact must run, no-op early-exit
    // must NOT have fired.
    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(touchSpy).not.toHaveBeenCalled();

    // Registry entry must be promoted from dev-link → user so the next
    // boot's trust check accepts the (now-extracted, real) install path.
    const finalRegistry = JSON.parse(await readFile(registryPath, "utf-8")) as {
      plugins: Array<{ id: string; installSource?: string }>;
    };
    const entry = finalRegistry.plugins.find((p) => p.id === "pageindex");
    expect(entry?.installSource).toBe("user");
  });

  it("forces full re-install for legacy registry entries with _devLinked=true and no installSource", async () => {
    // Pre-PR #430 dev-link entries can have `_devLinked: true` without an
    // `installSource` field. readPluginRegistry migrates them to
    // installSource="dev-link" on first read; this test asserts the
    // supersede guard accepts the migrated shape.
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pageindex",
            name: "Pageindex",
            description: "fixture",
            version: "0.1.15",
            installPolicy: "user",
          },
        ],
      }),
      "utf-8",
    );

    const installRoot = join(pluginsDir, "pageindex");
    await mkdir(installRoot, { recursive: true });
    const installedManifestPath = join(installRoot, "plugin.json");
    await writeFile(
      installedManifestPath,
      JSON.stringify({
        id: "pageindex",
        name: "Pageindex",
        version: "0.1.15",
        entry: "dist/index.js",
        tools: [],
        description: "fixture",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pageindex",
            manifestPath: "pageindex/plugin.json",
            enabled: true,
            installedBy: "user",
            // installSource omitted — legacy shape from before PR #430
            _devLinked: true,
          },
        ],
      }),
      "utf-8",
    );

    const service = makeService(testDir, marketplacePath);

    const touchSpy = vi.spyOn(
      service as unknown as { touchInstalledRegistryEntry: (...args: unknown[]) => Promise<void> },
      "touchInstalledRegistryEntry",
    );
    const installSpy = vi
      .spyOn(
        service as unknown as { installArtifact: (...args: unknown[]) => Promise<string> },
        "installArtifact",
      )
      .mockResolvedValue(installedManifestPath);
    vi
      .spyOn(
        (service as unknown as { artifactStore: { cacheVersionFromManifest: (...args: unknown[]) => Promise<void> } })
          .artifactStore,
        "cacheVersionFromManifest",
      )
      .mockResolvedValue();

    await service.install("pageindex", "user");

    expect(installSpy).toHaveBeenCalledTimes(1);
    expect(touchSpy).not.toHaveBeenCalled();
  });

  it("preserves the no-op early-exit for non-dev-link entries with matching version", async () => {
    // Same catalog as above.
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pageindex",
            name: "Pageindex",
            description: "fixture",
            version: "0.1.15",
            installPolicy: "user",
          },
        ],
      }),
      "utf-8",
    );

    const installRoot = join(pluginsDir, "pageindex");
    await mkdir(installRoot, { recursive: true });
    await writeFile(
      join(installRoot, "plugin.json"),
      JSON.stringify({
        id: "pageindex",
        name: "Pageindex",
        version: "0.1.15",
        entry: "dist/index.js",
        tools: [],
        description: "fixture",
      }),
      "utf-8",
    );
    // Existing entry is a regular user install (not dev-link).
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pageindex",
            manifestPath: "pageindex/plugin.json",
            enabled: true,
            installSource: "user",
          },
        ],
      }),
      "utf-8",
    );

    const service = makeService(testDir, marketplacePath);

    const touchSpy = vi.spyOn(
      service as unknown as { touchInstalledRegistryEntry: (...args: unknown[]) => Promise<void> },
      "touchInstalledRegistryEntry",
    );
    const installSpy = vi.spyOn(
      service as unknown as { installArtifact: (...args: unknown[]) => Promise<string> },
      "installArtifact",
    );

    await service.install("pageindex", "user");

    // Idempotency preserved: same-version user install is a touch-only no-op.
    expect(touchSpy).toHaveBeenCalledTimes(1);
    expect(installSpy).not.toHaveBeenCalled();
  });

  // Issue #472 — touch invariant. PR #470's `isDevLinkSupersede` guard
  // ensures touchInstalledRegistryEntry is never called on a dev-link
  // entry, but if a future caller bypasses the guard, the touch path's
  // `?? "user"` fallback would silently preserve `installSource:
  // "dev-link"` — same root cause as #468. The throw makes that
  // invariant violation loud rather than silent.
  it("throws when called directly on a dev-link entry (defense-in-depth)", async () => {
    await writeFile(
      marketplacePath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pageindex",
            manifestPath: "pageindex/plugin.json",
            enabled: true,
            installedBy: "user",
            installSource: "dev-link",
            _devLinked: true,
          },
        ],
      }),
      "utf-8",
    );

    const service = makeService(testDir, marketplacePath);
    const touch = (
      service as unknown as {
        touchInstalledRegistryEntry: (
          pluginId: string,
          bundleRootId: string | null,
          actor: "user" | "it-admin",
          approvedPluginAccess: unknown,
        ) => Promise<void>;
      }
    ).touchInstalledRegistryEntry.bind(service);

    await expect(touch("pageindex", null, "user", undefined)).rejects.toThrow(
      /touchInstalledRegistryEntry called on dev-link entry/,
    );
  });

  // Legacy pre-PR #430 shape (`_devLinked: true` only, no `installSource`)
  // is migrated to `installSource: "dev-link"` by `readPluginRegistry`'s
  // `migrateLegacyEntry` before any registry mutation reaches
  // `touchInstalledRegistryEntry`, so the modern-shape assertion above
  // covers both. No separate legacy-shape test needed.
});

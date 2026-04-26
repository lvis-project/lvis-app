/**
 * Phase 2b-1 — `installArtifact` packaged-build gate.
 *
 * Locks Security H-2 + Architect B1: packaged builds must refuse the
 * file:-spec / npm-install branch and only install via the signed-zip
 * download path. The branch is preserved for `LVIS_DEV_LINKED=1`-style
 * dev workflows where engineers iterate on a sibling-repo plugin
 * without going through the marketplace.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MockMarketplaceFetcher, PluginMarketplaceService } from "../marketplace.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";

describe("install() — packaged-build gate (Phase 2b-1)", () => {
  let testDir: string;
  let pluginsDir: string;
  let registryPath: string;
  let marketplacePath: string;

  beforeEach(async () => {
    setIsPackaged(false);
    testDir = join(
      homedir(),
      ".lvis",
      "test-tmp",
      `lvis-pkg-gate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    pluginsDir = join(testDir, "plugins");
    registryPath = join(pluginsDir, "registry.json");
    marketplacePath = join(testDir, "marketplace.json");
    await mkdir(pluginsDir, { recursive: true });
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
    await writeFile(
      marketplacePath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "demo-plugin",
            name: "Demo",
            description: "fixture",
            packageSpec: "file:../lvis-plugin-demo",
            packageName: "@lvis/plugin-demo",
            tools: [],
            installPolicy: "user",
          },
        ],
      }),
      "utf-8",
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(testDir, { recursive: true, force: true });
    _resetForTest();
  });

  function makeService(): PluginMarketplaceService {
    const fetcher = new MockMarketplaceFetcher(marketplacePath);
    const paths = makeTestPluginPaths({ rootDir: testDir });
    return new PluginMarketplaceService(testDir, paths, fetcher);
  }

  it("file:-spec install in dev unpackaged passes the gate (npm runs)", async () => {
    // dev-flags is configured `setIsPackaged(false)` above, but we also need
    // an opt-in env. Simulate `LVIS_DEV_LINKED=1` via the dev-flag the
    // helper recognises.
    const origDev = process.env.LVIS_DEV;
    const origLinked = process.env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY;
    process.env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY = "1";

    const svc = makeService();
    // Stub runNpmInstall so we don't actually spawn npm; we only care that
    // the gate let us *reach* it. installArtifact then calls
    // writeInstalledManifest which references appRoot/node_modules — which
    // doesn't exist in tmp, so it throws AFTER passing the security gate.
    // That's fine; we assert the gate-specific message is NOT present.
    vi.spyOn(svc as unknown as { runNpmInstall: (s: string) => Promise<void> }, "runNpmInstall")
      .mockResolvedValue();

    let caught: Error | null = null;
    try {
      await svc.install("demo-plugin");
    } catch (e) {
      caught = e as Error;
    }
    if (origDev === undefined) delete process.env.LVIS_DEV;
    else process.env.LVIS_DEV = origDev;
    if (origLinked === undefined) delete process.env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY;
    else process.env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY = origLinked;

    // Gate must NOT have rejected. Other downstream errors (e.g. node_modules
    // not present) are acceptable — Phase 2b-2 removes that dependency.
    if (caught) {
      expect(caught.message).not.toMatch(/file:-spec install .* is dev-only/);
    }
  });

  it("file:-spec install in unpackaged dev WITHOUT LVIS_DEV* env is rejected", async () => {
    // Default vitest run has neither LVIS_DEV nor LVIS_ALLOW_LINKED_PLUGIN_ENTRY.
    delete process.env.LVIS_DEV;
    delete process.env.LVIS_ALLOW_LINKED_PLUGIN_ENTRY;
    const svc = makeService();
    await expect(svc.install("demo-plugin")).rejects.toThrow(
      /file:-spec install .* is dev-only/,
    );
  });

  it("file:-spec install in packaged build is rejected", async () => {
    setIsPackaged(true);
    // MockMarketplaceFetcher itself refuses to construct in packaged builds
    // (Track A H-1 gate). Use a constructor-bypassed instance to exercise
    // the install-side gate specifically.
    const fetcher = Object.create(MockMarketplaceFetcher.prototype) as MockMarketplaceFetcher;
    Object.assign(fetcher, { marketplacePath });
    const paths = makeTestPluginPaths({ rootDir: testDir });
    const svc = new PluginMarketplaceService(testDir, paths, fetcher);

    await expect(svc.install("demo-plugin")).rejects.toThrow(
      /file:-spec install .* is dev-only/,
    );
  });

  it("runNpmInstall called in packaged build throws marketplace install must be signed", async () => {
    // Direct probe: even if some future refactor invokes runNpmInstall
    // outside installArtifact, the defense-in-depth assertion fires.
    setIsPackaged(true);
    const fetcher = Object.create(MockMarketplaceFetcher.prototype) as MockMarketplaceFetcher;
    Object.assign(fetcher, { marketplacePath });
    const paths = makeTestPluginPaths({ rootDir: testDir });
    const svc = new PluginMarketplaceService(testDir, paths, fetcher);

    const runNpm = (svc as unknown as { runNpmInstall: (s: string) => Promise<void> }).runNpmInstall;
    await expect(runNpm.call(svc, "@lvis/demo@1.0.0")).rejects.toThrow(
      /runNpmInstall is dev-only/,
    );
  });
});

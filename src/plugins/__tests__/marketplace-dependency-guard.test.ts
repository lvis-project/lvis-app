/**
 * S14 — marketplace install preflight: MissingDependenciesError is thrown
 * when required capabilities are not met by installed plugins.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import {resolve, join} from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { PluginMarketplaceService } from "../marketplace.js";
import type { PluginMarketplaceItem } from "../types.js";
import { MissingDependenciesError } from "../types.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginPaths } from "./test-helpers.js";
import { mkdtempSync } from "node:fs";

// Minimal in-memory fetcher
class StubFetcher {
  constructor(private items: PluginMarketplaceItem[]) {}
  async listPlugins() {
    return this.items;
  }
  async getPluginDetail(id: string) {
    return this.items.find((p) => p.id === id) ?? null;
  }
  async downloadVersion(_slug: string, _version: string) {
    throw new Error("not implemented");
  }
}

function makeItem(
  id: string,
  requiresCaps: string[] = [],
): PluginMarketplaceItem {
  return {
    id,
    name: id,
    description: "",
    packageSpec: `@lvis/${id}@1.0.0`,
    packageName: `@lvis/${id}`,
    tools: [],
    requires: requiresCaps.length > 0 ? { capabilities: requiresCaps } : undefined
  };
}

async function setupTestDir(
  dir: string,
  installedPlugins: Array<{ id: string; capabilities: string[] }>,
): Promise<string> {
  // PluginMarketplaceService expects the registry at `<appRoot>/plugins/registry.json`
  // (see constructor: `resolve(this.appRoot, "plugins/registry.json")`). Writing it
  // anywhere else means the service sees an empty registry and the test's
  // installed-manifest fixtures are invisible to the dependency resolver.
  const pluginsRoot = resolve(dir, "plugins");
  const registryPath = resolve(pluginsRoot, "registry.json");
  const pluginsInstalledDir = resolve(pluginsRoot, "installed");
  await mkdir(pluginsInstalledDir, { recursive: true });

  const registryEntries: Array<{ id: string; manifestPath: string; enabled: boolean }> = [];

  for (const p of installedPlugins) {
    const manifestDir = resolve(pluginsInstalledDir, p.id);
    await mkdir(manifestDir, { recursive: true });
    const manifestPath = resolve(manifestDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: p.id,
        name: p.id,
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
        description: "Test fixture.",
        capabilities: p.capabilities
      }),
    );
    // Registry manifestPath is relative to `plugins/` (the registry's parent dir).
    registryEntries.push({
      id: p.id,
      manifestPath: `installed/${p.id}/plugin.json`,
      enabled: true
    });
  }

  await writeFile(
    registryPath,
    JSON.stringify({ version: 1, plugins: registryEntries }),
  );

  return registryPath;
}

describe("marketplace install dependency guard (S14)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    setIsPackaged(false);
    tmpDir = mkdtempSync(join(tmpdir(), "lvis-test-"));
    await mkdir(tmpDir, { recursive: true });
    // Phase 2-final: stub the install pipeline so dep-guard tests don't try
    // to actually fetch / extract a zip. The dep-guard branch fires *before*
    // installArtifact, so its outcome is fully observable from a stub that
    // just records what it would have installed.
    vi.spyOn(
      PluginMarketplaceService.prototype as unknown as {
        installArtifact: (...args: unknown[]) => Promise<string>;
      },
      "installArtifact",
    ).mockResolvedValue("stub/plugin.json");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
    _resetForTest();
  });

  function makeService(
    fetcher: StubFetcher,
  ): PluginMarketplaceService {
    return new PluginMarketplaceService(
      makeTestPluginPaths({ rootDir: tmpDir }),
      fetcher as unknown as import("../marketplace-fetcher.js").MarketplaceFetcher,
    );
  }

  it("install succeeds when plugin has no requires", async () => {
    const item = makeItem("simple-plugin");
    const fetcher = new StubFetcher([item]);
    await setupTestDir(tmpDir, []);

    const svc = makeService(fetcher);

    // Should NOT throw MissingDependenciesError (it will fail later on npm install, which is fine)
    let threw: Error | null = null;
    try {
      await svc.install("simple-plugin");
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).not.toBeInstanceOf(MissingDependenciesError);
  });

  it("install throws MissingDependenciesError when required cap is absent", async () => {
    const item = makeItem("needs-meeting", ["meeting-recorder"]);
    const fetcher = new StubFetcher([item]);

    await mkdir(resolve(tmpDir, "plugins"), { recursive: true });
    await writeFile(
      resolve(tmpDir, "plugins", "registry.json"),
      JSON.stringify({ version: 1, plugins: [] }),
    );

    const svc = makeService(fetcher);

    await expect(svc.install("needs-meeting")).rejects.toBeInstanceOf(
      MissingDependenciesError,
    );
  });

  it("install throws with correct missing list", async () => {
    const item = makeItem("multi-dep", ["cap-a", "cap-b", "cap-c"]);
    const fetcher = new StubFetcher([item]);

    // Install cap-b provider
    const pluginDir = resolve(tmpDir, "plugins", "installed", "cap-b-provider");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      resolve(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "cap-b-provider",
        name: "B",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
        capabilities: ["cap-b"]
      }),
    );
    await mkdir(resolve(tmpDir, "plugins"), { recursive: true });
    await writeFile(
      resolve(tmpDir, "plugins", "registry.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "cap-b-provider",
            manifestPath: "installed/cap-b-provider/plugin.json",
            enabled: true
          },
        ]
      }),
    );

    const svc = makeService(fetcher);

    let err: MissingDependenciesError | null = null;
    try {
      await svc.install("multi-dep");
    } catch (e) {
      if (e instanceof MissingDependenciesError) err = e;
    }
    expect(err).toBeInstanceOf(MissingDependenciesError);
    expect(err?.missing).toEqual(["cap-a", "cap-c"]);
  });

  it("install proceeds when all required caps are satisfied", async () => {
    const item = makeItem("happy-dep", ["meeting-recorder"]);
    const fetcher = new StubFetcher([item]);

    const pluginDir = resolve(tmpDir, "plugins", "installed", "meeting-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      resolve(pluginDir, "plugin.json"),
      JSON.stringify({
        id: "meeting-plugin",
        name: "Meeting",
        version: "1.0.0",
        entry: "dist/index.js",
        tools: [],
        capabilities: ["meeting-recorder"]
      }),
    );
    await mkdir(resolve(tmpDir, "plugins"), { recursive: true });
    await writeFile(
      resolve(tmpDir, "plugins", "registry.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "meeting-plugin",
            manifestPath: "installed/meeting-plugin/plugin.json",
            enabled: true
          },
        ]
      }),
    );

    const svc = makeService(fetcher);

    let threw: Error | null = null;
    try {
      await svc.install("happy-dep");
    } catch (e) {
      threw = e as Error;
    }
    // Should not throw MissingDependenciesError — may throw npm error which is fine
    expect(threw).not.toBeInstanceOf(MissingDependenciesError);
  });
});

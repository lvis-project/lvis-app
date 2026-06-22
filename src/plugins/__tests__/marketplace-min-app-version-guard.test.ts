/**
 * Plugin↔app minimum-version gate — marketplace install preflight.
 *
 * `IncompatibleAppVersionError` is thrown BEFORE the artifact is downloaded
 * when the plugin declares `requires.minAppVersion` higher than the running
 * LVIS app version. A plugin without the field installs (backward-compat); a
 * plugin whose minAppVersion <= app version installs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { PluginMarketplaceService } from "../marketplace.js";
import type { PluginMarketplaceItem } from "../types.js";
import { IncompatibleAppVersionError, MissingDependenciesError } from "../types.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginMarketplaceService } from "./test-helpers.js";

// The gate reads the running app version through this module — mock it so the
// test controls "current app version" deterministically.
let MOCK_APP_VERSION = "1.4.0";
vi.mock("../../shared/app-version.js", () => ({
  getLvisAppVersion: () => MOCK_APP_VERSION,
  __resetLvisAppVersionCacheForTest: () => {},
}));

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

function makeItem(id: string, minAppVersion?: string): PluginMarketplaceItem {
  return {
    id,
    name: id,
    description: "Test fixture.",
    publisher: "Test fixture",
    packageSpec: `@lvis/${id}@1.0.0`,
    packageName: `@lvis/${id}`,
    tools: [],
    requires: minAppVersion ? { capabilities: [], minAppVersion } : undefined,
  };
}

describe("marketplace install minAppVersion gate", () => {
  let tmpDir: string;

  beforeEach(async () => {
    MOCK_APP_VERSION = "1.4.0";
    setIsPackaged(false);
    tmpDir = mkdtempSync(join(tmpdir(), "lvis-mav-"));
    await mkdir(resolve(tmpDir, "plugins"), { recursive: true });
    await writeFile(
      resolve(tmpDir, "plugins", "registry.json"),
      JSON.stringify({ version: 1, plugins: [] }),
    );
    // Stub the install pipeline — the gate fires before installArtifact, so the
    // compatible-path tests only need to observe that no version error throws.
    vi.spyOn(
      PluginMarketplaceService.prototype as unknown as {
        installArtifact: (plugin: PluginMarketplaceItem) => Promise<string>;
      },
      "installArtifact",
    ).mockImplementation(async (plugin) => {
      const manifestRelPath = `installed/${plugin.id}/plugin.json`;
      const manifestAbsPath = resolve(tmpDir, "plugins", manifestRelPath);
      await mkdir(dirname(manifestAbsPath), { recursive: true });
      await writeFile(
        manifestAbsPath,
        JSON.stringify({
          id: plugin.id,
          name: plugin.name,
          version: "1.0.0",
          entry: "dist/index.js",
          tools: [],
          description: plugin.description,
          publisher: plugin.publisher,
        }),
      );
      return manifestRelPath;
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpDir, { recursive: true, force: true });
    _resetForTest();
  });

  it("installs a plugin without minAppVersion (backward-compat)", async () => {
    const svc = makeTestPluginMarketplaceService(
      tmpDir,
      new StubFetcher([makeItem("plain")]) as never,
    );
    let threw: Error | null = null;
    try {
      await svc.install("plain");
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).not.toBeInstanceOf(IncompatibleAppVersionError);
  });

  it("installs when minAppVersion <= current app version", async () => {
    MOCK_APP_VERSION = "1.4.0";
    const svc = makeTestPluginMarketplaceService(
      tmpDir,
      new StubFetcher([makeItem("compatible", "1.4.0")]) as never,
    );
    let threw: Error | null = null;
    try {
      await svc.install("compatible");
    } catch (e) {
      threw = e as Error;
    }
    expect(threw).not.toBeInstanceOf(IncompatibleAppVersionError);
  });

  it("blocks (throws IncompatibleAppVersionError) when minAppVersion > current app version", async () => {
    MOCK_APP_VERSION = "1.4.0";
    const svc = makeTestPluginMarketplaceService(
      tmpDir,
      new StubFetcher([makeItem("too-new", "1.5.0")]) as never,
    );
    await expect(svc.install("too-new")).rejects.toBeInstanceOf(
      IncompatibleAppVersionError,
    );
  });

  it("carries required/current versions on the thrown error", async () => {
    MOCK_APP_VERSION = "1.2.3";
    const svc = makeTestPluginMarketplaceService(
      tmpDir,
      new StubFetcher([makeItem("too-new", "2.0.0")]) as never,
    );
    let err: IncompatibleAppVersionError | null = null;
    try {
      await svc.install("too-new");
    } catch (e) {
      err = e as IncompatibleAppVersionError;
    }
    expect(err).toBeInstanceOf(IncompatibleAppVersionError);
    expect(err?.required).toBe("2.0.0");
    expect(err?.current).toBe("1.2.3");
    expect(err?.message).toBe("plugin requires LVIS >= 2.0.0, current 1.2.3");
  });

  it("does not down-rank into the capability error path (version gate runs first)", async () => {
    MOCK_APP_VERSION = "1.0.0";
    const svc = makeTestPluginMarketplaceService(
      tmpDir,
      new StubFetcher([makeItem("too-new", "9.9.9")]) as never,
    );
    let err: Error | null = null;
    try {
      await svc.install("too-new");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeInstanceOf(IncompatibleAppVersionError);
    expect(err).not.toBeInstanceOf(MissingDependenciesError);
  });
});

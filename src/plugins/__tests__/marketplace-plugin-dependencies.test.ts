/**
 * Issue #92 — marketplace install no longer auto-installs plugin-id
 * dependencies. `dependencies[]` is a declarative preflight contract:
 *
 *   - `required: false` (or unset) → informational. Install proceeds even
 *     if the referenced plugin is absent. The consumer plugin must degrade
 *     its feature surface at runtime.
 *   - `required: true` → preflight throws `MissingPluginDependenciesError`
 *     when the referenced plugin is not in the installed registry.
 *
 * Regression: prior to issue #92, soft dependencies triggered recursive
 * auto-install which then failed with "Admin plugin cannot be installed
 * by user" when the dep was an admin-policy plugin (e.g. work-assistant
 * declaring ms-graph as a soft dep). This file pins the new contract.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { PluginMarketplaceService } from "../marketplace.js";
import type { PluginMarketplaceItem } from "../types.js";
import { MissingPluginDependenciesError } from "../types.js";
import { _resetForTest, setIsPackaged } from "../../boot/dev-flags.js";
import { makeTestPluginMarketplaceService } from "./test-helpers.js";

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
  overrides: Partial<PluginMarketplaceItem> = {},
): PluginMarketplaceItem {
  return {
    id,
    name: id,
    description: "Test fixture.",
    publisher: "Test fixture",
    packageSpec: `@lvis/${id}@1.0.0`,
    packageName: `@lvis/${id}`,
    tools: [],
    ...overrides,
  };
}

async function seedInstalledPlugin(
  rootDir: string,
  pluginId: string,
  manifestPatch: Record<string, unknown> = {},
): Promise<void> {
  const pluginDir = resolve(rootDir, "plugins", "installed", pluginId);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(
    resolve(pluginDir, "plugin.json"),
    JSON.stringify({
      id: pluginId,
      name: pluginId,
      version: "1.0.0",
      entry: "dist/index.js",
      tools: [],
      description: "Test fixture.",
      publisher: "Test fixture",
      ...manifestPatch,
    }),
  );
}

async function writeRegistry(
  rootDir: string,
  entries: Array<{ id: string }>,
): Promise<void> {
  await mkdir(resolve(rootDir, "plugins"), { recursive: true });
  await writeFile(
    resolve(rootDir, "plugins", "registry.json"),
    JSON.stringify({
      version: 1,
      plugins: entries.map((e) => ({
        id: e.id,
        manifestPath: `installed/${e.id}/plugin.json`,
        enabled: true,
      })),
    }),
  );
}

async function readRegistryIds(rootDir: string): Promise<string[]> {
  const raw = await readFile(resolve(rootDir, "plugins", "registry.json"), "utf-8");
  const parsed = JSON.parse(raw) as { plugins: Array<{ id: string }> };
  return parsed.plugins.map((p) => p.id).sort();
}

describe("marketplace install — plugin-id dependencies (issue #92)", () => {
  let tmpDir: string;
  let installArtifactSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    setIsPackaged(false);
    tmpDir = mkdtempSync(join(tmpdir(), "lvis-test-"));
    await mkdir(tmpDir, { recursive: true });
    // The dep-preflight branch fires *before* artifact download / extract,
    // so stubbing installArtifact lets us observe the preflight outcome
    // without touching a real zip pipeline. Tests can also assert on
    // call count to verify which plugins reached the install branch.
    installArtifactSpy = vi.spyOn(
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
          version: plugin.version ?? "1.0.0",
          entry: "dist/index.js",
          tools: plugin.tools ?? [],
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

  it("installs successfully when all soft dependencies are absent", async () => {
    // Mirrors the issue #92 work-assistant manifest: every dep `required: false`.
    const consumer = makeItem("work-assistant-like", {
      dependencies: [
        { pluginId: "ms-graph", required: false },
        { pluginId: "meeting", required: false },
      ],
    });
    await writeRegistry(tmpDir, []);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer]) as never);

    const result = await svc.install("work-assistant-like");
    expect(result).toEqual({ pluginId: "work-assistant-like", installed: true });

    // Critical: ms-graph / meeting must NOT have been auto-installed.
    const ids = await readRegistryIds(tmpDir);
    expect(ids).toEqual(["work-assistant-like"]);
  });

  it("installs successfully when soft dep is unset (string-form)", async () => {
    // Legacy string-form deps in `dependencies[]` are treated as required:true
    // by `normalizeDependencies`. Verify that string-form *with provider
    // installed* still works (regression guard for normalizer behavior).
    const consumer = makeItem("string-form-consumer", {
      dependencies: ["string-dep"],
    });
    const provider = makeItem("string-dep");
    await seedInstalledPlugin(tmpDir, "string-dep");
    await writeRegistry(tmpDir, [{ id: "string-dep" }]);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer, provider]) as never);

    await expect(svc.install("string-form-consumer")).resolves.toMatchObject({
      installed: true,
    });
  });

  it("throws MissingPluginDependenciesError when a hard-required dep is absent", async () => {
    const consumer = makeItem("consumer-hard-req", {
      dependencies: [
        { pluginId: "absent-plugin", required: true },
        { pluginId: "another-absent", required: true },
      ],
    });
    await writeRegistry(tmpDir, []);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer]) as never);

    let err: unknown = null;
    try {
      await svc.install("consumer-hard-req");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingPluginDependenciesError);
    expect((err as MissingPluginDependenciesError).missing).toEqual([
      "absent-plugin",
      "another-absent",
    ]);

    // Registry must remain untouched after a failed preflight.
    const ids = await readRegistryIds(tmpDir);
    expect(ids).toEqual([]);
  });

  it("ignores absent soft deps but enforces absent hard deps when mixed", async () => {
    const consumer = makeItem("mixed-consumer", {
      dependencies: [
        { pluginId: "soft-absent", required: false },
        { pluginId: "hard-absent", required: true },
      ],
    });
    await writeRegistry(tmpDir, []);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer]) as never);

    let err: unknown = null;
    try {
      await svc.install("mixed-consumer");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingPluginDependenciesError);
    // Only the hard-required missing dep surfaces — the soft one is ignored.
    expect((err as MissingPluginDependenciesError).missing).toEqual(["hard-absent"]);
  });

  it("installs successfully when hard-required deps are already installed", async () => {
    const consumer = makeItem("consumer-happy", {
      dependencies: [{ pluginId: "hard-dep", required: true }],
    });
    const provider = makeItem("hard-dep");
    await seedInstalledPlugin(tmpDir, "hard-dep");
    await writeRegistry(tmpDir, [{ id: "hard-dep" }]);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer, provider]) as never);

    await expect(svc.install("consumer-happy")).resolves.toMatchObject({
      installed: true,
    });
  });

  it("does NOT auto-install an admin-policy dep that the consumer declares as soft", async () => {
    // Issue #92 exact scenario: a `user`-policy consumer declares an
    // `admin`-policy plugin as `required: false`. Pre-fix: recursive
    // install fired and the admin guard blocked the user actor. Post-fix:
    // soft deps are never touched, so the admin plugin remains absent and
    // the consumer install proceeds.
    const consumer = makeItem("work-assistant-like", {
      installPolicy: "user",
      dependencies: [{ pluginId: "ms-graph-like", required: false }],
    });
    const adminDep = makeItem("ms-graph-like", { installPolicy: "admin" });
    await writeRegistry(tmpDir, []);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer, adminDep]) as never);

    await expect(svc.install("work-assistant-like")).resolves.toMatchObject({
      installed: true,
    });
    // Admin-policy plugin must not have been auto-installed — registry
    // and the `installArtifact` install branch must both reflect that
    // only the consumer reached the install path.
    const ids = await readRegistryIds(tmpDir);
    expect(ids).toEqual(["work-assistant-like"]);
    expect(installArtifactSpy).toHaveBeenCalledTimes(1);
    const installedPluginIds = installArtifactSpy.mock.calls.map(
      ([item]) => (item as { id: string }).id,
    );
    expect(installedPluginIds).toEqual(["work-assistant-like"]);
  });

  it("installs successfully when manifest has no `dependencies` field at all", async () => {
    const consumer = makeItem("no-deps-field");
    await writeRegistry(tmpDir, []);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer]) as never);

    await expect(svc.install("no-deps-field")).resolves.toMatchObject({
      installed: true,
    });
    expect(installArtifactSpy).toHaveBeenCalledTimes(1);
  });

  it("installs successfully when `dependencies` is the empty array", async () => {
    const consumer = makeItem("empty-deps", { dependencies: [] });
    await writeRegistry(tmpDir, []);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer]) as never);

    await expect(svc.install("empty-deps")).resolves.toMatchObject({
      installed: true,
    });
    expect(installArtifactSpy).toHaveBeenCalledTimes(1);
  });

  it("throws when a string-form dep is absent (legacy form coerces to required:true)", async () => {
    // `normalizeDependencies` coerces string-form `"foo"` to
    // `{ pluginId: "foo", required: true }`. Pin that semantics so a
    // future normalizer change can't silently relax the contract.
    const consumer = makeItem("legacy-string-consumer", {
      dependencies: ["missing-provider"],
    });
    await writeRegistry(tmpDir, []);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer]) as never);

    let err: unknown = null;
    try {
      await svc.install("legacy-string-consumer");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingPluginDependenciesError);
    expect((err as MissingPluginDependenciesError).missing).toEqual([
      "missing-provider",
    ]);
    // Nothing was installed.
    expect(installArtifactSpy).not.toHaveBeenCalled();
  });

  it("silently drops malformed dep entries with falsy pluginId (normalizer SOT)", async () => {
    // `normalizeDependencies` defends against object-form entries whose
    // `pluginId` is empty or missing. Such entries are dropped, the
    // preflight sees an effectively-empty deps list, and the install
    // proceeds. Pinning this so a future normalizer change can't silently
    // turn malformed entries into spurious throws.
    const consumer = makeItem("malformed-dep-consumer", {
      dependencies: [
        // @ts-expect-error — intentionally malformed to lock normalizer behavior.
        { pluginId: "", required: true },
        // @ts-expect-error — intentionally missing pluginId.
        { required: true },
      ],
    });
    await writeRegistry(tmpDir, []);
    const svc = makeTestPluginMarketplaceService(tmpDir, new StubFetcher([consumer]) as never);

    await expect(svc.install("malformed-dep-consumer")).resolves.toMatchObject({
      installed: true,
    });
    expect(installArtifactSpy).toHaveBeenCalledTimes(1);
  });
});

/**
 * S8 — PluginUpdateDetector tests.
 *
 * Verifies that checkForUpdates() returns the correct delta between
 * installed plugin versions (from the registry manifests) and the
 * latest versions in the catalog.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import {resolve, join} from "node:path";
import { PluginUpdateDetector, isNewer, isUpdateCheckEnabled } from "../update-detector.js";
import type { MarketplaceFetcher } from "../marketplace-fetcher.js";
import type { PluginMarketplaceItem } from "../types.js";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeFetcher(plugins: PluginMarketplaceItem[]): MarketplaceFetcher {
  return {
    listPlugins: vi.fn().mockResolvedValue(plugins),
    getPluginDetail: vi.fn().mockResolvedValue(null),
    downloadVersion: vi.fn().mockRejectedValue(new Error("not implemented"))
  };
}

function makeCatalogPlugin(id: string, version: string): PluginMarketplaceItem {
  return {
    id,
    name: id,
    description: "",
    publisher: "Test fixture",
    packageSpec: `@lvis/${id}@${version}`,
    packageName: `@lvis/${id}`,
    tools: [],
    version
  };
}

// ─── isNewer ────────────────────────────────────────────────────────────────

describe("isNewer", () => {
  it("returns true when candidate has higher patch", () => {
    expect(isNewer("1.0.1", "1.0.0")).toBe(true);
  });
  it("returns true when candidate has higher minor", () => {
    expect(isNewer("1.1.0", "1.0.9")).toBe(true);
  });
  it("returns true when candidate has higher major", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });
  it("returns false when versions are equal", () => {
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  });
  it("returns false when candidate is older", () => {
    expect(isNewer("1.0.0", "1.0.1")).toBe(false);
  });
  it("handles v-prefix", () => {
    expect(isNewer("v1.1.0", "v1.0.0")).toBe(true);
  });
  // S8 FU1 — semver pre-release precedence (semver.org §11)
  it("treats stable as newer than same-version prerelease (1.0.0 > 1.0.0-beta.1)", () => {
    expect(isNewer("1.0.0", "1.0.0-beta.1")).toBe(true);
  });
  it("treats prerelease as older than same-version stable (1.0.0-beta.1 < 1.0.0)", () => {
    expect(isNewer("1.0.0-beta.1", "1.0.0")).toBe(false);
  });
  it("compares prerelease numeric identifiers numerically (1.0.0-beta.2 > 1.0.0-beta.1)", () => {
    expect(isNewer("1.0.0-beta.2", "1.0.0-beta.1")).toBe(true);
    expect(isNewer("1.0.0-beta.10", "1.0.0-beta.2")).toBe(true);
  });
  it("orders alpha < beta lexically when non-numeric", () => {
    expect(isNewer("1.0.0-beta.1", "1.0.0-alpha.1")).toBe(true);
    expect(isNewer("1.0.0-alpha.1", "1.0.0-beta.1")).toBe(false);
  });
  it("shorter prerelease chain has lower precedence (1.0.0-alpha.1 > 1.0.0-alpha)", () => {
    expect(isNewer("1.0.0-alpha.1", "1.0.0-alpha")).toBe(true);
  });
  it("numeric identifiers have lower precedence than non-numeric", () => {
    expect(isNewer("1.0.0-beta", "1.0.0-1")).toBe(true);
    expect(isNewer("1.0.0-1", "1.0.0-beta")).toBe(false);
  });
});

// ─── isUpdateCheckEnabled ────────────────────────────────────────────────────

describe("isUpdateCheckEnabled", () => {
  it("is ON by default (no env var)", () => {
    expect(isUpdateCheckEnabled({})).toBe(true);
  });
  it("is OFF when set to '0'", () => {
    expect(isUpdateCheckEnabled({ LVIS_MARKETPLACE_UPDATE_CHECK: "0" })).toBe(false);
  });
  it("is OFF when set to 'false'", () => {
    expect(isUpdateCheckEnabled({ LVIS_MARKETPLACE_UPDATE_CHECK: "false" })).toBe(false);
  });
  it("is ON when set to '1'", () => {
    expect(isUpdateCheckEnabled({ LVIS_MARKETPLACE_UPDATE_CHECK: "1" })).toBe(true);
  });
});

// ─── PluginUpdateDetector ────────────────────────────────────────────────────

describe("PluginUpdateDetector", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "update-detector-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function setupRegistry(
    plugins: Array<{ id: string; version: string }>,
  ): Promise<string> {
    const installedDir = resolve(tmpDir, "installed");
    await mkdir(installedDir, { recursive: true });

    const entries = [];
    for (const { id, version } of plugins) {
      const dir = resolve(installedDir, id);
      await mkdir(dir, { recursive: true });
      await writeFile(
        resolve(dir, "plugin.json"),
        JSON.stringify({ id, version, name: id, entry: "dist/index.js", tools: [] }),
        "utf-8",
      );
      entries.push({ id, manifestPath: `installed/${id}/plugin.json` });
    }

    const registryPath = resolve(tmpDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: entries }),
      "utf-8",
    );
    return registryPath;
  }

  it("returns update when catalog version is newer", async () => {
    const registryPath = await setupRegistry([{ id: "pageindex", version: "1.0.0" }]);
    const fetcher = makeFetcher([makeCatalogPlugin("pageindex", "1.1.0")]);
    const detector = new PluginUpdateDetector(registryPath, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      pluginId: "pageindex",
      installedVersion: "1.0.0",
      latestVersion: "1.1.0"
    });
  });

  it("returns empty when all plugins are up-to-date", async () => {
    const registryPath = await setupRegistry([{ id: "pageindex", version: "1.1.0" }]);
    const fetcher = makeFetcher([makeCatalogPlugin("pageindex", "1.1.0")]);
    const detector = new PluginUpdateDetector(registryPath, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toHaveLength(0);
  });

  it("returns only plugins with newer versions when mixed", async () => {
    const registryPath = await setupRegistry([
      { id: "meeting", version: "2.0.0" },
      { id: "email", version: "1.0.0" },
    ]);
    const fetcher = makeFetcher([
      makeCatalogPlugin("meeting", "2.0.0"), // up-to-date
      makeCatalogPlugin("email", "1.2.0"),   // newer
    ]);
    const detector = new PluginUpdateDetector(registryPath, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toHaveLength(1);
    expect(updates[0].pluginId).toBe("email");
  });

  it("ignores installed plugins not in catalog", async () => {
    const registryPath = await setupRegistry([{ id: "local-plugin", version: "1.0.0" }]);
    const fetcher = makeFetcher([]); // empty catalog
    const detector = new PluginUpdateDetector(registryPath, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toHaveLength(0);
  });

  it("skips legacy _devLinked-only entries when installSource is missing", async () => {
    // Pre-PR #430 dev-link installs could write `_devLinked: true` without an
    // installSource. Treat that missing-installSource shape as legacy dev so a
    // stale registry does not spam path-escape warnings on every poll.
    const registryPath = resolve(tmpDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "agent-hub", manifestPath: "agent-hub/plugin.json", _devLinked: true },
        ],
      }),
      "utf-8",
    );
    const fetcher = makeFetcher([makeCatalogPlugin("agent-hub", "9.9.9")]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const detector = new PluginUpdateDetector(registryPath, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toHaveLength(0);
    // The path-escape warning must not fire — that was the symptom we
    // observed in production for every dev-linked plugin on every poll.
    expect(warnSpy).not.toHaveBeenCalledWith(
      "[update-detector] manifestPath escapes allowed roots, skipping:",
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it("skips entries with installSource='dev-link' (new field, no legacy _devLinked)", async () => {
    const registryPath = resolve(tmpDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "agent-hub", manifestPath: "agent-hub/plugin.json", installSource: "dev-link" },
        ],
      }),
      "utf-8",
    );
    const fetcher = makeFetcher([makeCatalogPlugin("agent-hub", "9.9.9")]);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const detector = new PluginUpdateDetector(registryPath, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toHaveLength(0);
    warnSpy.mockRestore();
  });

  it("does not skip non-dev entries solely because stale _devLinked is present", async () => {
    const registryPath = await setupRegistry([{ id: "pageindex", version: "1.0.0" }]);
    const parsed = JSON.parse(await readFile(registryPath, "utf-8")) as {
      version: number;
      plugins: Array<{ id: string; manifestPath: string; installSource?: string; _devLinked?: boolean }>;
    };
    parsed.plugins[0].installSource = "user";
    parsed.plugins[0]._devLinked = true;
    await writeFile(registryPath, JSON.stringify(parsed), "utf-8");
    const fetcher = makeFetcher([makeCatalogPlugin("pageindex", "1.1.0")]);
    const detector = new PluginUpdateDetector(registryPath, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toEqual([
      {
        pluginId: "pageindex",
        installedVersion: "1.0.0",
        latestVersion: "1.1.0",
      },
    ]);
  });

  it("ignores catalog plugins without a version field", async () => {
    const registryPath = await setupRegistry([{ id: "pageindex", version: "1.0.0" }]);
    const catalogPlugin = makeCatalogPlugin("pageindex", "1.1.0");
    delete (catalogPlugin as { version?: string }).version; // strip version
    const fetcher = makeFetcher([catalogPlugin]);
    const detector = new PluginUpdateDetector(registryPath, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toHaveLength(0);
  });

  it("returns empty array (never throws) when registry is missing", async () => {
    const missingRegistry = resolve(tmpDir, "does-not-exist.json");
    const fetcher = makeFetcher([makeCatalogPlugin("pageindex", "2.0.0")]);
    const detector = new PluginUpdateDetector(missingRegistry, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toEqual([]);
  });

  it("skips canary catalog entries by default (stable rollout only)", async () => {
    const registryPath = await setupRegistry([{ id: "pageindex", version: "1.0.0" }]);
    const canaryPlugin = { ...makeCatalogPlugin("pageindex", "2.0.0"), channel: "canary" as const };
    const fetcher = makeFetcher([canaryPlugin]);
    const detector = new PluginUpdateDetector(registryPath, fetcher);

    const updates = await detector.checkForUpdates();

    expect(updates).toHaveLength(0);
  });

  it("includes canary entries when canaryOptIn is true", async () => {
    const registryPath = await setupRegistry([{ id: "pageindex", version: "1.0.0" }]);
    const canaryPlugin = { ...makeCatalogPlugin("pageindex", "2.0.0"), channel: "canary" as const };
    const fetcher = makeFetcher([canaryPlugin]);
    const detector = new PluginUpdateDetector(registryPath, fetcher, { canaryOptIn: true });

    const updates = await detector.checkForUpdates();

    expect(updates).toHaveLength(1);
    expect(updates[0].latestVersion).toBe("2.0.0");
  });

  it("rejects manifests that escape allowed roots through a symlink", async () => {
    const outsideDir = resolve(tmpDir, "..", `outside-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(
      resolve(outsideDir, "plugin.json"),
      JSON.stringify({ id: "pageindex", version: "1.0.0", name: "pageindex", entry: "dist/index.js", tools: [] }),
      "utf-8",
    );

    const installedDir = resolve(tmpDir, "installed");
    await mkdir(installedDir, { recursive: true });
    await symlink(outsideDir, resolve(installedDir, "pageindex"), "dir");

    const registryPath = resolve(tmpDir, "registry.json");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "pageindex", manifestPath: "installed/pageindex/plugin.json" }],
      }),
      "utf-8",
    );

    const detector = new PluginUpdateDetector(
      registryPath,
      makeFetcher([makeCatalogPlugin("pageindex", "1.1.0")]),
    );

    await expect(detector.checkForUpdates()).resolves.toEqual([]);
  });
});

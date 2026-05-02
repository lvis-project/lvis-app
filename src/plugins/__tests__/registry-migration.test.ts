/**
 * registry.json migration — pre-PR #430 entries with `installedBy` +
 * `_devLinked` are mapped onto the unified `installSource` enum on first
 * read. The migration is one-shot (persisted back to disk) and idempotent
 * (already-migrated entries are left alone).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPluginRegistry, resolveManifestPathsFromRegistry } from "../registry.js";

describe("readPluginRegistry — legacy installedBy/_devLinked migration", () => {
  let tmpDir: string;
  let registryPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "lvis-registry-migration-"));
    registryPath = join(tmpDir, "registry.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("maps `_devLinked: true` → `installSource: \"local-dev\"` (post-purge rewrite) and persists the migration", async () => {
    // Post-2026-05 dev-link purge: legacy `_devLinked: true` and any
    // existing `installSource: "dev-link"` are rewritten to "local-dev"
    // (the closest still-valid sibling). Receipt verification then
    // applies normally — the operator will see a clear failure if the
    // entry was a dev-link install with no receipt on disk.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "agent-hub",
            manifestPath: "agent-hub/plugin.json",
            enabled: true,
            installedBy: "user",
            _devLinked: true,
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0]).toEqual({
      id: "agent-hub",
      manifestPath: "agent-hub/plugin.json",
      enabled: true,
      installSource: "local-dev",
    });

    // Persisted: a fresh read should return the same shape with no
    // legacy fields and no further migration log entry.
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0].installedBy).toBeUndefined();
    expect(onDisk.plugins[0]._devLinked).toBeUndefined();
    expect(onDisk.plugins[0].installSource).toBe("local-dev");
  });

  it("maps `installedBy: \"user\"` → `installSource: \"user\"`", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "calendar",
            manifestPath: "calendar/plugin.json",
            enabled: true,
            installedBy: "user",
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBe("user");

    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0].installedBy).toBeUndefined();
    expect(onDisk.plugins[0].installSource).toBe("user");
  });

  it("maps `installedBy: \"admin\"` → `installSource: \"admin\"`", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "meeting",
            manifestPath: "meeting/plugin.json",
            enabled: true,
            installedBy: "admin",
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBe("admin");

    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0].installedBy).toBeUndefined();
    expect(onDisk.plugins[0].installSource).toBe("admin");
  });

  it("`_devLinked: true` wins over `installedBy: \"admin\"` (rewritten to local-dev post-purge)", async () => {
    // Pre-PR #430 dev-link installs co-existed with admin signals on the
    // same entry only by accident; the disjunction call sites used was
    // "_devLinked first, then installedBy". After the 2026-05 dev-link
    // purge, the result is "local-dev" rather than "dev-link" — the
    // _devLinked precedence over installedBy is preserved, but the value
    // produced is the still-valid sibling.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "x",
            manifestPath: "x/plugin.json",
            installedBy: "admin",
            _devLinked: true,
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBe("local-dev");
  });

  it("rewrites pre-existing `installSource: \"dev-link\"` to `\"local-dev\"`", async () => {
    // Post-2026-05: any dev-link-typed install source on disk is normalised
    // to local-dev on read, with a one-shot loud audit warning.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "agent-hub",
            manifestPath: "agent-hub/plugin.json",
            enabled: true,
            installSource: "dev-link",
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBe("local-dev");
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0].installSource).toBe("local-dev");
  });

  it("entries with neither legacy field nor installSource keep installSource undefined", async () => {
    // Truly legacy entries (pre-installedBy) leave the manifest
    // installPolicy as the only signal — the deployment-guard
    // explicitly falls back to it when `installSource === undefined`,
    // so the migration must NOT default-stamp "user" here.
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "ancient",
            manifestPath: "ancient/plugin.json",
            enabled: true,
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0].installSource).toBeUndefined();
  });

  it("is idempotent: a second read does not rewrite an already-migrated registry", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "calendar",
            manifestPath: "calendar/plugin.json",
            enabled: true,
            installSource: "user",
          },
        ],
      }),
      "utf-8",
    );

    const before = await readFile(registryPath, "utf-8");
    await readPluginRegistry(registryPath);
    const after = await readFile(registryPath, "utf-8");
    expect(after).toEqual(before);
  });

  it("preserves bundleRefs and approvedPluginAccess across migration", async () => {
    const accessSpec = { plugins: [{ pluginId: "ms-graph", events: ["email.new"] }] };
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "work-proactive",
            manifestPath: "work-proactive/plugin.json",
            enabled: true,
            installedBy: "user",
            bundleRefs: ["x-bundle"],
            approvedPluginAccess: accessSpec,
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins[0]).toEqual({
      id: "work-proactive",
      manifestPath: "work-proactive/plugin.json",
      enabled: true,
      installSource: "user",
      bundleRefs: ["x-bundle"],
      approvedPluginAccess: accessSpec,
    });
  });

  it("migrates old-only pageindex registry entry to local-indexer and persists default manifest path rename", async () => {
    await mkdir(join(tmpDir, "pageindex"), { recursive: true });
    await writeFile(join(tmpDir, "pageindex", "plugin.json"), JSON.stringify({ id: "pageindex" }), "utf-8");

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

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins).toEqual([
      {
        id: "local-indexer",
        manifestPath: "local-indexer/plugin.json",
        enabled: true,
        installSource: "user",
      },
    ]);

    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins).toEqual(registry.plugins);
    const resolvedManifestPaths = resolveManifestPathsFromRegistry(registryPath, registry.plugins);
    expect(resolvedManifestPaths).toEqual([join(tmpDir, "local-indexer", "plugin.json")]);
    await expect(stat(join(tmpDir, "local-indexer", "plugin.json"))).resolves.toBeTruthy();
    await expect(stat(join(tmpDir, "pageindex"))).rejects.toThrow();
  });

  it("does not overwrite an existing local-indexer directory when migrating duplicate old and new entries", async () => {
    await mkdir(join(tmpDir, "pageindex"), { recursive: true });
    await mkdir(join(tmpDir, "local-indexer"), { recursive: true });
    await writeFile(join(tmpDir, "pageindex", "marker.txt"), "legacy", "utf-8");
    await writeFile(join(tmpDir, "local-indexer", "marker.txt"), "canonical", "utf-8");
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
          {
            id: "local-indexer",
            manifestPath: "local-indexer/plugin.json",
            enabled: false,
            installSource: "admin",
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins).toEqual([
      {
        id: "local-indexer",
        manifestPath: "local-indexer/plugin.json",
        enabled: false,
        installSource: "admin",
      },
    ]);
    await expect(readFile(join(tmpDir, "local-indexer", "marker.txt"), "utf-8")).resolves.toBe("canonical");
    await expect(readFile(join(tmpDir, "pageindex", "marker.txt"), "utf-8")).resolves.toBe("legacy");
  });

  it("leaves an already-canonical local-indexer registry entry unchanged", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "local-indexer",
            manifestPath: "local-indexer/plugin.json",
            enabled: false,
            installSource: "admin",
          },
        ],
      }),
      "utf-8",
    );

    const before = await readFile(registryPath, "utf-8");
    const registry = await readPluginRegistry(registryPath);
    const after = await readFile(registryPath, "utf-8");
    expect(registry.plugins[0]).toEqual({
      id: "local-indexer",
      manifestPath: "local-indexer/plugin.json",
      enabled: false,
      installSource: "admin",
    });
    expect(after).toEqual(before);
  });

  it("canonicalizes duplicate pageindex and local-indexer entries, preferring local-indexer and filling missing metadata", async () => {
    const approvedPluginAccess = { plugins: [{ pluginId: "ms-graph", tools: ["mail.search"] }] };
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
            bundleRefs: ["legacy-bundle"],
            approvedPluginAccess,
          },
          {
            id: "calendar",
            manifestPath: "calendar/plugin.json",
            enabled: true,
          },
          {
            id: "local-indexer",
            manifestPath: "local-indexer/plugin.json",
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins).toEqual([
      {
        id: "calendar",
        manifestPath: "calendar/plugin.json",
        enabled: true,
      },
      {
        id: "local-indexer",
        manifestPath: "local-indexer/plugin.json",
        enabled: true,
        installSource: "user",
        bundleRefs: ["legacy-bundle"],
        approvedPluginAccess,
      },
    ]);

    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins).toEqual(registry.plugins);
    expect(onDisk.plugins.filter((entry: { id: string }) => entry.id === "pageindex")).toHaveLength(0);
    expect(onDisk.plugins.filter((entry: { id: string }) => entry.id === "local-indexer")).toHaveLength(1);
  });

  it("preserves pageindex fields and custom manifest paths during rename", async () => {
    const approvedPluginAccess = { plugins: [{ pluginId: "agent-hub", events: ["agent.ready"] }] };
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "pageindex",
            manifestPath: "/opt/lvis/custom-pageindex/plugin.json",
            enabled: false,
            installSource: "local-dev",
            bundleRefs: ["custom-bundle"],
            approvedPluginAccess,
          },
        ],
      }),
      "utf-8",
    );

    const registry = await readPluginRegistry(registryPath);
    expect(registry.plugins).toEqual([
      {
        id: "local-indexer",
        manifestPath: "/opt/lvis/custom-pageindex/plugin.json",
        enabled: false,
        installSource: "local-dev",
        bundleRefs: ["custom-bundle"],
        approvedPluginAccess,
      },
    ]);
  });

  it("returns the empty default and does not write anything for a missing registry (first boot)", async () => {
    const missingPath = join(tmpDir, "does-not-exist.json");
    const registry = await readPluginRegistry(missingPath);
    expect(registry.plugins).toEqual([]);
    // Migration log should not fire on first boot — and certainly the
    // file must not be created.
    await expect(readFile(missingPath, "utf-8")).rejects.toThrow();
  });
});

/**
 * registry.json migration — pre-PR #430 entries with `installedBy` +
 * `_devLinked` are normalized onto `installSource` on first read. The legacy
 * boolean never persists as an ambiguous cleanup hint, so it cannot silently
 * re-enable the old dev-link trust bypass.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPluginRegistry } from "../registry.js";

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

  it("normalizes `_devLinked: true` legacy dev entries to installSource='dev-link' and clears the boolean", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "agent-hub",
            manifestPath: "agent-hub/plugin.json",
            enabled: true,
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
      installSource: "dev-link",
    });

    // Persisted: the supported installSource remains, the legacy boolean does not.
    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0].installedBy).toBeUndefined();
    expect(onDisk.plugins[0]._devLinked).toBeUndefined();
    expect(onDisk.plugins[0].installSource).toBe("dev-link");
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

  it("clears stale `_devLinked: true` while still migrating `installedBy`", async () => {
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
    expect(registry.plugins[0]).toEqual({
      id: "x",
      manifestPath: "x/plugin.json",
      installSource: "admin",
    });

    const onDisk = JSON.parse(await readFile(registryPath, "utf-8"));
    expect(onDisk.plugins[0]._devLinked).toBeUndefined();
    expect(onDisk.plugins[0].installSource).toBe("admin");
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

  it("is idempotent after clearing stale `_devLinked` from an already-typed non-dev entry", async () => {
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
            _devLinked: true,
          },
        ],
      }),
      "utf-8",
    );

    await readPluginRegistry(registryPath);
    const afterFirstRead = await readFile(registryPath, "utf-8");
    expect(JSON.parse(afterFirstRead).plugins[0]._devLinked).toBeUndefined();

    await readPluginRegistry(registryPath);
    const afterSecondRead = await readFile(registryPath, "utf-8");
    expect(afterSecondRead).toEqual(afterFirstRead);
  });

  it("persists canonical installSource while stripping `_devLinked` from an already-typed dev entry", async () => {
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "agent-hub",
            manifestPath: "agent-hub/plugin.json",
            enabled: true,
            installSource: "dev",
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
      installSource: "dev",
    });

    const afterFirstRead = await readFile(registryPath, "utf-8");
    expect(JSON.parse(afterFirstRead).plugins[0]._devLinked).toBeUndefined();

    await readPluginRegistry(registryPath);
    const afterSecondRead = await readFile(registryPath, "utf-8");
    expect(afterSecondRead).toEqual(afterFirstRead);
  });

  it("preserves legacy installSource='dev-link' while stripping `_devLinked` exactly once", async () => {
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
      installSource: "dev-link",
    });

    const afterFirstRead = await readFile(registryPath, "utf-8");
    expect(JSON.parse(afterFirstRead).plugins[0]._devLinked).toBeUndefined();

    await readPluginRegistry(registryPath);
    const afterSecondRead = await readFile(registryPath, "utf-8");
    expect(afterSecondRead).toEqual(afterFirstRead);
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

  it("returns the empty default and does not write anything for a missing registry (first boot)", async () => {
    const missingPath = join(tmpDir, "does-not-exist.json");
    const registry = await readPluginRegistry(missingPath);
    expect(registry.plugins).toEqual([]);
    // Migration log should not fire on first boot — and certainly the
    // file must not be created.
    await expect(readFile(missingPath, "utf-8")).rejects.toThrow();
  });
});

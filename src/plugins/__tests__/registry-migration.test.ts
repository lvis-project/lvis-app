/**
 * registry.json migration — pre-PR #430 entries with `installedBy` +
 * `_devLinked` are mapped onto the unified `installSource` enum on first
 * read. The migration is one-shot (persisted back to disk) and idempotent
 * (already-migrated entries are left alone).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("maps `_devLinked: true` → `installSource: \"dev-link\"` and persists the migration", async () => {
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
      installSource: "dev-link",
    });

    // Persisted: a fresh read should return the same shape with no
    // legacy fields and no further migration log entry.
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

  it("`_devLinked: true` wins over `installedBy: \"admin\"`", async () => {
    // Pre-PR #430 dev-link installs co-existed with admin signals on the
    // same entry only by accident; the disjunction call sites used was
    // "_devLinked first, then installedBy", so the migration matches.
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
    expect(registry.plugins[0].installSource).toBe("dev-link");
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

  it("returns the empty default and does not write anything for a missing registry (first boot)", async () => {
    const missingPath = join(tmpDir, "does-not-exist.json");
    const registry = await readPluginRegistry(missingPath);
    expect(registry.plugins).toEqual([]);
    // Migration log should not fire on first boot — and certainly the
    // file must not be created.
    await expect(readFile(missingPath, "utf-8")).rejects.toThrow();
  });
});

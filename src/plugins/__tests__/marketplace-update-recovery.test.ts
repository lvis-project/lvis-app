import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupPendingPluginUpdateBackup,
  preparePendingPluginUpdate,
  recoverPendingPluginUpdates,
} from "../marketplace-update-recovery.js";
import { installReceiptPath } from "../plugin-install-receipt.js";
import { readPluginRegistry } from "../registry.js";
import { sweepOrphanUninstallDirs } from "../orphan-uninstall-sweeper.js";
import type { PluginPaths } from "../plugin-paths.js";

describe("marketplace pending-update recovery", () => {
  let root: string;
  let paths: PluginPaths;
  const pluginId = "recoverable";
  const oldManifest = `${JSON.stringify({ id: pluginId, version: "1.0.0" })}\n`;
  const oldReceipt = `${JSON.stringify({ schemaVersion: 2, pluginId, version: "1.0.0" })}\n`;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pending-update-recovery-"));
    paths = {
      pluginsRoot: join(root, "plugins"),
      registryPath: join(root, "plugins", "registry.json"),
      cacheRoot: join(root, "cache"),
    };
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await mkdir(join(paths.cacheRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), oldManifest);
    await writeFile(installReceiptPath(paths.cacheRoot, pluginId), oldReceipt);
    await writeFile(paths.registryPath, `${JSON.stringify({
      version: 1,
      plugins: [{
        id: pluginId,
        manifestPath: `${pluginId}/plugin.json`,
        manifestSha256: createHash("sha256").update(oldManifest).digest("hex"),
        enabled: true,
        installSource: "user",
        bundleRefs: ["bundle-root"],
      }],
    })}\n`);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("clears a pre-promotion crash marker when old bytes and receipt remain exact", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const plannedBackup = join(paths.pluginsRoot, `.${pluginId}.old-planned`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: plannedBackup,
      recoveryBackupMode: "rename",
    });

    const restarted = await recoverPendingPluginUpdates(paths);

    expect(restarted).toEqual({ recovered: [pluginId], unresolved: [] });
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeUndefined();
  });

  it("restores a retained old directory and receipt after a post-promotion crash", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-retained`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), backupDir);
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
    await writeFile(installReceiptPath(paths.cacheRoot, pluginId), JSON.stringify({ pluginId, version: "2.0.0" }));

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(await readFile(installReceiptPath(paths.cacheRoot, pluginId), "utf-8")).toBe(oldReceipt);
    expect(existsSync(backupDir)).toBe(false);
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeUndefined();
  });

  it("only removes a retained backup through the explicit cleanup path and keeps the row hidden", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-retained`);
    await mkdir(backupDir);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });

    await sweepOrphanUninstallDirs(paths.pluginsRoot);
    expect(existsSync(backupDir)).toBe(true);
    expect(await cleanupPendingPluginUpdateBackup(paths, pluginId)).toBe(true);
    expect(existsSync(backupDir)).toBe(false);
    const pending = (await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate;
    expect(pending).toEqual(expect.objectContaining({ kind: "marketplace" }));
    expect(pending?.recoveryBackupDir).toBeUndefined();
  });

  it("rejects a nested lookalike marketplace backup path without deleting it", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const nestedRoot = join(paths.pluginsRoot, "unrelated");
    const backupDir = join(nestedRoot, `.${pluginId}.old-lookalike`);
    await mkdir(backupDir, { recursive: true });
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });

    await expect(cleanupPendingPluginUpdateBackup(paths, pluginId)).rejects.toThrow(
      `Unsafe recovery backup path for plugin: ${pluginId}`,
    );
    expect(existsSync(backupDir)).toBe(true);
  });
});

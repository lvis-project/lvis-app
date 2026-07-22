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
  const oldDist = "export const version = '1.0.0';\n";
  const oldReceipt = `${JSON.stringify({
    schemaVersion: 2,
    pluginId,
    version: "1.0.0",
    installSource: "marketplace",
    artifactSha256: "a".repeat(64),
    signerKeyId: "test-key",
    installedAt: "2026-07-22T00:00:00.000Z",
    files: [
      { path: "plugin.json", sha256: createHash("sha256").update(oldManifest).digest("hex") },
      { path: "dist/index.js", sha256: createHash("sha256").update(oldDist).digest("hex") },
    ],
  })}\n`;
  const backupSuffix = "00000000-0000-4000-8000-000000000001";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pending-update-recovery-"));
    paths = {
      pluginsRoot: join(root, "plugins"),
      registryPath: join(root, "plugins", "registry.json"),
      cacheRoot: join(root, "cache"),
    };
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await mkdir(join(paths.pluginsRoot, pluginId, "dist"), { recursive: true });
    await mkdir(join(paths.cacheRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), oldManifest);
    await writeFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), oldDist);
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
    const plannedBackup = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
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
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
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
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
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
    const backupDir = join(nestedRoot, `.${pluginId}.old-${backupSuffix}`);
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

  it("rejects a sibling plugin prefix collision without deleting either directory", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const collision = join(paths.pluginsRoot, `.${pluginId}.old-other.old-${backupSuffix}`);
    const unrelated = join(paths.pluginsRoot, "unrelated");
    await mkdir(collision, { recursive: true });
    await mkdir(unrelated);
    await writeFile(join(unrelated, "keep.txt"), "keep");
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: collision,
      recoveryBackupMode: "rename",
    });

    await expect(cleanupPendingPluginUpdateBackup(paths, pluginId)).rejects.toThrow(/Unsafe recovery backup path/);
    expect(await readFile(join(unrelated, "keep.txt"), "utf-8")).toBe("keep");
    expect(existsSync(collision)).toBe(true);
  });

  it.each([".", "..", "../outside", "nested/plugin", "nested\\plugin"])(
    "rejects unsafe recovery id %j before constructing or removing a plugin path",
    async (id) => {
      const unrelated = join(root, "outside", "keep.txt");
      await mkdir(join(root, "outside"), { recursive: true });
      await writeFile(unrelated, "keep");
      await writeFile(paths.registryPath, JSON.stringify({
        version: 1,
        plugins: [{
          id,
          manifestPath: "outside/plugin.json",
          pendingUpdate: {
            kind: "marketplace",
            previousManifestFileSha256: null,
            previousReceiptRaw: null,
          },
        }],
      }));

      await expect(recoverPendingPluginUpdates(paths)).rejects.toThrow(/invalid artifact slug/);
      expect(await readFile(unrelated, "utf-8")).toBe("keep");
    },
  );

  it("refuses recovery when a receipt-covered dist file is corrupted", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), backupDir);
    await writeFile(join(backupDir, "dist", "index.js"), "corrupted");
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "new payload");
    const unrelated = join(paths.pluginsRoot, "unrelated.txt");
    await writeFile(unrelated, "keep");

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
    expect(await readFile(unrelated, "utf-8")).toBe("keep");
    expect(existsSync(backupDir)).toBe(true);
  });

  it("refuses recovery from a corrupted durable receipt snapshot", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    await preparePendingPluginUpdate(paths, entry, { kind: "marketplace" });
    const registry = JSON.parse(await readFile(paths.registryPath, "utf-8")) as {
      plugins: Array<{ pendingUpdate?: { previousReceiptRaw: string | null } }>;
    };
    registry.plugins[0]!.pendingUpdate!.previousReceiptRaw = "{not-json";
    await writeFile(paths.registryPath, JSON.stringify(registry));
    const unrelated = join(paths.pluginsRoot, "unrelated.txt");
    await writeFile(unrelated, "keep");

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
    expect(await readFile(unrelated, "utf-8")).toBe("keep");
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeDefined();
  });

  it("restores directory bytes before publishing the matching receipt and leaves pending on receipt fault", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await preparePendingPluginUpdate(paths, entry, {
      kind: "marketplace",
      recoveryBackupDir: backupDir,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), backupDir);
    await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "new payload");
    const receiptPath = installReceiptPath(paths.cacheRoot, pluginId);
    await rm(receiptPath);
    await mkdir(receiptPath);

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(await readFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), "utf-8")).toBe(oldDist);
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeDefined();
  });
});

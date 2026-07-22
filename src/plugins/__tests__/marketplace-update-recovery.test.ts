import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupPendingPluginUpdateBackup,
  preparePendingPluginUpdate,
  recoverPendingPluginUpdates,
} from "../marketplace-update-recovery.js";
import { installReceiptPath } from "../plugin-install-receipt.js";
import { preparePluginRegistryForBoot } from "../plugin-boot-recovery.js";
import { createRemovalTransaction, stageRemovalTransaction } from "../plugin-removal-transaction.js";
import { readPluginRegistry, updatePluginRegistry } from "../registry.js";
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

  it("persists legacy registry migration before boot recovery", async () => {
    await writeFile(paths.registryPath, JSON.stringify({
      version: 1,
      plugins: [{
        id: pluginId,
        manifestPath: `${pluginId}/plugin.json`,
        installedBy: "user",
      }],
    }));

    await expect(preparePluginRegistryForBoot(paths)).resolves.toEqual({
      recovered: [],
      unresolved: [],
      removals: { restored: [], cleaned: [], unresolved: [] },
      pendingRecoverySkipped: false,
    });
    const persisted = JSON.parse(await readFile(paths.registryPath, "utf-8")) as {
      plugins: Array<Record<string, unknown>>;
    };
    expect(persisted.plugins[0]).toEqual(expect.objectContaining({ installSource: "user" }));
    expect(persisted.plugins[0]).not.toHaveProperty("installedBy");
  });

  it("blocks pending cleanup while removal restore is unresolved, then restores before cleanup on retry", async () => {
    const cleanupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await mkdir(cleanupDir);
    await updatePluginRegistry(paths.registryPath, (registry) => {
      registry.plugins[0]!.pendingCleanup = [{ kind: "obsolete-artifact", path: cleanupDir }];
    });
    const before = (await readPluginRegistry(paths.registryPath)).plugins;
    const journal = await createRemovalTransaction(paths, {
      kind: "uninstall",
      pluginIds: [pluginId],
      registryBefore: before,
      registryAfter: [],
      originals: [{ pluginId, path: join(paths.pluginsRoot, pluginId) }],
    });
    await stageRemovalTransaction(paths, journal);
    const registryBytesBeforeBoot = await readFile(paths.registryPath, "utf-8");
    const renamePath = vi.fn(async () => {
      throw Object.assign(new Error("injected reverse rename failure"), { code: "EACCES" });
    });

    await expect(preparePluginRegistryForBoot(paths, {
      removalReconcile: { renamePath, retry: { attempts: 1, sleep: async () => undefined } },
    })).resolves.toEqual({
      recovered: [],
      unresolved: [],
      removals: {
        restored: [],
        cleaned: [],
        unresolved: [{
          transactionId: journal.transactionId,
          reason: "injected reverse rename failure",
        }],
      },
      pendingRecoverySkipped: true,
    });
    expect(await readFile(paths.registryPath, "utf-8")).toBe(registryBytesBeforeBoot);
    expect(existsSync(cleanupDir)).toBe(true);
    expect(existsSync(journal.mappings[0]!.stagedPath)).toBe(true);

    await expect(preparePluginRegistryForBoot(paths)).resolves.toEqual({
      recovered: [pluginId],
      unresolved: [],
      removals: { restored: [journal.transactionId], cleaned: [], unresolved: [] },
      pendingRecoverySkipped: false,
    });
    expect(existsSync(join(paths.pluginsRoot, pluginId, "plugin.json"))).toBe(true);
    expect(existsSync(cleanupDir)).toBe(false);
    expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingCleanup).toBeUndefined();
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

  it.skipIf(process.platform === "win32")(
    "refuses predecessor recovery when the retained payload contains an unlisted executable symlink",
    async () => {
      const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
      const backupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
      await preparePendingPluginUpdate(paths, entry, {
        kind: "marketplace",
        recoveryBackupDir: backupDir,
        recoveryBackupMode: "rename",
      });
      await rename(join(paths.pluginsRoot, pluginId), backupDir);
      const outsideExecutable = join(root, "outside-executable");
      await writeFile(outsideExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      await symlink(outsideExecutable, join(backupDir, "dist", "injected-tool"));
      await mkdir(join(paths.pluginsRoot, pluginId), { recursive: true });
      await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "new payload");

      expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
      expect(existsSync(backupDir)).toBe(true);
      expect((await readPluginRegistry(paths.registryPath)).plugins[0]?.pendingUpdate).toBeDefined();
    },
  );

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

  it("keeps the original predecessor and grants across a crash during a superseding retry", async () => {
    const originalBackup = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    const retryBackup = join(paths.pluginsRoot, `.${pluginId}.old-00000000-0000-4000-8000-000000000002`);
    const original = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    original.approvedPluginAccess = { plugins: [{ pluginId: "trusted-peer", events: ["old.event"] }] };
    await writeFile(paths.registryPath, JSON.stringify({ version: 1, plugins: [original] }));
    await preparePendingPluginUpdate(paths, original, {
      kind: "marketplace",
      recoveryBackupDir: originalBackup,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), originalBackup);
    await mkdir(join(paths.pluginsRoot, pluginId, "dist"), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "2.0.0" }));
    await writeFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), "unresolved v2");

    const pendingBeforeRetry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    const originalPending = pendingBeforeRetry.pendingUpdate;
    await preparePendingPluginUpdate(paths, pendingBeforeRetry, {
      kind: "marketplace",
      recoveryBackupDir: retryBackup,
      recoveryBackupMode: "rename",
    });
    await rename(join(paths.pluginsRoot, pluginId), retryBackup);
    await mkdir(join(paths.pluginsRoot, pluginId, "dist"), { recursive: true });
    await writeFile(join(paths.pluginsRoot, pluginId, "plugin.json"), JSON.stringify({ id: pluginId, version: "3.0.0" }));
    await writeFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), "unpublished v3");

    const crashState = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    expect(crashState.pendingUpdate).toEqual(originalPending);
    expect(crashState.pendingCleanup).toEqual([
      { kind: "obsolete-artifact", path: retryBackup },
    ]);
    expect(crashState.approvedPluginAccess).toEqual(original.approvedPluginAccess);

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [pluginId], unresolved: [] });
    const recovered = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    expect(await readFile(join(paths.pluginsRoot, pluginId, "plugin.json"), "utf-8")).toBe(oldManifest);
    expect(recovered.approvedPluginAccess).toEqual(original.approvedPluginAccess);
    expect(recovered.pendingUpdate).toBeUndefined();
    expect(recovered.pendingCleanup).toBeUndefined();
    expect(existsSync(retryBackup)).toBe(false);
  });

  it("reports unresolved when cleanup succeeds but pending recovery remains unresolved", async () => {
    const entry = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    await preparePendingPluginUpdate(paths, entry, { kind: "marketplace" });
    await writeFile(join(paths.pluginsRoot, pluginId, "dist", "index.js"), "corrupted");
    const cleanupDir = join(paths.pluginsRoot, `.${pluginId}.old-${backupSuffix}`);
    await mkdir(cleanupDir);
    const registry = JSON.parse(await readFile(paths.registryPath, "utf-8")) as {
      plugins: Array<{ pendingCleanup?: unknown }>;
    };
    registry.plugins[0]!.pendingCleanup = [{ kind: "obsolete-artifact", path: cleanupDir }];
    await writeFile(paths.registryPath, JSON.stringify(registry));

    expect(await recoverPendingPluginUpdates(paths)).toEqual({ recovered: [], unresolved: [pluginId] });
    const unresolved = (await readPluginRegistry(paths.registryPath)).plugins[0]!;
    expect(unresolved.pendingUpdate).toBeDefined();
    expect(unresolved.pendingCleanup).toBeUndefined();
    expect(existsSync(cleanupDir)).toBe(false);
  });
});

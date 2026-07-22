import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { withFileLock } from "../../../lib/with-file-lock.js";

const [mode, registryPath, pluginId] = process.argv.slice(2);

function send(message: string): void {
  process.send?.(message);
}

if (!mode || !registryPath) throw new Error("mode and registry path are required");

if (mode === "hold-lock") {
  await withFileLock(`${registryPath}.lock-anchor`, async () => {
    send("locked");
    await new Promise<void>((resolve) => process.once("message", () => resolve()));
  });
  process.disconnect?.();
} else {
  if (mode === "fail-rename" || mode === "receipt-fail-rename" || mode === "pause-before-rename") {
    fs.renameSync = (() => {
      if (mode === "fail-rename" || mode === "receipt-fail-rename") {
        throw new Error("injected pre-rename failure");
      }
      send("staged");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error("unreachable");
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
  }
  if (mode === "committed-sync-error" || mode === "receipt-committed-sync-error") {
    const realFsyncSync = fs.fsyncSync;
    let fsyncCalls = 0;
    fs.fsyncSync = ((fd: number) => {
      fsyncCalls += 1;
      if (fsyncCalls === 2) throw new Error("injected parent directory sync failure");
      return realFsyncSync(fd);
    }) as typeof fs.fsyncSync;
    syncBuiltinESMExports();
  }
  if (mode === "receipt-committed-sync-error" || mode === "receipt-fail-rename") {
    if (!pluginId) throw new Error("plugin id is required");
    const { writeInstallReceipt } = await import("../../plugin-install-receipt.js");
    await writeInstallReceipt(registryPath, {
      schemaVersion: 2,
      pluginId,
      version: "2.0.0",
      installSource: "local-dev",
      artifactSha256: null,
      signerKeyId: null,
      installedAt: "2026-07-22T00:00:00.000Z",
      files: [{ path: "plugin.json", sha256: "abc" }],
    });
    process.disconnect?.();
    process.exit(0);
  }
  const { migratePluginRegistry, updatePluginRegistry } = await import("../../registry.js");
  if (mode === "migrate") {
    await migratePluginRegistry(registryPath);
  } else {
    if (!pluginId) throw new Error("plugin id is required");
    const transactionResult = await updatePluginRegistry(registryPath, (registry) => {
      const existing = registry.plugins.find((entry) => entry.id === pluginId);
      if (mode === "remove") {
        registry.plugins = registry.plugins.filter((entry) => entry.id !== pluginId);
      } else if (mode === "enable" || mode === "disable") {
        if (!existing) throw new Error(`plugin not found: ${pluginId}`);
        existing.enabled = mode === "enable";
      } else if (mode === "install") {
        if (existing) {
          existing.manifestPath = `${pluginId}/plugin.json`;
          existing.enabled = true;
          existing.installSource = "user";
        } else {
          registry.plugins.push({
            id: pluginId,
            manifestPath: `${pluginId}/plugin.json`,
            enabled: true,
            installSource: "user",
          });
        }
      } else {
        registry.plugins.push({ id: pluginId, manifestPath: `${pluginId}/plugin.json`, enabled: true });
      }
      return mode === "committed-sync-error" ? "committed-result" : undefined;
    });
    if (mode === "committed-sync-error" && transactionResult !== "committed-result") {
      throw new Error("committed registry transaction lost its result");
    }
  }
  process.disconnect?.();
}

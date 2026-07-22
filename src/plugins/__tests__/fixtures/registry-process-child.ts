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
  if (mode === "fail-rename" || mode === "pause-before-rename") {
    fs.renameSync = (() => {
      if (mode === "fail-rename") throw new Error("injected pre-rename failure");
      send("staged");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      throw new Error("unreachable");
    }) as typeof fs.renameSync;
    syncBuiltinESMExports();
  }
  const { migratePluginRegistry, updatePluginRegistry } = await import("../../registry.js");
  if (mode === "migrate") {
    await migratePluginRegistry(registryPath);
  } else {
    if (!pluginId) throw new Error("plugin id is required");
    await updatePluginRegistry(registryPath, (registry) => {
      registry.plugins.push({ id: pluginId, manifestPath: `${pluginId}/plugin.json`, enabled: true });
    });
  }
  process.disconnect?.();
}

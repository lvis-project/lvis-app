/**
 * Plugin storage layout — the security boundary inside a plugin root.
 *
 * `resolvePluginWritableRoot` is the single derivation every producer of
 * `ownerPluginSandboxRoot` uses. It must point at the plugin's data dir and
 * never at the plugin root, because the root holds the bundle the next load
 * imports into the Electron main process.
 */
import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  PLUGIN_DATA_DIR_NAME,
  PLUGIN_WORKER_RUN_DIR_NAME,
  resolvePluginWritableRoot,
} from "../plugin-storage-layout.js";
import { lvisHome } from "../../shared/lvis-home.js";

const PLUGIN_ID = "lvis-plugin-layout-fixture";

describe("resolvePluginWritableRoot", () => {
  it("resolves to the plugin's data dir, not the plugin root", () => {
    const pluginRoot = resolve(lvisHome(), "plugins", PLUGIN_ID);
    const writable = resolvePluginWritableRoot(PLUGIN_ID);
    expect(writable).toBe(resolve(pluginRoot, PLUGIN_DATA_DIR_NAME));
    expect(writable).not.toBe(pluginRoot);
  });

  it("leaves the plugin's own executable bundle and manifest outside the jail", () => {
    const pluginRoot = resolve(lvisHome(), "plugins", PLUGIN_ID);
    const writable = resolvePluginWritableRoot(PLUGIN_ID);
    for (const payload of ["dist", "dist/index.js", "plugin.json"]) {
      expect(resolve(pluginRoot, payload).startsWith(`${writable}/`)).toBe(false);
    }
  });

  it("leaves the host-allocated worker run dir outside the jail", () => {
    // Worker control sockets are host-created and host-owned; the plugin never
    // needs write access to them.
    const pluginRoot = resolve(lvisHome(), "plugins", PLUGIN_ID);
    const writable = resolvePluginWritableRoot(PLUGIN_ID);
    const runDir = resolve(pluginRoot, PLUGIN_WORKER_RUN_DIR_NAME);
    expect(runDir.startsWith(`${writable}/`)).toBe(false);
  });
});

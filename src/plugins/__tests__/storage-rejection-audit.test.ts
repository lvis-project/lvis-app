/**
 * Plugin-storage containment refusals must reach the audit trail on BOTH
 * `createPluginStorage` wirings.
 *
 * This file covers the plugin-webview bridge wiring:
 * `PluginRuntime.getPluginStorage()` — the function the `bridge.storage.get/set`
 * IPC handlers call (src/ipc/domains/plugins.ts). Those handlers only *reply*
 * to the calling webview when storage refuses, so the refusal record has to be
 * produced by the storage sink or it does not exist at all.
 *
 * The producer here is the real `PluginRuntime`: a real registry is loaded, the
 * real `ensureDataDir` picks the data root, and the refusal is triggered by a
 * real reparse point on disk — no trigger field is set by hand. The relative
 * path used is the exact string the IPC handler builds
 * (`ui-storage/<sanitized-key>.json`), which is the only shape a webview can
 * reach: `sanitizeStorageKey` restricts the key to `[A-Za-z0-9._-]+`, so the
 * lexical-escape branches are unreachable from a webview and the symlink
 * branches are not.
 *
 * The boot host-api-factory wiring is covered from its own real producer in
 * src/boot/steps/__tests__/plugin-runtime-hostapi-wiring.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeTestPluginRuntimeWithAudit,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";

// Windows can create directory junctions without Developer Mode or
// SeCreateSymbolicLinkPrivilege, so the escape is a real reparse point on
// every platform CI runs on (same seam as storage.test.ts).
const dirLinkType = process.platform === "win32" ? "junction" : "dir";

const PLUGIN_ID = "p-storage-audit";

describe("PluginRuntime.getPluginStorage — containment refusals are audited", () => {
  let fixture: TestPluginRuntimeFixture;
  let outsideDir: string;
  let auditEntries: Array<{ level: string; message: string; data?: unknown }>;

  beforeEach(async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "lvis-storage-audit-" });
    outsideDir = mkdtempSync(join(tmpdir(), "lvis-storage-audit-outside-"));
    auditEntries = [];
    await writeTestPlugin(fixture, {
      id: PLUGIN_ID,
      entry: "entry.mjs",
      entrySource:
        "export default async function createPlugin() {\n"
        + "  return { handlers: {}, start: async () => {}, stop: async () => {} };\n"
        + "}",
    });
    await writeTestPluginRegistry(fixture, [
      { id: PLUGIN_ID, manifestPath: join(fixture.pluginsRoot, PLUGIN_ID, "plugin.json") },
    ]);
  });

  afterEach(async () => {
    await rm(fixture.rootDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  /** The data root `ensurePluginDataDir` resolves for this plugin. */
  function pluginDataDir(): string {
    const dir = join(fixture.pluginsRoot, PLUGIN_ID, "data");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("emits plugin_storage_path_rejected when a webview read escapes via a planted symlink", async () => {
    // A real escape target with real content outside the sandbox root.
    writeFileSync(join(outsideDir, "tokens.json"), '{"stolen":true}', "utf-8");
    // The plugin plants `ui-storage` as a link to somewhere outside its root.
    symlinkSync(outsideDir, join(pluginDataDir(), "ui-storage"), dirLinkType);

    const runtime = makeTestPluginRuntimeWithAudit(fixture, auditEntries);
    await runtime.load();
    expect(runtime.listPluginIds()).toContain(PLUGIN_ID);

    const storage = runtime.getPluginStorage(PLUGIN_ID);
    expect(storage).toBeDefined();

    // Byte-for-byte the call the `lvis:plugin:storage:get` handler makes for
    // the webview key "tokens".
    await expect(storage!.readJson("ui-storage/tokens.json")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );

    const rejections = auditEntries.filter(
      (e) => e.message === "plugin_storage_path_rejected",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.level).toBe("error");
    expect(rejections[0]!.data).toMatchObject({
      pluginId: PLUGIN_ID,
      reason: "storage: rejected symlink escape",
    });
    // The record must carry where the escape resolved to, or an operator
    // cannot tell an escape attempt from a typo.
    const data = rejections[0]!.data as { real: string; target: string };
    expect(data.real).toBe(join(await realpath(outsideDir), "tokens.json"));
    expect(data.target).toContain("tokens.json");
  });

  it("emits plugin_storage_path_rejected when a webview write escapes via a planted symlink", async () => {
    symlinkSync(outsideDir, join(pluginDataDir(), "ui-storage"), dirLinkType);

    const runtime = makeTestPluginRuntimeWithAudit(fixture, auditEntries);
    await runtime.load();

    const storage = runtime.getPluginStorage(PLUGIN_ID);
    await expect(
      storage!.writeJson("ui-storage/planted.json", { evil: true }),
    ).rejects.toThrow(/symlink escapes plugin storage root/);

    expect(
      auditEntries.filter((e) => e.message === "plugin_storage_path_rejected"),
    ).toHaveLength(1);
  });

  it("stays silent for an in-sandbox round-trip", async () => {
    const runtime = makeTestPluginRuntimeWithAudit(fixture, auditEntries);
    await runtime.load();

    const storage = runtime.getPluginStorage(PLUGIN_ID);
    await storage!.writeJson("ui-storage/prefs.json", { theme: "dark" });
    await expect(storage!.readJson("ui-storage/prefs.json")).resolves.toEqual({
      theme: "dark",
    });

    expect(
      auditEntries.filter((e) => e.message === "plugin_storage_path_rejected"),
    ).toEqual([]);
  });
});

/**
 * uiCallable validation — post-redesign behavior.
 *
 * The legacy suffix-based "destructive verb" gate (and its
 * `allowManagedUnsigned` escape hatch for managed plugins) has been
 * REMOVED. uiCallable validation is now purely structural: every entry
 * must be a string declared in manifest.tools[]. Any verb suffix
 * (`_get`, `_delete`, `_drop`, …) is accepted regardless of install policy
 * type or signature status.
 *
 * Security model:
 *   - Code review + marketplace approval gate what ships.
 *   - Signature verification still gates *managed* plugin loading.
 *   - Destructive-action confirmation is the plugin developer's
 *     responsibility inside their own UI (see email_reply precedent).
 *
 * The `allowManagedUnsigned` option still exists in the constructor
 * signature but has NO EFFECT on uiCallable validation. The
 * `plugin_uiCallable_destructive_rejected` audit event is no longer emitted.
 *
 * These tests pin that new contract:
 *   1. managed + `_delete` in uiCallable + no verifier → LOADS.
 *   2. user + `_delete` in uiCallable → LOADS.
 *   3. allowManagedUnsigned=true is a no-op for uiCallable (both
 *      managed and user plugins load).
 *   4. No `plugin_uiCallable_destructive_rejected` audit entries are
 *      ever generated.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";

describe("PluginRuntime — uiCallable suffix-blocking removed", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;
  let auditEntries: Array<{ level: string; message: string; data?: unknown }>;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `lvis-ui-unsigned-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
    auditEntries = [];
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  async function writePlugin(id: string, manifestOverrides: Record<string, unknown> = {}): Promise<void> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "${id}_get": async () => "ok", "${id}_delete": async () => "ok" }, start: async () => {}, stop: async () => {} };
}`,
      "utf-8",
    );
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      description: "Test fixture.",
      entry: "entry.mjs",
      tools: [`${id}_get`, `${id}_delete`],
      ...manifestOverrides,
    };
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify(manifest), "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id, manifestPath: join(pluginDir, "plugin.json") }],
      }),
      "utf-8",
    );
  }

  function makeRuntime(opts: { allowManagedUnsigned?: boolean } = {}): PluginRuntime {
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      allowManagedUnsigned: opts.allowManagedUnsigned,
      auditLog: (level, message, data) => {
        auditEntries.push({ level, message, data });
      },
    });
  }

  it("managed plugin with any suffix loads successfully (no verifier needed)", async () => {
    await writePlugin("p_managed_default", {
      installPolicy: "admin",
      uiCallable: ["p_managed_default_delete"],
    });

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p_managed_default");
  });

  it("user plugin with any suffix loads successfully", async () => {
    await writePlugin("p_user_delete", {
      installPolicy: "user",
      uiCallable: ["p_user_delete_delete"],
    });

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p_user_delete");
  });

  it("allowManagedUnsigned has no effect on uiCallable validation (backward compat)", async () => {
    await writePlugin("p_managed_allow", {
      installPolicy: "admin",
      uiCallable: ["p_managed_allow_delete"],
    });
    await writePlugin("p_user_allow", {
      installPolicy: "user",
      uiCallable: ["p_user_allow_delete"],
    });

    // Rewrite the registry to include both plugins (writePlugin overwrites it).
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p_managed_allow", manifestPath: join(installedDir, "p_managed_allow", "plugin.json") },
          { id: "p_user_allow", manifestPath: join(installedDir, "p_user_allow", "plugin.json") },
        ],
      }),
      "utf-8",
    );

    const runtime = makeRuntime({ allowManagedUnsigned: true });
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p_managed_allow");
    expect(runtime.listPluginIds()).toContain("p_user_allow");
  });

  it("auditLog is NOT called for destructive suffix (no longer blocked)", async () => {
    await writePlugin("p_audit_check", {
      installPolicy: "user",
      uiCallable: ["p_audit_check_delete"],
    });

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p_audit_check");
    expect(
      auditEntries.some(
        (e) => e.message === "plugin_uiCallable_destructive_rejected",
      ),
    ).toBe(false);
  });
});

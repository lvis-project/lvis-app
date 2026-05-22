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
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  makeTestPluginRuntime,
  makeTestPluginRuntimeFixture,
  writeTestPlugin,
  writeTestPluginRegistry,
  type TestPluginRuntimeFixture,
} from "./test-helpers.js";

describe("PluginRuntime — uiCallable suffix-blocking removed", () => {
  let fixture: TestPluginRuntimeFixture;
  let auditEntries: Array<{ level: string; message: string; data?: unknown }>;

  beforeEach(async () => {
    fixture = await makeTestPluginRuntimeFixture({ prefix: "lvis-ui-unsigned-" });
    auditEntries = [];
  });

  afterEach(async () => {
    await rm(fixture.rootDir, { recursive: true, force: true });
  });

  async function writePlugin(id: string, manifestOverrides: Record<string, unknown> = {}): Promise<void> {
    const { manifestPath } = await writeTestPlugin(fixture, {
      id,
      entrySource: `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "${id}_get": async () => "ok",
      "${id}_delete": async () => "ok",
    },
    start: async () => {},
    stop: async () => {},
  };
}`,
      tools: [`${id}_get`, `${id}_delete`],
      manifest: manifestOverrides,
    });
    await writeTestPluginRegistry(fixture, [{ id, manifestPath }]);
  }

  function runtimeWithAudit(opts: { allowManagedUnsigned?: boolean } = {}) {
    return makeTestPluginRuntime(fixture, {
      allowManagedUnsigned: opts.allowManagedUnsigned,
      auditLog: (level, message, data) => {
        auditEntries.push({ level, message, data });
      },
    });
  }

  it("managed plugin with any suffix loads successfully (no verifier needed)", async () => {
    await writePlugin("p-managed-default", {
      installPolicy: "admin",
      tools: ["pmd_get", "pmd_delete"],
      uiCallable: ["pmd_delete"],
    });

    const runtime = runtimeWithAudit();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-managed-default");
  });

  it("user plugin with any suffix loads successfully", async () => {
    await writePlugin("p-user-delete", {
      installPolicy: "user",
      tools: ["pud_get", "pud_delete"],
      uiCallable: ["pud_delete"],
    });

    const runtime = runtimeWithAudit();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-user-delete");
  });

  it("allowManagedUnsigned has no effect on uiCallable validation (backward compat)", async () => {
    await writePlugin("p-managed-allow", {
      installPolicy: "admin",
      tools: ["pma_get", "pma_delete"],
      uiCallable: ["pma_delete"],
    });
    await writePlugin("p-user-allow", {
      installPolicy: "user",
      tools: ["pua_get", "pua_delete"],
      uiCallable: ["pua_delete"],
    });

    // Rewrite the registry to include both plugins (writePlugin overwrites it).
    await writeTestPluginRegistry(fixture, [
      {
        id: "p-managed-allow",
        manifestPath: join(fixture.pluginsRoot, "p-managed-allow", "plugin.json"),
      },
      {
        id: "p-user-allow",
        manifestPath: join(fixture.pluginsRoot, "p-user-allow", "plugin.json"),
      },
    ]);

    const runtime = runtimeWithAudit({ allowManagedUnsigned: true });
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-managed-allow");
    expect(runtime.listPluginIds()).toContain("p-user-allow");
  });

  it("auditLog is NOT called for destructive suffix (no longer blocked)", async () => {
    await writePlugin("p-audit-check", {
      installPolicy: "user",
      tools: ["pac_get", "pac_delete"],
      uiCallable: ["pac_delete"],
    });

    const runtime = runtimeWithAudit();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-audit-check");
    expect(
      auditEntries.some(
        (e) => e.message === "plugin_uiCallable_destructive_rejected",
      ),
    ).toBe(false);
  });
});

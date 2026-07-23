/**
 * uiActions security model — runtime scope enforcement.
 *
 * The runtime no longer blocks verbs by suffix. Instead:
 *   1. tools[] is the LLM registration surface.
 *   2. uiActions[] may name UI-only runtime methods that are not in tools[].
 *   3. callFromUi() re-checks the method is declared in that plugin's
 *      uiActions at invocation time (defense in depth against stale maps).
 *
 * Security properties come from:
 *   - code review of the plugin source,
 *   - marketplace approval before publish,
 *   - marketplace install receipt integrity before runtime load,
 * NOT from naming conventions. Any suffix (_delete, _remove, _send, _reply,
 * _create, _update, …) is permitted regardless of install policy. The
 * plugin developer is responsible for destructive-action confirmation UX in
 * their own renderer surface — see `index_remove_folder` which ships this way
 * today (note: `email_reply` is in tools[] only, not uiActions[]).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createNoopHostApiForTests, PluginRuntime } from "../runtime.js";
import { compileLegacyToolSurface } from "./test-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function writeTempPlugin(opts: {
  installPolicy: "admin" | "user";
  tools: string[];
  uiActions: Record<string, unknown>;
}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "lvis-ui-actions-"));
  const manifest = {
    id: `test-${Math.random().toString(36).slice(2, 8)}`,
    name: "uiActions Test",
    version: "1.0.0",
    description: "Test fixture.",
    publisher: "Test fixture",
    entry: "dist/index.js",
    // Pure v6: the legacy tools[]/uiActions surface is compiled to Tool objects
    // with explicit visibility (uiActions-only → ["app"]).
    tools: compileLegacyToolSurface({ tools: opts.tools, uiActions: opts.uiActions as Record<string, { description?: string }> }),
    installPolicy: opts.installPolicy,
  };
  writeFileSync(join(root, "plugin.json"), JSON.stringify(manifest, null, 2));
  return join(root, "plugin.json");
}

// Previously rejected on user plugins; must now be accepted on every
// install policy so plugin authors can own their confirmation UX.
const PREVIOUSLY_BLOCKED_VERBS = [
  "thing_delete",
  "thing_remove",
  "thing_send",
  "thing_destroy",
  "thing_erase",
  "thing_purge",
  "thing_reply",
  "thing_create",
  "thing_update",
  "thing_drop",
  "thing_wipe",
  "thing_reset",
  "thing_revoke",
  "thing_clear",
  "thing_archive",
  "thing_truncate",
];

describe("uiActions runtime-method validation", () => {
  it("accepts UI-only methods that are not in tools[]", async () => {
    const manifestPath = await writeTempPlugin({
      installPolicy: "user",
      tools: ["foo_get"],
      uiActions: { foo_get: {}, foo_missing: {} },
    });
    const rt = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [manifestPath],
    });
    const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
    await expect(parse(manifestPath)).resolves.toBeDefined();
  });

  // NOTE (#885 Phase R): the "rejects non-string uiActions entries" test was
  // removed — `uiActions` is no longer a manifest field; surface membership is
  // expressed by each Tool's `_meta.ui.visibility`, so there is no uiActions-map
  // structural validation left to exercise.

  it("accepts when every uiActions entry is also declared in tools[]", async () => {
    const manifestPath = await writeTempPlugin({
      installPolicy: "user",
      tools: ["foo_get", "foo_list"],
      uiActions: { foo_get: {}, foo_list: {} },
    });
    const rt = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [manifestPath],
    });
    const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
    await expect(parse(manifestPath)).resolves.toBeDefined();
  });
});

describe("uiActions accepts any suffix regardless of install policy", () => {
  for (const verb of PREVIOUSLY_BLOCKED_VERBS) {
    it(`[user] accepts '${verb}' when it is in tools[]`, async () => {
      const manifestPath = await writeTempPlugin({
        installPolicy: "user",
        tools: [verb],
        uiActions: { [verb]: {} },
      });
      const rt = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
        hostRoot: resolve(__dirname, "..", "..", ".."),
        manifestPaths: [manifestPath],
      });
      const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
      await expect(parse(manifestPath)).resolves.toBeDefined();
    });

    it(`[admin] accepts '${verb}' when it is in tools[]`, async () => {
      const manifestPath = await writeTempPlugin({
        installPolicy: "admin",
        tools: [verb],
        uiActions: { [verb]: {} },
      });
      const rt = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
        hostRoot: resolve(__dirname, "..", "..", ".."),
        manifestPaths: [manifestPath],
      });
      const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
      await expect(parse(manifestPath)).resolves.toBeDefined();
    });
  }
});

describe("callFromUi scope enforcement", () => {
  it("throws when method is unknown", async () => {
    const rt = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [],
    });
    await expect(rt.callFromUi("nonexistent_method")).rejects.toThrow(/not found/);
  });

  it("throws when method is declared in tools[] but missing from uiActions[]", async () => {
    // Build a runtime with a hand-crafted plugin map so we can exercise
    // callFromUi without spinning up a real plugin entry file.
    const rt = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [],
    });
    const internals = rt as unknown as {
      plugins: Map<string, { manifest: unknown }>;
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    // #885 v6 — normalized manifest: foo_get is UI-invokable (visibility ["app"]),
    // foo_delete is model-only (["model"]) so it is NOT a declared UI action.
    internals.plugins.set("test.plugin", {
      manifest: {
        tools: [
          { name: "foo_get", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
          { name: "foo_delete", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
        ],
      },
    } as unknown as never);
    internals.methodMap.set("foo_delete", {
      pluginId: "test.plugin",
      handler: async () => "should-never-run",
    });
    internals.methodMap.set("foo_get", {
      pluginId: "test.plugin",
      handler: async () => "ok",
    });
    rt.setToolInvocationDelegate((method, payload) => {
      const entry = internals.methodMap.get(method);
      if (!entry) throw new Error(`Plugin method not found: ${method}`);
      return entry.handler(payload);
    });

    await expect(rt.callFromUi("foo_delete")).rejects.toThrow(/not declared as a UI action/);
    await expect(rt.callFromUi("foo_get")).resolves.toBe("ok");
  });

  it("fails closed when a UI action method has no executor delegate", async () => {
    const rt = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [],
    });
    const internals = rt as unknown as {
      plugins: Map<string, { manifest: unknown }>;
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    // #885 v6 — foo_get is a declared UI action (visibility ["app"]).
    internals.plugins.set("test.plugin", {
      manifest: {
        tools: [
          { name: "foo_get", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
        ],
      },
    } as unknown as never);
    internals.methodMap.set("foo_get", {
      pluginId: "test.plugin",
      handler: async () => "should-never-run",
    });

    await expect(rt.callFromUi("foo_get")).rejects.toThrow(/executor is not wired/);
  });
});

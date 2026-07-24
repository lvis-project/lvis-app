/** Pure Tool app-visibility and runtime invocation-scope enforcement. */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  pureTool,
  TestPluginRuntime as PluginRuntime,
} from "./test-helpers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function writeTempPlugin(opts: {
  installPolicy: "admin" | "user";
  modelTools: string[];
  appTools: string[];
}): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "lvis-ui-actions-"));
  const manifest = {
    id: `test-${Math.random().toString(36).slice(2, 8)}`,
    name: "App visibility test",
    version: "1.0.0",
    description: "Test fixture.",
    publisher: "Test fixture",
    entry: "dist/index.js",
    tools: [...new Set([...opts.modelTools, ...opts.appTools])].map((name) =>
      pureTool(name, [
        ...(opts.modelTools.includes(name) ? (["model"] as const) : []),
        ...(opts.appTools.includes(name) ? (["app"] as const) : []),
      ])),
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

describe("app-visible Tool runtime-method validation", () => {
  it("accepts app-only Tools that are not model-visible", async () => {
    const manifestPath = await writeTempPlugin({
      installPolicy: "user",
      modelTools: ["foo_get"],
      appTools: ["foo_get", "foo_missing"],
    });
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [manifestPath],
    });
    const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
    await expect(parse(manifestPath)).resolves.toBeDefined();
  });

  it("accepts Tools visible to both model and app", async () => {
    const manifestPath = await writeTempPlugin({
      installPolicy: "user",
      modelTools: ["foo_get", "foo_list"],
      appTools: ["foo_get", "foo_list"],
    });
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [manifestPath],
    });
    const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
    await expect(parse(manifestPath)).resolves.toBeDefined();
  });
});

describe("app-visible Tool names do not infer destructive authority", () => {
  for (const verb of PREVIOUSLY_BLOCKED_VERBS) {
    it(`[user] accepts '${verb}' when it is in tools[]`, async () => {
      const manifestPath = await writeTempPlugin({
        installPolicy: "user",
        modelTools: [verb],
        appTools: [verb],
      });
      const rt = new PluginRuntime({
        hostRoot: resolve(__dirname, "..", "..", ".."),
        manifestPaths: [manifestPath],
      });
      const parse = (rt as unknown as { readManifest(p: string): Promise<unknown> }).readManifest.bind(rt);
      await expect(parse(manifestPath)).resolves.toBeDefined();
    });

    it(`[admin] accepts '${verb}' when it is in tools[]`, async () => {
      const manifestPath = await writeTempPlugin({
        installPolicy: "admin",
        modelTools: [verb],
        appTools: [verb],
      });
      const rt = new PluginRuntime({
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
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [],
    });
    await expect(rt.callFromUi("nonexistent_method")).rejects.toThrow(/not found/);
  });

  it("throws when a method is model-visible but not app-visible", async () => {
    // Build a runtime with a hand-crafted plugin map so we can exercise
    // callFromUi without spinning up a real plugin entry file.
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [],
    });
    const internals = rt as unknown as {
      plugins: Map<string, { manifest: unknown }>;
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    // foo_get is app-visible; foo_delete is model-only.
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

    await expect(rt.callFromUi("foo_delete")).rejects.toThrow(/not an app-visible Tool/);
    await expect(rt.callFromUi("foo_get")).resolves.toBe("ok");
  });

  it("fails closed when an app-visible Tool has no executor delegate", async () => {
    const rt = new PluginRuntime({
      hostRoot: resolve(__dirname, "..", "..", ".."),
      manifestPaths: [],
    });
    const internals = rt as unknown as {
      plugins: Map<string, { manifest: unknown }>;
      methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
    };
    // foo_get is app-visible.
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

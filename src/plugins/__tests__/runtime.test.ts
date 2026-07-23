import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createNoopHostApiForTests, PluginRuntime } from "../runtime.js";
import { PluginPhase } from "../lifecycle-log.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";
import {
  hashReceiptFiles,
  writeInstallReceipt,
} from "../plugin-install-receipt.js";
import {
  withAllPluginInstallLocks,
  withPluginInstallLock,
} from "../install-lifecycle.js";
import { uninstallPluginWithLifecycle } from "../uninstall-lifecycle.js";
import { mkdtempSync } from "node:fs";
import {
  makeTestPluginEntrySource,
  makeTestPluginRuntime,
  writeTestPlugin,
  writeTestPluginRegistry,
} from "./test-helpers.js";

/**
 * Phase 1.5 F-round §F5: direct unit tests for `PluginRuntime.disable()`.
 * Uses a real tmp-dir fixture with a minimal ESM plugin entry so the full
 * load → disable path is exercised (not mocks).
 */
describe("PluginRuntime.disable", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-runtime-"));
    // pluginsRoot — every install lives at <pluginsRoot>/<id>/plugin.json.
    // The registry sits at the root of pluginsRoot.
    installedDir = join(testDir, "plugins");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeFakePlugin(
    id: string,
    installPolicy?: "admin" | "user",
  ): Promise<string> {
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_hello`;
    const manifest: Record<string, unknown> = {};
    if (installPolicy) manifest.installPolicy = installPolicy;
    const { manifestPath } = await writeTestPlugin({
      rootDir: testDir,
      pluginsRoot: installedDir,
      registryPath,
    }, {
      id,
      tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      entrySource: makeTestPluginEntrySource({ [methodName]: JSON.stringify(`hi-${id}`) }),
      manifest,
    });
    return manifestPath;
  }

  function makeRuntime(): PluginRuntime {
    const guard = new PluginDeploymentGuard({ registryPath, pluginsRoot: installedDir });
    return makeTestPluginRuntime({
      rootDir: testDir,
      registryPath,
      pluginsRoot: installedDir,
    }, {
      deploymentGuard: guard,
    });
  }

  async function writePluginWithEntry(
    id: string,
    methodName: string,
    entrySource: string,
    manifest: Record<string, unknown> = {},
  ): Promise<string> {
    const { manifestPath } = await writeTestPlugin({
      rootDir: testDir,
      pluginsRoot: installedDir,
      registryPath,
    }, {
      id,
      tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      entrySource,
      manifest,
    });
    return manifestPath;
  }

  it("disable removes methods + marks registry enabled=false for user plugin", async () => {
    const manifestPath = await writeFakePlugin("p-user");
    await writeTestPluginRegistry({ registryPath }, [{ id: "p-user", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("p-user");
    expect(runtime.listToolNames()).toContain("p_user_hello");

    await runtime.disable("p-user");

    expect(runtime.listPluginIds()).not.toContain("p-user");
    expect(runtime.listToolNames()).not.toContain("p_user_hello");

    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find((p: { id: string }) => p.id === "p-user");
    expect(entry.enabled).toBe(false);
  });

  it("disable rejects managed plugin with guard error and leaves state unchanged", async () => {
    const manifestPath = await writeFakePlugin("p-managed", "admin");
    await writeTestPluginRegistry({ registryPath }, [{ id: "p-managed", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    await expect(runtime.disable("p-managed", "user")).rejects.toThrow(/Admin plugin/);

    expect(runtime.listPluginIds()).toContain("p-managed");
    expect(runtime.listToolNames()).toContain("p_managed_hello");

    // registry should NOT have enabled=false
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find((p: { id: string }) => p.id === "p-managed");
    expect(entry.enabled).toBe(true);
  });

  it("disable allows it-admin actor to disable a managed plugin", async () => {
    const manifestPath = await writeFakePlugin("p-managed", "admin");
    await writeTestPluginRegistry({ registryPath }, [{ id: "p-managed", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    await runtime.disable("p-managed", "it-admin");

    expect(runtime.listPluginIds()).not.toContain("p-managed");
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find((p: { id: string }) => p.id === "p-managed");
    expect(entry.enabled).toBe(false);
  });

  it("disable throws 'not found' for unknown pluginId without mutating state", async () => {
    const manifestPath = await writeFakePlugin("p-existing");
    await writeTestPluginRegistry({ registryPath }, [{ id: "p-existing", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    await expect(runtime.disable("p-missing")).rejects.toThrow(/not found/i);

    // Existing plugin still loaded
    expect(runtime.listPluginIds()).toContain("p-existing");
  });

  it("plugin with kebab-case id (example-plugin) and underscore methods loads correctly", async () => {
    // Plugin ID must use kebab-case (SDK v5.11.0 pattern ^[a-z][a-z0-9-]*$)
    // Tool names (methods[]) must still be underscore-only (LLM tool name namespace)
    const pluginId = "example-plugin";
    const pluginDir = join(installedDir, "com-example-test");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: { "com_example_test_hello": async () => "hi" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );

    const manifest = { id: pluginId, name: "Test", version: "1.0.0", entry: "entry.mjs", tools: [{ name: "com_example_test_hello", description: "com_example_test_hello tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }], description: "Test plugin fixture.", publisher: "Test fixture" };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [{ id: pluginId, manifestPath, enabled: true }]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("example-plugin");
    expect(runtime.listToolNames()).toContain("com_example_test_hello");
  });

  it("plugin with dot-notation method name is dropped fail-soft with a clear error", async () => {
    // Methods are LLM tool names and must not contain dots
    const pluginDir = join(installedDir, "bad-plugin");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "bad.method": async () => "fail" } };
}
`,
      "utf-8",
    );

    const manifest = { id: "bad-plugin", name: "Bad", version: "1.0.0", entry: "entry.mjs", tools: ["bad.method"], description: "Test fixture.", publisher: "Test fixture" };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [{ id: "bad-plugin", manifestPath, enabled: true }]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("bad-plugin");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("plugin with method name starting with digit is dropped fail-soft", async () => {
    const pluginDir = join(installedDir, "bad-leading-digit");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "1bad_name": async () => "fail" } };
}
`,
      "utf-8",
    );

    const manifest = { id: "bad-leading-digit", name: "Bad", version: "1.0.0", entry: "entry.mjs", tools: ["1bad_name"], description: "Test fixture.", publisher: "Test fixture" };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [{ id: "bad-leading-digit", manifestPath, enabled: true }]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("bad-leading-digit");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("plugin with hyphen in method name is dropped fail-soft", async () => {
    const pluginDir = join(installedDir, "bad-hyphen");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { "bad-name": async () => "fail" } };
}
`,
      "utf-8",
    );

    const manifest = { id: "bad-hyphen", name: "Bad", version: "1.0.0", entry: "entry.mjs", tools: ["bad-name"], description: "Test fixture.", publisher: "Test fixture" };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [{ id: "bad-hyphen", manifestPath, enabled: true }]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("bad-hyphen");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("plugin missing description is dropped with an error (Phase 1 MUST field)", async () => {
    const pluginDir = join(installedDir, "no-description");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { no_desc_ping: async () => "pong" } };
}`,
      "utf-8",
    );

    const manifest = { id: "no-description", name: "No Desc", version: "1.0.0", entry: "entry.mjs", tools: [{ name: "no_desc_ping", description: "no_desc_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }] };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [{ id: "no-description", manifestPath, enabled: true }]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("no-description");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("plugin with empty-string description is dropped with an error (Phase 1 MUST non-empty)", async () => {
    const pluginDir = join(installedDir, "empty-description");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return { handlers: { empty_desc_ping: async () => "pong" } };
}`,
      "utf-8",
    );

    const manifest = { id: "empty-description", name: "Empty Desc", version: "1.0.0", entry: "entry.mjs", tools: [{ name: "empty_desc_ping", description: "empty_desc_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }], description: "", publisher: "Test fixture" };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeTestPluginRegistry({ registryPath }, [{ id: "empty-description", manifestPath, enabled: true }]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("empty-description");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/manifest read failed/),
      expect.objectContaining({ phase: PluginPhase.VALIDATION_FAIL }),
    );
    errSpy.mockRestore();
  });

  it("callFromUi rejects tools not declared app-visible in _meta.ui.visibility", async () => {
    // Renderer-originated plugin calls must only reach app-visible tools — the
    // ones whose `_meta.ui.visibility` includes "app". Everything else has to go
    // through ConversationLoop (scope + permission + expansion caps).
    const pluginDir = join(installedDir, "ui-actions");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "uic_get": async () => "public-ok",
      "uic_private": async () => "private-ok",
    },
  };
}
`,
      "utf-8",
    );

    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "ui-actions",
        name: "ui-actions",
        version: "1.0.0",
        description: "Test fixture.",
        publisher: "Test fixture",
        entry: "entry.mjs",
        tools: [
          // uic_get is UI-invokable (dual) — reachable from callFromUi.
          { name: "uic_get", description: "uic_get tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } },
          // uic_private is model-only — NOT reachable from the UI bypass.
          { name: "uic_private", description: "uic_private tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model"] } } },
        ],
      }),
      "utf-8",
    );

    await writeTestPluginRegistry({ registryPath }, [{ id: "ui-actions", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.startAll();
    const delegate = vi.fn((method, payload) => runtime.call(method, payload));
    runtime.setToolInvocationDelegate(delegate);

    await expect(runtime.callFromUi("uic_get", undefined, { userAction: true })).resolves.toBe("public-ok");
    expect(delegate).toHaveBeenCalledWith(
      "uic_get",
      undefined,
      expect.objectContaining({
        origin: "ui",
        ownerPluginId: "ui-actions",
        userAction: true,
      }),
    );
    await expect(runtime.callFromUi("uic_private")).rejects.toThrow(
      /not declared as a UI action/,
    );
    // Normal call() path (ConversationLoop) still works for both.
    await expect(runtime.call("uic_private")).resolves.toBe("private-ok");
  });

  it("callFromUi can invoke UI-only methods that are not LLM tools", async () => {
    const pluginDir = join(installedDir, "ui-only-method");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "uio_upload_chunk": async () => "ui-only-ok",
    },
  };
}
`,
      "utf-8",
    );

    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "ui-only-method",
        name: "ui-only-method",
        version: "1.0.0",
        description: "Test fixture.",
        publisher: "Test fixture",
        entry: "entry.mjs",
        // UI-only method: app-only visibility, not model-visible (not an LLM tool).
        tools: [
          { name: "uio_upload_chunk", description: "uio_upload_chunk tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["app"] } } },
        ],
      }),
      "utf-8",
    );

    await writeTestPluginRegistry({ registryPath }, [{ id: "ui-only-method", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.startAll();
    runtime.setToolInvocationDelegate((method, payload) => runtime.call(method, payload));

    await expect(runtime.callFromUi("uio_upload_chunk")).resolves.toBe("ui-only-ok");
  });

  it("registerDisposer callbacks fire on disable() and not thereafter", async () => {
    const manifestPath = await writeFakePlugin("p-disposer");
    await writeTestPluginRegistry({ registryPath }, [{ id: "p-disposer", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    let calls = 0;
    const dispose = () => { calls += 1; };
    runtime.registerDisposer("p-disposer", dispose);

    await runtime.disable("p-disposer");
    expect(calls).toBe(1);
  });

  it("exposes capability/manifest/ipc binding metadata from loaded plugins", async () => {
    const pluginDir = join(installedDir, "meta-plugin");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "meta_ping": async () => "pong",
    },
  };
}
`,
      "utf-8",
    );

    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "meta-plugin",
        name: "meta-plugin",
        version: "1.0.0",
        description: "Test fixture.",
        publisher: "Test fixture",
        entry: "entry.mjs",
        tools: [{ name: "meta_ping", description: "meta_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        capabilities: ["worker-client"],
      }),
      "utf-8",
    );

    await writeTestPluginRegistry({ registryPath }, [{ id: "meta-plugin", manifestPath, enabled: true }]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.findPluginIdByCapability("worker-client")).toBe("meta-plugin");
    expect(runtime.listPluginIdsByCapability("worker-client")).toEqual(["meta-plugin"]);

    const manifest = runtime.getPluginManifest("meta-plugin");
    expect(manifest?.capabilities).toEqual(["worker-client"]);
  });

  describe("PluginHostApi cross-plugin isolation", () => {
    it("does not synthesize a cross-plugin callTool surface", async () => {
      const pluginDir = join(installedDir, "calltool-plugin");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "entry.mjs"),
        `export default async function createPlugin(ctx) {
  return { handlers: { "calltool_ping": async () => "pong" } };
}
`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify({ id: "calltool-plugin", name: "calltool-plugin", version: "1.0.0", entry: "entry.mjs", tools: [{ name: "calltool_ping", description: "calltool_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }], description: "Test fixture.", publisher: "Test fixture" }),
        "utf-8",
      );
      await writeTestPluginRegistry({ registryPath }, [{ id: "calltool-plugin", manifestPath, enabled: true }]);

      let injectedHostApi: Record<string, unknown> | undefined;

      const guard = new PluginDeploymentGuard({ registryPath, pluginsRoot: installedDir });
      const runtime = new PluginRuntime({
        hostRoot: testDir,
        registryPath,
        deploymentGuard: guard,
        pluginsRoot: installedDir,
        createHostApi: (_pluginId, _manifest) => {
          const hostApi = {
            registerKeywords: () => {},
            emitEvent: () => {},
            onEvent: () => () => {},
            saveMemory: async () => {},
            getSecret: () => null,
            callLlm: async () => { throw new Error("not available"); },
            logEvent: () => {},
            onShutdown: () => {},
          };
          injectedHostApi = hostApi;
          return hostApi;
        },
      });
      await runtime.startAll();

      // The plugin's own tool remains loaded, but HostApi has no direct delegate.
      expect(runtime.listToolNames()).toContain("calltool_ping");
      expect(injectedHostApi).not.toHaveProperty("callTool");
    });

    it("PluginRuntime.call still returns Promise<T> for the plugin's own tool", async () => {
      const pluginDir = join(installedDir, "calltool-delegate");
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "entry.mjs"),
        `export default async function createPlugin(ctx) {
  return { handlers: { "calltool_echo": async (payload) => ({ echoed: payload }) } };
}
`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify({ id: "calltool-delegate", name: "calltool-delegate", version: "1.0.0", entry: "entry.mjs", tools: [{ name: "calltool_echo", description: "calltool_echo tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }], description: "Test fixture.", publisher: "Test fixture" }),
        "utf-8",
      );
      await writeTestPluginRegistry({ registryPath }, [{ id: "calltool-delegate", manifestPath, enabled: true }]);

      const guard = new PluginDeploymentGuard({ registryPath, pluginsRoot: installedDir });
      const runtime = new PluginRuntime({
        hostRoot: testDir,
        registryPath,
        deploymentGuard: guard,
        pluginsRoot: installedDir,
        createHostApi: (_pluginId, _manifest) => ({
          registerKeywords: () => {},
          emitEvent: () => {},
          onEvent: () => () => {},
          saveMemory: async () => {},
          getSecret: () => null,
          callLlm: async () => { throw new Error("not available"); },
          logEvent: () => {},
          onShutdown: () => {},
        }),
      });
      await runtime.startAll();

      // The runtime's own invocation path still returns Promise<T>.
      const result = await runtime.call("calltool_echo", { msg: "hello" });
      expect(result).toEqual({ echoed: { msg: "hello" } });

      // Return value is a Promise
      const promise = runtime.call("calltool_echo", { msg: "world" });
      expect(promise).toBeInstanceOf(Promise);
      await expect(promise).resolves.toEqual({ echoed: { msg: "world" } });
    });
  });

  it("enforces narrow cross-plugin event access for orchestrator plugins", async () => {
    const writePlugin = async (
      id: string,
      methodName: string,
      extraManifest?: Record<string, unknown>,
    ): Promise<string> => {
      const pluginDir = join(installedDir, id);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "entry.mjs"),
        `export default async function createPlugin() {
  return {
    handlers: { "${methodName}": async () => "${id}" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          id,
          name: id,
          version: "1.0.0",
          description: "Test fixture.",
          publisher: "Test fixture",
          entry: "entry.mjs",
          tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
          ...extraManifest,
        }),
        "utf-8",
      );
      return manifestPath;
    };

    const workManifestPath = await writePlugin(
      "work-assistant",
      "work_assistant_ping",
      {
        emittedEvents: ["work_assistant.snapshot.requested"],
        pluginAccess: {
          plugins: [
            { pluginId: "email", events: ["email.action.needed"] },
            { pluginId: "meeting", events: ["meeting.summary.created", "meeting.ended"] },
            { pluginId: "ms-graph", events: ["ms-graph.snapshot.ready"] },
          ],
        },
      },
    );
    const calendarManifestPath = await writePlugin("calendar", "calendar_today");
    const emailManifestPath = await writePlugin("email", "email_ping");
    const meetingManifestPath = await writePlugin("meeting", "meeting_ping");
    const msGraphManifestPath = await writePlugin("ms-graph", "msgraph_ping", {
      emittedEvents: ["ms-graph.snapshot.ready"],
      pluginAccess: {
        plugins: [
          { pluginId: "work-assistant", events: ["work_assistant.snapshot.requested"] },
        ],
      },
    });
    await writeTestPluginRegistry({ registryPath }, [
      {
        id: "work-assistant",
        manifestPath: workManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [
            { pluginId: "email", events: ["email.action.needed"] },
            { pluginId: "meeting", events: ["meeting.summary.created", "meeting.ended"] },
            { pluginId: "ms-graph", events: ["ms-graph.snapshot.ready"] },
          ],
        },
      },
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
      { id: "meeting", manifestPath: meetingManifestPath, enabled: true },
      {
        id: "ms-graph",
        manifestPath: msGraphManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [
            { pluginId: "work-assistant", events: ["work_assistant.snapshot.requested"] },
          ],
        },
      },
    ]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(() => runtime.assertPluginEventAccess("work-assistant", "email.action.needed")).not.toThrow();
    expect(() => runtime.assertPluginEventAccess("work-assistant", "meeting.summary.created")).not.toThrow();
    expect(() => runtime.assertPluginEventAccess("work-assistant", "ms-graph.snapshot.ready")).not.toThrow();
    expect(() => runtime.assertPluginEventAccess("ms-graph", "work_assistant.snapshot.requested")).not.toThrow();
    expect(() => runtime.assertPluginEventAccess("calendar", "work_assistant.snapshot.requested")).toThrow(/not allowed/i);
    expect(() => runtime.assertPluginEventAccess("calendar", "email.action.needed")).toThrow(/not allowed/i);
  });

  it("allows work-assistant to subscribe to granted calendar events (P4 detector grants)", async () => {
    // Regression net for the host catalog ↔ registry grants paired
    // with the overlay-trigger plugin's calendar-* detectors:
    //   - `calendar-event-detector` (PR #7) → `calendar.event.upcoming`
    //   - `calendar-conflict-detector` (PR-C) → `calendar.event.conflict.detected`
    // Without these grants the overlay-trigger plugin throws on boot at the
    // first `hostApi.onEvent("calendar.event.<name>", ...)` call.
    // Locks both the positive (granted) and negative (event not in
    // scope, e.g. `calendar.event.starting`) paths so a future catalog
    // edit that drops events from the array doesn't silently break the
    // overlay trigger flow.
    const writePlugin = async (
      id: string,
      methodName: string,
      extraManifest: Record<string, unknown> = {},
    ): Promise<string> => {
      const pluginDir = join(installedDir, id);
      await mkdir(pluginDir, { recursive: true });
      const entryPath = join(pluginDir, "entry.js");
      await writeFile(
        entryPath,
        `export default async function createPlugin(ctx) { return { handlers: { ${methodName}: async () => "ok" } }; }`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      const manifest: Record<string, unknown> = {
        id,
        name: id,
        version: "1.0.0",
        description: "Test fixture.",
        publisher: "Test fixture",
        installPolicy: "user",
        entry: relative(pluginDir, entryPath),
        tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        ...extraManifest,
      };
      await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
      return manifestPath;
    };

    const grantedEvents = [
      "calendar.event.upcoming",
      "calendar.event.conflict.detected",
    ];
    const workManifestPath = await writePlugin("work-assistant", "work_assistant_ping", {
      pluginAccess: {
        plugins: [
          {
            pluginId: "calendar",
            events: grantedEvents,
          },
        ],
      },
    });
    const calendarManifestPath = await writePlugin("calendar", "calendar_today");
    await writeTestPluginRegistry({ registryPath }, [
      {
        id: "work-assistant",
        manifestPath: workManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [
            {
              pluginId: "calendar",
              events: grantedEvents,
            },
          ],
        },
      },
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
    ]);

    const runtime = makeRuntime();
    await runtime.load();

    // Granted path: each event in the grant is allowed.
    for (const ev of grantedEvents) {
      expect(() =>
        runtime.assertPluginEventAccess("work-assistant", ev),
      ).not.toThrow();
    }
    // Negative path — least-privilege: only the events explicitly
    // listed in the grant pass. `calendar.event.starting` is also a
    // calendar event but NOT in the grant, so the runtime denies.
    expect(() =>
      runtime.assertPluginEventAccess("work-assistant", "calendar.event.starting"),
    ).toThrow(/not allowed/i);
  });

  it("allows load-time event subscriptions when manifest pluginAccess is declared", async () => {
    const calendarManifestPath = await writePluginWithEntry(
      "calendar",
      "calendar_today",
      `export default async function createPlugin({ hostApi }) {
  hostApi.onEvent("email.analyzed", () => {});
  return {
    handlers: { "calendar_today": async () => "calendar" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      {
        pluginAccess: {
          plugins: [{ pluginId: "email", events: ["email.analyzed"] }],
        },
      },
    );
    const emailManifestPath = await writePluginWithEntry(
      "email",
      "email_ping",
      `export default async function createPlugin() {
  return {
    handlers: { "email_ping": async () => "email" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
    );

    await writeTestPluginRegistry({ registryPath }, [
      {
        id: "calendar",
        manifestPath: calendarManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [{ pluginId: "email", events: ["email.analyzed"] }],
        },
      },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
    ]);

    let runtime!: PluginRuntime;
    runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      deploymentGuard: new PluginDeploymentGuard({ registryPath, pluginsRoot: installedDir }),
      createHostApi: (pluginId) => ({
        registerKeywords: () => {},
        emitEvent: () => {},
        onEvent: (type) => runtime.assertPluginEventAccess(pluginId, type),
        getSecret: () => null,
      } as unknown as import("../types.js").PluginHostApi),
    });
    await expect(runtime.load()).resolves.toBeUndefined();
    expect(() => runtime.assertPluginEventAccess("calendar", "email.analyzed")).not.toThrow();
  });

  it("blocks load-time event subscriptions to later-loaded plugins without pluginAccess", async () => {
    const calendarManifestPath = await writePluginWithEntry(
      "calendar",
      "calendar_today",
      `export default async function createPlugin({ hostApi }) {
  hostApi.onEvent("email.analyzed", () => {});
  return {
    handlers: { "calendar_today": async () => "calendar" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
    );
    const emailManifestPath = await writePluginWithEntry(
      "email",
      "email_ping",
      `export default async function createPlugin() {
  return {
    handlers: { "email_ping": async () => "email" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
    );

    await writeTestPluginRegistry({ registryPath }, [
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
    ]);

    let runtime!: PluginRuntime;
    runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      deploymentGuard: new PluginDeploymentGuard({ registryPath, pluginsRoot: installedDir }),
      createHostApi: (pluginId) => ({
        registerKeywords: () => {},
        emitEvent: () => {},
        onEvent: (type) => runtime.assertPluginEventAccess(pluginId, type),
        getSecret: () => null,
      } as unknown as import("../types.js").PluginHostApi),
    });
    await expect(runtime.load()).rejects.toThrow(/not allowed/i);
  });

  it("blocks plugins from emitting events owned by another plugin", async () => {
    const calendarManifestPath = await writeFakePlugin("calendar");
    const emailManifestPath = await writeFakePlugin("email");

    await writeTestPluginRegistry({ registryPath }, [
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
    ]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(() => runtime.assertPluginEventEmitAccess("email", "email.analyzed")).not.toThrow();
    expect(() => runtime.assertPluginEventEmitAccess("calendar", "email.analyzed")).toThrow(/not allowed to emit/i);
  });

  it("drops plugins whose required capabilities are not provided by enabled manifests", async () => {
    const providerDir = join(installedDir, "cap-provider");
    await mkdir(providerDir, { recursive: true });
    await writeFile(
      join(providerDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: {
      "cap_provider_ping": async () => "pong",
    },
  };
}
`,
      "utf-8",
    );
    const providerManifestPath = join(providerDir, "plugin.json");
    await writeFile(
      providerManifestPath,
      JSON.stringify({
        id: "cap-provider",
        name: "cap-provider",
        version: "1.0.0",
        description: "Test fixture.",
        publisher: "Test fixture",
        entry: "entry.mjs",
        tools: [{ name: "cap_provider_ping", description: "cap_provider_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        capabilities: ["calendar-source"],
      }),
      "utf-8",
    );

    const consumerDir = join(installedDir, "needs-calendar");
    await mkdir(consumerDir, { recursive: true });
    await writeFile(
      join(consumerDir, "entry.mjs"),
      `export default async function createPlugin() {
  return {
    handlers: {
      "needs_calendar_ping": async () => "pong",
    },
  };
}
`,
      "utf-8",
    );
    const consumerManifestPath = join(consumerDir, "plugin.json");
    await writeFile(
      consumerManifestPath,
      JSON.stringify({
        id: "needs-calendar",
        name: "needs-calendar",
        version: "1.0.0",
        description: "Test fixture.",
        publisher: "Test fixture",
        entry: "entry.mjs",
        tools: [{ name: "needs_calendar_ping", description: "needs_calendar_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        requires: { capabilities: ["calendar-source", "mail-source"] },
      }),
      "utf-8",
    );

    await writeTestPluginRegistry({ registryPath }, [
      { id: "cap-provider", manifestPath: providerManifestPath, enabled: true },
      { id: "needs-calendar", manifestPath: consumerManifestPath, enabled: true },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain("cap-provider");
    expect(runtime.listPluginIds()).not.toContain("needs-calendar");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringMatching(/needs-calendar rejected .*mail-source/),
    );
    errSpy.mockRestore();
  });
});

/**
 * Trusted-path filter for registry-listed manifests. Marketplace installs
 * write under `~/.lvis/plugins/{slug}/`, which lives outside the project
 * `hostRoot`. Without `pluginsRoot` widening, every cloud-installed
 * plugin gets dropped on `restartAll()` after install.
 */
describe("PluginRuntime registry trusted-path", () => {
  let testDir: string;
  let hostRoot: string;
  let pluginsRoot: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "trusted-path-"));
    hostRoot = join(testDir, "host");
    pluginsRoot = join(testDir, "user-installs");
    registryPath = join(hostRoot, "plugins", "registry.json");
    await mkdir(join(hostRoot, "plugins"), { recursive: true });
    await mkdir(pluginsRoot, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeMinimalPlugin(rootDir: string, id: string): Promise<string> {
    const pluginDir = join(rootDir, id);
    await mkdir(pluginDir, { recursive: true });
    const entryPath = join(pluginDir, "entry.mjs");
    await writeFile(
      entryPath,
      `export default async function createPlugin() {
  return { handlers: { ${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping: async () => "ok" } };
}
`,
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        description: "Test fixture.",
        publisher: "Test fixture",
        entry: "entry.mjs",
        tools: [{ name: `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`, description: "minimal ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      }),
      "utf-8",
    );
    return manifestPath;
  }

  it("loads a plugin under pluginsRoot when widening is configured", async () => {
    const manifestPath = await writeMinimalPlugin(pluginsRoot, "cloud-plugin");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: "cloud-plugin", manifestPath, enabled: true }] }),
      "utf-8",
    );
    const runtime = new PluginRuntime({ hostRoot, pluginsRoot, registryPath });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("cloud-plugin");
  });

  it("drops a plugin under pluginsRoot when widening is NOT configured", async () => {
    const manifestPath = await writeMinimalPlugin(pluginsRoot, "cloud-plugin");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: "cloud-plugin", manifestPath, enabled: true }] }),
      "utf-8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = new PluginRuntime({ hostRoot, registryPath });
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("cloud-plugin");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/untrusted registry manifest path for cloud-plugin/),
    );
    warnSpy.mockRestore();
  });

  it("rejects a manifest path that is outside both trusted roots", async () => {
    // Disguise the manifest at a sibling of pluginsRoot so neither root
    // claims it; the prefix check must reject regardless of name similarity.
    const escapeDir = join(testDir, "user-installs-evil");
    const manifestPath = await writeMinimalPlugin(escapeDir, "evil");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: "evil", manifestPath, enabled: true }] }),
      "utf-8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = new PluginRuntime({ hostRoot, pluginsRoot, registryPath });
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("evil");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/untrusted registry manifest path for evil/),
    );
    warnSpy.mockRestore();
  });
});

/**
 * US-A3 — single-plugin lifecycle smoke tests.
 *
 * Audit complaint: ipc-bridge install / uninstall / install-local handlers
 * called `restartAll()` which wipes every loaded plugin's in-memory state.
 * `addPlugin(pluginId)` and `removePlugin(pluginId)` were added so a single
 * install/uninstall does not ripple into a full reload.
 *
 * The behavioral guarantee these tests anchor:
 *   - Adding a freshly-registered plugin does NOT restart any other plugin.
 *   - Removing one plugin does NOT restart any other plugin.
 *   - Re-adding an already-loaded plugin acts as a `restartPlugin` (picks up
 *     the latest bundle).
 */
describe("PluginRuntime addPlugin/removePlugin (US-A3)", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-runtime-add-"));
    installedDir = join(testDir, "plugins");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writePluginArtifact(
    id: string,
    artifactDirectory = id,
    toolSuffix = "ping",
  ): Promise<string> {
    const pluginDir = join(installedDir, artifactDirectory);
    await mkdir(pluginDir, { recursive: true });
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_${toolSuffix}`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `let started = 0;
export default async function createPlugin(ctx) {
  return {
    handlers: { "${methodName}": async () => "hi-${id}-" + started },
    start: async () => { started += 1; },
    stop: async () => {},
  };
}
`,
      "utf-8",
    );
    const manifest = { id, name: id, version: "1.0.0", entry: "entry.mjs", tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }], description: "Test fixture.", publisher: "Test fixture" };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return manifestPath;
  }

  async function writePlugin(id: string): Promise<string> {
    return writePluginArtifact(id);
  }

  async function writeStartFailingPlugin(id: string): Promise<{ manifestPath: string; stoppedPath: string }> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const stoppedPath = join(pluginDir, "stopped.txt");
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `import { writeFile } from "node:fs/promises";
export default async function createPlugin() {
  return {
    handlers: { "${methodName}": async () => "never" },
    start: async () => { throw new Error("simulated start failure"); },
    stop: async () => { await writeFile(${JSON.stringify(stoppedPath)}, "stopped", "utf-8"); },
  };
}
`,
      "utf-8",
    );
    const manifest = { id, name: id, version: "1.0.0", entry: "entry.mjs", tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }], description: "Start failure fixture.", publisher: "Test fixture" };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return { manifestPath, stoppedPath };
  }

  async function writeHostDisposerStartFailingPlugin(
    id: string,
  ): Promise<{ manifestPath: string; stoppedPath: string }> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const stoppedPath = join(pluginDir, "stopped.txt");
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `import { writeFile } from "node:fs/promises";
export default async function createPlugin({ hostApi }) {
  return {
    handlers: { "${methodName}": async () => "never" },
    start: async () => {
      hostApi.onEvent("test.event", () => {});
      throw new Error("simulated start failure");
    },
    stop: async () => { await writeFile(${JSON.stringify(stoppedPath)}, "stopped", "utf-8"); },
  };
}
`,
      "utf-8",
    );
    const manifest = { id, name: id, version: "1.0.0", entry: "entry.mjs", tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }], description: "Start failure fixture.", publisher: "Test fixture" };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return { manifestPath, stoppedPath };
  }

  function makeRuntime(): PluginRuntime {
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
  }

  function makeRuntimeWithPreparation(
    preparePluginStart: ConstructorParameters<typeof PluginRuntime>[0]["preparePluginStart"],
  ): PluginRuntime {
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      preparePluginStart,
    });
  }

  async function waitUntil<T>(fn: () => Promise<T> | T): Promise<T> {
    let lastErr: unknown;
    const deadline = Date.now() + 2_000;
    do {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } while (Date.now() < deadline);
    throw lastErr;
  }

  function makeRuntimeWithTrackedHostDisposer(
    disposed: string[],
    disabled: string[],
  ): PluginRuntime {
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      onDisable: (pluginId) => disabled.push(pluginId),
      createHostApi: (pluginId, _manifest, _pluginDataDir, incarnation) => ({
        registerKeywords: () => {},
        emitEvent: () => {},
        onEvent: () => {
          const dispose = () => disposed.push(pluginId);
          incarnation.registerDisposer(dispose);
          return dispose;
        },
        getInstalledPluginIds: () => [],
        onPluginsChanged: () => () => {},
        getSecret: () => null,
        callTool: async () => {
          throw new Error("not available");
        },
        callLlm: async () => {
          throw new Error("not available");
        },
        logEvent: () => {},
        onShutdown: () => {},
      }),
    });
  }

  async function writeHostDisposerPlugin(id: string): Promise<string> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`;
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin({ hostApi }) {
  return {
    handlers: { "${methodName}": async () => "ok" },
    start: async () => { hostApi.onEvent("test.event", () => {}); },
    stop: async () => {},
  };
}\n`,
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [{ name: methodName, description: "Test disposer tool.", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      description: "Disposer incarnation fixture.",
      publisher: "Test fixture",
    }), "utf-8");
    return manifestPath;
  }

  it("startAll stops a plugin instance whose start fails", async () => {
    const { manifestPath, stoppedPath } = await writeStartFailingPlugin("p-start-fails");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-start-fails", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();

    await runtime.startAll();

    expect(runtime.listPluginIds()).not.toContain("p-start-fails");
    await expect(readFile(stoppedPath, "utf-8")).resolves.toBe("stopped");
  });

  it("startAll start failure cleans runtime-managed disposers before unload", async () => {
    const { manifestPath, stoppedPath } = await writeHostDisposerStartFailingPlugin("p-start-disposer-fails");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-start-disposer-fails", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const disposed: string[] = [];
    const disabled: string[] = [];
    const runtime = makeRuntimeWithTrackedHostDisposer(disposed, disabled);

    await runtime.startAll();

    expect(runtime.listPluginIds()).not.toContain("p-start-disposer-fails");
    expect(disposed).toEqual(["p-start-disposer-fails"]);
    expect(disabled).toEqual(["p-start-disposer-fails"]);
    await expect(readFile(stoppedPath, "utf-8")).resolves.toBe("stopped");
  });

  it("revokes a timed-out boot incarnation before a slow peer settles", async () => {
    const timedId = "p-start-timeout-revoked";
    const slowId = "p-start-slow-peer";
    const timedDir = join(installedDir, timedId);
    const slowDir = join(installedDir, slowId);
    await mkdir(timedDir, { recursive: true });
    await mkdir(slowDir, { recursive: true });
    await writeFile(
      join(timedDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { p_start_timeout_revoked_ping: async () => "never" }, start: async () => new Promise(() => {}) };
}\n`,
      "utf-8",
    );
    await writeFile(
      join(slowDir, "entry.mjs"),
      `export default async function createPlugin() {
  return { handlers: { p_start_slow_peer_ping: async () => "ok" }, start: async () => new Promise((resolve) => setTimeout(resolve, 250)) };
}\n`,
      "utf-8",
    );
    const manifestFor = (id: string, tool: string, startupTimeoutMs: number) => ({
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      startupTimeoutMs,
      tools: [{ name: tool, description: `${tool} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      description: "Boot timeout revocation fixture.",
      publisher: "Test fixture",
    });
    const timedManifestPath = join(timedDir, "plugin.json");
    const slowManifestPath = join(slowDir, "plugin.json");
    await writeFile(timedManifestPath, JSON.stringify(manifestFor(timedId, "p_start_timeout_revoked_ping", 30)), "utf-8");
    await writeFile(slowManifestPath, JSON.stringify(manifestFor(slowId, "p_start_slow_peer_ping", 1_000)), "utf-8");
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [
        { id: timedId, manifestPath: timedManifestPath, enabled: true },
        { id: slowId, manifestPath: slowManifestPath, enabled: true },
      ],
    }), "utf-8");

    let timedHostApi: { getSecret(key: string): null } | undefined;
    let timedIncarnation: { isLifecycleHookActive(): boolean } | undefined;
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      createHostApi: (pluginId, _manifest, _pluginDataDir, incarnation) => {
        const getSecret = (_key: string): null => {
          if (!incarnation.isActive()) throw new Error("plugin instance is no longer active");
          return null;
        };
        const hostApi = {
          registerKeywords: () => {},
          emitEvent: () => {},
          onEvent: () => () => {},
          getInstalledPluginIds: () => [],
          onPluginsChanged: () => () => {},
          getSecret,
          callTool: async () => undefined,
          callLlm: async () => undefined,
          logEvent: () => {},
          onShutdown: () => {},
        };
        if (pluginId === timedId) {
          timedHostApi = hostApi;
          timedIncarnation = incarnation;
        }
        return hostApi as unknown as import("../types.js").PluginHostApi;
      },
    });
    let settled = false;
    const starting = runtime.startAll().finally(() => { settled = true; });

    for (let attempt = 0; attempt < 100 && !timedIncarnation?.isLifecycleHookActive(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(timedIncarnation?.isLifecycleHookActive()).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(settled).toBe(false);
    expect(timedHostApi).toBeDefined();
    expect(() => timedHostApi!.getSecret("late-write")).toThrow(/no longer active/);

    await starting;
    expect(runtime.listPluginIds()).not.toContain(timedId);
    expect(runtime.listPluginIds()).toContain(slowId);
  });

  it("restart disposes only the previous HostApi incarnation", async () => {
    const pluginId = "p-incarnation-disposer";
    const manifestPath = await writeHostDisposerPlugin(pluginId);
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{ id: pluginId, manifestPath, enabled: true }],
    }), "utf-8");
    const disposed: string[] = [];
    const runtime = makeRuntimeWithTrackedHostDisposer(disposed, []);

    await runtime.startAll();
    await expect(runtime.restartPlugin(pluginId)).resolves.toBe("started");
    expect(disposed).toEqual([pluginId]);
    await expect(runtime.call(`${pluginId.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`)).resolves.toBe("ok");

    await runtime.removePlugin(pluginId);
    expect(disposed).toEqual([pluginId, pluginId]);
  });

  it("addPlugin stops a newly-instantiated plugin when start fails", async () => {
    const existingPath = await writePlugin("p-existing");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-existing", manifestPath: existingPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    const { manifestPath, stoppedPath } = await writeStartFailingPlugin("p-new-broken");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: existingPath, enabled: true },
          { id: "p-new-broken", manifestPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin("p-new-broken")).rejects.toThrow(/addPlugin failed/);
    await expect(readFile(stoppedPath, "utf-8")).resolves.toBe("stopped");
    expect(runtime.listPluginIds()).toEqual(["p-existing"]);
  });

  it("uses the manifest id as the canonical lifecycle identity for a registry alias", async () => {
    const canonicalId = "p-canonical-runtime";
    const alias = "catalog-install-alias";
    const manifestPath = await writePlugin(canonicalId);
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{ id: alias, manifestPath, enabled: true }],
    }), "utf-8");
    const runtime = makeRuntime();

    await expect(runtime.addPlugin(alias)).resolves.toBe("started");
    expect(runtime.listPluginIds()).toEqual([canonicalId]);
    await expect(runtime.call("p_canonical_runtime_ping")).resolves.toContain("hi-p-canonical-runtime");
    await expect(runtime.waitForPluginReady(alias)).resolves.toBeUndefined();
  });

  it.each([
    ["canonical entry first", false],
    ["alias entry first", true],
  ] as const)(
    "rejects an ambiguous registry alias namespace before boot (%s)",
    async (_label, reverseEntries) => {
      const firstCanonicalId = "p-identity-beta";
      const secondCanonicalId = "p-identity-gamma";
      const firstManifestPath = await writePlugin(firstCanonicalId);
      const secondManifestPath = await writePlugin(secondCanonicalId);
      const entries = [
        {
          id: "p-identity-alpha",
          manifestPath: firstManifestPath,
          enabled: true,
        },
        {
          id: firstCanonicalId,
          manifestPath: secondManifestPath,
          enabled: true,
        },
      ];
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          plugins: reverseEntries ? entries.reverse() : entries,
        }),
        "utf-8",
      );
      const runtime = makeRuntime();

      await expect(runtime.startAll()).rejects.toMatchObject({
        code: "plugin-identity-collision",
        message: expect.stringContaining(firstCanonicalId),
      });
      expect(runtime.listPluginIds()).toEqual([]);
      expect(runtime.getPluginManifest(firstCanonicalId)).toBeUndefined();
      expect(runtime.getPluginManifest(secondCanonicalId)).toBeUndefined();
    },
  );

  it.each([
    ["first artifact first", false],
    ["second artifact first", true],
  ] as const)(
    "rejects two registry artifacts claiming one canonical identity (%s)",
    async (_label, reverseEntries) => {
      const canonicalId = "p-duplicate-canonical";
      const firstManifestPath = await writePluginArtifact(
        canonicalId,
        "p-duplicate-artifact-one",
        "first",
      );
      const secondManifestPath = await writePluginArtifact(
        canonicalId,
        "p-duplicate-artifact-two",
        "second",
      );
      const entries = [
        {
          id: "p-duplicate-alias-one",
          manifestPath: firstManifestPath,
          enabled: true,
        },
        {
          id: "p-duplicate-alias-two",
          manifestPath: secondManifestPath,
          enabled: true,
        },
      ];
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          plugins: reverseEntries ? entries.reverse() : entries,
        }),
        "utf-8",
      );
      const runtime = makeRuntime();

      await expect(runtime.startAll()).rejects.toMatchObject({
        code: "plugin-identity-collision",
        message: expect.stringContaining(canonicalId),
      });
      expect(runtime.listPluginIds()).toEqual([]);
      expect(runtime.listToolNames()).toEqual([]);
    },
  );

  it("rejects a static and registry artifact claiming one canonical identity", async () => {
    const canonicalId = "p-static-registry-canonical";
    const staticManifestPath = await writePluginArtifact(
      canonicalId,
      "p-static-canonical-artifact",
      "static",
    );
    const registryManifestPath = await writePluginArtifact(
      canonicalId,
      "p-registry-canonical-artifact",
      "registry",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: "p-static-registry-alias",
          manifestPath: registryManifestPath,
          enabled: true,
        }],
      }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      manifestPaths: [staticManifestPath],
      registryPath,
      pluginsRoot: installedDir,
    });

    await expect(runtime.startAll()).rejects.toMatchObject({
      code: "plugin-identity-collision",
      message: expect.stringContaining(canonicalId),
    });
    expect(runtime.listPluginIds()).toEqual([]);
    expect(runtime.listToolNames()).toEqual([]);
  });

  it("rejects a registry artifact added over a loaded static canonical identity", async () => {
    const canonicalId = "p-live-static-canonical";
    const staticManifestPath = await writePluginArtifact(
      canonicalId,
      "p-live-static-artifact",
      "static",
    );
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      manifestPaths: [staticManifestPath],
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();

    const registryManifestPath = await writePluginArtifact(
      canonicalId,
      "p-live-registry-artifact",
      "registry",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: canonicalId,
          manifestPath: registryManifestPath,
          enabled: true,
        }],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin(canonicalId)).rejects.toMatchObject({
      code: "plugin-identity-collision",
      message: expect.stringContaining(canonicalId),
    });
    expect(runtime.listPluginIds()).toEqual([canonicalId]);
    expect(runtime.listToolNames()).toContain(
      `${canonicalId.replace(/[^a-zA-Z0-9_]/g, "_")}_static`,
    );
    expect(runtime.listToolNames()).not.toContain(
      `${canonicalId.replace(/[^a-zA-Z0-9_]/g, "_")}_registry`,
    );
  });

  it("reserves a configured static identity after its runtime instance is removed", async () => {
    const canonicalId = "p-removed-static-canonical";
    const staticManifestPath = await writePluginArtifact(
      canonicalId,
      "p-removed-static-artifact",
      "static",
    );
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      manifestPaths: [staticManifestPath],
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();
    await runtime.removePlugin(canonicalId);

    const registryManifestPath = await writePluginArtifact(
      canonicalId,
      "p-removed-static-registry-artifact",
      "registry",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: canonicalId,
          manifestPath: registryManifestPath,
          enabled: true,
        }],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin(canonicalId)).rejects.toMatchObject({
      code: "plugin-identity-collision",
      message: expect.stringContaining(canonicalId),
    });
    expect(runtime.listPluginIds()).toEqual([]);
  });

  it("rejects manifest-id drift when restarting a loaded static plugin", async () => {
    const canonicalId = "p-static-manifest-stable";
    const changedId = "p-static-manifest-changed";
    const manifestPath = await writePluginArtifact(
      canonicalId,
      "p-static-manifest-artifact",
      "static",
    );
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      manifestPaths: [manifestPath],
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();

    const changedManifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    changedManifest.id = changedId;
    changedManifest.name = changedId;
    await writeFile(manifestPath, JSON.stringify(changedManifest), "utf-8");

    await expect(runtime.restartPlugin(canonicalId)).rejects.toMatchObject({
      code: "plugin-identity-collision",
      message: expect.stringContaining(changedId),
    });
    expect(runtime.listPluginIds()).toEqual([canonicalId]);
    expect(runtime.getPluginManifest(changedId)).toBeUndefined();
    await expect(
      runtime.call(`${canonicalId.replace(/[^a-zA-Z0-9_]/g, "_")}_static`),
    ).resolves.toContain(`hi-${canonicalId}`);
  });

  it("restarts the exact static artifact when plugin roots share a basename", async () => {
    const firstId = "p-static-root-first";
    const secondId = "p-static-root-second";
    const firstManifestPath = await writePluginArtifact(
      firstId,
      "p-static-parent-one/shared",
      "static",
    );
    const secondManifestPath = await writePluginArtifact(
      secondId,
      "p-static-parent-two/shared",
      "static",
    );
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      manifestPaths: [firstManifestPath, secondManifestPath],
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();

    await expect(runtime.restartPlugin(secondId)).resolves.toBe("started");
    await expect(
      runtime.call(`${secondId.replace(/[^a-zA-Z0-9_]/g, "_")}_static`),
    ).resolves.toContain(`hi-${secondId}`);
    await expect(
      runtime.call(`${firstId.replace(/[^a-zA-Z0-9_]/g, "_")}_static`),
    ).resolves.toContain(`hi-${firstId}`);
  });

  it("rejects two static plans converging on one identity before restart", async () => {
    const firstId = "p-static-converge-first";
    const secondId = "p-static-converge-second";
    const firstManifestPath = await writePluginArtifact(
      firstId,
      "p-static-converge-artifact-one",
      "static",
    );
    const secondManifestPath = await writePluginArtifact(
      secondId,
      "p-static-converge-artifact-two",
      "static",
    );
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      manifestPaths: [firstManifestPath, secondManifestPath],
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();

    const secondManifest = JSON.parse(await readFile(secondManifestPath, "utf-8"));
    secondManifest.id = firstId;
    secondManifest.name = firstId;
    await writeFile(secondManifestPath, JSON.stringify(secondManifest), "utf-8");

    await expect(runtime.restartPlugin(firstId)).rejects.toMatchObject({
      code: "plugin-identity-collision",
      message: expect.stringContaining(firstId),
    });
    expect(runtime.listPluginIds().sort()).toEqual([firstId, secondId].sort());
    await expect(
      runtime.call(`${firstId.replace(/[^a-zA-Z0-9_]/g, "_")}_static`),
    ).resolves.toContain(`hi-${firstId}`);
    await expect(
      runtime.call(`${secondId.replace(/[^a-zA-Z0-9_]/g, "_")}_static`),
    ).resolves.toContain(`hi-${secondId}`);
  });

  it("prioritizes an exact registry id over a static root basename during add", async () => {
    const staticId = "p-static-basename-owner";
    const requestedId = "p-registry-add-target";
    const staticManifestPath = await writePluginArtifact(
      staticId,
      requestedId,
      "static",
    );
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      manifestPaths: [staticManifestPath],
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();

    const registryManifestPath = await writePluginArtifact(
      requestedId,
      "p-registry-add-artifact",
      "registry",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: requestedId,
          manifestPath: registryManifestPath,
          enabled: true,
        }],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin(requestedId)).resolves.toBe("started");
    await expect(
      runtime.call(`${requestedId.replace(/[^a-zA-Z0-9_]/g, "_")}_registry`),
    ).resolves.toContain(`hi-${requestedId}`);
    await expect(
      runtime.call(`${staticId.replace(/[^a-zA-Z0-9_]/g, "_")}_static`),
    ).resolves.toContain(`hi-${staticId}`);
  });

  it("re-adds a disabled static plugin without changing its artifact claim", async () => {
    const canonicalId = "p-static-disable-readd";
    const manifestPath = await writePluginArtifact(
      canonicalId,
      "p-static-disable-readd-artifact",
      "static",
    );
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [] }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      manifestPaths: [manifestPath],
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();

    await runtime.disable(canonicalId);
    expect(runtime.listPluginIds()).toEqual([]);
    await expect(runtime.addPlugin(canonicalId)).resolves.toBe("started");

    expect(runtime.listPluginIds()).toEqual([canonicalId]);
    await expect(
      runtime.call(`${canonicalId.replace(/[^a-zA-Z0-9_]/g, "_")}_static`),
    ).resolves.toContain(`hi-${canonicalId}`);
  });

  it.each([
    ["valid entry first", false],
    ["failed entry first", true],
  ] as const)(
    "reserves a failed registry id before boot identity mutation (%s)",
    async (_label, reverseEntries) => {
      const canonicalId = "p-failed-identity-beta";
      const validManifestPath = await writePlugin(canonicalId);
      const malformedDir = join(installedDir, "p-malformed-identity");
      const malformedManifestPath = join(malformedDir, "plugin.json");
      await mkdir(malformedDir, { recursive: true });
      await writeFile(malformedManifestPath, "{}", "utf-8");
      const entries = [
        {
          id: "p-failed-identity-alpha",
          manifestPath: validManifestPath,
          enabled: true,
        },
        {
          id: canonicalId,
          manifestPath: malformedManifestPath,
          enabled: true,
        },
      ];
      await writeFile(
        registryPath,
        JSON.stringify({
          version: 1,
          plugins: reverseEntries ? entries.reverse() : entries,
        }),
        "utf-8",
      );
      const runtime = makeRuntime();

      await expect(runtime.startAll()).rejects.toMatchObject({
        code: "plugin-identity-collision",
        message: expect.stringContaining(canonicalId),
      });
      expect(runtime.listPluginIds()).toEqual([]);
      expect(runtime.getPluginManifest(canonicalId)).toBeUndefined();
    },
  );

  it("rejects a newly installed alias collision before restarting the existing plugin", async () => {
    const existingCanonicalId = "p-runtime-existing-canonical";
    const conflictingCanonicalId = "p-runtime-conflicting-canonical";
    const existingManifestPath = await writePlugin(existingCanonicalId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: "p-runtime-existing-alias",
          manifestPath: existingManifestPath,
          enabled: true,
        }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    const conflictingManifestPath = await writePlugin(conflictingCanonicalId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "p-runtime-existing-alias",
            manifestPath: existingManifestPath,
            enabled: true,
          },
          {
            id: existingCanonicalId,
            manifestPath: conflictingManifestPath,
            enabled: true,
          },
        ],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin(existingCanonicalId)).rejects.toMatchObject({
      code: "plugin-identity-collision",
      message: expect.stringContaining(existingCanonicalId),
    });
    expect(runtime.listPluginIds()).toEqual([existingCanonicalId]);
    expect(runtime.getPluginManifest(conflictingCanonicalId)).toBeUndefined();
  });

  it("rejects a direct restart when a raw registry id targets another manifest", async () => {
    const existingCanonicalId = "p-restart-existing-canonical";
    const conflictingCanonicalId = "p-restart-conflicting-canonical";
    const existingManifestPath = await writePlugin(existingCanonicalId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: "p-restart-existing-alias",
          manifestPath: existingManifestPath,
          enabled: true,
        }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    const conflictingManifestPath = await writePlugin(conflictingCanonicalId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "p-restart-existing-alias",
            manifestPath: existingManifestPath,
            enabled: true,
          },
          {
            id: existingCanonicalId,
            manifestPath: conflictingManifestPath,
            enabled: true,
          },
        ],
      }),
      "utf-8",
    );

    await expect(runtime.restartPlugin(existingCanonicalId)).rejects.toMatchObject({
      code: "plugin-identity-collision",
      message: expect.stringContaining(existingCanonicalId),
    });
    expect(runtime.listPluginIds()).toEqual([existingCanonicalId]);
    await expect(
      runtime.call(`${existingCanonicalId.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`),
    ).resolves.toContain(`hi-${existingCanonicalId}`);
  });

  it("verifies alias-installed restart receipts with the install identity", async () => {
    const canonicalId = "p-receipt-canonical";
    const installAlias = "p-receipt-install-alias";
    const manifestPath = await writePlugin(canonicalId);
    const pluginRoot = dirname(manifestPath);
    const receiptRoot = join(testDir, "receipts");
    await mkdir(receiptRoot, { recursive: true });
    await writeInstallReceipt(receiptRoot, {
      schemaVersion: 2,
      pluginId: installAlias,
      version: "1.0.0",
      installSource: "marketplace",
      artifactSha256: "a".repeat(64),
      signerKeyId: "test-signer",
      installedAt: new Date(0).toISOString(),
      files: await hashReceiptFiles(pluginRoot, ["entry.mjs", "plugin.json"]),
    });
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: installAlias, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = new PluginRuntime({
      createHostApi: createNoopHostApiForTests,
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
      installReceiptCacheRoot: receiptRoot,
    });
    await runtime.startAll();

    await expect(runtime.restartPlugin(canonicalId)).resolves.toBe("started");
    expect(runtime.resolvePluginId(installAlias)).toBe(canonicalId);
    await expect(
      runtime.call(`${canonicalId.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`),
    ).resolves.toContain(`hi-${canonicalId}`);
  });

  it("rejects incremental double-loading of an existing canonical identity", async () => {
    const canonicalId = "p-incremental-duplicate-canonical";
    const firstManifestPath = await writePluginArtifact(
      canonicalId,
      "p-incremental-artifact-one",
      "first",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{
          id: "p-incremental-alias-one",
          manifestPath: firstManifestPath,
          enabled: true,
        }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    const secondManifestPath = await writePluginArtifact(
      canonicalId,
      "p-incremental-artifact-two",
      "second",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "p-incremental-alias-one",
            manifestPath: firstManifestPath,
            enabled: true,
          },
          {
            id: "p-incremental-alias-two",
            manifestPath: secondManifestPath,
            enabled: true,
          },
        ],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin("p-incremental-alias-two")).rejects.toMatchObject({
      code: "plugin-identity-collision",
      message: expect.stringContaining(canonicalId),
    });
    expect(runtime.listPluginIds()).toEqual([canonicalId]);
    expect(runtime.listToolNames()).not.toContain(
      `${canonicalId.replace(/[^a-zA-Z0-9_]/g, "_")}_second`,
    );
  });

  it("rejects reusing a disabled plugin alias as a new canonical identity", async () => {
    const originalCanonicalId = "p-disabled-original-canonical";
    const alias = "p-disabled-reused-alias";
    const originalManifestPath = await writePlugin(originalCanonicalId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: alias, manifestPath: originalManifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    await runtime.disable(alias);

    const replacementManifestPath = await writePlugin(alias);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: alias, manifestPath: replacementManifestPath, enabled: true }],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin(alias)).rejects.toMatchObject({
      code: "plugin-identity-collision",
      message: expect.stringContaining(alias),
    });
    expect(runtime.resolvePluginId(alias)).toBe(originalCanonicalId);
    expect(runtime.listPluginIds()).toEqual([]);
    expect(runtime.getPluginManifest(alias)).toBeUndefined();
  });

  it("canonical removal cancels a deferred add requested through a registry alias", async () => {
    const canonicalId = "p-canonical-pending";
    const alias = "catalog-pending-alias";
    const manifestPath = await writePlugin(canonicalId);
    await writeFile(registryPath, JSON.stringify({
      version: 1,
      plugins: [{ id: alias, manifestPath, enabled: true }],
    }), "utf-8");
    let release!: () => void;
    const preparation = new Promise<void>((resolve) => { release = resolve; });
    const runtime = makeRuntimeWithPreparation(() => preparation);

    await expect(runtime.addPlugin(alias)).resolves.toBe("preparing");
    const ready = runtime.waitForPluginReady(alias);
    await runtime.removePlugin(canonicalId);
    release();

    await expect(ready).rejects.toThrow(/cancelled/);
    expect(runtime.listPluginIds()).not.toContain(canonicalId);
    await expect(runtime.call("p_canonical_pending_ping")).rejects.toThrow(/not found/);
    const state = runtime as unknown as {
      knownPluginManifests: Map<string, unknown>;
      knownPluginAccessGrants: Map<string, unknown>;
      knownToolOwners: Map<string, string>;
      knownEventOwners: Map<string, string>;
      disposers: Map<string, unknown>;
      preparation: {
        isPreparing(pluginId: string): boolean;
        hasPending(pluginId: string): boolean;
      };
    };
    expect(state.knownPluginManifests.has(canonicalId)).toBe(false);
    expect(state.knownPluginAccessGrants.has(canonicalId)).toBe(false);
    expect([...state.knownToolOwners.values()]).not.toContain(canonicalId);
    expect([...state.knownEventOwners.values()]).not.toContain(canonicalId);
    expect(state.disposers.has(canonicalId)).toBe(false);
    expect(state.preparation.isPreparing(canonicalId)).toBe(false);
    expect(state.preparation.hasPending(canonicalId)).toBe(false);
  });

  it("addPlugin restart path keeps the loaded plugin when replacement start fails", async () => {
    const existingPath = await writePlugin("p-restart-broken");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-restart-broken", manifestPath: existingPath, enabled: true }],
      }),
      "utf-8",
    );
    const disposed: string[] = [];
    const disabled: string[] = [];
    const runtime = makeRuntimeWithTrackedHostDisposer(disposed, disabled);
    await runtime.startAll();
    expect(await runtime.call("p_restart_broken_ping")).toBe("hi-p-restart-broken-1");

    const { stoppedPath } = await writeHostDisposerStartFailingPlugin("p-restart-broken");

    await expect(runtime.addPlugin("p-restart-broken")).rejects.toThrow(/addPlugin failed/);

    expect(runtime.listPluginIds()).toEqual(["p-restart-broken"]);
    expect(await runtime.call("p_restart_broken_ping")).toBe("hi-p-restart-broken-1");
    // The failed replacement's private subscription is cleaned while the
    // still-active original incarnation remains registered.
    expect(disposed).toEqual(["p-restart-broken"]);
    expect(disabled).toEqual([]);
    await expect(readFile(stoppedPath, "utf-8")).resolves.toBe("stopped");
  });

  it("boot-loaded plugin methods are not callable until startAll completes start()", async () => {
    const manifestPath = await writePlugin("p-start-guard");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-start-guard", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();

    await runtime.load();

    await expect(runtime.call("p_start_guard_ping")).rejects.toThrow(/still starting/);

    await runtime.startAll();

    await expect(runtime.call("p_start_guard_ping")).resolves.toBe("hi-p-start-guard-1");
  });

  it("setting plugin A config does not restart plugin B (single-plugin lifecycle)", async () => {
    // Two plugins both loaded; restartPlugin('p-a') must not affect p-b.
    const aPath = await writePlugin("p-a");
    const bPath = await writePlugin("p-b");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-a", manifestPath: aPath, enabled: true },
          { id: "p-b", manifestPath: bPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    // Sanity — both loaded with handlers.
    expect(runtime.listPluginIds().sort()).toEqual(["p-a", "p-b"]);
    const beforeA = await runtime.call("p_a_ping");
    const beforeB = await runtime.call("p_b_ping");

    // restartPlugin only restarts p-a; p-b's module state must be unchanged.
    await runtime.restartPlugin("p-a");

    const afterA = await runtime.call("p_a_ping");
    const afterB = await runtime.call("p_b_ping");
    // restartPlugin cache-busts the dynamic import so p-a 의 entry.mjs 가
    // 새 module 로 다시 평가됨 → top-level `let started = 0` 리셋 → start()
    // 가 다시 호출되어 1. p-b 는 미접촉 — 같은 module reuse, started=1 유지.
    // (옛 동작은 cache hit 으로 p-a started 가 2 까지 증가했으나, 그건
    // restart 의 의도된 의미가 아닌 ESM cache footgun 이었음.)
    expect(beforeA).toBe("hi-p-a-1");
    expect(afterA).toBe("hi-p-a-1");
    expect(beforeB).toBe("hi-p-b-1");
    expect(afterB).toBe("hi-p-b-1");
  });

  it("addPlugin loads a newly-registered plugin without restarting others", async () => {
    // p-existing is loaded first; then p-new is added to the registry and
    // addPlugin('p-new') is called. p-existing must not have its start
    // counter incremented.
    const existingPath = await writePlugin("p-existing");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-existing", manifestPath: existingPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");

    // Simulate marketplace install: write the new plugin + extend registry.
    const newPath = await writePlugin("p-new");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: existingPath, enabled: true },
          { id: "p-new", manifestPath: newPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    await runtime.addPlugin("p-new");

    expect(runtime.listPluginIds().sort()).toEqual(["p-existing", "p-new"]);
    expect(await runtime.call("p_new_ping")).toBe("hi-p-new-1");
    // p-existing was NOT restarted — counter still at 1.
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");
  });

  it("startAll defers dependency-prepared plugins and guards calls until ready", async () => {
    const manifestPath = await writePlugin("p-deferred");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-deferred", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) =>
      pluginId === "p-deferred" ? preparePromise : undefined,
    );

    await runtime.startAll();

    expect(runtime.listPluginIds()).toEqual([]);
    expect(runtime.listPluginManifests().map((entry) => entry.pluginId)).toEqual(["p-deferred"]);
    expect(runtime.listPluginCards().find((card) => card.id === "p-deferred")?.loadStatus).toBe("preparing");
    await expect(runtime.call("p_deferred_ping")).rejects.toThrow(/still installing its runtime dependencies/);

    resolvePrepare();

    await expect(runtime.waitForPluginReady("p-deferred")).resolves.toBeUndefined();
    expect(await runtime.call("p_deferred_ping")).toBe("hi-p-deferred-1");
    expect(runtime.listPluginCards().find((card) => card.id === "p-deferred")?.loadStatus).toBe("loaded");
  });

  it("surfaces dependency preparation progress on plugin cards", async () => {
    const manifestPath = await writePlugin("p-progress");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-progress", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId, reportProgress }) => {
      if (pluginId !== "p-progress") return undefined;
      reportProgress?.({
        phase: "installing-deps",
        message: "의존성 설치 중 (최초 1회)...",
        progressPct: 40.4,
      });
      return preparePromise;
    });

    await runtime.startAll();

    const preparingCard = runtime.listPluginCards().find((card) => card.id === "p-progress");
    expect(preparingCard?.loadStatus).toBe("preparing");
    expect(preparingCard?.preparationStatus).toMatchObject({
      phase: "installing-deps",
      message: "의존성 설치 중 (최초 1회)...",
      progressPct: 40,
    });

    resolvePrepare();
    await expect(runtime.waitForPluginReady("p-progress")).resolves.toBeUndefined();
    const loadedCard = runtime.listPluginCards().find((card) => card.id === "p-progress");
    expect(loadedCard?.loadStatus).toBe("loaded");
    expect(loadedCard?.preparationStatus).toBeUndefined();
  });

  it("ignores stale dependency preparation progress from cancelled generations", async () => {
    const manifestPath = await writePlugin("p-stale-progress");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-stale-progress", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const progressReporters: Array<NonNullable<Parameters<
      NonNullable<ConstructorParameters<typeof PluginRuntime>[0]["preparePluginStart"]>
    >[0]["reportProgress"]>> = [];
    const prepareResolves: Array<() => void> = [];
    const runtime = makeRuntimeWithPreparation(({ pluginId, reportProgress }) => {
      if (pluginId !== "p-stale-progress") return undefined;
      if (reportProgress) progressReporters.push(reportProgress);
      return new Promise<void>((resolve) => {
        prepareResolves.push(resolve);
      });
    });

    await expect(runtime.addPlugin("p-stale-progress")).resolves.toBe("preparing");
    progressReporters[0]?.({
      phase: "installing-deps",
      message: "첫 번째 준비 작업",
      progressPct: 20,
    });
    expect(runtime.listPluginCards().find((card) => card.id === "p-stale-progress")?.preparationStatus)
      .toMatchObject({ phase: "installing-deps", message: "첫 번째 준비 작업", progressPct: 20 });

    await runtime.removePlugin("p-stale-progress");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-stale-progress", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin("p-stale-progress")).resolves.toBe("preparing");
    progressReporters[1]?.({
      phase: "verifying",
      message: "두 번째 준비 작업",
      progressPct: 70,
    });
    progressReporters[0]?.({
      phase: "error",
      message: "취소된 이전 작업의 늦은 이벤트",
      progressPct: 99,
    });

    expect(runtime.listPluginCards().find((card) => card.id === "p-stale-progress")?.preparationStatus)
      .toMatchObject({ phase: "verifying", message: "두 번째 준비 작업", progressPct: 70 });

    prepareResolves[1]?.();
    await expect(runtime.waitForPluginReady("p-stale-progress")).resolves.toBeUndefined();
    prepareResolves[0]?.();
  });

  it("addPlugin returns while dependency preparation continues asynchronously", async () => {
    const existingPath = await writePlugin("p-existing");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-existing", manifestPath: existingPath, enabled: true }],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) =>
      pluginId === "p-new" ? preparePromise : undefined,
    );
    await runtime.startAll();
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");

    const newPath = await writePlugin("p-new");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: existingPath, enabled: true },
          { id: "p-new", manifestPath: newPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    await expect(runtime.addPlugin("p-new")).resolves.toBe("preparing");

    expect(runtime.listPluginIds()).toEqual(["p-existing"]);
    expect(runtime.listPluginCards().find((card) => card.id === "p-new")?.loadStatus).toBe("preparing");
    await expect(runtime.call("p_new_ping")).rejects.toThrow(/still installing its runtime dependencies/);

    resolvePrepare();

    await expect(runtime.waitForPluginReady("p-new")).resolves.toBeUndefined();
    expect(await runtime.call("p_new_ping")).toBe("hi-p-new-1");
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");
  });

  it("addPlugin reuses an existing pending dependency preparation", async () => {
    const manifestPath = await writePlugin("p-dedup-prep");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-dedup-prep", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const preparePluginStart = vi.fn(({ pluginId }) =>
      pluginId === "p-dedup-prep" ? preparePromise : undefined,
    );
    const runtime = makeRuntimeWithPreparation(preparePluginStart);

    await expect(runtime.addPlugin("p-dedup-prep")).resolves.toBe("preparing");
    await expect(runtime.addPlugin("p-dedup-prep")).resolves.toBe("preparing");

    expect(preparePluginStart).toHaveBeenCalledOnce();
    resolvePrepare();
    await expect(runtime.waitForPluginReady("p-dedup-prep")).resolves.toBeUndefined();
    expect(await runtime.call("p_dedup_prep_ping")).toBe("hi-p-dedup-prep-1");
  });

  it("removePlugin cancels a pending dependency-prepared start", async () => {
    const manifestPath = await writePlugin("p-pending-remove");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-pending-remove", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) =>
      pluginId === "p-pending-remove" ? preparePromise : undefined,
    );

    await expect(runtime.addPlugin("p-pending-remove")).resolves.toBe("preparing");
    expect(runtime.listPluginCards().find((card) => card.id === "p-pending-remove")?.loadStatus).toBe("preparing");

    await runtime.removePlugin("p-pending-remove");
    resolvePrepare();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.listPluginIds()).toEqual([]);
    expect(runtime.listPluginCards().find((card) => card.id === "p-pending-remove")).toBeUndefined();
    await expect(runtime.call("p_pending_remove_ping")).rejects.toThrow(/Plugin method not found/);
  });

  it("removePlugin cancellation does not invalidate another plugin preparation", async () => {
    const removedPath = await writePlugin("p-remove-one");
    const keptPath = await writePlugin("p-keep-one");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-remove-one", manifestPath: removedPath, enabled: true },
          { id: "p-keep-one", manifestPath: keptPath, enabled: true },
        ],
      }),
      "utf-8",
    );

    let resolveRemoved!: () => void;
    let resolveKept!: () => void;
    const removedPreparePromise = new Promise<void>((resolve) => {
      resolveRemoved = resolve;
    });
    const keptPreparePromise = new Promise<void>((resolve) => {
      resolveKept = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) => {
      if (pluginId === "p-remove-one") return removedPreparePromise;
      if (pluginId === "p-keep-one") return keptPreparePromise;
      return undefined;
    });

    await expect(runtime.addPlugin("p-remove-one")).resolves.toBe("preparing");
    await expect(runtime.addPlugin("p-keep-one")).resolves.toBe("preparing");

    await runtime.removePlugin("p-remove-one");
    resolveRemoved();
    resolveKept();

    await expect(runtime.waitForPluginReady("p-keep-one")).resolves.toBeUndefined();
    expect(await runtime.call("p_keep_one_ping")).toBe("hi-p-keep-one-1");
    expect(runtime.listPluginIds()).toEqual(["p-keep-one"]);
    expect(runtime.listPluginCards().find((card) => card.id === "p-remove-one")).toBeUndefined();
    await expect(runtime.call("p_remove_one_ping")).rejects.toThrow(/Plugin method not found/);
  });

  it("stale prepared start failure does not mark a newer generation failed", async () => {
    const pluginId = "p-stale-start";
    const methodName = "p_stale_start_ping";
    const staleDir = join(installedDir, `${pluginId}-stale`);
    await mkdir(staleDir, { recursive: true });
    const staleManifestPath = join(staleDir, "plugin.json");

    let startEntered!: () => void;
    const startEnteredPromise = new Promise<void>((resolve) => {
      startEntered = resolve;
    });
    let rejectStart!: () => void;
    const startGate = new Promise<void>((_, reject) => {
      rejectStart = () => reject(new Error("stale start failed"));
    });
    let staleStopped!: () => void;
    const staleStoppedPromise = new Promise<void>((resolve) => {
      staleStopped = resolve;
    });
    const controls = new Map([
      [pluginId, { startEntered, startGate, staleStopped }],
    ]);
    const globalWithControls = globalThis as typeof globalThis & {
      __lvisRuntimeTestControls?: typeof controls;
    };
    globalWithControls.__lvisRuntimeTestControls = controls;

    try {
      await writeFile(
        join(staleDir, "entry.mjs"),
        `const controls = globalThis.__lvisRuntimeTestControls.get(${JSON.stringify(pluginId)});
export default async function createPlugin() {
  return {
    handlers: { ${JSON.stringify(methodName)}: async () => "stale" },
    start: async () => {
      controls.startEntered();
      await controls.startGate;
    },
    stop: async () => { controls.staleStopped(); },
  };
}
`,
        "utf-8",
      );
      await writeFile(
        staleManifestPath,
        JSON.stringify({
          id: pluginId,
          name: pluginId,
          version: "1.0.0",
          entry: "entry.mjs",
          tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
          description: "stale start fixture",
          publisher: "Test fixture",
        }),
        "utf-8",
      );
      await writeFile(
        registryPath,
        JSON.stringify({ version: 1, plugins: [{ id: pluginId, manifestPath: staleManifestPath, enabled: true }] }),
        "utf-8",
      );

      let resolvePrepare!: () => void;
      const preparePromise = new Promise<void>((resolve) => {
        resolvePrepare = resolve;
      });
      let firstPrepare = true;
      const runtime = makeRuntimeWithPreparation(({ pluginId: requestedId }) => {
        if (requestedId !== pluginId || !firstPrepare) return undefined;
        firstPrepare = false;
        return preparePromise;
      });

      await expect(runtime.addPlugin(pluginId)).resolves.toBe("preparing");
      resolvePrepare();
      await startEnteredPromise;

      await runtime.removePlugin(pluginId);

      const freshDir = join(installedDir, `${pluginId}-fresh`);
      await mkdir(freshDir, { recursive: true });
      const freshManifestPath = join(freshDir, "plugin.json");
      await writeFile(
        join(freshDir, "entry.mjs"),
        `export default async function createPlugin() {
  return {
    handlers: { ${JSON.stringify(methodName)}: async () => "fresh" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
        "utf-8",
      );
      await writeFile(
        freshManifestPath,
        JSON.stringify({
          id: pluginId,
          name: pluginId,
          version: "1.0.1",
          entry: "entry.mjs",
          tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
          description: "fresh start fixture",
          publisher: "Test fixture",
        }),
        "utf-8",
      );
      await writeFile(
        registryPath,
        JSON.stringify({ version: 1, plugins: [{ id: pluginId, manifestPath: freshManifestPath, enabled: true }] }),
        "utf-8",
      );

      await expect(runtime.addPlugin(pluginId)).resolves.toBe("started");
      await expect(runtime.call(methodName)).resolves.toBe("fresh");

      rejectStart();
      await staleStoppedPromise;

      const failedPluginIds = (runtime as unknown as { failedPluginIds: Set<string> }).failedPluginIds;
      expect(failedPluginIds.has(pluginId)).toBe(false);
      await expect(runtime.call(methodName)).resolves.toBe("fresh");
    } finally {
      delete globalWithControls.__lvisRuntimeTestControls;
    }
  });

  it("restartPlugin keeps the existing plugin loaded when dependency preparation fails", async () => {
    const manifestPath = await writePlugin("p-restart-prepare-fails");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-restart-prepare-fails", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let failRestartPreparation = false;
    const runtime = makeRuntimeWithPreparation(({ pluginId }) => {
      if (!failRestartPreparation || pluginId !== "p-restart-prepare-fails") return undefined;
      return Promise.reject(new Error("prepare failed"));
    });
    await runtime.startAll();
    expect(await runtime.call("p_restart_prepare_fails_ping")).toBe("hi-p-restart-prepare-fails-1");

    failRestartPreparation = true;
    await expect(runtime.restartPlugin("p-restart-prepare-fails")).resolves.toBe("failed");

    expect(runtime.listPluginIds()).toEqual(["p-restart-prepare-fails"]);
    expect(await runtime.call("p_restart_prepare_fails_ping")).toBe("hi-p-restart-prepare-fails-1");
  });

  it("removePlugin does not wait for an invalidated restart preparation", async () => {
    const pluginId = "p-remove-during-restart-prep";
    const manifestPath = await writePlugin(pluginId);
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    let prepareRestart = false;
    let entered!: () => void;
    let release!: () => void;
    const preparationEntered = new Promise<void>((resolve) => { entered = resolve; });
    const preparationGate = new Promise<void>((resolve) => { release = resolve; });
    const runtime = makeRuntimeWithPreparation(() => {
      if (!prepareRestart) return undefined;
      entered();
      return preparationGate;
    });
    await runtime.startAll();
    prepareRestart = true;

    const restart = runtime.restartPlugin(pluginId);
    await preparationEntered;
    await expect(runtime.removePlugin(pluginId)).resolves.toBeUndefined();
    expect(runtime.listPluginIds()).not.toContain(pluginId);

    release();
    await expect(restart).resolves.toBe("failed");
  });

  it("addPlugin restart path prepares dependencies before stopping the loaded plugin", async () => {
    const manifestPath = await writePlugin("p-restart-prep");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-restart-prep", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let prepareRestart = false;
    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const runtime = makeRuntimeWithPreparation(({ pluginId }) =>
      prepareRestart && pluginId === "p-restart-prep" ? preparePromise : undefined,
    );
    await runtime.startAll();
    expect(await runtime.call("p_restart_prep_ping")).toBe("hi-p-restart-prep-1");

    prepareRestart = true;
    let restartCompleted = false;
    const restartPromise = runtime.addPlugin("p-restart-prep").then((result) => {
      restartCompleted = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(runtime.listPluginIds()).toEqual(["p-restart-prep"]);
    expect(runtime.listPluginCards().find((card) => card.id === "p-restart-prep")?.loadStatus).toBe("loaded");
    expect(await runtime.call("p_restart_prep_ping")).toBe("hi-p-restart-prep-1");
    expect(restartCompleted).toBe(false);

    resolvePrepare();

    await expect(restartPromise).resolves.toBe("started");
    await expect(waitUntil(() => runtime.call("p_restart_prep_ping"))).resolves.toBe("hi-p-restart-prep-1");
  });

  it("addPlugin restart path preserves the loaded plugin when dependency preparation fails", async () => {
    const manifestPath = await writePlugin("p-restart-add-prepare-fails");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-restart-add-prepare-fails", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let failRestartPreparation = false;
    const runtime = makeRuntimeWithPreparation(({ pluginId }) => {
      if (!failRestartPreparation || pluginId !== "p-restart-add-prepare-fails") return undefined;
      return Promise.reject(new Error("prepare failed"));
    });
    await runtime.startAll();
    expect(await runtime.call("p_restart_add_prepare_fails_ping")).toBe("hi-p-restart-add-prepare-fails-1");

    failRestartPreparation = true;
    await expect(runtime.addPlugin("p-restart-add-prepare-fails")).rejects.toThrow(/addPlugin failed/);

    expect(runtime.listPluginIds()).toEqual(["p-restart-add-prepare-fails"]);
    expect(await runtime.call("p_restart_add_prepare_fails_ping")).toBe("hi-p-restart-add-prepare-fails-1");
  });

  it("restartPlugin coalesces concurrent dependency preparation for a loaded plugin", async () => {
    const manifestPath = await writePlugin("p-restart-dedup-prep");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-restart-dedup-prep", manifestPath, enabled: true }],
      }),
      "utf-8",
    );

    let prepareRestart = false;
    let resolvePrepare!: () => void;
    const preparePromise = new Promise<void>((resolve) => {
      resolvePrepare = resolve;
    });
    const preparePluginStart = vi.fn(({ pluginId }) =>
      prepareRestart && pluginId === "p-restart-dedup-prep" ? preparePromise : undefined,
    );
    const runtime = makeRuntimeWithPreparation(preparePluginStart);
    await runtime.startAll();
    preparePluginStart.mockClear();

    prepareRestart = true;
    const first = runtime.restartPlugin("p-restart-dedup-prep");
    const second = runtime.restartPlugin("p-restart-dedup-prep");
    await waitUntil(() => {
      const calls = preparePluginStart.mock.calls.length;
      if (calls !== 1) throw new Error(`prepare calls: ${calls}`);
      return calls;
    });

    expect(preparePluginStart).toHaveBeenCalledTimes(1);
    expect(runtime.listPluginIds()).toEqual(["p-restart-dedup-prep"]);
    expect(await runtime.call("p_restart_dedup_prep_ping")).toBe("hi-p-restart-dedup-prep-1");

    resolvePrepare();

    await expect(first).resolves.toBe("started");
    await expect(second).resolves.toBe("started");
  });

  it("addPlugin on an already-loaded plugin acts as restartPlugin (reinstall path)", async () => {
    // A reinstall over an existing version should still pick up the latest
    // bundle. addPlugin's idempotency contract: if loaded, defer to restartPlugin.
    const aPath = await writePlugin("p-existing");
    const bPath = await writePlugin("p-other");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-existing", manifestPath: aPath, enabled: true },
          { id: "p-other", manifestPath: bPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();

    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");
    expect(await runtime.call("p_other_ping")).toBe("hi-p-other-1");

    await runtime.addPlugin("p-existing");

    // p-existing restarted (cache-bust → fresh module → top-level
    // `started=0` 다시 리셋 후 start() 한 번 호출 → 1). p-other 미접촉.
    // 옛 캐시 hit 동작에선 module reuse 로 started 가 2 까지 갔으나,
    // 그건 restart 의 의도된 의미가 아닌 footgun 이었음.
    expect(await runtime.call("p_existing_ping")).toBe("hi-p-existing-1");
    expect(await runtime.call("p_other_ping")).toBe("hi-p-other-1");
  });

  it("removePlugin drops a single plugin without restarting others", async () => {
    const aPath = await writePlugin("p-target");
    const bPath = await writePlugin("p-bystander");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [
          { id: "p-target", manifestPath: aPath, enabled: true },
          { id: "p-bystander", manifestPath: bPath, enabled: true },
        ],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(await runtime.call("p_target_ping")).toBe("hi-p-target-1");
    expect(await runtime.call("p_bystander_ping")).toBe("hi-p-bystander-1");

    await runtime.removePlugin("p-target");

    expect(runtime.listPluginIds()).toEqual(["p-bystander"]);
    expect(runtime.listToolNames()).not.toContain("p_target_ping");
    // p-bystander was NOT restarted — counter still at 1.
    expect(await runtime.call("p_bystander_ping")).toBe("hi-p-bystander-1");
  });

  it("removePlugin on an unloaded plugin is a no-op (idempotent)", async () => {
    const runtime = makeRuntime();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Should not throw.
    await runtime.removePlugin("nonexistent");

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("removePlugin: plugin not loaded — nonexistent"),
    );
    warnSpy.mockRestore();
  });

  it("addPlugin throws when registry has no entry for the id", async () => {
    const runtime = makeRuntime();
    // Empty registry — no plugin to add.
    await writeFile(registryPath, JSON.stringify({ version: 1, plugins: [] }), "utf-8");
    await expect(runtime.addPlugin("ghost")).rejects.toThrow(/not found in registry/);
  });

  it("addPlugin surfaces the manifest read error when registry entry exists but manifest is invalid (update-banner regression)", async () => {
    // Regression test for: addPlugin() throws "not found in registry" instead of the
    // real manifest-validation error when the newly installed manifest fails AJV validation.
    // This scenario arises when the update banner triggers install for a plugin that
    // previously failed to load and the updated manifest still has a schema violation.
    const pluginDir = join(installedDir, "p-broken");
    await mkdir(pluginDir, { recursive: true });
    // Write an invalid manifest (tool name has a dot, which fails schema validation).
    const badManifest = { id: "p-broken", name: "Broken", version: "1.0.0", entry: "entry.mjs", tools: ["bad.tool"] };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(badManifest), "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-broken", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();

    // Must throw the real schema error, not "not found in registry or disabled".
    await expect(runtime.addPlugin("p-broken")).rejects.toThrow(/schema validation failed|Invalid tool name/);
  });

  it("addPlugin throws when the entry module fails to import (atomic-install rollback signal)", async () => {
    // Regression test: pre-fix, an entry that throws at import
    // time was silently markFailed-then-return — install-IPC handler had no
    // way to know the install half-committed. Now addPlugin throws so the
    // handler can roll back the registry/dir state via marketplace.uninstall().
    //
    // Reproduces by writing an entry that throws at the top level, which
    // surfaces through esbuild-style "Dynamic require of …" / generic
    // ReferenceError patterns observed for ms-graph 0.1.18 / pageindex 0.1.16
    // pre-SDK-v3.4.2.
    const pluginDir = join(installedDir, "p-broken-entry");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "entry.mjs"),
      `throw new Error("simulated dynamic-require fallback shim throw");
export default async function createPlugin() { return {}; }`,
      "utf-8",
    );
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(
      manifestPath,
      JSON.stringify({
        id: "p-broken-entry",
        name: "Broken Entry",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: [{ name: "broken_entry_hello", description: "broken_entry_hello tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
        description: "test fixture for addPlugin import-fail rollback signal",
        publisher: "test",
      }),
      "utf-8",
    );
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-broken-entry", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();

    await expect(runtime.addPlugin("p-broken-entry")).rejects.toThrow(/addPlugin failed/);
  });

  it("addPlugin on a running plugin re-reads manifest from disk (update entry-point regression)", async () => {
    // Regression: restartPlugin() used the old in-memory manifest.entry after an
    // update that changed the entry-point path. Now it re-reads from disk.
    const pluginDir = join(installedDir, "p-update");
    await mkdir(pluginDir, { recursive: true });
    const manifestPath = join(pluginDir, "plugin.json");

    // v1: entry.mjs returns "v1"
    await writeFile(join(pluginDir, "entry-v1.mjs"), `
let started = 0;
export default async function createPlugin() {
  return {
    handlers: { p_update_ping: async () => "v1-" + started },
    start: async () => { started += 1; },
    stop: async () => {},
  };
}
`, "utf-8");
    await writeFile(manifestPath, JSON.stringify({
      id: "p-update", name: "Update", version: "1.0.0",
      description: "regression fixture",
      publisher: "Test fixture",
      entry: "entry-v1.mjs", tools: [{ name: "p_update_ping", description: "p_update_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      configSchema: {
        properties: {
          endpoint: { type: "string", title: "endpoint" },
        },
      },
    }), "utf-8");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: "p-update", manifestPath, enabled: true }],
      }),
      "utf-8",
    );
    const runtime = makeRuntime();
    await runtime.startAll();
    expect(await runtime.call("p_update_ping")).toBe("v1-1");
    expect(runtime.listPluginCards().find((card) => card.id === "p-update")?.configSchema?.properties)
      .toHaveProperty("endpoint");

    // Simulate marketplace update: write v2 entry and update manifest on disk.
    await writeFile(join(pluginDir, "entry-v2.mjs"), `
let started = 0;
export default async function createPlugin() {
  return {
    handlers: { p_update_ping: async () => "v2-" + started },
    start: async () => { started += 1; },
    stop: async () => {},
  };
}
`, "utf-8");
    // Update manifest.entry to point to the new entry file.
    await writeFile(manifestPath, JSON.stringify({
      id: "p-update", name: "Update", version: "2.0.0",
      description: "regression fixture v2",
      publisher: "Test fixture",
      entry: "entry-v2.mjs", tools: [{ name: "p_update_ping", description: "p_update_ping tool", inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      configSchema: {
        properties: {
          baseUrl: { type: "string", title: "baseUrl" },
        },
      },
    }), "utf-8");

    // addPlugin sees it's loaded → calls restartPlugin → must re-read manifest from disk.
    await runtime.addPlugin("p-update");

    // restartPlugin re-reads the manifest, picks up entry-v2.mjs.
    // Note: ESM module caching means we can't test the v2 handler body here
    // (same URL = cached module), but we verify the plugin is re-started (counter resets).
    expect(runtime.listPluginIds()).toContain("p-update");
    const card = runtime.listPluginCards().find((candidate) => candidate.id === "p-update");
    expect(card?.version).toBe("2.0.0");
    expect(card?.configSchema?.properties).toHaveProperty("baseUrl");
    expect(card?.configSchema?.properties).not.toHaveProperty("endpoint");
  });

  it("addPlugin on a running plugin follows updated registry manifestPath and refreshes plugin cards", async () => {
    const pluginId = "p-update-schema";
    const toolName = "p_update_schema_ping";

    async function writeVersion(version: string, fieldName: string): Promise<string> {
      const pluginDir = join(installedDir, pluginId, version);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(
        join(pluginDir, "entry.mjs"),
        `export default async function createPlugin() {
  return {
    handlers: { "${toolName}": async () => "${version}" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
        "utf-8",
      );
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          id: pluginId,
          name: "Update Schema",
          version,
          description: `schema fixture ${version}`,
          publisher: "Test fixture",
          entry: "entry.mjs",
          tools: [{ name: toolName, description: `${toolName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
          configSchema: {
            properties: {
              [fieldName]: { type: "string", title: fieldName },
            },
          },
        }),
        "utf-8",
      );
      return manifestPath;
    }

    const v1ManifestPath = await writeVersion("1.0.0", "endpoint");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath: v1ManifestPath, enabled: true }],
      }),
      "utf-8",
    );

    const runtime = makeRuntime();
    await runtime.startAll();
    expect(runtime.listPluginCards().find((card) => card.id === pluginId)?.version).toBe("1.0.0");

    const v2ManifestPath = await writeVersion("2.0.0", "baseUrl");
    await writeFile(
      registryPath,
      JSON.stringify({
        version: 1,
        plugins: [{ id: pluginId, manifestPath: v2ManifestPath, enabled: true }],
      }),
      "utf-8",
    );

    await runtime.addPlugin(pluginId);

    const card = runtime.listPluginCards().find((candidate) => candidate.id === pluginId);
    expect(runtime.getPluginRoot(pluginId)).toBe(join(installedDir, pluginId, "2.0.0"));
    expect(card?.version).toBe("2.0.0");
    expect(card?.configSchema?.properties).toHaveProperty("baseUrl");
    expect(card?.configSchema?.properties).not.toHaveProperty("endpoint");
  });
});

// ─── Lifecycle plog emission smoke tests ─────────────────────────────────────

describe("PluginRuntime lifecycle plog emission", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-plog-"));
    installedDir = join(testDir, "plugins");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeFakePlugin(id: string): Promise<string> {
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_hello`;
    const { manifestPath } = await writeTestPlugin({
      rootDir: testDir,
      pluginsRoot: installedDir,
      registryPath,
    }, {
      id,
      tools: [{ name: methodName, description: `${methodName} tool`, inputSchema: { type: "object", properties: {} }, _meta: { ui: { visibility: ["model", "app"] } } }],
      entrySource: makeTestPluginEntrySource({ [methodName]: JSON.stringify("hi") }),
    });
    return manifestPath;
  }

  it("emits LOAD_START phase for each plugin entry during load()", async () => {
    const manifestPath = await writeFakePlugin("plog-test");
    await writeTestPluginRegistry({ registryPath }, [{ id: "plog-test", manifestPath, enabled: true }]);
    // In test mode, createLogger maps debug→console.log.
    // The ctx object is passed as 2nd arg; check the message string + ctx via JSON.
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => { calls.push(args); });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    const hasLoadStart = calls.some((args) => {
      const flat = args.map((a) => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
      return flat.includes(PluginPhase.LOAD_START) || flat.includes("loading plugin");
    });
    expect(hasLoadStart).toBe(true);
    spy.mockRestore();
  });

  it("emits LOAD_OK phase after a plugin successfully loads", async () => {
    const manifestPath = await writeFakePlugin("plog-ok");
    await writeTestPluginRegistry({ registryPath }, [{ id: "plog-ok", manifestPath, enabled: true }]);
    const calls: unknown[][] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args) => { calls.push(args); });
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    const hasLoadOk = calls.some((args) => {
      const flat = args.map((a) => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
      return flat.includes(PluginPhase.LOAD_OK) || flat.includes("plugin loaded");
    });
    expect(hasLoadOk).toBe(true);
    spy.mockRestore();
  });

  it("emits RESTART_REQUEST phase when restartPlugin is called", async () => {
    const manifestPath = await writeFakePlugin("plog-restart");
    await writeTestPluginRegistry({ registryPath }, [{ id: "plog-restart", manifestPath, enabled: true }]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    const calls: unknown[][] = [];
    const spyLog = vi.spyOn(console, "log").mockImplementation((...args) => { calls.push(args); });
    await runtime.restartPlugin("plog-restart");
    const hasRestartRequest = calls.some((args) => {
      const flat = args.map((a) => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
      return flat.includes(PluginPhase.RESTART_REQUEST) || flat.includes("restart requested");
    });
    expect(hasRestartRequest).toBe(true);
    spyLog.mockRestore();
  });

  it("emits RESTART_STOP_OK phase after stop succeeds during restart", async () => {
    const manifestPath = await writeFakePlugin("plog-stop-ok");
    await writeTestPluginRegistry({ registryPath }, [{ id: "plog-stop-ok", manifestPath, enabled: true }]);
    const runtime = new PluginRuntime({ hostRoot: testDir, registryPath, pluginsRoot: installedDir });
    await runtime.load();
    const calls: unknown[][] = [];
    const spyLog = vi.spyOn(console, "log").mockImplementation((...args) => { calls.push(args); });
    await runtime.restartPlugin("plog-stop-ok");
    const hasStopOk = calls.some((args) => {
      const flat = args.map((a) => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
      return flat.includes(PluginPhase.RESTART_STOP_OK) || flat.includes("stopped previous instance");
    });
    expect(hasStopOk).toBe(true);
    spyLog.mockRestore();
  });
});

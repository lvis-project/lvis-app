import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PluginRuntime } from "../runtime.js";
import { PluginDeploymentGuard } from "../deployment-guard.js";

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
    testDir = join(homedir(), ".lvis", "test-tmp", `lvis-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    installedDir = join(testDir, "plugins", "installed");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(testDir, "plugins", "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeFakePlugin(
    id: string,
    deployment?: "managed" | "user",
    options?: {
      capabilities?: string[];
      requires?: string[];
      startBody?: string;
      stopBody?: string;
      factoryBody?: string;
    },
  ): Promise<string> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });

    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_hello`;

    // Minimal ESM plugin entry — no external deps.
    const entryPath = join(pluginDir, "entry.mjs");
    await writeFile(
      entryPath,
      `export default async function createPlugin(ctx) {
  ${options?.factoryBody ?? ""}
  return {
    handlers: {
      "${methodName}": async () => "hi-${id}",
    },
    start: async () => { ${options?.startBody ?? ""} },
    stop: async () => { ${options?.stopBody ?? ""} },
  };
}
`,
      "utf-8",
    );

    const manifest: Record<string, unknown> = {
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [methodName],
    };
    if (deployment) manifest.deployment = deployment;
    if (options?.capabilities) manifest.capabilities = options.capabilities;
    if (options?.requires) manifest.requires = { capabilities: options.requires };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return manifestPath;
  }

  async function writeRegistry(
    entries: Array<{ id: string; manifestPath: string; enabled?: boolean }>,
  ): Promise<void> {
    await mkdir(join(testDir, "plugins"), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: entries }),
      "utf-8",
    );
  }

  function makeRuntime(options?: {
    createHostApi?: ConstructorParameters<typeof PluginRuntime>[0]["createHostApi"];
    onDisable?: ConstructorParameters<typeof PluginRuntime>[0]["onDisable"];
  }): PluginRuntime {
    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      deploymentGuard: guard,
      createHostApi: options?.createHostApi,
      onDisable: options?.onDisable,
    });
  }

  it("disable removes methods + marks registry enabled=false for user plugin", async () => {
    const manifestPath = await writeFakePlugin("p-user");
    await writeRegistry([{ id: "p-user", manifestPath, enabled: true }]);
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
    const manifestPath = await writeFakePlugin("p-managed", "managed");
    await writeRegistry([{ id: "p-managed", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    await expect(runtime.disable("p-managed", "user")).rejects.toThrow(/Protected plugin|Managed plugin/);

    expect(runtime.listPluginIds()).toContain("p-managed");
    expect(runtime.listToolNames()).toContain("p_managed_hello");

    // registry should NOT have enabled=false
    const registry = JSON.parse(await readFile(registryPath, "utf-8"));
    const entry = registry.plugins.find((p: { id: string }) => p.id === "p-managed");
    expect(entry.enabled).toBe(true);
  });

  it("disable allows it-admin actor to disable a managed plugin", async () => {
    const manifestPath = await writeFakePlugin("p-managed", "managed");
    await writeRegistry([{ id: "p-managed", manifestPath, enabled: true }]);
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
    await writeRegistry([{ id: "p-existing", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    await expect(runtime.disable("p-missing")).rejects.toThrow(/not found/i);

    // Existing plugin still loaded
    expect(runtime.listPluginIds()).toContain("p-existing");
  });

  it("plugin with dotted reverse-domain id (com.lge.xxx) and underscore methods loads correctly", async () => {
    // Plugin ID may use reverse-domain dots (package identity namespace)
    // Tool names (methods[]) must still be underscore-only (LLM tool name namespace)
    const pluginId = "com.lge.test";
    const pluginDir = join(installedDir, "com-lge-test");
    await mkdir(pluginDir, { recursive: true });

    await writeFile(
      join(pluginDir, "entry.mjs"),
      `export default async function createPlugin(ctx) {
  return {
    handlers: { "com_lge_test_hello": async () => "hi" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );

    const manifest = { id: pluginId, name: "Test", version: "1.0.0", entry: "entry.mjs", tools: ["com_lge_test_hello"] };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeRegistry([{ id: pluginId, manifestPath, enabled: true }]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toContain(pluginId);
    expect(runtime.listToolNames()).toContain("com_lge_test_hello");
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

    const manifest = { id: "bad-plugin", name: "Bad", version: "1.0.0", entry: "entry.mjs", tools: ["bad.method"] };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeRegistry([{ id: "bad-plugin", manifestPath, enabled: true }]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("bad-plugin");
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Invalid tool name 'bad\.method'|schema validation failed/));
    errSpy.mockRestore();
  });

  it("loads bundled manifestPaths alongside registry plugins", async () => {
    const bundledDir = join(testDir, "bundled-plugin");
    await mkdir(bundledDir, { recursive: true });
    const bundledEntry = join(bundledDir, "entry.mjs");
    const bundledManifestPath = join(bundledDir, "plugin.json");
    await writeFile(
      bundledEntry,
      `export default async function createPlugin() {
  return { handlers: { "bundled_ping": async () => "bundled" } };
}
`,
      "utf-8",
    );
    await writeFile(
      bundledManifestPath,
      JSON.stringify({
        id: "bundled-plugin",
        name: "Bundled Plugin",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["bundled_ping"],
        deployment: "bundled",
      }),
      "utf-8",
    );

    const registryManifestPath = await writeFakePlugin("registry-plugin");
    await writeRegistry([{ id: "registry-plugin", manifestPath: registryManifestPath, enabled: true }]);

    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      manifestPaths: [bundledManifestPath],
      registryPath,
      deploymentGuard: guard,
    });

    await runtime.load();

    expect(runtime.listPluginIds()).toEqual(
      expect.arrayContaining(["bundled-plugin", "registry-plugin"]),
    );
    expect(runtime.listToolNames()).toEqual(
      expect.arrayContaining(["bundled_ping", "registry_plugin_hello"]),
    );
  });

  it("rejects plugins whose required capabilities are missing at runtime load", async () => {
    const dependentManifestPath = await writeFakePlugin(
      "needs-calendar",
      undefined,
      { requires: ["calendar-source"] },
    );
    await writeRegistry([{ id: "needs-calendar", manifestPath: dependentManifestPath, enabled: true }]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).not.toContain("needs-calendar");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("needs-calendar rejected — missing required capabilities: calendar-source"),
    );
  });

  it("loads plugins when required capabilities are provided by another enabled plugin", async () => {
    const providerManifestPath = await writeFakePlugin(
      "calendar-provider",
      undefined,
      { capabilities: ["calendar-source"] },
    );
    const dependentManifestPath = await writeFakePlugin(
      "needs-calendar",
      undefined,
      { requires: ["calendar-source"] },
    );
    await writeRegistry([
      { id: "calendar-provider", manifestPath: providerManifestPath, enabled: true },
      { id: "needs-calendar", manifestPath: dependentManifestPath, enabled: true },
    ]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.listPluginIds()).toEqual(
      expect.arrayContaining(["calendar-provider", "needs-calendar"]),
    );
  });

  it("drops dependents after provider start failure removes the required capability", async () => {
    const providerManifestPath = await writeFakePlugin(
      "calendar-provider",
      undefined,
      {
        capabilities: ["calendar-source"],
        startBody: 'throw new Error("provider start failed");',
      },
    );
    const dependentManifestPath = await writeFakePlugin(
      "needs-calendar",
      undefined,
      { requires: ["calendar-source"] },
    );
    await writeRegistry([
      { id: "calendar-provider", manifestPath: providerManifestPath, enabled: true },
      { id: "needs-calendar", manifestPath: dependentManifestPath, enabled: true },
    ]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.startAll();

    expect(runtime.listPluginIds()).not.toContain("calendar-provider");
    expect(runtime.listPluginIds()).not.toContain("needs-calendar");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[plugin:calendar-provider] start failed (non-fatal): provider start failed"),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[plugin-runtime] needs-calendar rejected — missing required capabilities: calendar-source"),
    );
  });

  it("dependency-pruned plugins run stop, disposer cleanup, and onDisable", async () => {
    const stopMarker = join(testDir, "needs-calendar.stopped");
    const onDisable = vi.fn();

    const providerManifestPath = await writeFakePlugin(
      "calendar-provider",
      undefined,
      {
        capabilities: ["calendar-source"],
        startBody: 'throw new Error("provider start failed");',
      },
    );
    const dependentManifestPath = await writeFakePlugin(
      "needs-calendar",
      undefined,
      {
        requires: ["calendar-source"],
        factoryBody: 'ctx.hostApi.onEvent("email.action.needed", () => {});',
        stopBody: `await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(stopMarker)}, "stopped", "utf-8"));`,
      },
    );
    await writeRegistry([
      { id: "calendar-provider", manifestPath: providerManifestPath, enabled: true },
      { id: "needs-calendar", manifestPath: dependentManifestPath, enabled: true },
    ]);

    const runtime = makeRuntime({
      createHostApi: () => ({
        registerKeywords: () => {},
        emitEvent: () => {},
        onEvent: () => () => {},
        getCalendarSnapshot: async () => [],
        addTask: () => {},
        saveNote: async () => {},
        getSecret: () => null,
        getMsGraphToken: async () => null,
        startMsGraphAuth: async () => {},
        isMsGraphAuthenticated: () => false,
        getMsGraphAccount: () => null,
        onMsGraphAuthChange: () => {},
        withMsGraphRetry: async () => {
          throw new Error("not used");
        },
        callLlm: async () => "",
        logEvent: () => {},
        onShutdown: () => {},
        openAuthWindow: async () => {
          throw new Error("not used");
        },
      }),
      onDisable,
    });

    await runtime.startAll();

    await expect(readFile(stopMarker, "utf-8")).resolves.toBe("stopped");
    expect(onDisable).toHaveBeenCalledWith("needs-calendar");
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

    const manifest = { id: "bad-leading-digit", name: "Bad", version: "1.0.0", entry: "entry.mjs", tools: ["1bad_name"] };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeRegistry([{ id: "bad-leading-digit", manifestPath, enabled: true }]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("bad-leading-digit");
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Invalid tool name '1bad_name'|schema validation failed/));
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

    const manifest = { id: "bad-hyphen", name: "Bad", version: "1.0.0", entry: "entry.mjs", tools: ["bad-name"] };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    await writeRegistry([{ id: "bad-hyphen", manifestPath, enabled: true }]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runtime = makeRuntime();
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("bad-hyphen");
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/Invalid tool name 'bad-name'|schema validation failed/));
    errSpy.mockRestore();
  });

  it("callFromUi rejects methods not declared in manifest.uiCallable[]", async () => {
    // H2: renderer-originated plugin calls must only reach methods the plugin
    // explicitly exposes via manifest.uiCallable. Everything else has to go
    // through ConversationLoop (scope + permission + expansion caps).
    const pluginDir = join(installedDir, "ui-callable");
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
        id: "ui-callable",
        name: "ui-callable",
        version: "1.0.0",
        entry: "entry.mjs",
        tools: ["uic_get", "uic_private"],
        uiCallable: ["uic_get"],
      }),
      "utf-8",
    );

    await writeRegistry([{ id: "ui-callable", manifestPath, enabled: true }]);
    const runtime = makeRuntime();
    await runtime.load();

    await expect(runtime.callFromUi("uic_get")).resolves.toBe("public-ok");
    await expect(runtime.callFromUi("uic_private")).rejects.toThrow(
      /not UI-callable/,
    );
    // Normal call() path (ConversationLoop) still works for both.
    await expect(runtime.call("uic_private")).resolves.toBe("private-ok");
  });

  it("registerDisposer callbacks fire on disable() and not thereafter", async () => {
    const manifestPath = await writeFakePlugin("p-disposer");
    await writeRegistry([{ id: "p-disposer", manifestPath, enabled: true }]);
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
        entry: "entry.mjs",
        tools: ["meta_ping"],
        capabilities: ["worker-client"],
        startupTools: ["meta_ping"],
      }),
      "utf-8",
    );

    await writeRegistry([{ id: "meta-plugin", manifestPath, enabled: true }]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(runtime.findPluginIdByCapability("worker-client")).toBe("meta-plugin");
    expect(runtime.listPluginIdsByCapability("worker-client")).toEqual(["meta-plugin"]);

    const manifest = runtime.getPluginManifest("meta-plugin");
    expect(manifest?.startupTools).toEqual(["meta_ping"]);
  });
});

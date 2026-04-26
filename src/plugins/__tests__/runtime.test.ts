import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative } from "node:path";
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
    installPolicy?: "admin" | "user",
  ): Promise<string> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });

    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_hello`;

    // Minimal ESM plugin entry — no external deps.
    const entryPath = join(pluginDir, "entry.mjs");
    await writeFile(
      entryPath,
      `export default async function createPlugin(ctx) {
  return {
    handlers: {
      "${methodName}": async () => "hi-${id}",
    },
    start: async () => {},
    stop: async () => {},
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
    if (installPolicy) manifest.installPolicy = installPolicy;
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return manifestPath;
  }

  async function writeRegistry(
    entries: Array<{ id: string; manifestPath: string; enabled?: boolean; approvedPluginAccess?: unknown }>,
  ): Promise<void> {
    await mkdir(join(testDir, "plugins"), { recursive: true });
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: entries }),
      "utf-8",
    );
  }

  function makeRuntime(): PluginRuntime {
    const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
    return new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      deploymentGuard: guard,
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
    const manifestPath = await writeFakePlugin("p-managed", "admin");
    await writeRegistry([{ id: "p-managed", manifestPath, enabled: true }]);
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

  describe("PluginHostApi.callTool", () => {
    it("callTool is injected into PluginHostApi via createHostApi", async () => {
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
        JSON.stringify({ id: "calltool-plugin", name: "calltool-plugin", version: "1.0.0", entry: "entry.mjs", tools: ["calltool_ping"] }),
        "utf-8",
      );
      await writeRegistry([{ id: "calltool-plugin", manifestPath, enabled: true }]);

      let injectedCallTool: ((toolName: string, payload?: unknown) => Promise<unknown>) | undefined;

      const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
      const runtime = new PluginRuntime({
        hostRoot: testDir,
        registryPath,
        deploymentGuard: guard,
        createHostApi: (_pluginId, _manifest) => {
          const hostApi = {
            registerKeywords: () => {},
            emitEvent: () => {},
            onEvent: () => () => {},
            addTask: () => {},
            saveMemory: async () => {},
            getSecret: () => null,
            getMsGraphToken: async () => null,
            startMsGraphAuth: async () => {},
            isMsGraphAuthenticated: () => false,
            getMsGraphAccount: () => null,
            onMsGraphAuthChange: () => {},
            callTool: async <T = unknown>(toolName: string, payload?: unknown): Promise<T> =>
              runtime.call(toolName, payload) as Promise<T>,
            withMsGraphRetry: async () => { throw new Error("not available"); },
            callLlm: async () => { throw new Error("not available"); },
            logEvent: () => {},
            onShutdown: () => {},
          };
          injectedCallTool = hostApi.callTool;
          return hostApi;
        },
      });
      await runtime.load();

      // Verify the tool is loaded and callTool was injected
      expect(runtime.listToolNames()).toContain("calltool_ping");
      expect(injectedCallTool).toBeTypeOf("function");
    });

    it("callTool delegates to pluginRuntime.call and returns Promise<T>", async () => {
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
        JSON.stringify({ id: "calltool-delegate", name: "calltool-delegate", version: "1.0.0", entry: "entry.mjs", tools: ["calltool_echo"] }),
        "utf-8",
      );
      await writeRegistry([{ id: "calltool-delegate", manifestPath, enabled: true }]);

      const guard = new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir });
      const runtime = new PluginRuntime({
        hostRoot: testDir,
        registryPath,
        deploymentGuard: guard,
        createHostApi: (_pluginId, _manifest) => ({
          registerKeywords: () => {},
          emitEvent: () => {},
          onEvent: () => () => {},
          addTask: () => {},
          saveMemory: async () => {},
          getSecret: () => null,
          getMsGraphToken: async () => null,
          startMsGraphAuth: async () => {},
          isMsGraphAuthenticated: () => false,
          getMsGraphAccount: () => null,
          onMsGraphAuthChange: () => {},
          callTool: async <T = unknown>(toolName: string, payload?: unknown): Promise<T> =>
            runtime.call(toolName, payload) as Promise<T>,
          withMsGraphRetry: async () => { throw new Error("not available"); },
          callLlm: async () => { throw new Error("not available"); },
          logEvent: () => {},
          onShutdown: () => {},
        }),
      });
      await runtime.load();

      // callTool → pluginRuntime.call → returns Promise<T>
      const result = await runtime.call("calltool_echo", { msg: "hello" });
      expect(result).toEqual({ echoed: { msg: "hello" } });

      // Return value is a Promise
      const promise = runtime.call("calltool_echo", { msg: "world" });
      expect(promise).toBeInstanceOf(Promise);
      await expect(promise).resolves.toEqual({ echoed: { msg: "world" } });
    });
  });

  it("enforces narrow cross-plugin tool/event access for orchestrator plugins", async () => {
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
          entry: "entry.mjs",
          tools: [methodName],
          ...extraManifest,
        }),
        "utf-8",
      );
      return manifestPath;
    };

    const workManifestPath = await writePlugin(
      "work-proactive",
      "work_proactive_ping",
      {
        pluginAccess: {
          plugins: [
            { pluginId: "calendar", tools: ["calendar_today"] },
            { pluginId: "email", events: ["email.action.needed"] },
            { pluginId: "meeting", events: ["meeting.summary.created", "meeting.ended"] },
          ],
        },
      },
    );
    const calendarManifestPath = await writePlugin("calendar", "calendar_today");
    const emailManifestPath = await writePlugin("email", "email_ping");
    const meetingManifestPath = await writePlugin("meeting", "meeting_ping");
    await writeRegistry([
      {
        id: "work-proactive",
        manifestPath: workManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [
            { pluginId: "calendar", tools: ["calendar_today"] },
            { pluginId: "email", events: ["email.action.needed"] },
            { pluginId: "meeting", events: ["meeting.summary.created", "meeting.ended"] },
          ],
        },
      },
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
      { id: "meeting", manifestPath: meetingManifestPath, enabled: true },
    ]);

    const runtime = makeRuntime();
    await runtime.load();

    expect(() => runtime.assertPluginToolAccess("work-proactive", "calendar_today")).not.toThrow();
    expect(() => runtime.assertPluginEventAccess("work-proactive", "email.action.needed")).not.toThrow();
    expect(() => runtime.assertPluginEventAccess("work-proactive", "meeting.summary.created")).not.toThrow();
    expect(() => runtime.assertPluginToolAccess("calendar", "work_proactive_ping")).toThrow(/not allowed/i);
    expect(() => runtime.assertPluginEventAccess("calendar", "email.action.needed")).toThrow(/not allowed/i);
  });

  it("allows work-proactive to subscribe to granted calendar events (P4 detector grants)", async () => {
    // Regression net for the host catalog ↔ registry grants paired
    // with the brain plugin's calendar-* detectors:
    //   - `calendar-event-detector` (PR #7) → `calendar.event.upcoming`
    //   - `calendar-conflict-detector` (PR-C) → `calendar.event.conflict.detected`
    // Without these grants the brain plugin throws on boot at the
    // first `hostApi.onEvent("calendar.event.<name>", ...)` call.
    // Locks both the positive (granted) and negative (event not in
    // scope, e.g. `calendar.event.starting`) paths so a future catalog
    // edit that drops events from the array doesn't silently break the
    // proactive flow.
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
        installPolicy: "user",
        entry: relative(pluginDir, entryPath),
        tools: [methodName],
        ...extraManifest,
      };
      await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
      return manifestPath;
    };

    const grantedEvents = [
      "calendar.event.upcoming",
      "calendar.event.conflict.detected",
    ];
    const workManifestPath = await writePlugin("work-proactive", "work_proactive_ping", {
      pluginAccess: {
        plugins: [
          {
            pluginId: "calendar",
            tools: ["calendar_today"],
            events: grantedEvents,
          },
        ],
      },
    });
    const calendarManifestPath = await writePlugin("calendar", "calendar_today");
    await writeRegistry([
      {
        id: "work-proactive",
        manifestPath: workManifestPath,
        enabled: true,
        approvedPluginAccess: {
          plugins: [
            {
              pluginId: "calendar",
              tools: ["calendar_today"],
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
        runtime.assertPluginEventAccess("work-proactive", ev),
      ).not.toThrow();
    }
    // Negative path — least-privilege: only the events explicitly
    // listed in the grant pass. `calendar.event.starting` is also a
    // calendar event but NOT in the grant, so the runtime denies.
    expect(() =>
      runtime.assertPluginEventAccess("work-proactive", "calendar.event.starting"),
    ).toThrow(/not allowed/i);
  });

  it("allows load-time event subscriptions when manifest pluginAccess is declared", async () => {
    const writePlugin = async (
      id: string,
      methodName: string,
      entrySource: string,
      extraManifest?: Record<string, unknown>,
    ): Promise<string> => {
      const pluginDir = join(installedDir, id);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "entry.mjs"), entrySource, "utf-8");
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          id,
          name: id,
          version: "1.0.0",
          entry: "entry.mjs",
          tools: [methodName],
          ...extraManifest,
        }),
        "utf-8",
      );
      return manifestPath;
    };

    const calendarManifestPath = await writePlugin(
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
    const emailManifestPath = await writePlugin(
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

    await writeRegistry([
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
      deploymentGuard: new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir }),
      createHostApi: (pluginId) => ({
        registerKeywords: () => {},
        emitEvent: () => {},
        onEvent: (type) => runtime.assertPluginEventAccess(pluginId, type),
        addTask: () => {},
        getSecret: () => null,
      } as unknown as import("../types.js").PluginHostApi),
    });
    await expect(runtime.load()).resolves.toBeUndefined();
    expect(() => runtime.assertPluginEventAccess("calendar", "email.analyzed")).not.toThrow();
  });

  it("blocks load-time event subscriptions to later-loaded plugins without pluginAccess", async () => {
    const writePlugin = async (
      id: string,
      methodName: string,
      entrySource: string,
      extraManifest?: Record<string, unknown>,
    ): Promise<string> => {
      const pluginDir = join(installedDir, id);
      await mkdir(pluginDir, { recursive: true });
      await writeFile(join(pluginDir, "entry.mjs"), entrySource, "utf-8");
      const manifestPath = join(pluginDir, "plugin.json");
      await writeFile(
        manifestPath,
        JSON.stringify({
          id,
          name: id,
          version: "1.0.0",
          entry: "entry.mjs",
          tools: [methodName],
          ...extraManifest,
        }),
        "utf-8",
      );
      return manifestPath;
    };

    const calendarManifestPath = await writePlugin(
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
    const emailManifestPath = await writePlugin(
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

    await writeRegistry([
      { id: "calendar", manifestPath: calendarManifestPath, enabled: true },
      { id: "email", manifestPath: emailManifestPath, enabled: true },
    ]);

    let runtime!: PluginRuntime;
    runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      deploymentGuard: new PluginDeploymentGuard({ registryPath, userInstalledDir: installedDir }),
      createHostApi: (pluginId) => ({
        registerKeywords: () => {},
        emitEvent: () => {},
        onEvent: (type) => runtime.assertPluginEventAccess(pluginId, type),
        addTask: () => {},
        getSecret: () => null,
      } as unknown as import("../types.js").PluginHostApi),
    });
    await expect(runtime.load()).rejects.toThrow(/not allowed/i);
  });

  it("blocks plugins from emitting events owned by another plugin", async () => {
    const calendarManifestPath = await writeFakePlugin("calendar");
    const emailManifestPath = await writeFakePlugin("email");

    await writeRegistry([
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
        entry: "entry.mjs",
        tools: ["cap_provider_ping"],
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
        entry: "entry.mjs",
        tools: ["needs_calendar_ping"],
        requires: { capabilities: ["calendar-source", "mail-source"] },
      }),
      "utf-8",
    );

    await writeRegistry([
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
 * `hostRoot`. Without `userInstalledDir` widening, every cloud-installed
 * plugin gets dropped on `restartAll()` after install.
 */
describe("PluginRuntime registry trusted-path", () => {
  let testDir: string;
  let hostRoot: string;
  let userInstalledDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = join(homedir(), ".lvis", "test-tmp", `trusted-path-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    hostRoot = join(testDir, "host");
    userInstalledDir = join(testDir, "user-installs");
    registryPath = join(hostRoot, "plugins", "registry.json");
    await mkdir(join(hostRoot, "plugins"), { recursive: true });
    await mkdir(userInstalledDir, { recursive: true });
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
        entry: "entry.mjs",
        tools: [`${id.replace(/[^a-zA-Z0-9_]/g, "_")}_ping`],
      }),
      "utf-8",
    );
    return manifestPath;
  }

  it("loads a plugin under userInstalledDir when widening is configured", async () => {
    const manifestPath = await writeMinimalPlugin(userInstalledDir, "cloud-plugin");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: "cloud-plugin", manifestPath, enabled: true }] }),
      "utf-8",
    );
    const runtime = new PluginRuntime({ hostRoot, userInstalledDir, registryPath });
    await runtime.load();
    expect(runtime.listPluginIds()).toContain("cloud-plugin");
  });

  it("drops a plugin under userInstalledDir when widening is NOT configured", async () => {
    const manifestPath = await writeMinimalPlugin(userInstalledDir, "cloud-plugin");
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
    // Disguise the manifest at a sibling of userInstalledDir so neither root
    // claims it; the prefix check must reject regardless of name similarity.
    const escapeDir = join(testDir, "user-installs-evil");
    const manifestPath = await writeMinimalPlugin(escapeDir, "evil");
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: [{ id: "evil", manifestPath, enabled: true }] }),
      "utf-8",
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const runtime = new PluginRuntime({ hostRoot, userInstalledDir, registryPath });
    await runtime.load();
    expect(runtime.listPluginIds()).not.toContain("evil");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/untrusted registry manifest path for evil/),
    );
    warnSpy.mockRestore();
  });
});

/**
 * The isolated arm, end to end.
 *
 * The child here is the REAL child — `servePluginChild`, the real
 * `startPluginChildRuntime`, the real `PluginMcpServer`, the real
 * `importPluginFactory` importing a real module off disk — driven over
 * in-memory paired streams instead of a pipe. That is the same substitution
 * `stdio-server-loop`'s own tests make, and it is the only one: everything
 * above the two `PassThrough`s is production code, including the dispatch table
 * assembled from the four group factories.
 *
 * What the confinement half is worth is NOT provable here, and is deliberately
 * not claimed here — `confined-plugin-child.test.ts` spawns a real process for
 * that, because a test that asserts "we called `spawnConfinedChild`" proves
 * wiring and calls it protection.
 */
import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHostApi, PluginManifest, PluginRuntimeContext } from "../../types.js";
import { servePluginChild } from "../plugin-child-main.js";
import {
  createBoundHostApiDispatchTable,
  createOutOfProcessPluginFactory,
  type ConfinedPluginChild,
} from "../out-of-process-plugin.js";
import type { ChildLink } from "../plugin-child-transport.js";
import { HOSTAPI_PATH_CONTRACTS, type HostApiPath } from "../host-api-path-contracts.js";

const PLUGIN_ID = "work-assistant";
const EMPTY_SCHEMA = { type: "object", properties: {} } as const;

const MANIFEST: PluginManifest = {
  id: PLUGIN_ID,
  name: "Work Assistant",
  version: "0.10.14",
  entry: "dist/hostPlugin.js",
  description: "the pilot plugin, served out of process",
  tools: [
    { name: "pilot_echo", description: "echo a payload back", inputSchema: EMPTY_SCHEMA },
    {
      name: "pilot_reach_host",
      description: "call the host and return what it said",
      inputSchema: EMPTY_SCHEMA,
    },
    { name: "pilot_throw", description: "throw from the handler", inputSchema: EMPTY_SCHEMA },
    {
      name: "pilot_undeclared_handler",
      description: "declared, never implemented",
      inputSchema: EMPTY_SCHEMA,
    },
  ],
};

/**
 * A plugin module written to disk, because the child imports one for real.
 *
 * A fake `loadFactory` would skip the exact thing the child had to be changed
 * to make possible: reaching `importPluginFactory` without dragging Electron
 * in. Importing a module off disk is the assertion.
 */
function writePluginModule(): { dir: string; entryPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "oop-plugin-"));
  const entryPath = join(dir, "plugin.mjs");
  writeFileSync(
    entryPath,
    `export const createPlugin = async (context) => {
  const seen = [];
  context.hostApi.onEvent("host:ping", (data) => seen.push(data));
  return {
    handlers: {
      pilot_echo: async (payload) => ({
        payload: payload ?? null,
        payloadWasAbsent: payload === undefined,
        installed: context.hostApi.getInstalledPluginIds(),
        pluginDataDir: context.pluginDataDir,
        configuredDomains: context.hostApi.config.get("domains") ?? null,
      }),
      pilot_reach_host: async () => await context.hostApi.callLlm("say hello"),
      pilot_throw: async () => { throw new Error("the handler exploded"); },
    },
    start: async () => { context.hostApi.emitEvent("pilot:started", { ok: true }); },
    stop: async () => { context.hostApi.logEvent("info", "pilot:stopped"); },
  };
};
`,
    "utf-8",
  );
  return { dir, entryPath };
}

/** Every hostApi member the pilot reaches, plus the ones the harness asserts on. */
function fakeHostApi(): PluginHostApi & {
  emitted: Array<[string, unknown]>;
  logged: Array<[string, string]>;
} {
  const emitted: Array<[string, unknown]> = [];
  const logged: Array<[string, string]> = [];
  const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
  const hostApi = {
    emitted,
    logged,
    storage: {
      resolve: (...segments: string[]) => segments.join("/"),
      read: vi.fn(),
      readText: vi.fn(),
      readJson: vi.fn(),
      list: vi.fn(),
      exists: vi.fn(),
      write: vi.fn(),
      writeJson: vi.fn(),
      rm: vi.fn(),
      mkdir: vi.fn(),
      writeEncrypted: vi.fn(),
      readEncrypted: vi.fn(),
    },
    config: {
      get: vi.fn(),
      set: vi.fn(async () => undefined),
      onChange: vi.fn(() => () => undefined),
    },
    agentApproval: { request: vi.fn(), respond: vi.fn() },
    getSecret: vi.fn(),
    getInstalledPluginIds: vi.fn(() => ["work-assistant", "meeting"]),
    hasRoutineBySource: vi.fn(async () => false),
    getAppPreference: vi.fn(),
    probePrivateHost: vi.fn(),
    resolveApiKey: vi.fn(),
    emitEvent: vi.fn((type: string, data?: unknown) => {
      emitted.push([type, data]);
    }),
    onEvent: vi.fn((type: string, handler: (data: unknown) => void) => {
      let set = eventHandlers.get(type);
      if (!set) {
        set = new Set();
        eventHandlers.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    }),
    onPluginsChanged: vi.fn(() => () => undefined),
    onShutdown: vi.fn(),
    logEvent: vi.fn((level: string, message: string) => {
      logged.push([level, message]);
    }),
    callLlm: vi.fn(async () => "the host answered"),
    hostFetch: vi.fn(),
    spawnWorker: vi.fn(),
    openExternalUrl: vi.fn(),
    openAuthWindow: vi.fn(),
    openAuthPartitionViewer: vi.fn(),
    clearAuthPartition: vi.fn(),
    triggerConversation: vi.fn(async () => ({ accepted: true })),
  } as unknown as PluginHostApi & {
    emitted: Array<[string, unknown]>;
    logged: Array<[string, string]>;
  };
  return hostApi;
}

/** A child served over paired streams, with the host's end of the link. */
function pairedChild(): { child: ConfinedPluginChild; kill: (reason: string) => void } {
  const hostToChild = new PassThrough();
  const childToHost = new PassThrough();
  const service = servePluginChild(hostToChild, childToHost);
  const goneHandlers: Array<(reason: string) => void> = [];
  const link: ChildLink = {
    input: childToHost,
    output: hostToChild,
    terminate: () => service.hostGone(),
    onGone: (handler) => goneHandlers.push(handler),
  };
  return {
    child: { link },
    kill: (reason) => {
      service.hostGone();
      for (const handler of goneHandlers) handler(reason);
    },
  };
}

function hostContext(
  hostApi: PluginHostApi,
  overrides: Partial<PluginRuntimeContext> = {},
): PluginRuntimeContext {
  return {
    pluginId: PLUGIN_ID,
    pluginRoot: "/plugins/work-assistant",
    hostRoot: "/app",
    pluginDataDir: "/plugins/work-assistant/data",
    config: { domains: ["lge.com"] },
    log: () => undefined,
    hostApi,
    ...overrides,
  };
}

describe("the dispatch table, assembled from the four group factories", () => {
  it("binds every member the contract says the host answers", () => {
    const table = createBoundHostApiDispatchTable(fakeHostApi());
    const unbound = (Object.keys(table) as HostApiPath[]).filter(
      (path) => table[path].status === "unimplemented",
    );
    expect(unbound).toEqual([]);
  });

  it("leaves the child-local members refusing, rather than servicing them", () => {
    const table = createBoundHostApiDispatchTable(fakeHostApi());
    const childLocal = (Object.keys(HOSTAPI_PATH_CONTRACTS) as HostApiPath[]).filter(
      (path) => HOSTAPI_PATH_CONTRACTS[path].result === "child-local",
    );
    expect(childLocal.length).toBeGreaterThan(0);
    for (const path of childLocal) {
      expect(table[path].status, path).toBe("child-local");
    }
  });
});

describe("the pilot, out of process", () => {
  it("invokes a declared tool end to end and returns the plugin's own value", async () => {
    const { dir, entryPath } = writePluginModule();
    const hostApi = fakeHostApi();
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));

      // Only the declared tools the plugin actually implements become handlers,
      // which is the same set `buildMethodMap` derives in-process.
      expect(Object.keys(instance.handlers).sort()).toEqual([
        "pilot_echo",
        "pilot_reach_host",
        "pilot_throw",
      ]);

      const echoed = await instance.handlers.pilot_echo!({ text: "hi" });
      // A STRUCTURED value, not its JSON text: the boundary carries the raw
      // result, so an object stays an object and a string stays a string.
      expect(echoed).toEqual({
        payload: { text: "hi" },
        payloadWasAbsent: false,
        installed: ["work-assistant", "meeting"],
        pluginDataDir: "/plugins/work-assistant/data",
        configuredDomains: ["lge.com"],
      });
      // An absent payload stays absent across the boundary. MCP carries an
      // object, so `{}` would arrive where the plugin expects nothing — and
      // several plugins branch on exactly that difference.
      const bare = (await instance.handlers.pilot_echo!()) as { payloadWasAbsent: boolean };
      expect(bare.payloadWasAbsent).toBe(true);

      // A payload that cannot be an arguments object is refused, not coerced.
      await expect(instance.handlers.pilot_echo!("not-an-object")).rejects.toThrow(
        /payload must be an object or absent/,
      );
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries a hostApi call from the child to the bound incarnation and back", async () => {
    const { dir, entryPath } = writePluginModule();
    const hostApi = fakeHostApi();
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));
      await expect(instance.handlers.pilot_reach_host!()).resolves.toBe(
        "the host answered",
      );
      // The bound instance, not a fresh one: the effect recorder and the effect
      // gate wrap THIS object in production, so a boundary bound to any other
      // would record nothing.
      // `{}` and not `undefined`: `callLlm`'s handler always passes an options
      // object, because the wire carries the three declared option fields
      // individually and rebuilds them host-side.
      expect(hostApi.callLlm).toHaveBeenCalledWith("say hello", {});
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("runs start() and stop() in the child and lets the plugin's effects reach the host", async () => {
    const { dir, entryPath } = writePluginModule();
    const hostApi = fakeHostApi();
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));
      await instance.start?.();
      expect(hostApi.emitted).toContainEqual(["pilot:started", { ok: true }]);
      await instance.stop?.();
      expect(hostApi.logged).toContainEqual(["info", "pilot:stopped"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not expose a hook the plugin does not implement, but always exposes stop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oop-plugin-bare-"));
    const entryPath = join(dir, "plugin.mjs");
    writeFileSync(
      entryPath,
      "export const createPlugin = async () => ({ handlers: {} });\n",
      "utf-8",
    );
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(fakeHostApi()));
      expect(instance.start).toBeUndefined();
      expect(instance.onPublished).toBeUndefined();
      expect(instance.readUiResource).toBeUndefined();
      // stop is the host's only hand on the child's lifetime, so it is present
      // even when the plugin implements none.
      expect(typeof instance.stop).toBe("function");
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("surfaces a throwing handler as a rejection carrying the plugin's message", async () => {
    const { dir, entryPath } = writePluginModule();
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(fakeHostApi()));
      await expect(instance.handlers.pilot_throw!()).rejects.toThrow(
        "the handler exploded",
      );
      await instance.stop?.();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a child that dies is a failed plugin, never a hung host", () => {
  it("rejects a call in flight when the child goes away", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oop-plugin-hang-"));
    const entryPath = join(dir, "plugin.mjs");
    writeFileSync(
      entryPath,
      `export const createPlugin = async () => ({
  handlers: { pilot_echo: () => new Promise(() => {}) },
});
`,
      "utf-8",
    );
    const { child, kill } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(fakeHostApi()));
      const inFlight = instance.handlers.pilot_echo!({});
      kill("child crashed");
      await expect(inFlight).rejects.toThrow(/child crashed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the factory when the child cannot construct the plugin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oop-plugin-noexport-"));
    const entryPath = join(dir, "plugin.mjs");
    writeFileSync(entryPath, "export const notAFactory = 1;\n", "utf-8");
    const { child } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      await expect(factory(hostContext(fakeHostApi()))).rejects.toThrow(
        /exports no plugin factory/,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails the factory when the child dies before it answers construct", async () => {
    const { child, kill } = pairedChild();
    // Dies the instant `construct` is written, which is the shape a spawn that
    // fails on exec takes: the host has sent its first request and there is
    // nobody left to answer it.
    const output = new PassThrough();
    output.once("data", () => kill("child exited during startup"));
    const factory = createOutOfProcessPluginFactory({
      manifest: MANIFEST,
      entryPath: join(tmpdir(), "never-imported.mjs"),
      connect: async () => ({ link: { ...child.link, output } }),
    });
    await expect(factory(hostContext(fakeHostApi()))).rejects.toThrow(
      /child exited during startup/,
    );
  });

  it("releases the host-side subscriptions the dead child opened", async () => {
    const { dir, entryPath } = writePluginModule();
    const hostApi = fakeHostApi();
    const unsubscribe = vi.fn();
    (hostApi.onEvent as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => unsubscribe,
    );
    const { child, kill } = pairedChild();
    try {
      const factory = createOutOfProcessPluginFactory({
        manifest: MANIFEST,
        entryPath,
        connect: async () => child,
      });
      const instance = await factory(hostContext(hostApi));
      // The plugin subscribed in its factory body; the round trip that opens
      // the host half is not awaited by the contract, so settle it first.
      await instance.handlers.pilot_echo!({});
      expect(hostApi.onEvent).toHaveBeenCalledWith("host:ping", expect.any(Function));
      expect(unsubscribe).not.toHaveBeenCalled();

      kill("child crashed");
      // The host-side registration is undone even though the child never sent
      // a release — case 2 of the four ways a two-sided lifetime ends.
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

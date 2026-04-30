/**
 * Tests for the three architect follow-ups from PR #331 (configSchema):
 *
 *   US-3c.1 — secretsPresent detection via lvis:plugins:config:secret:list-keys
 *   US-3c.2 — restartPlugin() restarts one plugin, leaves others undisturbed
 *   US-3c.3 — SECRET_REDACTED_SENTINEL replaces "[REDACTED]" literal; equality
 *              checks on the sentinel don't produce false transitions
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { PluginRuntime } from "../runtime.js";
import {
  emitPluginConfigChange,
  subscribePluginConfigChange,
  _resetPluginConfigChangeBus,
  SECRET_REDACTED_SENTINEL,
} from "../config-change-bus.js";

// ─────────────────────────────────────────────────────────────────────────────
// US-3c.3 — SECRET_REDACTED_SENTINEL
// ─────────────────────────────────────────────────────────────────────────────

describe("US-3c.3 — SECRET_REDACTED_SENTINEL", () => {
  beforeEach(() => {
    _resetPluginConfigChangeBus();
  });

  it("is a symbol (not a string)", () => {
    expect(typeof SECRET_REDACTED_SENTINEL).toBe("symbol");
  });

  it("is stable across imports via Symbol.for key", () => {
    // Symbol.for("lvis.config.secret.redacted") must always return the same symbol
    expect(SECRET_REDACTED_SENTINEL).toBe(Symbol.for("lvis.config.secret.redacted"));
  });

  it("listener receives sentinel when secret is emitted, not '[REDACTED]' string", () => {
    const received: Array<[string, unknown]> = [];
    subscribePluginConfigChange("plugin.x", "apiKey", (k, v) => received.push([k, v]));

    emitPluginConfigChange("plugin.x", "apiKey", SECRET_REDACTED_SENTINEL);

    expect(received).toHaveLength(1);
    const [key, value] = received[0];
    expect(key).toBe("apiKey");
    expect(value).toBe(SECRET_REDACTED_SENTINEL);
    // Must NOT be the old literal string
    expect(value).not.toBe("[REDACTED]");
  });

  it("equality check on sentinel reliably distinguishes secret-change from cleartext value", () => {
    const sentinelHits: string[] = [];
    const cleartextHits: string[] = [];

    subscribePluginConfigChange("plugin.y", "apiKey", (_k, v) => {
      if (v === SECRET_REDACTED_SENTINEL) {
        sentinelHits.push("secret-updated");
      } else {
        cleartextHits.push(String(v));
      }
    });

    // Secret update → sentinel
    emitPluginConfigChange("plugin.y", "apiKey", SECRET_REDACTED_SENTINEL);
    // Cleartext update → actual value
    emitPluginConfigChange("plugin.y", "apiKey", "some-value");
    // Another secret update
    emitPluginConfigChange("plugin.y", "apiKey", SECRET_REDACTED_SENTINEL);

    expect(sentinelHits).toHaveLength(2);
    expect(cleartextHits).toEqual(["some-value"]);
  });

  it("setting the same secret twice fires the sentinel twice (no false equality skip)", () => {
    // A listener doing prev === current with a Symbol will always see them as
    // the same identity, so this tests that the bus still fires on every emit
    // (the bus itself does not deduplicate).
    const hits: unknown[] = [];
    subscribePluginConfigChange("plugin.z", "token", (_k, v) => hits.push(v));

    emitPluginConfigChange("plugin.z", "token", SECRET_REDACTED_SENTINEL);
    emitPluginConfigChange("plugin.z", "token", SECRET_REDACTED_SENTINEL);

    expect(hits).toHaveLength(2);
    expect(hits[0]).toBe(SECRET_REDACTED_SENTINEL);
    expect(hits[1]).toBe(SECRET_REDACTED_SENTINEL);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-3c.2 — PluginRuntime.restartPlugin()
// ─────────────────────────────────────────────────────────────────────────────

describe("US-3c.2 — PluginRuntime.restartPlugin", () => {
  let testDir: string;
  let installedDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), "lvis-restart-"));
    installedDir = join(testDir, "plugins");
    await mkdir(installedDir, { recursive: true });
    registryPath = join(installedDir, "registry.json");
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function writeFakePlugin(id: string): Promise<string> {
    const pluginDir = join(installedDir, id);
    await mkdir(pluginDir, { recursive: true });
    const methodName = `${id.replace(/[^a-zA-Z0-9_]/g, "_")}_hello`;
    const entryPath = join(pluginDir, "entry.mjs");
    await writeFile(
      entryPath,
      `export default async function createPlugin() {
  return {
    handlers: { "${methodName}": async () => "hi-${id}" },
    start: async () => {},
    stop: async () => {},
  };
}
`,
      "utf-8",
    );
    const manifest = {
      id,
      name: id,
      version: "1.0.0",
      entry: "entry.mjs",
      tools: [methodName],
    };
    const manifestPath = join(pluginDir, "plugin.json");
    await writeFile(manifestPath, JSON.stringify(manifest), "utf-8");
    return manifestPath;
  }

  async function writeRegistry(
    entries: Array<{ id: string; manifestPath: string; enabled?: boolean }>,
  ): Promise<void> {
    await writeFile(
      registryPath,
      JSON.stringify({ version: 1, plugins: entries }),
      "utf-8",
    );
  }

  it("restartPlugin reloads one plugin and leaves the other plugin running", async () => {
    const mpA = await writeFakePlugin("plugin-a");
    const mpB = await writeFakePlugin("plugin-b");
    await writeRegistry([
      { id: "plugin-a", manifestPath: mpA, enabled: true },
      { id: "plugin-b", manifestPath: mpB, enabled: true },
    ]);

    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();

    // Both plugins loaded before restart
    expect(runtime.listPluginIds()).toContain("plugin-a");
    expect(runtime.listPluginIds()).toContain("plugin-b");

    // Restart only plugin-a
    await runtime.restartPlugin("plugin-a");

    // plugin-a still present after restart
    expect(runtime.listPluginIds()).toContain("plugin-a");
    // plugin-b untouched
    expect(runtime.listPluginIds()).toContain("plugin-b");

    // Methods for both plugins are still callable
    expect(runtime.listToolNames()).toContain("plugin_a_hello");
    expect(runtime.listToolNames()).toContain("plugin_b_hello");
  });

  it("restartPlugin is a no-op (logs warning) for an unknown pluginId", async () => {
    const mpA = await writeFakePlugin("plugin-a");
    await writeRegistry([{ id: "plugin-a", manifestPath: mpA, enabled: true }]);
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();

    const warnSpy = vi.spyOn(console, "warn");

    // Should not throw
    await expect(runtime.restartPlugin("no-such-plugin")).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no-such-plugin"),
    );

    // Existing plugin unaffected
    expect(runtime.listPluginIds()).toContain("plugin-a");
  });

  it("restartAll() still works and restarts all plugins", async () => {
    const mpA = await writeFakePlugin("plugin-a");
    const mpB = await writeFakePlugin("plugin-b");
    await writeRegistry([
      { id: "plugin-a", manifestPath: mpA, enabled: true },
      { id: "plugin-b", manifestPath: mpB, enabled: true },
    ]);
    const runtime = new PluginRuntime({
      hostRoot: testDir,
      registryPath,
      pluginsRoot: installedDir,
    });
    await runtime.startAll();
    expect(runtime.listPluginIds()).toHaveLength(2);

    await runtime.restartAll();
    expect(runtime.listPluginIds()).toHaveLength(2);
    expect(runtime.listPluginIds()).toContain("plugin-a");
    expect(runtime.listPluginIds()).toContain("plugin-b");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// US-3c.1 — lvis:plugins:config:secret:list-keys IPC handler
// (handler-level unit test mirroring ipc-bridge-runtime-handlers.test.ts)
// ─────────────────────────────────────────────────────────────────────────────

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, fn);
    }),
  },
}));

vi.mock("../../permissions/policy-store.js", () => ({
  loadPolicy: vi.fn(),
  savePolicy: vi.fn(),
}));

function makeMockPM() {
  return {
    getMode: vi.fn(() => "default"),
    setModePersist: vi.fn(),
    listPersistedRules: vi.fn(async () => []),
    addAlwaysAllowedPersist: vi.fn(),
    addAlwaysDeniedPersist: vi.fn(),
    removeRule: vi.fn(),
    getVisibilityDenyRules: vi.fn(() => []),
  };
}

function makeMockGate() {
  return { resolve: vi.fn(), setPolicy: vi.fn() };
}

import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

function makeServicesForListSecretKeys(secretsMap: Record<string, string | null>) {
  return {
    pluginRuntime: {
      call: vi.fn(),
      listToolNames: vi.fn(() => []),
      listPluginIds: vi.fn(() => []),
      listPluginCards: vi.fn(() => []),
      restartAll: vi.fn(),
      restartPlugin: vi.fn(),
      setConfigOverride: vi.fn(),
      listUiExtensions: vi.fn(() => []),
      getPluginManifest: vi.fn((pluginId: string) => {
        if (pluginId === "test.plugin") {
          return {
            configSchema: {
              properties: {
                endpoint: { type: "string" },
                apiKey: { type: "string", format: "secret" },
                token: { type: "string", format: "secret" },
                retries: { type: "integer", default: 3 },
              },
            },
          };
        }
        return null;
      }),
    } as any,
    pluginMarketplace: { list: vi.fn(), install: vi.fn(), uninstall: vi.fn() } as any,
    taskService: {
      add: vi.fn(), update: vi.fn(), get: vi.fn(), delete: vi.fn(),
      query: vi.fn(), getPendingByPriority: vi.fn(() => []),
      getOverdue: vi.fn(() => []), getDueToday: vi.fn(() => []),
    } as any,
    settingsService: {
      getAll: vi.fn(),
      patch: vi.fn(),
      get: vi.fn((key: string) => {
        if (key === "marketplace") return { backend: "mock" };
        return fakeLlmSettings();
      }),
      getSecret: vi.fn((key: string) => secretsMap[key] ?? null),
      setSecret: vi.fn(),
      deleteSecret: vi.fn(),
      getPluginConfig: vi.fn(() => ({})),
      setPluginConfig: vi.fn(async (_pluginId: string, config: unknown) => config),
    } as any,
    memoryManager: {
      listMemoryEntries: vi.fn(() => []),
      saveMemory: vi.fn(),
      deleteMemory: vi.fn(),
      searchMemoryEntries: vi.fn(() => []),
      getMemoryContext: vi.fn(() => ""),
      getLvisMd: vi.fn(),
      updateLvisMd: vi.fn(),
      getUserPreferences: vi.fn(),
      updateUserPreferences: vi.fn(),
    } as any,
    conversationLoop: {
      permissionManager: makeMockPM(),
      hasProvider: vi.fn(),
      runTurn: vi.fn(),
      newConversation: vi.fn(),
      getSessionId: vi.fn(() => "s1"),
      listSessions: vi.fn(() => []),
      loadSession: vi.fn(),
      refreshProvider: vi.fn(),
    } as any,
    approvalGate: makeMockGate() as any,
    mcpManager: { listServers: vi.fn(() => []), killSwitch: vi.fn() } as any,
    toolRegistry: { setDenyRules: vi.fn(), size: 0 } as any,
    auditLogger: { log: vi.fn() } as any,
    idleScheduler: undefined,
    bashAstValidator: {} as any,
    auditService: {} as any,
    postTurnHookChain: {} as any,
    knowledgeAvailable: false,
  };
}

describe("US-3c.1 — lvis:plugins:config:secret:list-keys IPC handler", () => {
  beforeEach(async () => {
    ipcHandlers.clear();
    vi.clearAllMocks();
    const { registerIpcHandlers } = await import("../../ipc-bridge.js");
    registerIpcHandlers(
      makeServicesForListSecretKeys({
        "plugin.test.plugin.apiKey": "enc-value",
        "plugin.test.plugin.token": null,   // not stored
      }),
      () => null,
    );
  });

  function invoke(channel: string, event: unknown, ...args: unknown[]): unknown {
    const fn = ipcHandlers.get(channel);
    if (!fn) throw new Error(`No handler: ${channel}`);
    return fn(event, ...args);
  }

  function trustedEvent() {
    return { senderFrame: { url: "file://" } };
  }

  function untrustedEvent() {
    return { senderFrame: { url: "https://evil.example.com/" } };
  }

  it("returns only keys that have a stored secret", async () => {
    const result = await invoke(
      "lvis:plugins:config:secret:list-keys",
      trustedEvent(),
      "test.plugin",
    ) as { ok: boolean; keys: string[] };

    expect(result.ok).toBe(true);
    expect(result.keys).toContain("apiKey");
    expect(result.keys).not.toContain("token");   // null → not present
    expect(result.keys).not.toContain("endpoint"); // not a secret field
    expect(result.keys).not.toContain("retries");  // not a secret field
  });

  it("returns empty keys for a plugin without configSchema", async () => {
    const result = await invoke(
      "lvis:plugins:config:secret:list-keys",
      trustedEvent(),
      "unknown.plugin",
    ) as { ok: boolean; keys: string[] };

    expect(result.ok).toBe(true);
    expect(result.keys).toEqual([]);
  });

  it("rejects untrusted frames with unauthorized-frame error", async () => {
    const result = await invoke(
      "lvis:plugins:config:secret:list-keys",
      untrustedEvent(),
      "test.plugin",
    ) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("unauthorized-frame");
  });
});

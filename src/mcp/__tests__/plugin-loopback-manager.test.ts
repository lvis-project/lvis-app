/**
 * `PluginLoopbackManager` lifecycle (mcp-alignment-design.md §3.1).
 * The boot cutover seam: start on enable, stop on disable, idempotent reload,
 * stopAll on shutdown — driving real PluginMcpHosts over a real ToolRegistry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PluginLoopbackManager } from "../plugin-loopback-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { manifestIntegrityState } from "../../permissions/manifest-integrity.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";

beforeEach(() => manifestIntegrityState.resetForTests());

// #885 v6 — the loopback consumes the NORMALIZED pure `Tool[]`. Each tool is one
// model-visible object; category is host-derived (the wire carries none).
function manifest(id: string, tools: string[]): PluginManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    entry: "dist/index.js",
    description: id,
    tools: tools.map((t) => ({
      name: t,
      description: t,
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    })),
  };
}

function fakeRuntime(): PluginRuntime {
  return {
    isPluginEnabled: () => true,
    call: vi.fn(async (name: string) => `ran ${name}`),
  } as unknown as PluginRuntime;
}

/**
 * A tool that (in the pre-v6 world) omitted `category`. Under host-classifies-risk
 * it loads at the write-equivalent default-strict baseline rather than throwing —
 * used to pin that the missing-category hard-fail is gone. In v6 category is gone
 * from the contract entirely, so every loopback tool registers as write-equivalent.
 */
function categorylessManifest(id: string, tool: string): PluginManifest {
  return {
    id,
    name: id,
    version: "2.0.0",
    entry: "dist/index.js",
    description: id,
    tools: [
      {
        name: tool,
        description: tool,
        inputSchema: { type: "object", properties: {} },
        _meta: { ui: { visibility: ["model"] } },
      },
    ],
  };
}

describe("PluginLoopbackManager", () => {
  it("start registers a plugin's tools and tracks the host", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    const names = await mgr.start(manifest("com.a", ["a_one", "a_two"]));
    expect(names).toEqual(["a_one", "a_two"]);
    expect(mgr.has("com.a")).toBe(true);
    expect(mgr.list()).toEqual(["com.a"]);
    expect(registry.findByName("a_one")?.pluginId).toBe("com.a");
  });

  it("start is idempotent — a reload re-registers without duplicating", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.start(manifest("com.a", ["a_one"]));
    // Reload with a changed tool set — old tool gone, new tool present, one host.
    const names = await mgr.start(manifest("com.a", ["a_renamed"]));
    expect(names).toEqual(["a_renamed"]);
    expect(mgr.list()).toEqual(["com.a"]);
    expect(registry.findByName("a_one")).toBeUndefined();
    expect(registry.findByName("a_renamed")?.pluginId).toBe("com.a");
  });

  it("stop unregisters one plugin's tools and forgets the host", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);
    await mgr.start(manifest("com.a", ["a_one"]));
    await mgr.start(manifest("com.b", ["b_one"]));

    await mgr.stop("com.a");
    expect(mgr.has("com.a")).toBe(false);
    expect(registry.findByName("a_one")).toBeUndefined();
    // Bystander untouched.
    expect(registry.findByName("b_one")?.pluginId).toBe("com.b");
    expect(mgr.list()).toEqual(["com.b"]);
  });

  it("stop is a no-op for an unknown plugin", async () => {
    const mgr = new PluginLoopbackManager(fakeRuntime(), new ToolRegistry());
    await expect(mgr.stop("nope")).resolves.toBeUndefined();
  });

  it("category-less reload now loads write-equivalent (default-strict), not a hard fail", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.start(manifest("com.a", ["a_one"]));
    // host-classifies-risk: a category-less tool no longer aborts the load — it
    // registers at the write-equivalent default-strict baseline.
    await expect(mgr.start(categorylessManifest("com.a", "a_bad"))).resolves.toEqual(["a_bad"]);
    expect(registry.findByName("a_bad")?.category).toBe("write");
    // The reload atomically swapped com.a's tool set.
    expect(registry.findByName("a_one")).toBeUndefined();
    expect(mgr.list()).toEqual(["com.a"]);
  });

  it("atomic reload: a failed reload keeps the PREVIOUS tools (no zero-tools window)", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.start(manifest("com.a", ["a_one"]));
    const before = registry.findByName("a_one");
    expect(before?.pluginId).toBe("com.a");
    // A bystander plugin owns the name the reload will try to claim.
    await mgr.start(manifest("com.b", ["clash"]));

    // Reload com.a declaring a tool name already owned by com.b → the atomic
    // swap's cross-plugin name-collision guard throws, leaving com.a's previous
    // registration fully intact (no zero-tools window).
    await expect(mgr.start(manifest("com.a", ["clash"]))).rejects.toThrow(
      /name collision/i,
    );

    expect(registry.findByName("a_one")).toBe(before);
    expect(registry.findByName("clash")?.pluginId).toBe("com.b");
    expect(mgr.list().sort()).toEqual(["com.a", "com.b"]);
  });

  it("atomic reload: a successful reload swaps to the new tool set", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.start(manifest("com.a", ["a_old"]));
    expect(registry.findByName("a_old")?.pluginId).toBe("com.a");

    await mgr.start(manifest("com.a", ["a_new"]));
    expect(registry.findByName("a_old")).toBeUndefined();
    expect(registry.findByName("a_new")?.pluginId).toBe("com.a");
    expect(mgr.list()).toEqual(["com.a"]);
  });

  it("syncAll reconciles: starts present plugins, stops gone ones, leaves bystanders untouched", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);

    await mgr.syncAll([
      { pluginId: "com.a", manifest: manifest("com.a", ["a_one"]) },
      { pluginId: "com.b", manifest: manifest("com.b", ["b_one"]) },
    ]);
    expect(mgr.list().sort()).toEqual(["com.a", "com.b"]);
    const bystander = registry.findByName("a_one");

    // Re-sync with com.b removed (uninstall): b's tools gone, a's identity preserved.
    await mgr.syncAll([{ pluginId: "com.a", manifest: manifest("com.a", ["a_one"]) }]);
    expect(mgr.list()).toEqual(["com.a"]);
    expect(registry.findByName("b_one")).toBeUndefined();
    expect(registry.findByName("a_one")).toBe(bystander); // not churned (has()-guard)
  });

  it("stopAll tears down every running host", async () => {
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);
    await mgr.start(manifest("com.a", ["a_one"]));
    await mgr.start(manifest("com.b", ["b_one"]));

    await mgr.stopAll();
    expect(mgr.list()).toEqual([]);
    expect(registry.findByName("a_one")).toBeUndefined();
    expect(registry.findByName("b_one")).toBeUndefined();
  });
});

/**
 * ARCH MINOR-1 — teardown parity between the two MCP server arms.
 *
 * A plugin's loopback host used to go down SILENTLY: only `McpManager` fed the
 * `serverDisconnected` sink, so disabling a plugin left its live MCP-App cards
 * rendered and interactive against a server that no longer existed, while an
 * external server's cards correctly flipped to the `mcp-app-disconnected`
 * placeholder. Same sink, same event shape, both arms.
 */
describe("PluginLoopbackManager — serverDisconnected broadcast (teardown parity)", () => {
  it("stop() emits the disconnect for the stopped plugin (serverId === pluginId)", async () => {
    const onDisconnected = vi.fn();
    const mgr = new PluginLoopbackManager(fakeRuntime(), new ToolRegistry(), onDisconnected);
    await mgr.start(manifest("com.a", ["a_one"]));

    await mgr.stop("com.a");
    expect(onDisconnected).toHaveBeenCalledTimes(1);
    expect(onDisconnected).toHaveBeenCalledWith("com.a");
  });

  it("does not emit for an unknown plugin (stop is a no-op)", async () => {
    const onDisconnected = vi.fn();
    const mgr = new PluginLoopbackManager(fakeRuntime(), new ToolRegistry(), onDisconnected);
    await mgr.stop("never-started");
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("emits once per host on stopAll, and once per REMOVED plugin on syncAll", async () => {
    const onDisconnected = vi.fn();
    const mgr = new PluginLoopbackManager(fakeRuntime(), new ToolRegistry(), onDisconnected);
    await mgr.syncAll([
      { pluginId: "com.a", manifest: manifest("com.a", ["a_one"]) },
      { pluginId: "com.b", manifest: manifest("com.b", ["b_one"]) },
    ]);
    expect(onDisconnected).not.toHaveBeenCalled();

    // Uninstall com.b: only the removed plugin's cards are disconnected.
    await mgr.syncAll([{ pluginId: "com.a", manifest: manifest("com.a", ["a_one"]) }]);
    expect(onDisconnected.mock.calls).toEqual([["com.b"]]);

    await mgr.stopAll();
    expect(onDisconnected.mock.calls).toEqual([["com.b"], ["com.a"]]);
  });

  it("a reload (start over a running host) does NOT emit a disconnect", async () => {
    const onDisconnected = vi.fn();
    const mgr = new PluginLoopbackManager(fakeRuntime(), new ToolRegistry(), onDisconnected);
    await mgr.start(manifest("com.a", ["a_one"]));
    // The atomic swap disposes the superseded host; the server is still there.
    await mgr.start(manifest("com.a", ["a_two"]));
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("defaults to the real sink — a construction site cannot silently opt out", async () => {
    // No sink injected: the default is the SAME factory McpManager gets. It is
    // best-effort by contract (its own try/catch swallows a headless-Electron
    // failure), so stop() must still complete cleanly.
    const registry = new ToolRegistry();
    const mgr = new PluginLoopbackManager(fakeRuntime(), registry);
    await mgr.start(manifest("com.a", ["a_one"]));
    await expect(mgr.stop("com.a")).resolves.toBeUndefined();
    expect(registry.findByName("a_one")).toBeUndefined();
  });
});

describe("PluginLoopbackManager — ui:// resource serving (readUiResource)", () => {
  /**
   * Content-serving: the PLUGIN serves the card bytes through
   * `PluginRuntime.readUiResource` (host-gated + host-bounded there). No plugin
   * root, no disk fixture — the host reads no plugin file on this path.
   */
  function cardRuntime(): PluginRuntime {
    return {
      isPluginEnabled: () => true,
      call: vi.fn(async (name: string) => `ran ${name}`),
      readUiResource: vi.fn(async (_pluginId: string, uri: string) => {
        if (!uri.endsWith("/card.html")) throw new Error(`plugin has no card '${uri}'`);
        return "<h1>served</h1>";
      }),
    } as unknown as PluginRuntime;
  }

  function uiManifest(id: string): PluginManifest {
    return {
      ...manifest(id, ["card_open"]),
      uiResources: [
        {
          uri: `ui://${id}/card.html`,
          csp: { connectDomains: ["https://api.example.com"] },
        },
      ],
    };
  }

  it("serves a plugin's OWN declared ui:// resource (plugin html + manifest-declared csp)", async () => {
    const runtime = cardRuntime();
    const mgr = new PluginLoopbackManager(runtime, new ToolRegistry());
    await mgr.start(uiManifest("com.cards"));

    const res = await mgr.readUiResource("com.cards", "ui://com.cards/card.html");
    expect(res.html).toBe("<h1>served</h1>");
    expect(res.csp).toEqual({ connectDomains: ["https://api.example.com"] });
    expect(runtime.readUiResource).toHaveBeenCalledWith("com.cards", "ui://com.cards/card.html");
  });

  it("rejects a cross-plugin uri authority (own-namespace-only, fail-closed)", async () => {
    const runtime = cardRuntime();
    const mgr = new PluginLoopbackManager(runtime, new ToolRegistry());
    await mgr.start(uiManifest("com.cards"));

    await expect(
      mgr.readUiResource("com.cards", "ui://com.evil/card.html"),
    ).rejects.toThrow(/own namespace/i);
    // The plugin is never asked to serve another namespace's card.
    expect(runtime.readUiResource).not.toHaveBeenCalled();
  });

  it("rejects an undeclared uri in the plugin's own namespace", async () => {
    const runtime = cardRuntime();
    const mgr = new PluginLoopbackManager(runtime, new ToolRegistry());
    await mgr.start(uiManifest("com.cards"));

    await expect(
      mgr.readUiResource("com.cards", "ui://com.cards/nope.html"),
    ).rejects.toThrow(/no declared ui:\/\/ resource/i);
    expect(runtime.readUiResource).not.toHaveBeenCalled();
  });

  it("throws when no loopback host runs for the plugin", async () => {
    const mgr = new PluginLoopbackManager(cardRuntime(), new ToolRegistry());
    await expect(
      mgr.readUiResource("com.absent", "ui://com.absent/card.html"),
    ).rejects.toThrow(/no running loopback host/i);
  });
});

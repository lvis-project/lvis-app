import { beforeEach, describe, expect, it, vi } from "vitest";
import { PluginLoopbackManager, type PreparedPluginLoopbackGeneration } from "../plugin-loopback-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { manifestIntegrityState } from "../../permissions/manifest-integrity.js";
import type { PluginRuntime } from "../../plugins/runtime.js";
import type { PluginManifest } from "../../plugins/types.js";

beforeEach(() => manifestIntegrityState.resetForTests());

function manifest(id: string, tools: string[]): PluginManifest {
  return {
    id,
    name: id,
    version: "1.0.0",
    entry: "dist/index.js",
    description: id,
    publisher: "tests",
    tools: tools.map((name) => ({
      name,
      description: name,
      inputSchema: { type: "object", properties: {} },
      _meta: { ui: { visibility: ["model"] } },
    })),
  };
}

function fakeRuntime(): PluginRuntime {
  return {
    isPluginEnabled: () => true,
    isSessionActivated: () => false,
    callForPlugin: vi.fn(async (_pluginId: string, name: string) => `ran ${name}`),
  } as unknown as PluginRuntime;
}

async function prepareAndPublish(
  manager: PluginLoopbackManager,
  candidate: PluginManifest,
  generationId: string,
): Promise<PreparedPluginLoopbackGeneration> {
  const prepared = await manager.prepareGeneration(candidate, generationId);
  manager.publishGeneration(prepared);
  manager.postPublishGeneration(prepared);
  return prepared;
}

describe("PluginLoopbackManager generation publication", () => {
  it("keeps a prepared host hidden until the shared pointer publication", async () => {
    const registry = new ToolRegistry();
    const manager = new PluginLoopbackManager(fakeRuntime(), registry);
    const prepared = await manager.prepareGeneration(manifest("com.a", ["a_one", "a_two"]), "g1");

    expect(manager.has("com.a")).toBe(false);
    expect(registry.findByName("a_one")).toBeUndefined();

    manager.publishGeneration(prepared);
    expect(manager.has("com.a")).toBe(true);
    expect(manager.list()).toEqual(["com.a"]);
    expect(registry.findByName("a_one")?.pluginId).toBe("com.a");
  });

  it("atomically replaces tools and rejects stale card generations", async () => {
    const registry = new ToolRegistry();
    const manager = new PluginLoopbackManager(fakeRuntime(), registry);
    await prepareAndPublish(manager, manifest("com.a", ["a_old"]), "g1");
    const next = await prepareAndPublish(manager, manifest("com.a", ["a_new"]), "g2");

    expect(registry.findByName("a_old")).toBeUndefined();
    expect(registry.findByName("a_new")?.pluginId).toBe("com.a");
    expect(() => manager.assertCardGeneration("com.a", "g1")).toThrow(/stale card generation/);
    expect(() => manager.assertCardGeneration("com.a", "g2")).not.toThrow();

    await manager.retireGeneration("com.a", "g1");
    expect(next.published).toBe(true);
  });

  it("keeps the predecessor published when candidate reservation collides", async () => {
    const registry = new ToolRegistry();
    const manager = new PluginLoopbackManager(fakeRuntime(), registry);
    await prepareAndPublish(manager, manifest("com.a", ["a_one"]), "a1");
    await prepareAndPublish(manager, manifest("com.b", ["clash"]), "b1");

    await expect(manager.prepareGeneration(manifest("com.a", ["clash"]), "a2"))
      .rejects.toThrow(/name collision/i);
    expect(registry.findByName("a_one")?.pluginId).toBe("com.a");
    expect(registry.findByName("clash")?.pluginId).toBe("com.b");
  });

  it("publishes removal before retirement and emits one disconnect", async () => {
    const registry = new ToolRegistry();
    const disconnected = vi.fn();
    const manager = new PluginLoopbackManager(fakeRuntime(), registry, disconnected);
    await prepareAndPublish(manager, manifest("com.a", ["a_one"]), "g1");
    const removal = manager.prepareRemoval("com.a", "g2");

    manager.publishGeneration(removal);
    expect(manager.has("com.a")).toBe(false);
    expect(registry.findByName("a_one")).toBeUndefined();
    expect(disconnected).not.toHaveBeenCalled();

    manager.postPublishGeneration(removal);
    expect(disconnected).toHaveBeenCalledWith("com.a");
    await manager.retireGeneration("com.a", "g1");
    expect(disconnected).toHaveBeenCalledTimes(1);
  });

  it("clears disconnect retirement only for the removed plugin predecessor", async () => {
    const registry = new ToolRegistry();
    const disconnected = vi.fn();
    const manager = new PluginLoopbackManager(fakeRuntime(), registry, disconnected);
    await prepareAndPublish(manager, manifest("com.a", ["a_old"]), "a1");
    await prepareAndPublish(manager, manifest("com.a", ["a_new"]), "a2");
    await prepareAndPublish(manager, manifest("com.b", ["b_one"]), "b1");

    const removal = manager.prepareRemoval("com.b", "b2");
    manager.publishGeneration(removal);
    manager.postPublishGeneration(removal);
    await manager.retireGeneration("com.b", "b1");

    expect(disconnected).toHaveBeenCalledTimes(1);
    expect(disconnected).toHaveBeenCalledWith("com.b");
    await manager.retireGeneration("com.a", "a1");
    expect(disconnected).toHaveBeenCalledTimes(1);
  });
});

describe("PluginLoopbackManager ui resources", () => {
  function uiManifest(id: string): PluginManifest {
    return {
      ...manifest(id, ["card_open"]),
      uiResources: [{
        uri: `ui://${id}/card.html`,
        csp: { connectDomains: ["https://api.example.com"] },
      }],
    };
  }

  it("serves only the exact declared resource from the published generation", async () => {
    const runtime = {
      ...fakeRuntime(),
      readUiResource: vi.fn(async () => "<h1>served</h1>"),
    } as unknown as PluginRuntime;
    const manager = new PluginLoopbackManager(runtime, new ToolRegistry());
    await prepareAndPublish(manager, uiManifest("com.cards"), "cards-g1");

    await expect(manager.readUiResource("com.cards", "ui://com.cards/card.html"))
      .resolves.toEqual({
        html: "<h1>served</h1>",
        csp: { connectDomains: ["https://api.example.com"] },
      });
    expect(runtime.readUiResource).toHaveBeenCalledWith(
      "com.cards",
      "ui://com.cards/card.html",
      undefined,
      "cards-g1",
    );
    await expect(manager.readUiResource("com.cards", "ui://com.evil/card.html"))
      .rejects.toThrow(/own namespace/i);
    await expect(manager.readUiResource("com.cards", "ui://com.cards/missing.html"))
      .rejects.toThrow(/no declared ui:\/\/ resource/i);
  });
});

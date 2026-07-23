import { describe, expect, it, vi } from "vitest";
import { PluginRuntime } from "../runtime/index.js";
import type { PluginManifest, RuntimePlugin } from "../runtime/types.js";
import type { PluginRuntimeGenerationProjection } from "../plugin-host-generation.js";

describe("PluginRuntime generation isolation", () => {
  it("does not fall back to a live handler missing from the leased generation", async () => {
    const runtime = new PluginRuntime({ hostRoot: "/tmp/lvis-runtime-generation-test" });
    const pluginId = "strict-generation";
    const method = "strict_generation_read";
    const legacyHandler = vi.fn(async () => "stale");
    const manifest = {
      id: pluginId,
      name: "Strict generation",
      version: "1.0.0",
      entry: "index.js",
      description: "Generation isolation test fixture.",
      publisher: "LVIS",
      tools: [],
    } as PluginManifest;
    const instance = { handlers: {} } as RuntimePlugin;
    const projection: PluginRuntimeGenerationProjection = {
      manifest,
      pluginRoot: "/tmp/lvis-runtime-generation-test/plugin",
      instance,
      methods: new Map(),
    };

    const internals = runtime as unknown as {
      methodMap: Map<string, { pluginId: string; handler: typeof legacyHandler }>;
      plugins: Map<string, {
        manifest: PluginManifest;
        pluginRoot: string;
        instance: RuntimePlugin;
        methods: Map<string, typeof legacyHandler>;
        started: boolean;
      }>;
    };
    internals.methodMap.set(method, { pluginId, handler: legacyHandler });
    internals.plugins.set(pluginId, {
      manifest,
      pluginRoot: projection.pluginRoot,
      instance,
      methods: new Map([[method, legacyHandler]]),
      started: true,
    });
    const lease = {
      generation: {
        pluginId,
        generationId: "generation-2",
        state: { runtime: projection },
      },
      release: vi.fn(),
    };
    runtime.setGenerationAccess({
      getActive: vi.fn(() => lease.generation as never),
      acquire: vi.fn(async () => lease as never),
      acquireExact: vi.fn(async () => lease as never),
    });

    await expect(runtime.call(method)).rejects.toThrow(/not found in active generation/);
    expect(legacyHandler).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledOnce();
  });
});

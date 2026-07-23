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
      activationId: "activation-2",
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
      replaceRuntime: vi.fn(async () => undefined),
      getActive: vi.fn(() => lease.generation as never),
      acquire: vi.fn(async () => lease as never),
      acquireExact: vi.fn(async () => lease as never),
      runWithLease: vi.fn(async (_lease, operation) => operation()),
    });

    await expect(runtime.call(method)).rejects.toThrow(/not found in active generation/);
    expect(legacyHandler).not.toHaveBeenCalled();
    expect(lease.release).toHaveBeenCalledOnce();
  });

  it("fails closed when an operation is attempted before lifecycle binding", async () => {
    const runtime = new PluginRuntime({ hostRoot: "/tmp/lvis-runtime-unbound-test" });
    runtime._testInjectPlugin("unbound", "unbound_read", async () => "must-not-run");

    await expect(runtime.call("unbound_read")).rejects.toThrow(
      /generation access is not bound before plugin operation/,
    );
  });

  it("lets an admitted exact-generation call finish after the live pointer retires", async () => {
    const runtime = new PluginRuntime({ hostRoot: "/tmp/lvis-runtime-drain-test" });
    const pluginId = "draining-generation";
    const method = "draining_generation_read";
    const handler = vi.fn(async () => "leased-result");
    const manifest = {
      id: pluginId,
      name: "Draining generation",
      version: "1.0.0",
      entry: "index.js",
      description: "Generation drain test fixture.",
      publisher: "LVIS",
      tools: [],
    } as PluginManifest;
    const instance = { handlers: { [method]: handler } } as RuntimePlugin;
    const projection: PluginRuntimeGenerationProjection = {
      activationId: "activation-drain",
      manifest,
      pluginRoot: "/tmp/lvis-runtime-drain-test/plugin",
      instance,
      methods: new Map([[method, handler]]),
    };
    const internals = runtime as unknown as {
      methodMap: Map<string, { pluginId: string; handler: typeof handler }>;
      plugins: Map<string, unknown>;
    };
    internals.methodMap.set(method, { pluginId, handler });
    internals.plugins.set(pluginId, {
      activationId: projection.activationId,
      manifest,
      pluginRoot: projection.pluginRoot,
      instance,
      methods: new Map([[method, handler]]),
      started: true,
    });
    const generation = {
      pluginId,
      generationId: "generation-drain",
      state: { runtime: projection },
    };
    const release = vi.fn();
    runtime.setGenerationAccess({
      replaceRuntime: vi.fn(async () => undefined),
      getActive: vi.fn(() => generation as never),
      acquire: vi.fn(async () => ({ generation, release }) as never),
      acquireExact: vi.fn(async () => ({ generation, release }) as never),
      runWithLease: vi.fn(async (_lease, operation) => {
        internals.methodMap.delete(method);
        internals.plugins.delete(pluginId);
        return operation();
      }),
    });

    await expect(runtime.call(method)).resolves.toBe("leased-result");
    expect(handler).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });
});

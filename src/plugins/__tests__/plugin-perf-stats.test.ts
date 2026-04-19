/**
 * PluginRuntime — per-plugin performance stats.
 * Verifies that call() increments counters, accumulates timing, and that
 * errors increment errorCount without losing timing info.
 */
import { describe, it, expect } from "vitest";
import { PluginRuntime } from "../runtime.js";

function makeRuntime() {
  return new PluginRuntime({ hostRoot: "/tmp/test-host" });
}

/** Directly inject a plugin + handler into the runtime's private maps. */
function injectPlugin(
  runtime: PluginRuntime,
  pluginId: string,
  toolName: string,
  handler: (payload?: unknown) => Promise<unknown>,
) {
  // Access private maps via cast for unit-test purposes.
  const r = runtime as unknown as {
    plugins: Map<string, unknown>;
    methodMap: Map<string, { pluginId: string; handler: (p?: unknown) => Promise<unknown> }>;
  };
  r.plugins.set(pluginId, {
    manifest: { id: pluginId, name: pluginId, version: "1.0.0", entry: "index.js", tools: [toolName] },
    pluginRoot: "/tmp",
    instance: {},
    methods: new Map([[toolName, handler]]),
  });
  r.methodMap.set(toolName, { pluginId, handler });
}

describe("PluginRuntime.getPerfStats()", () => {
  it("returns empty record when no plugins are loaded", () => {
    const rt = makeRuntime();
    expect(rt.getPerfStats()).toEqual({});
  });

  it("records call count and exec time on success", async () => {
    const rt = makeRuntime();
    injectPlugin(rt, "com.lge.test", "test_ping", async () => "pong");

    await rt.call("test_ping");
    await rt.call("test_ping");

    const stats = rt.getPerfStats();
    expect(stats["com.lge.test"]).toBeDefined();
    expect(stats["com.lge.test"].toolCallCount).toBe(2);
    expect(stats["com.lge.test"].errorCount).toBe(0);
    expect(stats["com.lge.test"].totalExecMs).toBeGreaterThanOrEqual(0);
    expect(stats["com.lge.test"].lastCallAt).toBeTypeOf("number");
  });

  it("increments errorCount on handler throw", async () => {
    const rt = makeRuntime();
    injectPlugin(rt, "com.lge.test", "test_fail", async () => {
      throw new Error("boom");
    });

    await expect(rt.call("test_fail")).rejects.toThrow("boom");

    const stats = rt.getPerfStats();
    expect(stats["com.lge.test"].toolCallCount).toBe(1);
    expect(stats["com.lge.test"].errorCount).toBe(1);
    expect(stats["com.lge.test"].totalExecMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks multiple plugins independently", async () => {
    const rt = makeRuntime();
    injectPlugin(rt, "com.lge.alpha", "alpha_get", async () => "a");
    injectPlugin(rt, "com.lge.beta", "beta_get", async () => "b");

    await rt.call("alpha_get");
    await rt.call("alpha_get");
    await rt.call("beta_get");

    const stats = rt.getPerfStats();
    expect(stats["com.lge.alpha"].toolCallCount).toBe(2);
    expect(stats["com.lge.beta"].toolCallCount).toBe(1);
  });

  it("returns a snapshot (mutations do not affect internal state)", async () => {
    const rt = makeRuntime();
    injectPlugin(rt, "com.lge.snap", "snap_get", async () => null);
    await rt.call("snap_get");

    const snap = rt.getPerfStats();
    snap["com.lge.snap"].toolCallCount = 999;

    const snap2 = rt.getPerfStats();
    expect(snap2["com.lge.snap"].toolCallCount).toBe(1);
  });
});

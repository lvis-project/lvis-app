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

describe("PluginRuntime.getPerfStats()", () => {
  it("returns empty record when no plugins are loaded", () => {
    const rt = makeRuntime();
    expect(rt.getPerfStats()).toEqual({});
  });

  it("records call count and exec time on success", async () => {
    const rt = makeRuntime();
    rt._testInjectPlugin("com.ep.test", "test_ping", async () => "pong");

    await rt.call("test_ping");
    await rt.call("test_ping");

    const stats = rt.getPerfStats();
    expect(stats["com.ep.test"]).toBeDefined();
    expect(stats["com.ep.test"].toolCallCount).toBe(2);
    expect(stats["com.ep.test"].errorCount).toBe(0);
    expect(stats["com.ep.test"].totalExecMs).toBeGreaterThanOrEqual(0);
    expect(stats["com.ep.test"].lastCallAt).toBeTypeOf("number");
  });

  it("increments errorCount on handler throw", async () => {
    const rt = makeRuntime();
    rt._testInjectPlugin("com.ep.test", "test_fail", async () => {
      throw new Error("boom");
    });

    await expect(rt.call("test_fail")).rejects.toThrow("boom");

    const stats = rt.getPerfStats();
    expect(stats["com.ep.test"].toolCallCount).toBe(1);
    expect(stats["com.ep.test"].errorCount).toBe(1);
    expect(stats["com.ep.test"].totalExecMs).toBeGreaterThanOrEqual(0);
  });

  it("tracks multiple plugins independently", async () => {
    const rt = makeRuntime();
    rt._testInjectPlugin("com.ep.alpha", "alpha_get", async () => "a");
    rt._testInjectPlugin("com.ep.beta", "beta_get", async () => "b");

    await rt.call("alpha_get");
    await rt.call("alpha_get");
    await rt.call("beta_get");

    const stats = rt.getPerfStats();
    expect(stats["com.ep.alpha"].toolCallCount).toBe(2);
    expect(stats["com.ep.beta"].toolCallCount).toBe(1);
  });

  it("returns a snapshot (mutations do not affect internal state)", async () => {
    const rt = makeRuntime();
    rt._testInjectPlugin("com.ep.snap", "snap_get", async () => null);
    await rt.call("snap_get");

    const snap = rt.getPerfStats();
    snap["com.ep.snap"].toolCallCount = 999;

    const snap2 = rt.getPerfStats();
    expect(snap2["com.ep.snap"].toolCallCount).toBe(1);
  });
});

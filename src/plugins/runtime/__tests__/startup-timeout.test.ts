import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPluginFactoryWithTimeout, runStartWithTimeout } from "../index.js";
import { TOOL_TIMEOUT_POLICY } from "../../../shared/tool-timeout-policy.js";

describe("runStartWithTimeout — plugin instance.start() host-enforced timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves when start() completes within the timeout window", async () => {
    let resolved = false;
    const start = () =>
      new Promise<void>((resolve) => {
        setTimeout(() => {
          resolved = true;
          resolve();
        }, 100);
      });
    const promise = runStartWithTimeout(start, 1_000);
    await vi.advanceTimersByTimeAsync(200);
    await promise;
    expect(resolved).toBe(true);
  });

  it("falls back to pluginStartupDefaultMs when manifest doesn't declare startupTimeoutMs", async () => {
    const start = () => new Promise<void>(() => {
      // never resolves — simulates a hung plugin
    });
    const promise = runStartWithTimeout(start, undefined);
    const rejection = promise.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs + 50);
    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      new RegExp(`startup timeout \\(>${TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs}ms\\)`),
    );
  });

  it("clamps manifest-declared startupTimeoutMs to pluginStartupMaxMs", async () => {
    const wildlyLargeManifestValue = TOOL_TIMEOUT_POLICY.pluginStartupMaxMs * 10;
    const start = () => new Promise<void>(() => {
      // never resolves
    });
    const promise = runStartWithTimeout(start, wildlyLargeManifestValue);
    const rejection = promise.catch((err: Error) => err);
    // Advance past the clamped max — if the clamp works, this triggers
    // rejection. If the clamp leaked, the test would hang here.
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.pluginStartupMaxMs + 50);
    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      new RegExp(`startup timeout \\(>${TOOL_TIMEOUT_POLICY.pluginStartupMaxMs}ms\\)`),
    );
  });

  it("honors a manifest-declared timeout below the max cap", async () => {
    const declaredMs = 5_000;
    expect(declaredMs).toBeLessThan(TOOL_TIMEOUT_POLICY.pluginStartupMaxMs);
    const start = () => new Promise<void>(() => {
      // never resolves
    });
    const promise = runStartWithTimeout(start, declaredMs);
    const rejection = promise.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(declaredMs + 50);
    const err = await rejection;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(new RegExp(`startup timeout \\(>${declaredMs}ms\\)`));
  });
});

describe("runPluginFactoryWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("bounds a non-settling factory", async () => {
    const promise = runPluginFactoryWithTimeout(
      () => new Promise<never>(() => undefined),
      () => undefined,
      1_000,
    );
    const rejection = promise.catch((error) => error);
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(rejection).resolves.toMatchObject({
      message: "plugin factory timeout (>1000ms)",
    });
  });

  it("hands a late-created instance to cleanup without returning it", async () => {
    let resolveFactory!: (value: { id: string }) => void;
    const factory = new Promise<{ id: string }>((resolve) => { resolveFactory = resolve; });
    const cleanup = vi.fn(async () => undefined);
    const result = runPluginFactoryWithTimeout(() => factory, cleanup, 1_000)
      .catch((error) => error);

    await vi.advanceTimersByTimeAsync(1_001);
    await expect(result).resolves.toMatchObject({
      message: "plugin factory timeout (>1000ms)",
    });
    resolveFactory({ id: "late" });
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledWith({ id: "late" });
  });
});

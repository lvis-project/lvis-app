/**
 * Unit tests for `createRefreshActiveLlmWildcard` (#893 / PR #894 Cycle 3).
 *
 * The factory replaces the inline closure that previously lived in
 * `boot.ts` so the debounce + vendor-change-restart contract can be
 * verified without spinning up a full Electron bootstrap.
 *
 * Each test pins one piece of the contract:
 *   1. First call seeds `lastWildcardVendor` and DOES NOT restart plugins
 *   2. Vendor change after the seed triggers a debounced restart sweep
 *   3. Bursty calls within the debounce window coalesce to ONE sweep
 *   4. Same-vendor calls are no-ops once seeded (no extra restarts)
 *   5. Empty / undefined vendor leaves the wildcard slot untouched
 *   6. Wildcard slot always exposes `hostApiVendor` only (no `hostApiKey`)
 *   7. `restartPlugin` rejection is logged but does not crash the timer
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefreshActiveLlmWildcard } from "../refresh-active-llm-wildcard.js";

function makeDeps(initial: { vendor?: string } = {}) {
  let vendor = initial.vendor ?? "openai";
  const setOverride = vi.fn();
  const clearOverride = vi.fn();
  const listPluginIds = vi.fn(() => ["plugin-a", "plugin-b"]);
  const restartPlugin = vi.fn(async (_id: string) => undefined);
  return {
    setVendor: (next: string | undefined) => { vendor = next as string; },
    deps: {
      getActiveVendor: () => vendor,
      setWildcardConfigOverride: setOverride,
      clearWildcardConfigOverride: clearOverride,
      listPluginIds,
      restartPlugin,
      // Default 200 ms — tests use a real fake timer.
    },
    setOverride,
    clearOverride,
    listPluginIds,
    restartPlugin,
  };
}

describe("createRefreshActiveLlmWildcard (#893 / PR #894 Cycle 3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("first refresh seeds vendor and does not restart any plugin", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();

    // Wildcard slot received the non-secret vendor metadata.
    expect(ctx.setOverride).toHaveBeenCalledWith({ hostApiVendor: "openai" });
    // The stale `hostApiKey` slot is always swept.
    expect(ctx.clearOverride).toHaveBeenCalledWith(["hostApiKey"]);
    // First call must not restart any plugin — that would churn on boot.
    vi.advanceTimersByTime(1_000);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();
  });

  it("vendor change after the seed restarts every loaded plugin (debounced 200ms)", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();

    // Within the debounce window — restart has NOT fired yet.
    vi.advanceTimersByTime(199);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();

    // At the boundary the debounced sweep runs over every plugin id.
    vi.advanceTimersByTime(1);
    expect(ctx.restartPlugin).toHaveBeenCalledTimes(2);
    expect(ctx.restartPlugin).toHaveBeenCalledWith("plugin-a");
    expect(ctx.restartPlugin).toHaveBeenCalledWith("plugin-b");
  });

  it("coalesces a burst of vendor changes into a single restart sweep", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    // Rapid IPC churn: vendor → key → baseUrl patched in one IPC.
    ctx.setVendor("claude");
    refresh();
    vi.advanceTimersByTime(50);
    ctx.setVendor("gemini");
    refresh();
    vi.advanceTimersByTime(50);
    ctx.setVendor("copilot");
    refresh();

    // Still inside the debounce window relative to the LAST refresh.
    vi.advanceTimersByTime(199);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    // Exactly one sweep — coalesced across the burst.
    expect(ctx.restartPlugin).toHaveBeenCalledTimes(2);
  });

  it("repeated calls with the same vendor are a no-op after the seed", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    refresh();
    refresh();

    vi.advanceTimersByTime(1_000);
    expect(ctx.restartPlugin).not.toHaveBeenCalled();
    // The wildcard slot is still written each call so a fresh boot or
    // pluginRuntime swap can re-seed without an external trigger.
    expect(ctx.setOverride).toHaveBeenCalledTimes(3);
  });

  it("empty / undefined vendor leaves the wildcard slot untouched", () => {
    const ctx = makeDeps({ vendor: "" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    expect(ctx.setOverride).not.toHaveBeenCalled();
    expect(ctx.clearOverride).not.toHaveBeenCalled();
    expect(ctx.restartPlugin).not.toHaveBeenCalled();
  });

  it("never injects hostApiKey via the wildcard slot (CRIT-1 contract)", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();
    vi.advanceTimersByTime(200);

    // Every `setWildcardConfigOverride` call must carry `hostApiVendor`
    // ONLY — no `hostApiKey`, no `llmApiKey`, no provider secret.
    for (const call of ctx.setOverride.mock.calls) {
      const payload = call[0] as Record<string, unknown>;
      expect(Object.keys(payload)).toEqual(["hostApiVendor"]);
      expect(payload).not.toHaveProperty("hostApiKey");
      expect(payload).not.toHaveProperty("llmApiKey");
    }
  });

  it("restartPlugin rejection is swallowed so other plugins still restart", async () => {
    const ctx = makeDeps({ vendor: "openai" });
    ctx.deps.restartPlugin = vi.fn(async (id: string) => {
      if (id === "plugin-a") throw new Error("simulated restart failure");
      return undefined;
    });
    const { refresh } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();
    vi.advanceTimersByTime(200);

    // Both restart attempts are issued even though the first rejects.
    expect(ctx.deps.restartPlugin).toHaveBeenCalledWith("plugin-a");
    expect(ctx.deps.restartPlugin).toHaveBeenCalledWith("plugin-b");
    // Flush microtasks so the swallowed rejection settles before the
    // test exits — vitest would otherwise surface it as unhandled.
    await vi.runAllTimersAsync();
  });

  it("dispose() cancels a pending debounce timer", () => {
    const ctx = makeDeps({ vendor: "openai" });
    const { refresh, dispose } = createRefreshActiveLlmWildcard(ctx.deps);

    refresh();
    ctx.setVendor("claude");
    refresh();

    dispose();
    vi.advanceTimersByTime(1_000);
    // Timer was cleared — no plugins were restarted post-dispose.
    expect(ctx.restartPlugin).not.toHaveBeenCalled();
  });
});

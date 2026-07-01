/**
 * C1 gap-lock — RateLimiter token-bucket (tool-governance §9).
 *
 * The executor's `RateLimiter` had ZERO coverage. It is a private class (not
 * exported), so this file locks its behavior two ways:
 *   1. Directly against the ToolExecutor's own limiter instance — the exact
 *      object the pipeline consumes — to pin the token-bucket refill-over-time
 *      contract deterministically (consume to empty → advance time → refills).
 *   2. Through the public `executeAll` path — a low/medium-trust tool whose
 *      bucket is drained surfaces the rate-limit error, and refills after time
 *      advances (observable rate-limit behavior through ToolExecutor).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolExecutor, type ToolPermissionContext } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool } from "../base.js";
import { PermissionManager } from "../../permissions/permission-manager.js";

interface RateCheck {
  check(toolName: string, trust: "high" | "medium" | "low"): { allowed: boolean; remaining: number };
}

function limiterOf(executor: ToolExecutor): RateCheck {
  return (executor as unknown as { rateLimiter: RateCheck }).rateLimiter;
}

function userPermissionContext(
  overrides: Partial<ToolPermissionContext> = {},
): ToolPermissionContext {
  return { trustOrigin: "user-keyboard", ...overrides };
}

const noopAuditLogger = {
  log: vi.fn(),
  isPermissionAuditChainReady: vi.fn(() => false),
  assertPermissionAuditWritable: vi.fn(),
  appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => ({ ...entry, prevHash: "h" })),
  isShadowChannelWritable: vi.fn(() => true),
  getPermissionShadowLogFile: vi.fn(() => "/tmp/shadow.jsonl"),
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RateLimiter (executor-owned instance)", () => {
  it("high trust is unlimited — always allowed with Infinity remaining", () => {
    const limiter = limiterOf(new ToolExecutor(new ToolRegistry()));
    for (let i = 0; i < 100; i += 1) {
      expect(limiter.check("any_tool", "high")).toEqual({ allowed: true, remaining: Infinity });
    }
  });

  it("low trust (20/min) drains to empty, denies, then refills over time", () => {
    const t0 = 1_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);
    const limiter = limiterOf(new ToolExecutor(new ToolRegistry()));

    // 20 tokens available at construction; consume all of them.
    for (let i = 0; i < 20; i += 1) {
      expect(limiter.check("low_tool", "low").allowed).toBe(true);
    }
    // 21st call at the same instant → denied, no tokens left.
    expect(limiter.check("low_tool", "low")).toEqual({ allowed: false, remaining: 0 });

    // Advance 3s: refill = 3/60 min * 20 tokens = 1 token → one more allowed.
    nowSpy.mockReturnValue(t0 + 3_000);
    expect(limiter.check("low_tool", "low").allowed).toBe(true);
    // Immediately after, empty again.
    expect(limiter.check("low_tool", "low")).toEqual({ allowed: false, remaining: 0 });
  });
});

describe("rate limiting observable through ToolExecutor.executeAll", () => {
  it("a drained medium-trust bucket surfaces a rate-limit error, then refills after time advances", async () => {
    const t0 = 2_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(t0);

    const executeSpy = vi.fn(async () => "did-run");
    const registry = new ToolRegistry();
    registry.register(createDynamicTool({
      name: "rl_plugin_read",
      description: "rate-limit probe",
      source: "plugin",
      pluginId: "rl-plugin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => ({ output: await executeSpy(), isError: false }),
    }));
    const permMgr = new PermissionManager("/tmp/nonexistent-rate-limit.json");
    permMgr.checkDetailed = () => ({ decision: "allow", reason: "test allow", layer: 3 });
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      undefined,
      undefined,
      noopAuditLogger as never,
    );

    // Pre-drain this tool's medium bucket (60/min) via the same limiter the
    // pipeline consumes, so the next executeAll trips the Step-5 gate.
    const limiter = limiterOf(executor);
    for (let i = 0; i < 60; i += 1) limiter.check("rl_plugin_read", "medium");

    const denied = await executor.executeAll(
      [{ id: "tu-rl-1", name: "rl_plugin_read", input: {} }],
      { sessionId: "sess-rl", permissionContext: userPermissionContext() },
    );
    expect(denied[0].is_error).toBe(true);
    expect(denied[0].content).toContain("rl_plugin_read");
    expect(executeSpy).not.toHaveBeenCalled();

    // Advance 1s: refill = 1/60 min * 60 tokens = 1 token → next call runs.
    nowSpy.mockReturnValue(t0 + 1_000);
    const allowed = await executor.executeAll(
      [{ id: "tu-rl-2", name: "rl_plugin_read", input: {} }],
      { sessionId: "sess-rl", permissionContext: userPermissionContext() },
    );
    expect(allowed[0].is_error).toBeUndefined();
    expect(allowed[0].content).toBe("did-run");
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });
});

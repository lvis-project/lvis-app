import { describe, expect, it } from "vitest";
import {
  MAX_TIMER_DELAY_MS,
  TOOL_TIMEOUT_POLICY,
  normalizeShutdownCleanupTimeoutMs,
  resolveSubAgentCeilingMs,
} from "../tool-timeout-policy.js";
import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_MIN,
} from "../subagent-policy.js";

describe("TOOL_TIMEOUT_POLICY — single source of truth invariants", () => {
  it("no shell max exists — a timed-out call must be able to retry with a larger budget", () => {
    expect("shellMaxMs" in TOOL_TIMEOUT_POLICY).toBe(false);
  });

  it("a shell default always exists, so an unspecified call still has a deadline", () => {
    expect(Number.isFinite(TOOL_TIMEOUT_POLICY.shellDefaultMs)).toBe(true);
    expect(TOOL_TIMEOUT_POLICY.shellDefaultMs).toBeGreaterThan(0);
  });

  it("MCP default never exceeds MCP max", () => {
    expect(TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs).toBeLessThanOrEqual(
      TOOL_TIMEOUT_POLICY.mcpRequestMaxMs,
    );
  });

  it("plugin startup default never exceeds plugin startup max", () => {
    expect(TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs).toBeLessThanOrEqual(
      TOOL_TIMEOUT_POLICY.pluginStartupMaxMs,
    );
  });

  it("every cap is finite and positive — no infinite-wait possible", () => {
    const finitePositive = (n: number) => Number.isFinite(n) && n > 0;
    expect(finitePositive(TOOL_TIMEOUT_POLICY.shellDefaultMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.globalCeilingMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.pluginStartupMaxMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.mcpRequestMaxMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.networkFetchDefaultMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs)).toBe(true);
  });

  it("user wait policy: 120_000ms across shell default / executor ceiling / MCP max", () => {
    expect(TOOL_TIMEOUT_POLICY.shellDefaultMs).toBe(120_000);
    expect(TOOL_TIMEOUT_POLICY.globalCeilingMs).toBe(120_000);
    expect(TOOL_TIMEOUT_POLICY.mcpRequestMaxMs).toBe(120_000);
  });

  it("executor global ceiling >= any per-surface max so the last-resort cap is never a regression", () => {
    expect(TOOL_TIMEOUT_POLICY.globalCeilingMs).toBeGreaterThanOrEqual(
      TOOL_TIMEOUT_POLICY.mcpRequestMaxMs,
    );
  });

  it("sub-agent ceiling exceeds the per-tool ceiling — sub-agents legitimately need more headroom", () => {
    expect(TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs).toBeGreaterThan(
      TOOL_TIMEOUT_POLICY.globalCeilingMs,
    );
  });

  it("the scaled sub-agent ceiling reproduces the shipped constant at the default round budget", () => {
    // The per-round allowance is DERIVED from the pair the policy already
    // shipped, so scaling is a generalization of the old constant, not a
    // retune of it. (The module also asserts this at load time.)
    expect(resolveSubAgentCeilingMs(SUBAGENT_MAX_ROUNDS_DEFAULT)).toBe(
      TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs,
    );
  });

  it("a larger round budget buys proportionally more wall clock", () => {
    // The failure this removes: rounds were made user-configurable with no
    // maximum, so a 600-round agent under a fixed 600s clock died of the clock
    // at round ~60 — the setting was silently inert past the default.
    expect(resolveSubAgentCeilingMs(SUBAGENT_MAX_ROUNDS_DEFAULT * 10)).toBe(
      TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs * 10,
    );
  });

  it("a smaller round budget never drops below the shipped floor", () => {
    for (const rounds of [SUBAGENT_MAX_ROUNDS_MIN, 5, 0, Number.NaN]) {
      expect(resolveSubAgentCeilingMs(rounds)).toBe(
        TOOL_TIMEOUT_POLICY.subAgentCeilingFloorMs,
      );
    }
  });

  it("the scaled ceiling is always finite — a deadline still always exists", () => {
    for (const rounds of [SUBAGENT_MAX_ROUNDS_MIN, 60, 100_000]) {
      const ceiling = resolveSubAgentCeilingMs(rounds);
      expect(Number.isFinite(ceiling)).toBe(true);
      expect(ceiling).toBeGreaterThan(0);
    }
  });

  it("approval gate user-wait is independent of (and longer than) the tool execution cap — the user, not the runtime, is the slow party", () => {
    expect(TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs).toBeGreaterThan(
      TOOL_TIMEOUT_POLICY.globalCeilingMs,
    );
  });

  it("shell SOT is ms-aligned — shellDefaultMs is divisible by 1000 so the Zod schema's `/ 1000` conversion yields an integer default", () => {
    expect(TOOL_TIMEOUT_POLICY.shellDefaultMs % 1000).toBe(0);
  });
});

describe("normalizeShutdownCleanupTimeoutMs", () => {
  it("accepts a positive number or its string form identically", () => {
    // The setting arrives as a number and the environment variable as a string;
    // one rule means they cannot disagree about what is acceptable.
    expect(normalizeShutdownCleanupTimeoutMs(30_000)).toBe(30_000);
    expect(normalizeShutdownCleanupTimeoutMs("30000")).toBe(30_000);
    expect(normalizeShutdownCleanupTimeoutMs("  30000  ")).toBe(30_000);
  });

  it("floors a fractional value rather than handing a fraction to setTimeout", () => {
    expect(normalizeShutdownCleanupTimeoutMs(1234.9)).toBe(1234);
  });

  it("rejects anything that could not be a deadline", () => {
    for (const value of [0, -1, "0", "-1", "abc", "", "   ", Number.NaN, Infinity, null, undefined, {}, []]) {
      expect(normalizeShutdownCleanupTimeoutMs(value)).toBeUndefined();
    }
  });

  it("clamps past Node's timer ceiling instead of overflowing it to ~1ms", () => {
    expect(normalizeShutdownCleanupTimeoutMs(MAX_TIMER_DELAY_MS)).toBe(MAX_TIMER_DELAY_MS);
    expect(normalizeShutdownCleanupTimeoutMs(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS);
    expect(normalizeShutdownCleanupTimeoutMs("999999999999")).toBe(MAX_TIMER_DELAY_MS);
  });

  it("accepts the shipped default — the control must be able to offer it back", () => {
    expect(normalizeShutdownCleanupTimeoutMs(TOOL_TIMEOUT_POLICY.shutdownCleanupMs))
      .toBe(TOOL_TIMEOUT_POLICY.shutdownCleanupMs);
  });
});

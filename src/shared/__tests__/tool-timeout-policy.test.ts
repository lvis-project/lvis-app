import { describe, expect, it } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../tool-timeout-policy.js";

describe("TOOL_TIMEOUT_POLICY — single source of truth invariants", () => {
  it("shell default never exceeds shell max", () => {
    expect(TOOL_TIMEOUT_POLICY.shellDefaultMs).toBeLessThanOrEqual(
      TOOL_TIMEOUT_POLICY.shellMaxMs,
    );
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
    expect(finitePositive(TOOL_TIMEOUT_POLICY.shellMaxMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.globalCeilingMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.pluginStartupMaxMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.subAgentCeilingMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.mcpRequestMaxMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.networkFetchDefaultMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs)).toBe(true);
  });

  it("user cap policy: 120_000ms across shell max / executor ceiling / MCP max", () => {
    expect(TOOL_TIMEOUT_POLICY.shellMaxMs).toBe(120_000);
    expect(TOOL_TIMEOUT_POLICY.globalCeilingMs).toBe(120_000);
    expect(TOOL_TIMEOUT_POLICY.mcpRequestMaxMs).toBe(120_000);
  });

  it("executor global ceiling >= any per-surface max so the last-resort cap is never a regression", () => {
    expect(TOOL_TIMEOUT_POLICY.globalCeilingMs).toBeGreaterThanOrEqual(
      TOOL_TIMEOUT_POLICY.shellMaxMs,
    );
    expect(TOOL_TIMEOUT_POLICY.globalCeilingMs).toBeGreaterThanOrEqual(
      TOOL_TIMEOUT_POLICY.mcpRequestMaxMs,
    );
  });

  it("sub-agent ceiling exceeds the per-tool ceiling — sub-agents legitimately need more headroom", () => {
    expect(TOOL_TIMEOUT_POLICY.subAgentCeilingMs).toBeGreaterThan(
      TOOL_TIMEOUT_POLICY.globalCeilingMs,
    );
  });

  it("approval gate user-wait is independent of (and longer than) the tool execution cap — the user, not the runtime, is the slow party", () => {
    expect(TOOL_TIMEOUT_POLICY.approvalGateUserWaitMs).toBeGreaterThan(
      TOOL_TIMEOUT_POLICY.globalCeilingMs,
    );
  });

  it("shell SOT is ms-aligned — shellMaxMs is divisible by 1000 so the Zod schema's `/ 1000` conversion yields an integer for model input", () => {
    expect(TOOL_TIMEOUT_POLICY.shellDefaultMs % 1000).toBe(0);
    expect(TOOL_TIMEOUT_POLICY.shellMaxMs % 1000).toBe(0);
  });
});

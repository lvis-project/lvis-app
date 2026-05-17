import { describe, expect, it } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../tool-timeout-policy.js";

describe("TOOL_TIMEOUT_POLICY — single source of truth invariants", () => {
  it("shell default never exceeds shell max", () => {
    expect(TOOL_TIMEOUT_POLICY.shellDefaultSeconds).toBeLessThanOrEqual(
      TOOL_TIMEOUT_POLICY.shellMaxSeconds,
    );
  });

  it("MCP default never exceeds MCP max", () => {
    expect(TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs).toBeLessThanOrEqual(
      TOOL_TIMEOUT_POLICY.mcpRequestMaxMs,
    );
  });

  it("every cap is finite and positive — no infinite-wait possible", () => {
    const finitePositive = (n: number) => Number.isFinite(n) && n > 0;
    expect(finitePositive(TOOL_TIMEOUT_POLICY.shellDefaultSeconds)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.shellMaxSeconds)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.globalCeilingMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.pluginCallToolCeilingMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.mcpRequestDefaultMs)).toBe(true);
    expect(finitePositive(TOOL_TIMEOUT_POLICY.mcpRequestMaxMs)).toBe(true);
  });

  it("user cap policy: 120s = 120_000ms across shell max / executor ceiling / MCP max", () => {
    expect(TOOL_TIMEOUT_POLICY.shellMaxSeconds).toBe(120);
    expect(TOOL_TIMEOUT_POLICY.globalCeilingMs).toBe(120_000);
    expect(TOOL_TIMEOUT_POLICY.pluginCallToolCeilingMs).toBe(120_000);
    expect(TOOL_TIMEOUT_POLICY.mcpRequestMaxMs).toBe(120_000);
  });

  it("executor global ceiling >= any per-surface max so the last-resort cap is never a regression", () => {
    expect(TOOL_TIMEOUT_POLICY.globalCeilingMs).toBeGreaterThanOrEqual(
      TOOL_TIMEOUT_POLICY.shellMaxSeconds * 1000,
    );
    expect(TOOL_TIMEOUT_POLICY.globalCeilingMs).toBeGreaterThanOrEqual(
      TOOL_TIMEOUT_POLICY.mcpRequestMaxMs,
    );
  });
});

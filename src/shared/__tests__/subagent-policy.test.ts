import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_SPAWNS_PER_ROUND,
  MAX_TOOL_CALLS_PER_ROUND,
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_MIN,
} from "../subagent-policy.js";

describe("sub-agent orchestration policy", () => {
  it("allows up to five agent_spawn calls in one assistant round", () => {
    expect(MAX_AGENT_SPAWNS_PER_ROUND).toBe(5);
  });

  it("uses the same cap for per-round tool calls so agent_spawn cannot drift from host execution policy", () => {
    expect(MAX_TOOL_CALLS_PER_ROUND).toBe(MAX_AGENT_SPAWNS_PER_ROUND);
  });

  it("keeps the round budget floor at one so an agent can always finish a tool round-trip", () => {
    expect(SUBAGENT_MAX_ROUNDS_MIN).toBe(1);
  });

  it("ships a round budget default at or above the floor", () => {
    expect(SUBAGENT_MAX_ROUNDS_DEFAULT).toBe(60);
    expect(SUBAGENT_MAX_ROUNDS_DEFAULT).toBeGreaterThanOrEqual(SUBAGENT_MAX_ROUNDS_MIN);
  });
});

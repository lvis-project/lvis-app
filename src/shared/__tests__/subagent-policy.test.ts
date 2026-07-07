import { describe, expect, it } from "vitest";
import {
  MAX_AGENT_SPAWNS_PER_ROUND,
  MAX_TOOL_CALLS_PER_ROUND,
} from "../subagent-policy.js";

describe("sub-agent orchestration policy", () => {
  it("allows up to five agent_spawn calls in one assistant round", () => {
    expect(MAX_AGENT_SPAWNS_PER_ROUND).toBe(5);
  });

  it("uses the same cap for per-round tool calls so agent_spawn cannot drift from host execution policy", () => {
    expect(MAX_TOOL_CALLS_PER_ROUND).toBe(MAX_AGENT_SPAWNS_PER_ROUND);
  });
});

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  decideGrokPreToolUse,
  isGrokPreToolPolicyHookEntrypoint,
} from "../subscription-grok-tool-policy-hook.js";

describe("Grok subscription PreToolUse policy hook", () => {
  it("allows LVIS MCP tools and catalog-only discovery", () => {
    expect(decideGrokPreToolUse({ toolName: "search_tool" }))
      .toEqual({ decision: "allow" });
    expect(decideGrokPreToolUse({ toolName: "lvis-host-tools__workspace_search" }))
      .toEqual({ decision: "allow" });
    expect(decideGrokPreToolUse({ toolName: "lvis-host-tools__Mcp_Tool-2" }))
      .toEqual({ decision: "allow" });
  });

  it("denies native, other-MCP, malformed, and unsafe alias calls", () => {
    for (const event of [
      { toolName: "read_file" },
      { toolName: "web_search" },
      { toolName: "use_tool" },
      { toolName: "github__create_issue" },
      { toolName: "other-server__workspace_read" },
      { toolName: "lvis-host-tools___private" },
      { toolName: "lvis-host-tools__9starts_with_number" },
      { toolName: "lvis-host-tools__too-long-".repeat(20) },
      { toolName: 42 },
      {},
      null,
    ]) {
      expect(decideGrokPreToolUse(event)).toMatchObject({ decision: "deny" });
    }
  });

  it("recognizes only its compiled script path as an entrypoint", () => {
    const moduleUrl = new URL("./policy-hook.js", import.meta.url).href;
    const entry = fileURLToPath(moduleUrl);
    expect(isGrokPreToolPolicyHookEntrypoint(undefined, moduleUrl)).toBe(false);
    expect(isGrokPreToolPolicyHookEntrypoint(`${entry}.other`, moduleUrl)).toBe(false);
    expect(isGrokPreToolPolicyHookEntrypoint(entry, moduleUrl)).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { LoopContext } from "../loop-context.js";
import { gateCrossAgentInterceptedMetaTools } from "../intercepted-meta-gate.js";
import type { ToolUseBlock } from "../../../tools/executor.js";

const tailnetAuthority = Object.freeze({
  kind: "tailnet-controller" as const,
  actorId: "tailnet:controller-digest" as `tailnet:${string}`,
});

function gateSelf(requestAndWait = vi.fn()) {
  return {
    deps: { approvalGate: { requestAndWait } },
    auditLogger: { log: vi.fn() },
  } as unknown as LoopContext;
}

describe("intercepted meta gate — Tailnet controller", () => {
  it("denies tool-surface expansion without opening an approval route", async () => {
    const requestAndWait = vi.fn();
    const self = gateSelf(requestAndWait);
    const toolUses: ToolUseBlock[] = [
      { id: "plugin-expand", name: "request_plugin", input: { pluginId: "untrusted" } },
      { id: "tool-expand", name: "tool_search", input: { query: "shell" } },
      { id: "ordinary-read", name: "read_file", input: { path: "README.md" } },
    ];

    const result = await gateCrossAgentInterceptedMetaTools(
      self,
      toolUses,
      undefined,
      "tailnet-surface",
      "tailnet-session",
      tailnetAuthority,
    );

    expect(result.approved).toEqual([toolUses[2]]);
    expect(result.denied).toEqual([
      {
        toolUseId: "plugin-expand",
        toolName: "request_plugin",
        content: "remote-controller-meta-disabled: request_plugin",
      },
      {
        toolUseId: "tool-expand",
        toolName: "tool_search",
        content: "remote-controller-meta-disabled: tool_search",
      },
    ]);
    expect(requestAndWait).not.toHaveBeenCalled();
  });
});

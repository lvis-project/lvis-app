// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { createOnCallTool } from "../on-call-tool.js";
import type { McpUiToolCallOutcome } from "../../../../../../mcp/types.js";

type CallToolParams = { name: string; arguments?: Record<string, unknown> };
type Handler = (p: CallToolParams) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function build(outcome: McpUiToolCallOutcome | Error) {
  const callTool = vi.fn(async () => {
    if (outcome instanceof Error) throw outcome;
    return outcome;
  });
  return { callTool, handler: createOnCallTool({ callTool }) as unknown as Handler };
}

describe("createOnCallTool — the app never names a server", () => {
  it("forwards ONLY the tool name + args to the serverId-bound invoker", async () => {
    const { callTool, handler } = build({ ok: true, result: "done" });

    await handler({ name: "acme_open", arguments: { id: 7 } });

    // No serverId in the app's params, and none in what the handler passes on: the
    // binding was made by McpAppView from the card payload.
    expect(callTool).toHaveBeenCalledWith("acme_open", { id: 7 });
  });

  it("defaults missing arguments to an empty object", async () => {
    const { callTool, handler } = build({ ok: true, result: "" });
    await handler({ name: "acme_status" });
    expect(callTool).toHaveBeenCalledWith("acme_status", {});
  });
});

describe("createOnCallTool — CallToolResult shaping", () => {
  it("returns a text CallToolResult for a string result", async () => {
    const { handler } = build({ ok: true, result: "hello" });
    await expect(handler({ name: "t" })).resolves.toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });

  it("serializes a structured result into a text block", async () => {
    const { handler } = build({ ok: true, result: { count: 2 } });
    await expect(handler({ name: "t" })).resolves.toEqual({
      content: [{ type: "text", text: '{"count":2}' }],
    });
  });
});

describe("createOnCallTool — denials come back as MCP error RESULTS, never as throws", () => {
  it("renders a host denial as { isError: true } with the reason", async () => {
    const { handler } = build({
      ok: false,
      error: "cross-server-call-denied",
      message: "Tool 'x' is not owned by MCP server 'acme-cards'",
    });

    await expect(handler({ name: "x" })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "Tool 'x' is not owned by MCP server 'acme-cards'" }],
    });
  });

  it("falls back to the error CODE when main sent no message", async () => {
    const { handler } = build({ ok: false, error: "unauthorized-frame" });
    await expect(handler({ name: "x" })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "unauthorized-frame" }],
    });
  });

  it("renders even an IPC transport failure as an error result (bridge request never rejects)", async () => {
    const { handler } = build(new Error("ipc exploded"));
    await expect(handler({ name: "x" })).resolves.toEqual({
      isError: true,
      content: [{ type: "text", text: "ipc exploded" }],
    });
  });
});

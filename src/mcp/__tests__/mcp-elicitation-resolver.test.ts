/**
 * MRTR elicitation resolver (milestone mrtr-input-loop, live-resolver step).
 * The resolver routes elicitation/create to the host approval gate and maps the
 * decision to an MCP ElicitResult; sampling/roots (deprecated upstream) throw.
 */
import { describe, it, expect, vi } from "vitest";
import {
  createElicitationResolverFactory,
  type ElicitationApprovalGate,
} from "../mcp-elicitation-resolver.js";
import type { ApprovalChoice } from "../../permissions/approval-gate.js";

function gateReturning(choice: ApprovalChoice): {
  gate: ElicitationApprovalGate;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const gate: ElicitationApprovalGate = {
    requestAndWait: vi.fn(async (req) => {
      calls.push(req as unknown as Record<string, unknown>);
      return { requestId: (req as { id: string }).id, choice };
    }),
  };
  return { gate, calls };
}

describe("createElicitationResolverFactory", () => {
  it("routes a form elicitation to the approval gate and maps allow → accept", async () => {
    const { gate, calls } = gateReturning("allow-once");
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("hr-server");

    const result = await resolve("q1", {
      method: "elicitation/create",
      mode: "form",
      message: "Pick a date",
      requestedSchema: { type: "object", properties: { date: { type: "string" } } },
    });

    expect(result).toEqual({ action: "accept", content: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      category: "agent-action",
      kind: "agent-action",
      toolName: "mcp:hr-server:elicitation",
      toolCategory: "meta",
      source: "mcp",
      trustOrigin: "plugin-emitted",
      reason: "Pick a date",
    });
    // server provenance: the schema is forwarded for the (future) form UI.
    expect((calls[0].args as { requestedSchema?: unknown }).requestedSchema).toBeDefined();
  });

  it("maps a deny decision → decline", async () => {
    const { gate } = gateReturning("deny-once");
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("s");
    const result = await resolve("q", { method: "elicitation/create", message: "ok?" });
    expect(result).toEqual({ action: "decline" });
  });

  it("url-mode elicitation forwards the url to the gate args", async () => {
    const { gate, calls } = gateReturning("allow-once");
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("auth");
    await resolve("q", {
      method: "elicitation/create",
      mode: "url",
      message: "Authorize",
      url: "https://example.com/oauth",
      elicitationId: "e1",
    });
    expect(calls[0].args).toMatchObject({ url: "https://example.com/oauth", elicitationId: "e1" });
  });

  it("throws (No-Fallback) for sampling/createMessage — deprecated upstream, not fabricated", async () => {
    const { gate } = gateReturning("allow-once");
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("s");
    await expect(
      resolve("q", { method: "sampling/createMessage", messages: [] }),
    ).rejects.toThrow(/only 'elicitation\/create' is supported/);
  });

  it("throws for roots/list (deprecated)", async () => {
    const { gate } = gateReturning("allow-once");
    const resolve = createElicitationResolverFactory({ approvalGate: gate })("s");
    await expect(resolve("q", { method: "roots/list" })).rejects.toThrow(/No-Fallback/);
  });
});

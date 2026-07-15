import { describe, expect, it, vi } from "vitest";
import { A2A_ROLE_AGENT, type A2APart } from "../../shared/a2a.js";
import { maskSensitiveData } from "../../shared/dlp.js";
import {
  A2A_CAUSAL_CONTEXT_METADATA_KEY,
  type A2AAgentSendResult,
} from "../../engine/a2a-agent-message-envelope.js";
import {
  A2A_INPUT_REQUIRED_CONTROL_KIND,
  A2A_INPUT_REQUIRED_CONTROL_VERSION,
  createAgentSendTool,
  isA2AQuestionInputRequiredControl,
  type AgentSendRuntime,
} from "../agent-send.js";
import { ToolRegistry } from "../registry.js";

function success(parts: A2APart[], disposition: "parent" | "queued" | "mailbox" = "parent"):
A2AAgentSendResult {
  return {
    ok: true,
    disposition,
    messageId: "message-1",
    canonicalMessage: {
      messageId: "message-1",
      contextId: "parent-session",
      taskId: "sub-sender",
      role: A2A_ROLE_AGENT,
      parts: parts as [A2APart, ...A2APart[]],
    },
  };
}

function makeRuntime(overrides: Partial<AgentSendRuntime> = {}) {
  const runtime: AgentSendRuntime = {
    sendAgentMessage: vi.fn(async (input) => success(input.parts as A2APart[])),
    auditAgentSendDrop: vi.fn(async () => undefined),
    reserveQuestionWait: vi.fn(async () => ({ ok: true as const, token: Symbol("question") })),
    cancelQuestionWait: vi.fn(async () => undefined),
    ...overrides,
  };
  return runtime;
}

function childContext(metadata: Record<string, unknown> = {}) {
  return {
    cwd: process.cwd(),
    extraAllowedDirectories: [],
    metadata: {
      sessionId: "sub-sender",
      spawnDepth: 1,
      ...metadata,
    },
  };
}

describe("agent_send host boundary", () => {
  it("returns the exact question control sentinel only after successful parent delivery", async () => {
    const sendAgentMessage = vi.fn(async () => success([{ text: "masked prompt" }]));
    const runtime = makeRuntime({ sendAgentMessage });
    const tool = createAgentSendTool({ getRuntime: () => runtime });
    const mainRegistry = new ToolRegistry();
    mainRegistry.register(tool);
    expect(mainRegistry.getToolSchemas().map((schema) => schema.name)).not.toContain("agent_send");

    const result = await tool.execute({
      to: "parent",
      parts: [{ text: "raw prompt" }],
      waitForReply: true,
    }, childContext());

    expect(result.isError).toBe(false);
    expect(result.metadata?.rawResult).toEqual({
      kind: A2A_INPUT_REQUIRED_CONTROL_KIND,
      version: A2A_INPUT_REQUIRED_CONTROL_VERSION,
      reason: "question",
      prompt: "masked prompt",
    });
    expect(runtime.reserveQuestionWait).toHaveBeenCalledWith("sub-sender", "raw prompt");
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      waitForReply: true,
    }));
    const generatedMessageId = sendAgentMessage.mock.calls[0]?.[0].messageId ?? "";
    expect(generatedMessageId)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(maskSensitiveData(generatedMessageId).detections).toEqual([]);
    expect(tool.modelVisible).toBe(false);
    expect(runtime.cancelQuestionWait).not.toHaveBeenCalled();
    expect(tool.parallelSafe).toBeUndefined();
  });

  it("rejects a second outstanding question before message delivery", async () => {
    const sendAgentMessage = vi.fn(async () => success([{ text: "question" }]));
    const runtime = makeRuntime({
      sendAgentMessage,
      reserveQuestionWait: vi.fn(async () => ({
        ok: false as const,
        reason: "question-already-outstanding" as const,
      })),
    });
    const tool = createAgentSendTool({ getRuntime: () => runtime });

    const result = await tool.execute({
      to: "parent",
      parts: [{ text: "question" }],
      waitForReply: true,
    }, childContext());

    expect(result.isError).toBe(true);
    expect(result.metadata).toBeUndefined();
    expect(sendAgentMessage).not.toHaveBeenCalled();
    expect(runtime.auditAgentSendDrop).toHaveBeenCalledWith(expect.objectContaining({
      reason: "question-already-outstanding",
    }));
  });

  it("cancels the reserved question and emits no sentinel on delivery failure", async () => {
    const token = Symbol("question");
    const runtime = makeRuntime({
      reserveQuestionWait: vi.fn(async () => ({ ok: true as const, token })),
      sendAgentMessage: vi.fn(async () => ({
        ok: false as const,
        disposition: "dropped" as const,
        reason: "unknown-recipient" as const,
      })),
    });
    const tool = createAgentSendTool({ getRuntime: () => runtime });

    const result = await tool.execute({
      to: "parent",
      parts: [{ text: "question" }],
      waitForReply: true,
    }, childContext());

    expect(result.isError).toBe(true);
    expect(result.metadata).toBeUndefined();
    expect(runtime.cancelQuestionWait).toHaveBeenCalledWith("sub-sender", token);
  });

  it("suppresses the sentinel when abort wins after delivery", async () => {
    const controller = new AbortController();
    const token = Symbol("question");
    const runtime = makeRuntime({
      reserveQuestionWait: vi.fn(async () => ({ ok: true as const, token })),
      sendAgentMessage: vi.fn(async () => {
        controller.abort();
        return success([{ text: "question" }]);
      }),
    });
    const tool = createAgentSendTool({ getRuntime: () => runtime });

    const result = await tool.execute({
      to: "parent",
      parts: [{ text: "question" }],
      waitForReply: true,
    }, {
      ...childContext(),
      abortSignal: controller.signal,
    });

    expect(result.isError).toBe(true);
    expect(result.metadata).toBeUndefined();
    expect(runtime.cancelQuestionWait).toHaveBeenCalledWith("sub-sender", token);
  });

  it("returns success when abort arrives after an ordinary message was accepted", async () => {
    const controller = new AbortController();
    const sendAgentMessage = vi.fn(async () => {
      controller.abort();
      return success([{ text: "ordinary" }], "queued");
    });
    const runtime = makeRuntime({ sendAgentMessage });
    const tool = createAgentSendTool({ getRuntime: () => runtime });

    const result = await tool.execute({
      to: "sub-recipient",
      parts: [{ text: "ordinary" }],
    }, {
      ...childContext(),
      abortSignal: controller.signal,
    });

    expect(result.isError).toBe(false);
    expect(JSON.parse(result.output)).toMatchObject({
      messageId: "message-1",
      disposition: "queued",
      waitForReply: false,
    });
    expect(sendAgentMessage).toHaveBeenCalledTimes(1);
    expect(runtime.cancelQuestionWait).not.toHaveBeenCalled();
    expect(runtime.auditAgentSendDrop).not.toHaveBeenCalled();
  });

  it("derives the sender and causal hop only from trusted tool context metadata", async () => {
    const sendAgentMessage = vi.fn(async (input) => success(input.parts as A2APart[], "queued"));
    const runtime = makeRuntime({ sendAgentMessage });
    const tool = createAgentSendTool({ getRuntime: () => runtime });
    const causal = {
      kind: "a2a-causal-hop",
      version: 1,
      originSessionId: "parent-session",
      recipientChildSessionId: "sub-sender",
      hopCount: 3,
    } as const;

    const result = await tool.execute({
      to: "sub-recipient",
      parts: [{ text: "hello" }],
    }, childContext({ [A2A_CAUSAL_CONTEXT_METADATA_KEY]: causal }));

    expect(result.isError).toBe(false);
    expect(result.metadata).toBeUndefined();
    expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
      senderChildSessionId: "sub-sender",
      recipient: "sub-recipient",
      causalContext: causal,
    }));
  });

  it("rejects raw FilePart, parent execution, and forged causal metadata", async () => {
    const runtime = makeRuntime();
    const tool = createAgentSendTool({ getRuntime: () => runtime });

    const raw = await tool.execute({
      to: "sub-recipient",
      parts: [{ raw: "AA==" }],
    }, childContext());
    expect(raw.isError).toBe(true);

    const parent = await tool.execute({
      to: "sub-recipient",
      parts: [{ text: "hello" }],
    }, childContext({ spawnDepth: 0, sessionId: "parent-session" }));
    expect(parent.isError).toBe(true);

    const forged = await tool.execute({
      to: "sub-recipient",
      parts: [{ text: "hello" }],
    }, childContext({
      [A2A_CAUSAL_CONTEXT_METADATA_KEY]: {
        kind: "a2a-causal-hop",
        version: 1,
        originSessionId: "other-parent",
        recipientChildSessionId: "sub-sender",
        hopCount: 1,
        extra: true,
      },
    }));
    expect(forged.isError).toBe(true);
    expect(runtime.sendAgentMessage).not.toHaveBeenCalled();
  });

  it("strictly validates question-control keys and prompt bounds", () => {
    const valid = {
      kind: A2A_INPUT_REQUIRED_CONTROL_KIND,
      version: A2A_INPUT_REQUIRED_CONTROL_VERSION,
      reason: "question",
      prompt: "answer this",
    };
    expect(isA2AQuestionInputRequiredControl(valid)).toBe(true);
    expect(isA2AQuestionInputRequiredControl({ ...valid, extra: true })).toBe(false);
    expect(isA2AQuestionInputRequiredControl({ ...valid, prompt: "" })).toBe(false);
  });
});

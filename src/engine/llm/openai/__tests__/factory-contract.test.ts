import { afterEach, describe, expect, it, vi } from "vitest";
import type { StreamEvent, StreamTurnParams, ToolSchema } from "../../types.js";
import { collectAsyncIterable } from "../../../../__tests__/test-helpers.js";
import { prepareMarkedToolResultsForWire } from "../../../wire-serialize.js";
import { estimateTokens } from "../../../../shared/token-estimate.js";

const tools: ToolSchema[] = [{
  name: "read_file",
  description: "Read a governed file.",
  inputSchema: { type: "object", properties: { path: { type: "string" } } },
}];

function request(): StreamTurnParams {
  return {
    model: "gpt-5.4",
    systemPrompt: "Use the declared tools.",
    messages: [
      { role: "user", content: "Read it.", meta: { messageId: "host-user" } },
      {
        role: "assistant",
        content: "Reading.",
        thought: "display-only",
        thinkingBlocks: [{ thinking: "signed private thought", signature: "private-signature" }],
        toolCalls: [{ id: "call-1", name: "read_file", input: { path: "file.txt" }, source: "builtin" }],
        meta: { messageId: "host-assistant" },
      },
      {
        role: "tool_result",
        toolUseId: "call-1",
        toolName: "read_file",
        content: "stale content ".repeat(100),
        isError: true,
        meta: { compactedAt: "2026-01-01T00:00:00Z" },
      },
    ],
    tools,
    outputTokenLimit: 2048,
    enableThinking: true,
    thinkingBudgetTokens: 14000,
    continuationPrefill: true,
  };
}

afterEach(() => {
  vi.doUnmock("../../vercel/adapter.js");
  vi.resetModules();
});

describe("provider factory request ownership", () => {
  it("prepares API history before the lazy wire transport sees it", async () => {
    const seen: StreamTurnParams[] = [];
    const loaded = vi.fn();
    const constructors = vi.fn();
    vi.doMock("../../vercel/adapter.js", () => {
      loaded();
      return {
        VercelUnifiedProvider: class {
          constructor(...args: unknown[]) { constructors(...args); }
          async *streamTurn(params: StreamTurnParams): AsyncIterable<StreamEvent> {
            seen.push(params);
            yield { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1 } };
          }
        },
      };
    });
    const { createProvider } = await import("../../provider-factory.js");
    const fetch = vi.fn();
    const provider = createProvider({ vendor: "openai", apiKey: "fixture-key", baseUrl: "https://api.example.test/v1", fetch });
    expect(loaded).not.toHaveBeenCalled();
    const input = request();
    const original = structuredClone(input);
    const controller = new AbortController();
    input.abortSignal = controller.signal;
    expect(await collectAsyncIterable(provider.streamTurn(input))).toEqual([
      { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: 2, outputTokens: 1 } },
    ]);
    expect(constructors).toHaveBeenCalledWith("openai", "fixture-key", "https://api.example.test/v1", fetch, expect.any(Object));
    expect(seen[0]).toMatchObject({
      model: input.model,
      systemPrompt: input.systemPrompt,
      outputTokenLimit: 2048,
      enableThinking: true,
      thinkingBudgetTokens: 14000,
      continuationPrefill: true,
      abortSignal: controller.signal,
    });
    expect(seen[0]?.messages).toEqual([
      { role: "user", content: "Read it." },
      { role: "assistant", content: "Reading.", toolCalls: [{ id: "call-1", name: "read_file", input: { path: "file.txt" } }] },
      prepareMarkedToolResultsForWire(input.messages)[2],
    ]);
    expect(provider.constructor.name).toBe("OpenAiProvider");
    expect(provider.subscriptionRuntime).toBeUndefined();
    expect({ ...input, abortSignal: undefined }).toEqual({ ...original, abortSignal: undefined });
  });

  it("uses the same prepared native envelope for estimation and dispatch", async () => {
    const apiModuleLoaded = vi.fn(() => { throw new Error("native connection must not load the API transport"); });
    vi.doMock("../../vercel/adapter.js", apiModuleLoaded);
    const { createSubscriptionLlmProvider } = await import("../../../../main/subscription-llm-provider.js");
    let text = "";
    const stop = vi.fn(async () => undefined);
    const openTextSession = vi.fn(async () => ({
      provider: "codex" as const,
      async *streamTurn(prompt: string): AsyncIterable<StreamEvent> {
        text = prompt;
        yield { type: "message_complete", stopReason: "end_turn" };
      },
      cancelActiveTurn: vi.fn(async () => undefined),
      stop,
    }));
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex", model: "native-selected" },
      service: { openTextSession },
    });
    const input = request();
    const projection = provider.projectRequestInput({
      systemPrompt: input.systemPrompt,
      messages: input.messages,
      toolSchemas: input.tools!,
      enableThinking: input.enableThinking,
      thinkingBudgetTokens: input.thinkingBudgetTokens,
      continuationPrefill: input.continuationPrefill,
    });
    await collectAsyncIterable(provider.streamTurn(input));
    expect(projection?.messageTokens).toBe(estimateTokens(text));
    expect(text).not.toContain("stale content");
    expect(text).not.toContain("private-signature");
    expect(text).not.toContain("host-assistant");
    expect(text).toContain('"thinkingBudgetTokens":14000');
    expect(text).toContain('"isError":true');
    expect(text).not.toContain('"reasoningEffort"');
    expect(text).not.toContain('"outputTokenLimit"');
    expect(openTextSession).toHaveBeenCalledWith(
      { kind: "subscription", provider: "codex", model: "native-selected" },
      { tools },
    );
    expect(provider.constructor.name).toBe("OpenAiProvider");
    expect(stop).toHaveBeenCalledOnce();
    expect(apiModuleLoaded).not.toHaveBeenCalled();
  });

  it("keeps other native providers outside the OpenAI connection contract", async () => {
    const { createSubscriptionLlmProvider } = await import("../../../../main/subscription-llm-provider.js");
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "kimi-code", model: "native-selected" },
      service: { openTextSession: vi.fn() },
    });
    expect(provider.constructor.name).toBe("SubscriptionLlmProvider");
    expect(provider.subscriptionRuntime).toEqual({ kind: "subscription", provider: "kimi-code", model: "native-selected" });
  });
});

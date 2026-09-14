import { describe, expect, it, vi } from "vitest";
import type {
  GenericMessage,
  ProviderRequestInputProjectionParams,
  StreamEvent,
  StreamTurnParams,
  ToolSchema,
} from "../../types.js";
import { createOpenAiProvider, type OpenAiProviderConnection } from "../provider.js";
import { collectAsyncIterable } from "../../../../__tests__/test-helpers.js";
import { estimateRequestInputProjection } from "../../../request-input-projection.js";
import { prepareMarkedToolResultsForWire } from "../../../wire-serialize.js";

const IMAGE = { data: "iVBORw0KGgo=", mimeType: "image/png", width: 512, height: 512 };
const TOOL: ToolSchema = { name: "inspect_image", description: "Inspect the image.", inputSchema: { type: "object", properties: {} } };

function history(): GenericMessage[] {
  return [
    { role: "user", content: [{ type: "image", image: `data:image/png;base64,${IMAGE.data}`, width: 512, height: 512 }], meta: { messageId: "local-user" } },
    {
      role: "assistant",
      content: "Inspecting.",
      thought: "local thought",
      thinkingBlocks: [{ thinking: "private reasoning", signature: "private signature" }],
      toolCalls: [{ id: "call-image", name: TOOL.name, input: {}, source: "plugin", pluginId: "private-plugin", invalidInput: { raw: "[]", reason: "non-object", rawChars: 2 } }],
      meta: { interrupted: true },
    },
    { role: "tool_result", toolUseId: "call-image", toolName: TOOL.name, content: "Image details unavailable.", isError: true, image: IMAGE, meta: { messageId: "local-result" } },
    {
      role: "tool_result",
      toolUseId: "call-stale",
      toolName: TOOL.name,
      content: "old content",
      image: IMAGE,
      meta: { compactedAt: "2026-01-01T00:00:00Z" },
    },
  ];
}

describe("common provider request policy", () => {
  it.each(["api-key", "codex-subscription"] as const)("shares estimation and dispatch input for %s", async (kind) => {
    let projected: ProviderRequestInputProjectionParams | undefined;
    let dispatched: StreamTurnParams | undefined;
    const projection = { systemPromptTokens: 1, messageTokens: 2, toolSchemaTokens: 3, totalTokens: 6 };
    const transport = {
      projectRequestInput(input: ProviderRequestInputProjectionParams) {
        expect(this).toBe(transport);
        projected = input;
        return projection;
      },
      async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
        expect(this).toBe(transport);
        dispatched = input;
      },
    };
    const provider = createOpenAiProvider(kind === "api-key"
      ? { kind, transport }
      : { kind, selection: { kind: "subscription", provider: "codex", model: "native-selection" }, transport });
    const messages = history();
    const original = structuredClone(messages);
    const tools = [{ ...TOOL, hostOnly: "do-not-send" }];
    const input = {
      systemPrompt: "Use governed tools.", messages, toolSchemas: tools,
      continuationPrefill: true, enableThinking: true, thinkingBudgetTokens: 14000,
    };
    expect(provider.projectRequestInput(input)).toEqual(projection);
    const controller = new AbortController();
    await collectAsyncIterable(provider.streamTurn({
      ...input, model: "request-model", tools, outputTokenLimit: 32768, streamSmoothing: "word", abortSignal: controller.signal,
    }));
    expect(dispatched?.messages).toEqual(projected?.messages);
    expect(dispatched?.tools).toEqual(projected?.toolSchemas);
    expect(projected?.toolSchemas).toEqual([TOOL]);
    expect(dispatched).toMatchObject({
      model: "request-model", outputTokenLimit: 32768, streamSmoothing: "word",
      enableThinking: true, thinkingBudgetTokens: 14000, continuationPrefill: true, abortSignal: controller.signal,
    });
    expect(projected?.messages).toEqual([
      { role: "user", content: original[0]!.content },
      { role: "assistant", content: "Inspecting.", toolCalls: [{ id: "call-image", name: TOOL.name, input: {} }] },
      { role: "tool_result", toolUseId: "call-image", toolName: TOOL.name, content: "Image details unavailable.", isError: true, image: IMAGE },
      prepareMarkedToolResultsForWire(original)[3],
    ]);
    expect(messages).toEqual(original);
    expect(tools[0]?.hostOnly).toBe("do-not-send");
  });

  it("uses the existing API estimator on prepared input when the wire has no custom projection", async () => {
    let sent: StreamTurnParams | undefined;
    const provider = createOpenAiProvider({ kind: "api-key", transport: {
      async *streamTurn(input) { sent = input; },
    } });
    const input = { systemPrompt: "system", messages: history(), toolSchemas: [TOOL] };
    const projection = provider.projectRequestInput(input);
    await collectAsyncIterable(provider.streamTurn({ ...input, model: "selected", tools: input.toolSchemas }));
    expect(projection).toEqual(estimateRequestInputProjection({
      systemPrompt: sent!.systemPrompt, messages: sent!.messages, toolSchemas: sent!.tools!,
    }, { vendor: "openai" }));
  });

  it("keeps native selection immutable and rejects an incompatible connection", () => {
    const selection = { kind: "subscription" as const, provider: "codex" as const, model: "native-selected" };
    const transport = { async *streamTurn(): AsyncIterable<StreamEvent> {} };
    const provider = createOpenAiProvider({ kind: "codex-subscription", selection, transport });
    selection.model = "changed-after-creation";
    expect(provider.subscriptionRuntime).toEqual({ kind: "subscription", provider: "codex", model: "native-selected" });
    expect(Object.isFrozen(provider.subscriptionRuntime)).toBe(true);
    expect(() => createOpenAiProvider({
      kind: "codex-subscription", selection: { kind: "subscription", provider: "kimi-code" }, transport,
    } as unknown as OpenAiProviderConnection)).toThrow("invalid OpenAI subscription connection");
  });

  it.each(["api-key", "codex-subscription"] as const)("preserves transport events and cancellation ownership for %s", async (kind) => {
    const controller = new AbortController();
    const completed: StreamEvent = kind === "api-key"
      ? { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3 } }
      : { type: "message_complete", stopReason: "tool_use", subscriptionUsage: {
          provider: "codex", model: "native-selected", source: "provider-reported", billable: false, inputTokens: 10, outputTokens: 4, totalTokens: 14,
        } };
    const events: StreamEvent[] = [
      { type: "text_delta", text: "Checking." },
      { type: "reasoning_delta", text: "Plan." },
      { type: "tool_call", id: "call", name: TOOL.name, input: {}, invalidInput: { raw: "[", rawChars: 1, reason: "unparsable-json" } },
      completed,
    ];
    const cleanup = vi.fn();
    const transport = {
      async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
        expect(input.abortSignal).toBe(controller.signal);
        try { yield* events; } finally { cleanup(); }
      },
    };
    const provider = createOpenAiProvider(kind === "api-key"
      ? { kind, transport }
      : { kind, selection: { kind: "subscription", provider: "codex", model: "native-selected" }, transport });
    expect(await collectAsyncIterable(provider.streamTurn({ model: "selected", systemPrompt: "", messages: [], abortSignal: controller.signal }))).toEqual(events);
    expect(cleanup).toHaveBeenCalledOnce();

    const iterator = provider.streamTurn({ model: "selected", systemPrompt: "", messages: [], abortSignal: controller.signal })[Symbol.asyncIterator]();
    await iterator.next();
    controller.abort();
    await iterator.return?.();
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  it("does not reinterpret explicit errors or incomplete streams as completion", async () => {
    const failure: StreamEvent = { type: "error", error: "transport failure", classification: "network", providerError: { origin: "provider", statusCode: 503, messagePreview: "temporarily unavailable" } };
    const provider = createOpenAiProvider({ kind: "api-key", transport: {
      async *streamTurn() { yield failure; },
    } });
    expect(await collectAsyncIterable(provider.streamTurn({ model: "selected", systemPrompt: "", messages: [] }))).toEqual([failure]);
    const empty = createOpenAiProvider({ kind: "api-key", transport: { async *streamTurn() {} } });
    expect(await collectAsyncIterable(empty.streamTurn({ model: "selected", systemPrompt: "", messages: [] }))).toEqual([]);
  });
});

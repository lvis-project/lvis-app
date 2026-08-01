import { describe, expect, it, vi } from "vitest";
import { collectAsyncIterable as collect } from "../../__tests__/test-helpers.js";
import type {
  ProviderRequestInputProjectionParams,
  StreamEvent,
  StreamTurnParams,
} from "../../engine/llm/types.js";
import { FallbackProvider } from "../../engine/llm/vercel/fallback-chain.js";
import { SubscriptionToolBridge } from "../subscription-tool-bridge.js";
import { stubMarkedToolResults } from "../../engine/wire-serialize.js";
import { estimateMultimodalTokenOverhead } from "../../shared/multimodal-token-estimate.js";
import { estimateTokens } from "../../shared/token-estimate.js";
import {
  createSubscriptionLlmProvider,
  serializeSubscriptionConversation,
  serializeSubscriptionConversationPayload,
  SubscriptionAttachmentInputRejectedError,
  SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED,
} from "../subscription-llm-provider.js";
import type {
  SubscriptionRuntimeService,
  SubscriptionTextSession,
} from "../subscription-runtime-service.js";
import { SubscriptionRuntimeServiceError } from "../subscription-runtime-service.js";

function params(overrides: Partial<StreamTurnParams> = {}): StreamTurnParams {
  return {
    model: "default",
    systemPrompt: "Apply the LVIS conversation and use only declared host tools.",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Please summarize this." },
        ],
      },
      {
        role: "assistant",
        content: "Earlier text answer.",
        thought: "private chain-of-thought must remain local",
        thinkingBlocks: [{ thinking: "signed private reasoning", signature: "do-not-forward" }],
        toolCalls: [{ id: "call-1", name: "read_file", input: { path: "secret.txt" } }],
      },
      {
        role: "tool_result",
        toolUseId: "call-1",
        content: "sensitive tool output",
      },
    ],
    ...overrides,
  };
}

function sessionWith(events: StreamEvent[]): {
  session: SubscriptionTextSession;
  streamTurn: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
} {
  const stop = vi.fn(async () => undefined);
  const streamTurn = vi.fn((_: string) => ({
    async *[Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
      for (const event of events) yield event;
    },
  }));
  return {
    session: {
      provider: "codex",
      streamTurn,
      cancelActiveTurn: vi.fn(async () => undefined),
      stop,
    },
    streamTurn,
    stop,
  };
}

describe("SubscriptionLlmProvider", () => {
  it("projects the subscription envelope plus bridge-normalized transport sidecars", () => {
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex", model: "gpt-5.5-codex" },
      service: { openTextSession: vi.fn() } as Pick<SubscriptionRuntimeService, "openTextSession">,
    });
    const toolSchemas = [{
      name: "read_file",
      description: "Read an approved file through LVIS.",
      inputSchema: { type: "object" as const, properties: { path: { type: "string" } } },
    }];
    const input = {
      systemPrompt: "Use the governed LVIS conversation.",
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Older image must stay a text marker." },
            { type: "image" as const, image: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", width: 4096, height: 4096 },
          ],
        },
        {
          role: "tool_result" as const,
          toolUseId: "call-1",
          toolName: "read_file",
          content: "raw stale tool result ".repeat(500),
          meta: { compactedAt: "2026-08-01T00:00:00.000Z" },
        },
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "Inspect the current image." },
            { type: "image" as const, image: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png", width: 1024, height: 512 },
          ],
        },
      ],
      toolSchemas,
      continuationPrefill: true,
      enableThinking: true,
      thinkingBudgetTokens: 2048,
    } satisfies ProviderRequestInputProjectionParams;

    const projection = provider.projectRequestInput(input);
    const payload = serializeSubscriptionConversationPayload({
      model: "gpt-5.5-codex",
      systemPrompt: input.systemPrompt,
      messages: stubMarkedToolResults(input.messages),
      tools: input.toolSchemas,
      continuationPrefill: true,
      enableThinking: true,
      thinkingBudgetTokens: 2048,
    });
    const expectedNativeImageTokens = estimateMultimodalTokenOverhead([
      { type: "image", width: 1024, height: 512 },
    ]);
    const expectedToolSchemaTokens = estimateTokens(JSON.stringify({
      dynamicTools: [{
        type: "function",
        name: toolSchemas[0].name,
        description: toolSchemas[0].description,
        inputSchema: toolSchemas[0].inputSchema,
      }],
    }));

    expect(projection).toEqual({
      systemPromptTokens: 0,
      messageTokens: estimateTokens(payload.text) + expectedNativeImageTokens,
      toolSchemaTokens: expectedToolSchemaTokens,
      totalTokens: estimateTokens(payload.text) + expectedNativeImageTokens + expectedToolSchemaTokens,
    });
    expect(payload.text).toContain('"continuationPrefill":true');
    expect(payload.text).toContain('"enableThinking":true');
    expect(payload.text).not.toContain("raw stale tool result");
    expect(payload.text).not.toContain("iVBORw0KGgo=");

    const wrapped = new FallbackProvider(provider, [], () => "must-not-read-api-key");
    expect(wrapped.projectRequestInput(input)).toEqual(projection);
    expect(wrapped.withCallbacks({}).projectRequestInput?.(input)).toEqual(projection);
  });

  it("uses the bridge-normalized wire shape for Codex and Kimi tool sidecars", () => {
    const toolSchemas = [{
      name: "read file safely",
      description: "Read a governed local file.",
      inputSchema: { type: "object" as const, properties: { path: { type: "string" } } },
    }];
    const input = {
      systemPrompt: "system",
      messages: [{ role: "user" as const, content: "inspect it" }],
      toolSchemas,
    } satisfies ProviderRequestInputProjectionParams;
    const bridgedTools = new SubscriptionToolBridge(toolSchemas).tools;
    const expectedCodex = estimateTokens(JSON.stringify({
      dynamicTools: bridgedTools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));
    const expectedKimi = estimateTokens(JSON.stringify({ tools: bridgedTools }));
    const rawToolTokens = estimateTokens(JSON.stringify({ tools: toolSchemas }));
    const service = { openTextSession: vi.fn() } as Pick<SubscriptionRuntimeService, "openTextSession">;

    const codex = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex", model: "gpt-5.5-codex" },
      service,
    });
    const kimi = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "kimi-code", model: "kimi-k2" },
      service,
    });
    const grok = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "grok-build", model: "grok-code-fast" },
      service,
    });

    expect(codex.projectRequestInput(input)?.toolSchemaTokens).toBe(expectedCodex);
    expect(kimi.projectRequestInput(input)?.toolSchemaTokens).toBe(expectedKimi);
    expect(grok.projectRequestInput(input)).toBeUndefined();
    expect(expectedCodex).not.toBe(rawToolTokens);
  });

  it("falls back to the generic projection when native input cannot serialize", () => {
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex" },
      service: { openTextSession: vi.fn() } as Pick<SubscriptionRuntimeService, "openTextSession">,
    });

    expect(provider.projectRequestInput({
      systemPrompt: "system",
      messages: [{
        role: "user",
        content: [{ type: "file", data: "data:text/plain;base64,WA==", mimeType: "text/plain" }],
      }],
      toolSchemas: [],
    })).toBeUndefined();
  });

  it("serializes a disabled subscription reasoning policy without an API budget", () => {
    const serialized = serializeSubscriptionConversation(params({
      enableThinking: false,
      thinkingBudgetTokens: undefined,
    }));
    const requestJson = serialized.match(/<lvis-request-json>\s*([\s\S]*?)\s*<\/lvis-request-json>/)?.[1];
    if (!requestJson) throw new Error("subscription JSON envelope missing");
    const envelope = JSON.parse(requestJson) as Record<string, unknown>;

    expect(envelope.enableThinking).toBe(false);
    expect(envelope).not.toHaveProperty("thinkingBudgetTokens");
  });

  it("preserves normal conversation context and opens an LVIS-governed tool session", async () => {
    const subscriptionUsage = {
      provider: "codex",
      model: "gpt-5",
      source: "provider-reported",
      billable: false,
      inputTokens: 21,
      outputTokens: 8,
      totalTokens: 34,
      cacheReadTokens: 11,
      cacheWriteTokens: 2,
      reasoningOutputTokens: 5,
    } as const;
    const { session, streamTurn, stop } = sessionWith([
      { type: "text_delta", text: "Safe answer" },
      {
        type: "message_complete",
        stopReason: "end_turn",
        usage: { inputTokens: 1, outputTokens: 1 },
        subscriptionUsage,
      },
    ]);
    const service = {
      openTextSession: vi.fn(async () => session),
    } as Pick<SubscriptionRuntimeService, "openTextSession">;
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex", model: "gpt-5" },
      service,
    });
    const tools = [{
      name: "read_file",
      description: "Read an approved project file through LVIS.",
      inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] },
    }];

    const events = await collect(provider.streamTurn(params({ tools })));

    expect(provider.subscriptionRuntime).toEqual({
      kind: "subscription", provider: "codex", model: "gpt-5",
    });
    expect(events).toEqual([
      { type: "text_delta", text: "Safe answer" },
      { type: "message_complete", stopReason: "end_turn", subscriptionUsage },
    ]);
    expect(events[1]).not.toHaveProperty("usage");
    expect(service.openTextSession).toHaveBeenCalledWith(provider.subscriptionRuntime, { tools });
    const serialized = streamTurn.mock.calls[0]?.[0] as string;
    expect(serialized).toContain("Apply the LVIS conversation and use only declared host tools.");
    expect(serialized).toContain("Please summarize this.");
    expect(serialized).toContain("read_file");
    expect(serialized).toContain("sensitive tool output");
    expect(serialized).not.toContain("private chain-of-thought must remain local");
    expect(serialized).not.toContain("signed private reasoning");
    expect(serialized).not.toContain("do-not-forward");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("forwards a sub-agent's parent selection for live catalog fallback", async () => {
    const { session } = sessionWith([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const service = {
      openTextSession: vi.fn(async () => session),
    } as Pick<SubscriptionRuntimeService, "openTextSession">;
    const parentSelection = {
      kind: "subscription" as const,
      provider: "codex" as const,
      model: "parent-model",
    };
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex", model: "profile-model" },
      fallbackSelection: parentSelection,
      service,
    });
    const tools = [{
      name: "read_file",
      description: "Read one approved file.",
      inputSchema: { type: "object" as const, properties: {} },
    }];

    await collect(provider.streamTurn(params({ tools })));

    expect(service.openTextSession).toHaveBeenCalledWith(
      provider.subscriptionRuntime,
      { tools, fallbackSelection: parentSelection },
    );
  });

  it("separates original user image bytes from the text envelope", () => {
    const payload = serializeSubscriptionConversationPayload(params({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image", image: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" },
        ],
      }],
    }));

    expect(payload.attachments).toEqual([{
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    }]);
    expect(payload.text).not.toContain("iVBORw0KGgo=");
    const requestJson = payload.text.match(/<lvis-request-json>\s*([\s\S]*?)\s*<\/lvis-request-json>/)?.[1];
    if (!requestJson) throw new Error("subscription JSON envelope missing");
    const envelope = JSON.parse(requestJson) as { messages: Array<{ content: unknown }> };
    expect(envelope.messages[0]?.content).toEqual([
      { type: "text", text: "Inspect this image." },
      { type: "image", mimeType: "image/png", attachmentIndex: 0 },
    ]);
  });

  it("rejects an image whose declared MIME does not match its bytes", () => {
    expect(() => serializeSubscriptionConversation(params({
      messages: [{
        role: "user",
        content: [
          { type: "image", image: "data:image/png;base64,c2VjcmV0", mimeType: "image/png" },
        ],
      }],
    }))).toThrow(SubscriptionAttachmentInputRejectedError);
  });

  it("forwards original user images only through the native session argument", async () => {
    const { session, streamTurn } = sessionWith([
      { type: "message_complete", stopReason: "end_turn" },
    ]);
    const service = { openTextSession: vi.fn(async () => session) } as Pick<
      SubscriptionRuntimeService,
      "openTextSession"
    >;
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex" },
      service,
    });

    await collect(provider.streamTurn(params({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this image." },
          { type: "image", image: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" },
        ],
      }],
    })));

    expect(streamTurn.mock.calls[0]?.[0]).not.toContain("iVBORw0KGgo=");
    expect(streamTurn.mock.calls[0]?.[2]).toEqual([{
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    }]);
  });

  it("reserves ACP JSONL room when an original image is present", async () => {
    const { session } = sessionWith([]);
    const service = {
      openTextSession: vi.fn(async () => session),
    } as Pick<SubscriptionRuntimeService, "openTextSession">;
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "kimi-code" },
      service,
    });

    const events = await collect(provider.streamTurn(params({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "x".repeat(300 * 1024) },
          { type: "image", image: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" },
        ],
      }],
    })));

    expect(events).toEqual([expect.objectContaining({
      type: "error",
      error: "The selected subscription runtime cannot send an attachment this large.",
      classification: "subscription-attachment-too-large",
    })]);
    expect(service.openTextSession).not.toHaveBeenCalled();
  });

  it("fails closed before a subscription session can receive a raw generic file payload", async () => {
    const input = params({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Inspect this file." },
          { type: "file", data: "data:text/plain;base64,iVBORw0KGgo=", mimeType: "text/plain" },
        ],
      }],
    });
    expect(() => serializeSubscriptionConversation(input)).toThrow(SubscriptionAttachmentInputRejectedError);

    const { session, streamTurn, stop } = sessionWith([]);
    const service = { openTextSession: vi.fn(async () => session) } as Pick<
      SubscriptionRuntimeService,
      "openTextSession"
    >;
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex" },
      service,
    });
    const events = await collect(provider.streamTurn(input));

    expect(events).toEqual([{
      type: "error",
      error: "The selected subscription runtime cannot send this attachment.",
      classification: SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED,
      providerError: {
        origin: "unknown",
        statusCode: 400,
        providerCode: SUBSCRIPTION_ATTACHMENT_INPUT_REJECTED,
        messagePreview: "subscription attachment input rejected",
      },
    }]);
    expect(service.openTextSession).not.toHaveBeenCalled();
    expect(streamTurn).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("keeps a historic tool-result image as its text placeholder without raw re-egress", () => {
    const payload = serializeSubscriptionConversationPayload(params({
      messages: [
        { role: "user", content: "Reuse the earlier result." },
        {
          role: "tool_result",
          toolUseId: "tool-1",
          content: "[image loaded]",
          image: { data: "iVBORw0KGgo=", mimeType: "image/png" },
        },
      ],
    }));
    expect(payload.attachments).toEqual([]);
    expect(payload.text).toContain("[image loaded]");
    expect(payload.text).not.toContain("iVBORw0KGgo=");
  });

  it("keeps older image turns as canonical markers instead of exhausting native attachment limits", () => {
    const olderImages = Array.from({ length: 6 }, (_, index) => ({
      role: "user" as const,
      content: [{
        type: "image" as const,
        image: "data:image/png;base64,iVBORw0KGgo=",
        mimeType: "image/png",
        width: index + 1,
      }],
    }));
    const payload = serializeSubscriptionConversationPayload(params({
      messages: [...olderImages, { role: "user", content: "Now answer in text." }],
    }));

    expect(payload.attachments).toEqual([]);
    expect(payload.text).not.toContain("iVBORw0KGgo=");
    expect(payload.text).toContain("[image:image/png]");
  });

  it("retains newest user images across a tool-result continuation", () => {
    const payload = serializeSubscriptionConversationPayload(params({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this image." },
            { type: "image", image: "data:image/png;base64,iVBORw0KGgo=", mimeType: "image/png" },
          ],
        },
        { role: "assistant", content: "I will inspect it.", toolCalls: [{ id: "tool-1", name: "view_image", input: {} }] },
        { role: "tool_result", toolUseId: "tool-1", content: "[image loaded]" },
      ],
    }));
    expect(payload.attachments).toEqual([{
      type: "image",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    }]);
  });

  it("forwards controlled LVIS tool calls and their round boundary", async () => {
    const { session, stop } = sessionWith([
      { type: "tool_call", id: "subscription_tool_1", name: "list_directory", input: { path: "src" } },
      { type: "message_complete", stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 8 } },
    ]);
    const service = {
      openTextSession: vi.fn(async () => session),
    } as Pick<SubscriptionRuntimeService, "openTextSession">;
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "kimi-code" },
      service,
    });
    const tools = [{
      name: "list_directory",
      description: "List an approved directory through LVIS.",
      inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"] },
    }];

    const events = await collect(provider.streamTurn(params({ tools })));

    expect(events).toEqual([
      { type: "tool_call", id: "subscription_tool_1", name: "list_directory", input: { path: "src" } },
      { type: "message_complete", stopReason: "tool_use" },
    ]);
    expect(service.openTextSession).toHaveBeenCalledWith(provider.subscriptionRuntime, { tools });
    expect(stop).toHaveBeenCalledOnce();
  });

  it("normalizes runtime failures and always stops the opened session", async () => {
    const { session, stop } = sessionWith([
      { type: "error", error: "runtime detail must not escape" },
    ]);
    const service = {
      openTextSession: vi.fn(async () => session),
    } as Pick<SubscriptionRuntimeService, "openTextSession">;
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "grok-build" },
      service,
    });

    const events = await collect(provider.streamTurn(params()));

    expect(events).toEqual([{
      type: "error",
      error: "Subscription runtime could not complete. Verify the connected runtime and try again.",
      classification: "subscription-chat-unavailable",
    }]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("projects a known schema rejection to a declared tool name without leaking runtime detail", async () => {
    const rawProviderDetail = "400 Invalid schema for function 'read_file': internal endpoint detail";
    const { session } = sessionWith([{
      type: "error",
      error: rawProviderDetail,
      providerError: {
        origin: "provider",
        statusCode: 400,
        providerCode: "invalid_function_parameters",
        messagePreview: rawProviderDetail,
      },
    }]);
    const service = {
      openTextSession: vi.fn(async () => session),
    } as Pick<SubscriptionRuntimeService, "openTextSession">;
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex" },
      service,
    });
    const tools = [{
      name: "read_file",
      description: "Read an approved project file through LVIS.",
      inputSchema: { type: "object" as const, properties: {}, required: [] },
    }];

    const events = await collect(provider.streamTurn(params({ tools })));

    expect(events).toEqual([{
      type: "error",
      error: "Subscription runtime could not complete. Verify the connected runtime and try again.",
      classification: "subscription-chat-unavailable",
      providerError: {
        origin: "provider",
        statusCode: 400,
        providerCode: "invalid_function_parameters",
        classification: "unknown",
        messagePreview: "Invalid schema for function 'read_file'.",
      },
    }]);
    expect(JSON.stringify(events)).not.toContain(rawProviderDetail);
  });

  it("projects only bounded TPM facts and never the raw provider message", async () => {
    const rawProviderDetail = "Rate limit reached for secret-plan on tokens per min (TPM): Limit 200000, Used 190000, Requested 30000.";
    const { session } = sessionWith([{
      type: "error",
      error: rawProviderDetail,
      providerError: {
        origin: "provider",
        providerType: "tokens",
        providerCode: "rate_limit_exceeded",
        classification: "rate-limit",
        messagePreview: rawProviderDetail,
        rateLimit: {
          kind: "tokens-per-minute",
          limit: 200_000,
          used: 190_000,
          requested: 30_000,
          retryAfterSeconds: 2.5,
        },
      },
    }]);
    const service = {
      openTextSession: vi.fn(async () => session),
    } as Pick<SubscriptionRuntimeService, "openTextSession">;
    const provider = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "grok-build" },
      service,
    });

    const events = await collect(provider.streamTurn(params()));

    expect(events).toEqual([{
      type: "error",
      error: "Subscription runtime could not complete. Verify the connected runtime and try again.",
      classification: "subscription-chat-unavailable",
      providerError: {
        origin: "provider",
        providerType: "tokens",
        providerCode: "rate_limit_exceeded",
        classification: "rate-limit",
        messagePreview: "subscription runtime tokens-per-minute rate limit",
        rateLimit: {
          kind: "tokens-per-minute",
          limit: 200_000,
          used: 190_000,
          requested: 30_000,
          retryAfterSeconds: 2.5,
        },
      },
    }]);
    expect(JSON.stringify(events)).not.toContain(rawProviderDetail);
  });

  it("retains projected TPM recovery facts after the same-runtime retry budget", async () => {
    vi.useFakeTimers();
    try {
      const rawProviderDetail = "Rate limit reached for secret-plan on tokens per min (TPM): Limit 200000, Used 190000, Requested 30000.";
      const { session } = sessionWith([{
        type: "error",
        error: rawProviderDetail,
        providerError: {
          origin: "provider",
          providerType: "tokens",
          providerCode: "rate_limit_exceeded",
          classification: "rate-limit",
          messagePreview: rawProviderDetail,
          rateLimit: {
            kind: "tokens-per-minute",
            limit: 200_000,
            used: 190_000,
            requested: 30_000,
          },
        },
      }]);
      const service = {
        openTextSession: vi.fn(async () => session),
      } as Pick<SubscriptionRuntimeService, "openTextSession">;
      const primary = createSubscriptionLlmProvider({
        selection: { kind: "subscription", provider: "codex" },
        service,
      });
      const retrying = new FallbackProvider(primary, [], () => {
        throw new Error("API-key fallback must not be created");
      });

      const pending = collect(retrying.streamTurn(params()));
      await vi.advanceTimersByTimeAsync(5_000);
      const events = await pending;

      expect(service.openTextSession).toHaveBeenCalledTimes(5);
      expect(events).toEqual([{
        type: "error",
        error: "Subscription runtime could not complete. Verify the connected runtime and try again.",
        classification: "subscription-chat-unavailable",
        providerError: {
          origin: "provider",
          providerType: "tokens",
          providerCode: "rate_limit_exceeded",
          classification: "rate-limit",
          messagePreview: "subscription runtime tokens-per-minute rate limit",
          rateLimit: {
            kind: "tokens-per-minute",
            limit: 200_000,
            used: 190_000,
            requested: 30_000,
          },
        },
      }]);
      expect(JSON.stringify(events)).not.toContain(rawProviderDetail);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry a locally known unavailable subscription runtime", async () => {
    const service = {
      openTextSession: vi.fn(async () => {
        throw new SubscriptionRuntimeServiceError("subscription-chat-unavailable");
      }),
    } as Pick<SubscriptionRuntimeService, "openTextSession">;
    const primary = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex" },
      service,
    });
    const retrying = new FallbackProvider(primary, [], () => {
      throw new Error("API-key fallback must not be created");
    });

    const events = await collect(retrying.streamTurn(params()));

    expect(service.openTextSession).toHaveBeenCalledOnce();
    expect(events).toEqual([{
      type: "error",
      error: "Subscription runtime could not complete. Verify the connected runtime and try again.",
      classification: "subscription-chat-unavailable",
      providerError: {
        origin: "unknown",
        providerCode: "subscription-chat-unavailable",
        isRetryable: false,
        messagePreview: "subscription runtime chat unavailable",
      },
    }]);
  });

  it("does not retry a locally rejected oversized subscription envelope", async () => {
    const service = {
      openTextSession: vi.fn(),
    } as Pick<SubscriptionRuntimeService, "openTextSession">;
    const primary = createSubscriptionLlmProvider({
      selection: { kind: "subscription", provider: "codex" },
      service,
    });
    const onStatus = vi.fn();
    const retrying = new FallbackProvider(primary, [], () => {
      throw new Error("API-key fallback must not be created");
    }).withCallbacks({ onStatus });

    const events = await collect(retrying.streamTurn(params({
      messages: [{ role: "user", content: "x".repeat(720 * 1024) }],
    })));

    expect(service.openTextSession).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{
      type: "error",
      error: "Subscription runtime could not complete. Verify the connected runtime and try again.",
      classification: "subscription-chat-unavailable",
      providerError: {
        origin: "unknown",
        statusCode: 400,
        providerCode: "subscription-input-too-large",
        isRetryable: false,
        messagePreview: "subscription input too large",
      },
    }]);
  });
});

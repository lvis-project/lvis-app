import { describe, expect, it, vi } from "vitest";

import { collectAsyncIterable as collect } from "../../../__tests__/test-helpers.js";

import type { LLMProvider, StreamEvent, StreamTurnParams } from "../../llm/types.js";
import type { ConversationLoop } from "../../conversation-loop.js";
import { FallbackProvider } from "../../llm/vercel/fallback-chain.js";
import { rejectedToolNameFromError } from "../../llm/rejected-tool-schema.js";
import { contextBudgetForCurrentRuntime } from "../compaction.js";
import { buildProvider, pingProvider } from "../provider.js";
import { collectRoundStream } from "../stream-collector.js";
import type { ConversationLoopDeps } from "../types.js";
import {
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  type SubscriptionChatRuntimeSelection,
} from "../../../shared/subscription-runtime.js";

const SAFE_SUBSCRIPTION_FAILURE = "Subscription runtime could not complete. Verify the connected runtime and try again.";

function retryParams(): StreamTurnParams {
  return {
    model: "default",
    systemPrompt: "system",
    messages: [{ role: "user", content: "retry this subscription turn" }],
  };
}

function buildRetryDeps(
  selection: SubscriptionChatRuntimeSelection,
  candidate: LLMProvider,
) {
  const getSecret = vi.fn(() => "api-key-must-not-be-read");
  const subscriptionProviderFactory = vi.fn(() => candidate);
  return {
    deps: {
      settingsService: {
        get: vi.fn(() => ({ activeChatRuntime: selection })),
        getSecret,
      },
      subscriptionProviderFactory,
    } as unknown as ConversationLoopDeps,
    getSecret,
    subscriptionProviderFactory,
  };
}

async function collectSubscriptionRound(
  provider: LLMProvider,
  tools: StreamTurnParams["tools"] = [],
) {
  return collectRoundStream({
    provider,
    model: "default",
    systemPrompt: "system",
    messages: [{ role: "user", content: "retry this subscription turn" }],
    toolSchemas: tools ?? [],
    llmSettings: {
      streamSmoothing: "none",
      enableThinking: false,
      thinkingBudgetTokens: 10_000,
    },
  });
}

function buildSubscriptionDeps(
  selection: SubscriptionChatRuntimeSelection,
  modelOverride?: string,
) {
  const subscriptionProviderFactory = vi.fn((runtimeSelection: SubscriptionChatRuntimeSelection): LLMProvider => ({
    vendor: "openai",
    subscriptionRuntime: runtimeSelection,
    async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
      yield { type: "message_complete", stopReason: "end_turn" };
    },
  }));
  return {
    deps: {
      settingsService: {
        get: () => ({ activeChatRuntime: selection }),
      },
      subscriptionProviderFactory,
      ...(modelOverride === undefined ? {} : { modelOverride }),
    } as unknown as ConversationLoopDeps,
    subscriptionProviderFactory,
  };
}

describe("buildProvider subscription model overrides", () => {
  it("forwards a clean Codex override as a new immutable selection", async () => {
    const persisted = {
      kind: "subscription",
      provider: "codex",
      model: "gpt-5.4",
    } as const satisfies SubscriptionChatRuntimeSelection;
    const { deps, subscriptionProviderFactory } = buildSubscriptionDeps(
      persisted,
      "  gpt-5.5-codex  ",
    );

    const provider = buildProvider(deps);
    const [selection] = subscriptionProviderFactory.mock.calls[0] ?? [];

    expect(provider?.subscriptionRuntime).toEqual({
      kind: "subscription",
      provider: "codex",
      model: "gpt-5.5-codex",
    });
    expect(selection).toEqual(provider?.subscriptionRuntime);
    expect(selection).not.toBe(persisted);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(persisted.model).toBe("gpt-5.4");
    await expect(pingProvider(provider, deps.settingsService)).resolves.toMatchObject({
      configured: true,
      online: true,
      vendor: "subscription:codex",
      model: "gpt-5.5-codex",
    });
  });

  it.each([
    ["valid catalog candidate", "gpt-5.1"],
    ["stale catalog candidate", "removed-profile-model"],
  ])("uses the conservative 64K budget for a Codex child candidate", (_caseName, modelOverride) => {
    const persisted = {
      kind: "subscription",
      provider: "codex",
      model: "gpt-4o",
    } as const satisfies SubscriptionChatRuntimeSelection;
    const { deps } = buildSubscriptionDeps(persisted, modelOverride);
    const provider = buildProvider(deps);

    const budget = contextBudgetForCurrentRuntime({ provider, deps } as unknown as ConversationLoop);

    expect(budget).toEqual({
      model: modelOverride,
      preflight: 29_600,
      usableContext: 37_000,
      identity: `subscription:codex/${modelOverride}`,
    });
  });

  it.each([
    ["empty", "   "],
    ["control character", "gpt-5.5\u0000"],
    ["over the subscription model-id limit", "x".repeat(MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH + 1)],
  ])("retains the persisted Codex selection for a %s override", (_caseName, modelOverride) => {
    const persisted = {
      kind: "subscription",
      provider: "codex",
      model: "gpt-5.4",
    } as const satisfies SubscriptionChatRuntimeSelection;
    const { deps, subscriptionProviderFactory } = buildSubscriptionDeps(persisted, modelOverride);

    const provider = buildProvider(deps);
    const [selection] = subscriptionProviderFactory.mock.calls[0] ?? [];

    expect(selection).toBe(persisted);
    expect(provider?.subscriptionRuntime).toBe(persisted);
  });

  it.each(["kimi-code", "grok-build"] as const)(
    "does not apply a model override to the %s ACP runtime",
    (runtimeId) => {
      const persisted = {
        kind: "subscription",
        provider: runtimeId,
        model: "provider-default",
      } as const satisfies SubscriptionChatRuntimeSelection;
      const { deps, subscriptionProviderFactory } = buildSubscriptionDeps(
        persisted,
        "gpt-5.5-codex",
      );

      const provider = buildProvider(deps);
      const [selection] = subscriptionProviderFactory.mock.calls[0] ?? [];

      expect(selection).toBe(persisted);
      expect(provider?.subscriptionRuntime).toBe(persisted);
    },
  );
});

describe("subscription primary-only retries", () => {
  it("retries the selected subscription runtime without reading API-key fallback credentials", async () => {
    vi.useFakeTimers();
    try {
      const selection = {
        kind: "subscription",
        provider: "codex",
        model: "gpt-5.5-codex",
      } as const satisfies SubscriptionChatRuntimeSelection;
      let attempts = 0;
      const streamTurn = vi.fn(async function* (): AsyncIterable<StreamEvent> {
        attempts += 1;
        if (attempts < 3) {
          yield {
            type: "error",
            error: SAFE_SUBSCRIPTION_FAILURE,
            classification: "network",
          };
          return;
        }
        yield { type: "text_delta", text: "recovered" };
        yield { type: "message_complete", stopReason: "end_turn" };
      });
      const candidate: LLMProvider = {
        vendor: "openai",
        subscriptionRuntime: selection,
        streamTurn,
      };
      const { deps, getSecret, subscriptionProviderFactory } = buildRetryDeps(selection, candidate);

      const provider = buildProvider(deps);

      expect(provider).toBeInstanceOf(FallbackProvider);
      expect(provider?.subscriptionRuntime).toBe(selection);
      expect((provider as FallbackProvider).withCallbacks({}).subscriptionRuntime).toBe(selection);
      const pending = collect(provider!.streamTurn(retryParams()));
      await vi.advanceTimersByTimeAsync(2_000);

      await expect(pending).resolves.toEqual([
        { type: "text_delta", text: "recovered" },
        { type: "message_complete", stopReason: "end_turn" },
      ]);
      expect(streamTurn).toHaveBeenCalledTimes(3);
      expect(subscriptionProviderFactory).toHaveBeenCalledOnce();
      expect(getSecret).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a declared schema rejection structured, non-retryable, and renderer-safe", async () => {
    const selection = {
      kind: "subscription",
      provider: "kimi-code",
    } as const satisfies SubscriptionChatRuntimeSelection;
    const rawProviderMessage = "400 Invalid schema for function 'bad_tool': internal vendor detail";
    const streamTurn = vi.fn(async function* (): AsyncIterable<StreamEvent> {
      yield {
        type: "error",
        error: SAFE_SUBSCRIPTION_FAILURE,
        providerError: {
          origin: "provider",
          statusCode: 400,
          providerCode: "invalid_function_parameters",
          messagePreview: rawProviderMessage,
        },
      };
    });
    const { deps } = buildRetryDeps(selection, {
      vendor: "openai",
      subscriptionRuntime: selection,
      streamTurn,
    });
    const provider = buildProvider(deps)!;
    const result = await collectSubscriptionRound(provider, [{
      name: "bad_tool",
      description: "test schema",
      inputSchema: { type: "object", properties: {} },
    }]);

    expect(streamTurn).toHaveBeenCalledOnce();
    expect(result.kind).toBe("stream_error");
    if (result.kind !== "stream_error") throw new Error("expected stream error");
    expect(rejectedToolNameFromError(result.providerError, ["bad_tool"])).toBe("bad_tool");
    expect(result.userMessage).not.toContain(rawProviderMessage);
    expect(result.providerError).toMatchObject({
      statusCode: 400,
      providerCode: "invalid_function_parameters",
    });
  });

  it("hands an internal context-length marker to compaction without transient retries", async () => {
    const selection = {
      kind: "subscription",
      provider: "codex",
    } as const satisfies SubscriptionChatRuntimeSelection;
    const streamTurn = vi.fn(async function* (): AsyncIterable<StreamEvent> {
      yield {
        type: "error",
        error: SAFE_SUBSCRIPTION_FAILURE,
        classification: "subscription-chat-unavailable",
        providerError: {
          origin: "unknown",
          classification: "context-length",
          messagePreview: "context window exceeded",
        },
      };
    });
    const { deps, getSecret } = buildRetryDeps(selection, {
      vendor: "openai",
      subscriptionRuntime: selection,
      streamTurn,
    });

    const result = await collectSubscriptionRound(buildProvider(deps)!);

    expect(streamTurn).toHaveBeenCalledOnce();
    expect(getSecret).not.toHaveBeenCalled();
    expect(result).toEqual({
      kind: "context_error",
      errorMessage: "context window exceeded",
    });
  });

  it("returns TPM diagnostics after bounded same-runtime retries without exposing the raw message", async () => {
    vi.useFakeTimers();
    try {
      const selection = {
        kind: "subscription",
        provider: "grok-build",
      } as const satisfies SubscriptionChatRuntimeSelection;
      const rawProviderMessage = "Rate limit reached for internal-plan on tokens per min (TPM): Limit 200000, Used 190000, Requested 30000.";
      const streamTurn = vi.fn(async function* (): AsyncIterable<StreamEvent> {
        yield {
          type: "error",
          error: SAFE_SUBSCRIPTION_FAILURE,
          providerError: {
            origin: "provider",
            providerType: "tokens",
            providerCode: "rate_limit_exceeded",
            classification: "rate-limit",
            messagePreview: rawProviderMessage,
            rateLimit: {
              kind: "tokens-per-minute",
              limit: 200_000,
              used: 190_000,
              requested: 30_000,
            },
          },
        };
      });
      const { deps, getSecret } = buildRetryDeps(selection, {
        vendor: "openai",
        subscriptionRuntime: selection,
        streamTurn,
      });
      const provider = buildProvider(deps)!;
      const pending = collectSubscriptionRound(provider);
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;

      expect(streamTurn).toHaveBeenCalledTimes(5);
      expect(getSecret).not.toHaveBeenCalled();
      expect(result.kind).toBe("stream_error");
      if (result.kind !== "stream_error") throw new Error("expected stream error");
      expect(result.classification).toBe("rate-limit");
      expect(result.providerError).toMatchObject({
        providerType: "tokens",
        providerCode: "rate_limit_exceeded",
        rateLimit: {
          kind: "tokens-per-minute",
          limit: 200_000,
          used: 190_000,
          requested: 30_000,
        },
      });
      expect(result.userMessage).not.toContain(rawProviderMessage);
    } finally {
      vi.useRealTimers();
    }
  });
});

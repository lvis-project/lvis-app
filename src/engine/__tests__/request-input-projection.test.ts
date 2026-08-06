import { describe, expect, it } from "vitest";

import type { GenericMessage, LLMProvider, ToolSchema } from "../llm/types.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import { estimateUserMessageTokens } from "../../shared/multimodal-token-estimate.js";
import { estimateRequestInputProjection, projectNextTurnInputTokens } from "../request-input-projection.js";

describe("estimateRequestInputProjection", () => {
  it("counts system prompt and exposed tool schemas in addition to wire messages", () => {
    const messages: GenericMessage[] = [{ role: "user", content: "hello" }];
    const toolSchemas: ToolSchema[] = [
      {
        name: "search_docs",
        description: "Search internal documents",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
      },
    ];

    const projection = estimateRequestInputProjection({
      systemPrompt: "You are LVIS.",
      messages,
      toolSchemas,
    });

    expect(projection.messageTokens).toBe(estimateMessagesTokens(messages));
    expect(projection.systemPromptTokens).toBeGreaterThan(0);
    expect(projection.toolSchemaTokens).toBeGreaterThan(0);
    expect(projection.totalTokens).toBe(
      projection.systemPromptTokens + projection.messageTokens + projection.toolSchemaTokens,
    );
  });

  it("counts multipart user text and images through the shared user-wire estimator", () => {
    const content = [
      { type: "text" as const, text: "한글 본문" },
      { type: "text" as const, text: "<resource>server text</resource>" },
      {
        type: "image" as const,
        image: "data:image/png;base64,abc",
        mimeType: "image/png",
        width: 2048,
        height: 512,
      },
    ];
    const messages: GenericMessage[] = [{ role: "user", content }];
    const projection = estimateRequestInputProjection({
      systemPrompt: "",
      messages,
      toolSchemas: [],
    });

    expect(projection.messageTokens).toBe(estimateUserMessageTokens(content));
    expect(projection.totalTokens).toBe(projection.messageTokens);
  });
  it("leaves the generic API-key estimator unchanged when transport flags are present", () => {
    const input = {
      systemPrompt: "system",
      messages: [{ role: "user" as const, content: "hello" }],
      toolSchemas: [],
    };

    expect(estimateRequestInputProjection({
      ...input,
      continuationPrefill: true,
      enableThinking: true,
      thinkingBudgetTokens: 2048,
    })).toEqual(estimateRequestInputProjection(input));
  });

  it("falls back when an optional provider projection throws or violates the token contract", () => {
    const input = {
      systemPrompt: "system",
      messages: [{ role: "user" as const, content: "hello" }],
      toolSchemas: [],
    };
    const generic = estimateRequestInputProjection(input);
    const throwingProvider = {
      projectRequestInput: () => {
        throw new Error("projection-failure");
      },
    } satisfies Pick<LLMProvider, "projectRequestInput">;
    const malformedProvider = {
      projectRequestInput: () => ({
        totalTokens: Number.NaN,
        systemPromptTokens: 1,
        messageTokens: -1,
        toolSchemaTokens: 1,
      }),
    } as unknown as Pick<LLMProvider, "projectRequestInput">;

    expect(estimateRequestInputProjection(input, throwingProvider)).toEqual(generic);
    expect(estimateRequestInputProjection(input, malformedProvider)).toEqual(generic);
  });

  it("uses provider-wire tool_result stubs through estimateMessagesTokens", () => {
    const raw = "large result ".repeat(2_000);
    const messages: GenericMessage[] = [
      {
        role: "tool_result",
        toolUseId: "tool-1",
        toolName: "search_docs",
        content: raw,
        meta: { compactedAt: "2026-05-24T00:00:00.000Z" },
      },
    ];

    const projection = estimateRequestInputProjection({
      systemPrompt: "",
      messages,
      toolSchemas: [],
    });

    expect(projection.messageTokens).toBeLessThan(100);
    expect(projection.totalTokens).toBe(projection.messageTokens);
  });
});

describe("projectNextTurnInputTokens", () => {
  it("calibrates local post-turn projection with the provider input baseline", () => {
    const lastRoundProjection = {
      totalTokens: 1_000,
      systemPromptTokens: 100,
      messageTokens: 800,
      toolSchemaTokens: 100,
    };
    const postTurnProjection = {
      totalTokens: 1_250,
      systemPromptTokens: 100,
      messageTokens: 1_050,
      toolSchemaTokens: 100,
    };

    expect(projectNextTurnInputTokens({
      providerInputTokens: 1_100,
      lastRoundProjection,
      postTurnProjection,
    })).toBe(1_350);
  });
});

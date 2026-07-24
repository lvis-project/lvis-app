/**
 * #1182 — provider-as-oracle reactive tool-schema guard.
 *
 * When the provider rejects the whole request with a strict-mode 400
 * (invalid_function_parameters) naming one offending function, the loop drops
 * just that tool and retries the round with the reduced set — no hand-rolled
 * mirror of the provider's strict-mode rules. These tests drive a real
 * ConversationLoop with two in-scope builtin tools and a provider that 400s.
 */
import { describe, expect, it } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent, StreamTurnParams,
} from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

/** Provider that records the tool names it was handed on each streamTurn call. */
class ToolRecordingProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly toolNamesPerCall: string[][] = [];
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.toolNamesPerCall.push((input.tools ?? []).map((t) => t.name));
    yield* this.turns[this.index++] ?? [];
  }
}

function rejection(toolName: string): StreamEvent {
  return {
    type: "error",
    error: `400 Invalid schema for function '${toolName}'`,
    providerError: {
      origin: "provider",
      statusCode: 400,
      providerCode: "invalid_function_parameters",
      messagePreview: `Invalid schema for function '${toolName}': In context=('properties','tags'), array schema is missing items.`,
    },
  } as StreamEvent;
}

type ToolSpec = { name: string; source?: "builtin" | "mcp" };

function makeLoop(
  provider: LLMProvider,
  tools: ToolSpec[] = [{ name: "good_tool" }, { name: "bad_tool" }],
) {
  const toolRegistry = new ToolRegistry();
  for (const { name, source = "builtin" } of tools) {
    toolRegistry.register(
      createDynamicTool({
        name,
        description: `${name} description`,
        source,
        category: "read",
        ...(source === "mcp" ? { mcpServerId: "test-server" } : {}),
        jsonSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: [],
        },
        isReadOnly: () => true,
        execute: async () => ({ output: "ok", isError: false }),
      }),
    );
  }
  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry,
    memoryManager: { saveSession: () => {}, listSessions: () => [] },
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as unknown as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

describe("ConversationLoop — provider-as-oracle tool-schema guard (#1182)", () => {
  it("drops the rejected tool and retries the round with the reduced tool set", async () => {
    const provider = new ToolRecordingProvider([
      [rejection("bad_tool")],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop(provider);

    const result = await loop.runTurn("go", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(result.text).toContain("done");
    expect(result.stopReason).toBe("end_turn");
    // Two provider calls: the 400, then the successful retry.
    expect(provider.toolNamesPerCall).toHaveLength(2);
    // First call saw both tools; retry dropped only the rejected one.
    expect(provider.toolNamesPerCall[0]).toEqual(
      expect.arrayContaining(["good_tool", "bad_tool"]),
    );
    expect(provider.toolNamesPerCall[1]).toContain("good_tool");
    expect(provider.toolNamesPerCall[1]).not.toContain("bad_tool");
  });

  it("does not loop forever when the same tool is reported again after being dropped", async () => {
    // The provider re-reports bad_tool on the retry. Since it is no longer in
    // the tool set, the extractor returns undefined → no further retry → the
    // error surfaces normally. The turn must end after exactly two calls.
    const provider = new ToolRecordingProvider([
      [rejection("bad_tool")],
      [rejection("bad_tool")],
    ]);
    const loop = makeLoop(provider);

    const result = await loop.runTurn("go", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(provider.toolNamesPerCall).toHaveLength(2);
    expect(provider.toolNamesPerCall[1]).not.toContain("bad_tool");
    expect(result.stopReason).toBe("stream-error");
  });

  it("drops an MCP-sourced tool the same way (MCP tools have no plugin-load lint — the oracle is their only guard)", async () => {
    const provider = new ToolRecordingProvider([
      [rejection("mcp_bad_tool")],
      [
        { type: "text_delta", text: "done" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);
    const loop = makeLoop(provider, [
      { name: "good_tool", source: "builtin" },
      { name: "mcp_bad_tool", source: "mcp" },
    ]);

    const result = await loop.runTurn("go", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    expect(result.stopReason).toBe("end_turn");
    expect(provider.toolNamesPerCall).toHaveLength(2);
    // The MCP tool was in scope on the first call and dropped on the retry.
    expect(provider.toolNamesPerCall[0]).toEqual(
      expect.arrayContaining(["good_tool", "mcp_bad_tool"]),
    );
    expect(provider.toolNamesPerCall[1]).toContain("good_tool");
    expect(provider.toolNamesPerCall[1]).not.toContain("mcp_bad_tool");
  });

  it("does not drop tools for a non-schema provider error (rate limit)", async () => {
    const provider = new ToolRecordingProvider([
      [
        {
          type: "error",
          error: "429 Rate limit reached; please retry the bad_tool call later",
          providerError: {
            origin: "provider",
            statusCode: 429,
            providerCode: "rate_limit_exceeded",
            messagePreview:
              "Rate limit reached; please retry the bad_tool call later",
          },
        } as StreamEvent,
      ],
    ]);
    const loop = makeLoop(provider);

    const result = await loop.runTurn("go", undefined, undefined, {
      inputOrigin: "user-keyboard",
    });

    // Single call, no retry — the rate-limit error is not a schema rejection.
    expect(provider.toolNamesPerCall).toHaveLength(1);
    expect(result.stopReason).toBe("stream-error");
  });
});

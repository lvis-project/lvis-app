/**
 * Continuous transcript durability.
 *
 * The turn's persistence points all sit AFTER `queryLoop` returns (the
 * post-turn hook chain, the no-hook-chain fallback, and the turn_summary
 * save). Any throw between the user append and those points therefore used to
 * discard the entire turn — the user's own message included — because the
 * history it lived in is in-memory state.
 *
 * These tests pin the invariants that make the record survive:
 *   1. the user message is durable before the first provider call,
 *   2. rounds completed before a mid-turn throw stay durable,
 *   3. a provider stream failure keeps its partial round + error marker,
 *   4. the persisted partial turn replays through `historyToEntries`.
 *
 * The loops built here carry no `postTurnHookChain`, which is also how
 * `SubAgentRunner` constructs a child loop — so these cases exercise the same
 * persistence path a sub-agent transcript takes into `~/.lvis/subagent/`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { GenericMessage, LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { MemoryManager } from "../../memory/memory-manager.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import { historyToEntries } from "../../ui/renderer/utils/history.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

const SESSION_ID = "durability-session";

class ScriptedProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;

  constructor(
    private readonly turns: StreamEvent[][],
    private readonly onStreamStart?: () => void,
  ) {}

  async *streamTurn(_params: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.onStreamStart?.();
    yield* this.turns[this.index++] ?? [];
  }
}

function buildLoop(
  memoryManager: MemoryManager,
  toolRegistry: ToolRegistry,
  provider: LLMProvider,
): ConversationLoop {
  const loop = new ConversationLoop({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system" },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry,
    memoryManager,
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  (loop as { sessionId: string }).sessionId = SESSION_ID;
  return loop;
}

/**
 * A tool whose approval-cache key throws — the shape that lost the reported
 * turn. `approvalCacheKeyFor` runs the tool's own zod parse (BashTool's
 * `approvalCacheKey` does exactly this) at the invocation runner's authority
 * boundary, OUTSIDE the handler's error boundary, so an over-max
 * `timeoutSeconds` escapes the loop as a rejected `lvis:chat:send` instead of
 * becoming an error tool_result.
 */
function explodingTool(message: string) {
  return createDynamicTool({
    name: "exploding_tool",
    description: "rejects its own input at the approval boundary",
    source: "builtin",
    category: "read",
    jsonSchema: { type: "object", properties: {} },
    approvalCacheKey: () => {
      throw new Error(message);
    },
    execute: async () => ({ output: "never reached", isError: false }),
  });
}

function persisted(memoryManager: MemoryManager): GenericMessage[] {
  return (memoryManager.loadSession(SESSION_ID) ?? []) as GenericMessage[];
}

async function withTmpMemory(
  run: (memoryManager: MemoryManager) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "lvis-durability-"));
  try {
    await run(new MemoryManager({ lvisDir: dir }));
  } finally {
    await cleanupTmpDir(dir);
  }
}

describe("transcript durability", () => {
  it("persists the user message before the first provider call", async () => {
    await withTmpMemory(async (memoryManager) => {
      let onDiskAtStreamStart: GenericMessage[] = [];
      const provider = new ScriptedProvider(
        [[{ type: "text_delta", text: "hi" }, { type: "message_complete", stopReason: "end_turn" }]],
        () => {
          onDiskAtStreamStart = persisted(memoryManager);
        },
      );

      await buildLoop(memoryManager, new ToolRegistry(), provider).runTurn(
        "질문입니다",
        undefined,
        undefined,
        { inputOrigin: "user-keyboard" },
      );

      expect(onDiskAtStreamStart).toHaveLength(1);
      expect(onDiskAtStreamStart[0]).toMatchObject({
        role: "user",
        content: "질문입니다",
      });
    });
  });

  it("keeps the user message durable when the turn throws before any round", async () => {
    await withTmpMemory(async (memoryManager) => {
      const loop = buildLoop(memoryManager, new ToolRegistry(), new ScriptedProvider([]));
      (loop as unknown as {
        deps: { systemPromptBuilder: { build: () => string } };
      }).deps.systemPromptBuilder.build = () => {
        throw new Error("prompt assembly failed");
      };

      await expect(
        loop.runTurn("사라지면 안 되는 질문", undefined, undefined, {
          inputOrigin: "user-keyboard",
        }),
      ).rejects.toThrow("prompt assembly failed");

      const messages = persisted(memoryManager);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        role: "user",
        content: "사라지면 안 되는 질문",
      });
    });
  });

  it("keeps completed rounds durable when a tool throws mid-turn", async () => {
    await withTmpMemory(async (memoryManager) => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(
        createDynamicTool({
          name: "ok_tool",
          description: "succeeds",
          source: "builtin",
          category: "read",
          jsonSchema: { type: "object", properties: {} },
          execute: async () => ({ output: "tool round 1 output", isError: false }),
        }),
      );
      toolRegistry.register(explodingTool("timeoutSeconds too_big"));

      const provider = new ScriptedProvider([
        [
          { type: "text_delta", text: "먼저 도구를 실행합니다" },
          { type: "tool_call", id: "call-1", name: "ok_tool", input: {} },
          { type: "message_complete", stopReason: "tool_use" },
        ],
        [
          { type: "text_delta", text: "이제 두 번째 도구" },
          { type: "tool_call", id: "call-2", name: "exploding_tool", input: {} },
          { type: "message_complete", stopReason: "tool_use" },
        ],
      ]);

      await expect(
        buildLoop(memoryManager, toolRegistry, provider).runTurn(
          "두 라운드 작업",
          undefined,
          undefined,
          { inputOrigin: "user-keyboard" },
        ),
      ).rejects.toThrow("timeoutSeconds too_big");

      const messages = persisted(memoryManager);
      expect(messages[0]).toMatchObject({ role: "user", content: "두 라운드 작업" });
      expect(messages[1]).toMatchObject({
        role: "assistant",
        content: "먼저 도구를 실행합니다",
      });
      expect(messages[2]).toMatchObject({
        role: "tool_result",
        toolUseId: "call-1",
        content: "tool round 1 output",
      });
      expect(messages[3]).toMatchObject({
        role: "assistant",
        content: "이제 두 번째 도구",
      });
      // The failed round's own assistant message is the tail: its tool_use has
      // no result, which `normalizeToolPairInvariant` repairs on load.
      expect(messages).toHaveLength(4);
    });
  });

  it("persists a stream failure's partial turn with the stream-error marker", async () => {
    await withTmpMemory(async (memoryManager) => {
      const provider = new ScriptedProvider([
        [
          { type: "text_delta", text: "부분 응답" },
          { type: "error", error: "provider exploded" },
        ],
      ]);

      const result = await buildLoop(
        memoryManager,
        new ToolRegistry(),
        provider,
      ).runTurn("스트림 실패", undefined, undefined, { inputOrigin: "user-keyboard" });

      expect(result.stopReason).toBe("stream-error");
      const messages = persisted(memoryManager);
      expect(messages[0]).toMatchObject({ role: "user", content: "스트림 실패" });
      const notice = messages.find(
        (m) => m.role === "assistant" && m.meta?.systemNotice === "stream-error",
      );
      expect(notice).toBeDefined();
    });
  });

  it("replays a persisted mid-turn failure through historyToEntries", async () => {
    await withTmpMemory(async (memoryManager) => {
      const toolRegistry = new ToolRegistry();
      toolRegistry.register(explodingTool("boom"));
      const provider = new ScriptedProvider([
        [
          { type: "text_delta", text: "작업 시작" },
          { type: "tool_call", id: "call-1", name: "exploding_tool", input: {} },
          { type: "message_complete", stopReason: "tool_use" },
        ],
      ]);
      const loop = buildLoop(memoryManager, toolRegistry, provider);

      await expect(
        loop.runTurn("리로드 확인", undefined, undefined, { inputOrigin: "user-keyboard" }),
      ).rejects.toThrow("boom");

      // Reload the way the app does: engine load (which repairs the unpaired
      // tool_use tail) then the renderer's persisted-history projection.
      const reloadLoop = buildLoop(memoryManager, new ToolRegistry(), provider);
      expect(reloadLoop.loadSession(SESSION_ID)).toBe(true);
      const entries = historyToEntries(
        reloadLoop
          .getHistory()
          .getMessages()
          .map((message, index) => serializeHistoryMessage(message, index)),
      );

      expect(entries.some((e) => e.kind === "user" && e.text === "리로드 확인")).toBe(true);
      expect(entries.some((e) => e.kind === "assistant" && e.text === "작업 시작")).toBe(true);
    });
  });
});

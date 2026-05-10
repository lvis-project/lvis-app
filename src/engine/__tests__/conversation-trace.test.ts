/**
 * K4: §4.5 11-step conversation trace — instrumentation smoke test.
 *
 * Goals:
 *  - runTurn() 한 턴이 11 step canonical 이름을 모두 emit
 *  - 파일 기반 tracer 생성 시 JSONL 유효성
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import {
  createTracer,
  type ConversationTracer,
  type TraceStepName,
  type TraceEntry
} from "../../observability/conversation-trace.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

class RecordingTracer implements ConversationTracer {
  readonly enabled = true;
  readonly filePath = undefined;
  steps: Array<{ name: TraceStepName; meta?: Record<string, unknown> }> = [];
  step(name: TraceStepName, meta?: Record<string, unknown>): void {
    this.steps.push({ name, meta });
  }
}

function makeLoop(provider: LLMProvider) {
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(
    createDynamicTool({
      name: "list_directory",
      description: "List files",
      source: "builtin",
      category: "read",
      jsonSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"]
      },
      isReadOnly: () => true,
      execute: async () => ({ output: "src\npackage.json", isError: false })
    }),
  );

  const keywordEngine = new KeywordEngine();
  const routeEngine = new RouteEngine({ toolRegistry });
  const loop = new ConversationLoop(({
    settingsService: {
      get: () => fakeLlmSettings(),
      getSecret: () => "test-key"
    },
    systemPromptBuilder: { build: () => "system" },
    keywordEngine,
    routeEngine,
    toolRegistry,
    memoryManager: {
      saveSession: () => {},
      listSessions: () => []
    }
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
  (loop as { provider: LLMProvider | null }).provider = provider;
  return loop;
}

describe("ConversationTracer — §4.5 11-step", () => {
  it("emits all 11 canonical steps across a tool-use turn", async () => {
    const provider = new FakeProvider([
      [
        { type: "reasoning_delta", text: "생각 중" },
        { type: "text_delta", text: "먼저 확인" },
        { type: "tool_call", id: "t1", name: "list_directory", input: { path: "src" } },
        { type: "message_complete", stopReason: "tool_use" },
      ],
      [
        { type: "reasoning_delta", text: "결과 해석" },
        { type: "text_delta", text: "완료" },
        { type: "message_complete", stopReason: "end_turn" },
      ],
    ]);

    const loop = makeLoop(provider);
    const rec = new RecordingTracer();
    loop.setTracer(rec);

    await loop.runTurn("디렉토리 보여줘", undefined, undefined, { inputOrigin: "user-keyboard" });

    const names = new Set(rec.steps.map((s) => s.name));
    const expected: TraceStepName[] = [
      "REQUEST_ENTRY",
      "KEYWORD_CLASSIFY",
      "ROUTE_RESOLVE",
      "TURN_ORCHESTRATE",
      "HISTORY_APPEND",
      "PROMPT_ASSEMBLE",
      "LLM_STREAM",
      "REASONING_ACCUMULATE",
      "TOOL_EXECUTE",
      "ROUND_COMMIT",
      "POST_TURN",
    ];
    for (const step of expected) {
      expect(names.has(step), `missing step: ${step}`).toBe(true);
    }
    expect(expected.length).toBe(11);
  });

  it("writes valid JSONL entries to the trace file when enabled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-trace-"));
    const sessionId = "test-session-abc";
    const tracer = createTracer(sessionId, { enabled: true, traceDir: dir });
    expect(tracer.enabled).toBe(true);
    expect(tracer.filePath).toBe(join(dir, `${sessionId}.jsonl`));

    tracer.step("REQUEST_ENTRY", { inputLen: 5 });
    tracer.step("POST_TURN", { toolCallCount: 0 });

    const raw = readFileSync(tracer.filePath!, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed: TraceEntry[] = lines.map((l) => JSON.parse(l) as TraceEntry);
    expect(parsed[0].step).toBe("REQUEST_ENTRY");
    expect(parsed[0].sessionId).toBe(sessionId);
    expect(typeof parsed[0].ts).toBe("string");
    expect(parsed[0].meta).toEqual({ inputLen: 5 });
    expect(parsed[1].step).toBe("POST_TURN");
  });

  it("is no-op when disabled (production fallback)", () => {
    const tracer = createTracer("s", { enabled: false });
    expect(tracer.enabled).toBe(false);
    expect(tracer.filePath).toBeUndefined();
    // does not throw
    tracer.step("REQUEST_ENTRY");
  });
});

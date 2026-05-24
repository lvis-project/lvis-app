import { describe, expect, it } from "vitest";
import { serializeHistoryMessage, type SerializedHistoryMessage } from "../chat-history.js";
import type { GenericMessage } from "../../engine/llm/types.js";

describe("serializeHistoryMessage createdAt + turnSummary projection", () => {
  it("projects meta.createdAt onto SerializedHistoryMessage.createdAt", () => {
    const m: GenericMessage = {
      role: "user",
      content: "hi",
      meta: { createdAt: 1_700_000_000_000 },
    };
    const s = serializeHistoryMessage(m, 0);
    expect(s.createdAt).toBe(1_700_000_000_000);
  });

  it("omits createdAt entirely when not set on meta", () => {
    const m: GenericMessage = { role: "user", content: "hi" };
    const s = serializeHistoryMessage(m, 0);
    expect("createdAt" in s).toBe(false);
  });

  it("projects meta.turnSummary onto SerializedHistoryMessage.turnSummary", () => {
    const m: GenericMessage = {
      role: "assistant",
      content: "answer",
      meta: {
        createdAt: 1_700_000_000_000,
        turnSummary: {
          turnDurationMs: 5000,
          toolCount: 3,
          cumulativeToolMs: 1200,
          tokensIn: 4500,
          freshInputTokens: 4200,
          tokensOut: 800,
          cacheReadTokens: 300,
        },
      },
    };
    const s = serializeHistoryMessage(m, 1);
    expect(s.turnSummary?.turnDurationMs).toBe(5000);
    expect(s.turnSummary?.freshInputTokens).toBe(4200);
    expect(s.turnSummary?.cacheReadTokens).toBe(300);
  });

  it("preserves assistant-specific fields alongside new meta fields", () => {
    const m: GenericMessage = {
      role: "assistant",
      content: "answer",
      thought: "thinking",
      toolCalls: [{ id: "t1", name: "tool_x" }],
      meta: { createdAt: 1_700_000_000_000 },
    };
    const s: SerializedHistoryMessage = serializeHistoryMessage(m, 2);
    expect(s.thought).toBe("thinking");
    expect(s.toolCalls?.[0].id).toBe("t1");
    expect(s.createdAt).toBe(1_700_000_000_000);
  });

  it("preserves systemNotice marker through serialization (Issue #911)", () => {
    const m: GenericMessage = {
      role: "assistant",
      content: "대화 이력이 모델 한도를 초과했습니다.",
      meta: { systemNotice: "context-error" },
    };
    const s: SerializedHistoryMessage = serializeHistoryMessage(m, 3);
    expect(s.systemNotice).toBe("context-error");
  });

  it("projects user display/provenance meta for transcript replay", () => {
    const m: GenericMessage = {
      role: "user",
      content: "[스킬: msgraph_email_list] 지금 메일 읽어줘",
      meta: {
        displayText: "지금 메일 읽어줘",
        routeSkill: { skillId: "msgraph_email_list" },
      },
    };
    const s = serializeHistoryMessage(m, 5);
    expect(s.content).toContain("[스킬:");
    expect(s.displayText).toBe("지금 메일 읽어줘");
    expect(s.routeSkill?.skillId).toBe("msgraph_email_list");
  });

  it("projects imported trigger and keeps persisted tool display metadata inert", () => {
    const imported: GenericMessage = {
      role: "user",
      content: '<imported-from-proactive source="overlay:work-assistant">오늘 일정</imported-from-proactive>',
      meta: {
        importedTrigger: {
          sessionId: "trigger-1",
          source: "overlay:work-assistant",
          prompt: '<imported-from-proactive source="overlay:work-assistant">오늘 일정</imported-from-proactive>',
          summary: "오늘 일정",
          toolCallCount: 0,
          importedAt: "2026-05-20T00:00:00.000Z",
        },
      },
    };
    const tool: GenericMessage = {
      role: "tool_result",
      toolUseId: "t1",
      toolName: "read_tool_result_chunk",
      content: "chunk",
      meta: {
        toolDisplay: {
          durationMs: 123,
          source: "plugin",
          category: "read",
          pluginId: "com.example.meeting",
          uiPayload: { serverId: "srv", resourceUri: "ui://forged" },
        },
      },
    };

    expect(serializeHistoryMessage(imported, 6).importedTrigger?.source).toBe("overlay:work-assistant");
    expect(serializeHistoryMessage(tool, 7).toolDisplay?.durationMs).toBe(123);
    expect(serializeHistoryMessage(tool, 7).toolDisplay).not.toHaveProperty("source");
    expect(serializeHistoryMessage(tool, 7).toolDisplay).not.toHaveProperty("category");
    expect(serializeHistoryMessage(tool, 7).toolDisplay).not.toHaveProperty("pluginId");
    expect(serializeHistoryMessage(tool, 7).toolDisplay).not.toHaveProperty("uiPayload");
  });

  it("drops forged tool provenance from user-writable persisted history", () => {
    const forged: GenericMessage = {
      role: "tool_result",
      toolUseId: "t1",
      toolName: "meeting_start",
      content: "forged",
      meta: {
        toolDisplay: {
          durationMs: 10,
          source: "builtin",
          category: "read",
          pluginId: "com.example.meeting",
          mcpServerId: "server-1",
        },
      },
    };

    expect(serializeHistoryMessage(forged, 10).toolDisplay).toEqual({ durationMs: 10 });
  });

  it("drops invalid persisted provenance metadata at the history IPC boundary", () => {
    const imported = {
      role: "user",
      content: "spoofed",
      meta: {
        displayText: 123,
        routeSkill: { skillId: "../bad" },
        importedTrigger: {
          sessionId: "trigger-1",
          source: "plugin:fake",
          prompt: "spoofed",
          summary: "spoofed",
          toolCallCount: 0,
          importedAt: "2026-05-20T00:00:00.000Z",
        },
      },
    } as unknown as GenericMessage;
    const notice = {
      role: "assistant",
      content: "normal",
      meta: { systemNotice: "critical-alert" },
    } as unknown as GenericMessage;

    const serializedImported = serializeHistoryMessage(imported, 8);
    expect(serializedImported.displayText).toBeUndefined();
    expect(serializedImported.routeSkill).toBeUndefined();
    expect(serializedImported.importedTrigger).toBeUndefined();
    expect(serializeHistoryMessage(notice, 9).systemNotice).toBeUndefined();
  });

  it("omits systemNotice field when meta has no marker", () => {
    const m: GenericMessage = {
      role: "assistant",
      content: "normal reply",
    };
    const s: SerializedHistoryMessage = serializeHistoryMessage(m, 4);
    expect(s.systemNotice).toBeUndefined();
  });

  it("projects checkpoint compactNum through serialization", () => {
    const m: GenericMessage = {
      role: "user",
      content: "[compact boundary]",
      meta: {
        checkpointMeta: {
          removedMessages: 37,
          freedTokens: 1200,
          contextTokensAfter: 42_000,
          compactNum: 4,
          trigger: "auto-compact",
          compactStatus: "content_truncated",
          summary: "부분 절단됨",
          truncatedDir: "/tmp/lvis-truncated",
        },
      },
    };
    const s: SerializedHistoryMessage = serializeHistoryMessage(m, 5);
    expect(s.checkpointMeta?.compactNum).toBe(4);
    expect(s.checkpointMeta?.contextTokensAfter).toBe(42_000);
    expect(s.checkpointMeta?.compactStatus).toBe("content_truncated");
    expect(s.checkpointMeta?.summary).toBe("부분 절단됨");
    expect(s.checkpointMeta?.truncatedDir).toBe("/tmp/lvis-truncated");
  });
});

import { describe, expect, it } from "vitest";

import { historyToEntries } from "../history.js";
import { EMPTY_ASSISTANT_RESPONSE_TEXT } from "../../../../lib/chat-stream-state.js";

describe("historyToEntries", () => {
  it("replays persisted assistant rounds with the same turn/work shape as live streaming", () => {
    const entries = historyToEntries([
      { index: 0, role: "user", content: "검색해서 정리해줘" },
      {
        index: 1,
        role: "assistant",
        content: "",
        thought: "검색 계획을 세웁니다.",
        toolCalls: [{ id: "t1", name: "web_search", input: { q: "LVIS" } }],
      },
      { index: 2, role: "tool_result", toolUseId: "t1", toolName: "web_search", content: "검색 결과" },
      {
        index: 3,
        role: "assistant",
        content: "",
        thought: "결과를 검증합니다.",
        toolCalls: [{ id: "t2", name: "web_fetch", input: { url: "https://example.com" } }],
      },
      { index: 4, role: "tool_result", toolUseId: "t2", toolName: "web_fetch", content: "본문" },
      { index: 5, role: "assistant", content: "최종 답변입니다." },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "reasoning",
      "tool_group",
      "reasoning",
      "tool_group",
      "assistant",
    ]);
    expect(entries[1]).toMatchObject({ kind: "reasoning", text: "검색 계획을 세웁니다.", streaming: false });
    expect(entries[2]).toMatchObject({
      kind: "tool_group",
      status: "done",
      tools: [{ toolUseId: "t1", name: "web_search", status: "done", result: "검색 결과" }],
    });
    expect(entries[5]).toMatchObject({ kind: "assistant", text: "최종 답변입니다.", streaming: false });
  });

  it("does not create blank assistant bubbles for structural empty tool-use rounds", () => {
    const entries = historyToEntries([
      { index: 0, role: "user", content: "도구만 먼저 써줘" },
      {
        index: 1,
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "calendar_list", input: {} }],
      },
      { index: 2, role: "tool_result", toolUseId: "t1", toolName: "calendar_list", content: "[]" },
      { index: 3, role: "assistant", content: "일정이 없습니다." },
    ]);

    expect(entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
    expect(entries.at(-1)).toMatchObject({ kind: "assistant", text: "일정이 없습니다." });
  });

  it("does not create blank assistant bubbles for whitespace-only structural rounds", () => {
    const entries = historyToEntries([
      { index: 0, role: "user", content: "도구만 먼저 써줘" },
      {
        index: 1,
        role: "assistant",
        content: "\n  ",
        toolCalls: [{ id: "t1", name: "calendar_list", input: {} }],
      },
      { index: 2, role: "tool_result", toolUseId: "t1", toolName: "calendar_list", content: "[]" },
      { index: 3, role: "assistant", content: "일정이 없습니다." },
    ]);

    expect(entries.filter((entry) => entry.kind === "assistant")).toHaveLength(1);
    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool_group", "assistant"]);
  });

  it("strips persisted assistant meta markers during replay", () => {
    const entries = historyToEntries([
      { index: 0, role: "user", content: "제목 마커 확인" },
      {
        index: 1,
        role: "assistant",
        content: "결과는 **정상**입니다.<title>히스토리 마커 제거</title>[checkpoint]",
      },
    ]);

    expect(entries.at(-1)).toMatchObject({
      kind: "assistant",
      text: "결과는 **정상**입니다.",
    });
  });

  it("shows an explicit empty response when persisted assistant text only contains meta markers", () => {
    const entries = historyToEntries([
      { index: 0, role: "user", content: "제목만 생성" },
      {
        index: 1,
        role: "assistant",
        content: "<title>제목만 생성</title>[checkpoint]",
      },
    ]);

    expect(entries.at(-1)).toMatchObject({
      kind: "assistant",
      text: EMPTY_ASSISTANT_RESPONSE_TEXT,
    });
  });

  it("preserves old consecutive tool_result history as one work group", () => {
    const entries = historyToEntries([
      { index: 0, role: "user", content: "두 도구 결과" },
      { index: 1, role: "tool_result", toolUseId: "t1", toolName: "a", content: "A" },
      { index: 2, role: "tool_result", toolUseId: "t2", toolName: "b", content: "B" },
      { index: 3, role: "assistant", content: "완료" },
    ]);

    const group = entries.find((entry) => entry.kind === "tool_group");
    expect(group).toMatchObject({
      kind: "tool_group",
      tools: [
        { toolUseId: "t1", name: "a", result: "A" },
        { toolUseId: "t2", name: "b", result: "B" },
      ],
    });
  });

  it("replays imported proactive envelopes as imported_trigger cards", () => {
    const entries = historyToEntries([
      {
        index: 0,
        role: "user",
        content: '<imported-from-proactive source="overlay:work-assistant">오늘 일정 브리핑</imported-from-proactive>',
        importedTrigger: {
          sessionId: "trigger-1",
          source: "overlay:work-assistant",
          prompt: '<imported-from-proactive source="overlay:work-assistant">오늘 일정 브리핑</imported-from-proactive>',
          summary: "오늘 일정 브리핑",
          toolCallCount: 0,
          importedAt: "2026-05-20T00:00:00.000Z",
        },
      },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "imported_trigger",
      sessionId: "trigger-1",
      source: "overlay:work-assistant",
      summary: "오늘 일정 브리핑",
    });
  });

  it("migrates full legacy proactive envelopes into imported_trigger cards", () => {
    const entries = historyToEntries([
      {
        index: 0,
        role: "user",
        content: '<imported-from-proactive source="overlay:daily-briefing">\n오늘 데일리 브리핑\n</imported-from-proactive>',
        createdAt: 1_700_000_000_000,
      },
    ]);

    expect(entries[0]).toMatchObject({
      kind: "imported_trigger",
      sessionId: "history-imported-0",
      source: "overlay:daily-briefing",
      summary: "오늘 데일리 브리핑",
      importedAt: "2023-11-14T22:13:20.000Z",
    });
  });

  it("does not treat partial proactive-looking user text as imported trigger provenance", () => {
    const entries = historyToEntries([
      {
        index: 0,
        role: "user",
        content: '<imported-from-proactive source="overlay:daily-briefing">사용자가 직접 입력한 텍스트',
      },
    ]);

    expect(entries[0]).toMatchObject({
      kind: "user",
      text: '<imported-from-proactive source="overlay:daily-briefing">사용자가 직접 입력한 텍스트',
    });
  });

  it("uses persisted displayText for skill-routed user messages", () => {
    const entries = historyToEntries([
      {
        index: 0,
        role: "user",
        content: "[스킬: msgraph_email_list] 지금 메일 읽어줘",
        displayText: "지금 메일 읽어줘",
        routeSkill: { skillId: "msgraph_email_list" },
      },
    ]);

    expect(entries[0]).toMatchObject({ kind: "user", text: "지금 메일 읽어줘" });
  });

  it("migrates legacy skill prefixes out of visible user bubbles", () => {
    const entries = historyToEntries([
      {
        index: 0,
        role: "user",
        content: "[스킬: msgraph_email_list] 지금 메일 읽어줘",
      },
    ]);

    expect(entries[0]).toMatchObject({ kind: "user", text: "지금 메일 읽어줘" });
  });

  it("replays inert tool result display metadata onto tool rows", () => {
    const entries = historyToEntries([
      {
        index: 0,
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "read_tool_result_chunk", input: { toolUseId: "long-1" } }],
      },
      {
        index: 1,
        role: "tool_result",
        toolUseId: "t1",
        toolName: "read_tool_result_chunk",
        content: "chunk",
        toolDisplay: {
          durationMs: 456,
          uiPayload: {
            serverId: "srv",
            resourceUri: "ui://result",
          },
        } as never,
      },
    ]);

    const group = entries.find((entry) => entry.kind === "tool_group");
    expect(group).toMatchObject({
      kind: "tool_group",
      tools: [
        {
          toolUseId: "t1",
          name: "read_tool_result_chunk",
          durationMs: 456,
        },
      ],
    });
    expect(group?.kind === "tool_group" ? group.tools[0] : undefined).not.toHaveProperty("uiPayload");
  });

  it("replays ask_user_question answers as a visible answer recap bubble", () => {
    const entries = historyToEntries([
      { index: 0, role: "user", content: "뉴스 정리해줘" },
      {
        index: 1,
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "ask-1",
            name: "ask_user_question",
            input: {
              questions: [
                {
                  question: "헤드라인 범위는요?",
                  summaryHint: "범위",
                  choices: ["국내", "국제", "IT/경제"],
                },
              ],
            },
          },
        ],
      },
      {
        index: 2,
        role: "tool_result",
        toolUseId: "ask-1",
        toolName: "ask_user_question",
        content: JSON.stringify({ answers: [{ choice: "IT/경제" }] }),
      },
      { index: 3, role: "assistant", content: "IT/경제 기준으로 정리하겠습니다." },
    ]);

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool_group", "ask_user_answer", "assistant"]);
    expect(entries[2]).toMatchObject({
      kind: "ask_user_answer",
      sourceToolUseId: "ask-1",
      rows: [{ label: "범위", value: "IT/경제" }],
    });
  });

  describe("createdAt propagation", () => {
    it("propagates createdAt from SerializedHistoryMessage to assistant ChatEntry", () => {
      const ts = 1_700_000_000_000;
      const entries = historyToEntries([
        { index: 0, role: "user", content: "q", createdAt: ts },
        { index: 1, role: "assistant", content: "a", createdAt: ts + 500 },
      ]);
      const user = entries.find((e) => e.kind === "user");
      const assistant = entries.find((e) => e.kind === "assistant");
      expect(user?.kind === "user" ? user.createdAt : undefined).toBe(ts);
      expect(assistant?.kind === "assistant" ? assistant.createdAt : undefined).toBe(ts + 500);
    });

    it("leaves createdAt undefined for legacy messages without it", () => {
      const entries = historyToEntries([
        { index: 0, role: "user", content: "old q" },
        { index: 1, role: "assistant", content: "old a" },
      ]);
      const assistant = entries.find((e) => e.kind === "assistant");
      expect(assistant?.kind === "assistant" ? assistant.createdAt : undefined).toBeUndefined();
    });
  });

  describe("turnSummary reconstruction", () => {
    it("emits a turn_summary ChatEntry after assistant when meta.turnSummary present", () => {
      const entries = historyToEntries([
        { index: 0, role: "user", content: "q" },
        {
          index: 1,
          role: "assistant",
          content: "a",
          createdAt: 1_700_000_000_000,
          turnSummary: {
            turnDurationMs: 3500,
            toolCount: 1,
            cumulativeToolMs: 800,
            tokensIn: 1200,
            freshInputTokens: 1000,
            tokensOut: 250,
            cacheReadTokens: 200,
          },
        },
      ]);
      const summary = entries.find((e) => e.kind === "turn_summary");
      expect(summary).toBeDefined();
      if (summary?.kind === "turn_summary") {
        expect(summary.turnDurationMs).toBe(3500);
        expect(summary.tokensOut).toBe(250);
        expect(summary.cacheReadTokens).toBe(200);
      }
    });

    it("does NOT emit a turn_summary entry when meta.turnSummary is absent (legacy)", () => {
      const entries = historyToEntries([
        { index: 0, role: "user", content: "q" },
        { index: 1, role: "assistant", content: "a" },
      ]);
      expect(entries.find((e) => e.kind === "turn_summary")).toBeUndefined();
    });
  });

  describe("checkpointMeta reconstruction", () => {
    it("emits a checkpoint ChatEntry when the user message carries meta.checkpointMeta", () => {
      const entries = historyToEntries([
        { index: 0, role: "user", content: "[compact stub]" },
        {
          index: 1,
          role: "user",
          content: "[Boundary marker]",
          checkpointMeta: {
            removedMessages: 5,
            freedTokens: 1200,
            trigger: "auto-compact",
            summary: "summarized 5 messages",
          },
        },
      ]);
      const checkpoint = entries.find((e) => e.kind === "checkpoint");
      expect(checkpoint).toBeDefined();
      if (checkpoint?.kind === "checkpoint") {
        expect(checkpoint.removedMessages).toBe(5);
        expect(checkpoint.freedTokens).toBe(1200);
        expect(checkpoint.trigger).toBe("auto-compact");
        expect(checkpoint.summary).toBe("summarized 5 messages");
      }
    });

    it("renders a normal user bubble when checkpointMeta is absent (legacy boundary)", () => {
      const entries = historyToEntries([
        { index: 0, role: "user", content: "old boundary stub" },
      ]);
      expect(entries[0]?.kind).toBe("user");
      expect(entries.find((e) => e.kind === "checkpoint")).toBeUndefined();
    });
  });
});

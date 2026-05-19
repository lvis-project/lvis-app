import { describe, expect, it } from "vitest";

import {
  appendImportedTriggerEntry,
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  dropPermissionReviewEntries,
  finalizeStreamingReasoning,
  finalizeStreamingAssistant,
  setAssistantError,
  upsertPermissionReview,
  upsertStreamingReasoning,
  upsertStreamingAssistant,
  type ChatEntry,
} from "../chat-stream-state.js";

describe("chat-stream-state", () => {
  it("merges adjacent tool rounds into a single visual bundle when no assistant output is between them", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문");

    entries = applyToolStart(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      name: "web_fetch",
      displayOrder: 0,
      input: { url: "https://example.com/a" },
    });
    entries = applyToolEnd(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      result: "ok",
      isError: false,
    });
    entries = applyToolStart(entries, {
      groupId: "round-2",
      toolUseId: "tool-2",
      name: "web_fetch",
      displayOrder: 0,
      input: { url: "https://example.com/b" },
    });

    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      kind: "tool_group",
      groupId: "round-1",
      groupIds: ["round-1", "round-2"],
      status: "running",
    });
    if (entries[1]?.kind !== "tool_group") {
      throw new Error("expected tool_group");
    }
    expect(entries[1].tools.map((tool) => tool.toolUseId)).toEqual(["tool-1", "tool-2"]);
  });

  it("keeps a streaming reasoning step visible before the running tool bundle", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문");
    entries = upsertStreamingReasoning(entries, "먼저 구조를 확인합니다.");
    entries = applyToolStart(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      name: "web_fetch",
      displayOrder: 0,
      input: { url: "https://example.com" },
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "reasoning", "tool_group"]);
    expect(entries[1]).toMatchObject({
      kind: "reasoning",
      text: "먼저 구조를 확인합니다.",
      streaming: true,
    });
  });

  it("upserts permission review status and drops it when the matching tool starts", () => {
    let entries: ChatEntry[] = appendUserEntry([], "규정 찾아줘");
    entries = upsertPermissionReview(entries, {
      status: "reviewing",
      toolName: "internal_kb_query",
      toolCategory: "network",
      source: "plugin",
      groupId: "round-review",
      toolUseId: "tool-review",
      displayOrder: 0,
    });
    entries = upsertPermissionReview(entries, {
      status: "needs_approval",
      toolName: "internal_kb_query",
      toolCategory: "network",
      source: "plugin",
      groupId: "round-review",
      toolUseId: "tool-review",
      displayOrder: 0,
      verdictLevel: "high",
      reason: "external send",
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "permission_review"]);
    expect(entries[1]).toMatchObject({
      kind: "permission_review",
      status: "needs_approval",
      verdictLevel: "high",
    });

    entries = applyToolStart(
      dropPermissionReviewEntries(entries, { groupId: "round-review", toolUseId: "tool-review" }),
      {
        groupId: "round-review",
        toolUseId: "tool-review",
        name: "internal_kb_query",
        displayOrder: 0,
      },
    );

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool_group"]);
  });

  it("drops only the matching permission review when sibling tools share a group", () => {
    let entries: ChatEntry[] = appendUserEntry([], "여러 도구");
    entries = upsertPermissionReview(entries, {
      status: "reviewing",
      toolName: "first_tool",
      groupId: "shared-group",
      toolUseId: "tool-a",
    });
    entries = upsertPermissionReview(entries, {
      status: "reviewing",
      toolName: "second_tool",
      groupId: "shared-group",
      toolUseId: "tool-b",
    });

    entries = dropPermissionReviewEntries(entries, {
      groupId: "shared-group",
      toolUseId: "tool-a",
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "permission_review"]);
    expect(entries[1]).toMatchObject({
      kind: "permission_review",
      toolUseId: "tool-b",
      toolName: "second_tool",
    });
  });

  it("finalizes reasoning and assistant as separate timeline entries", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문");
    entries = upsertStreamingReasoning(entries, "구조를 먼저 분석합니다.");
    entries = upsertStreamingAssistant(entries, "분석 방향을 설명하겠습니다.");

    entries = finalizeStreamingReasoning(entries, "구조를 먼저 분석합니다.");
    entries = finalizeStreamingAssistant(entries, "분석 방향을 설명하겠습니다.");

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "reasoning", "assistant"]);
    expect(entries[1]).toMatchObject({
      kind: "reasoning",
      text: "구조를 먼저 분석합니다.",
      streaming: false,
    });
    expect(entries[2]).toMatchObject({
      kind: "assistant",
      text: "분석 방향을 설명하겠습니다.",
      streaming: false,
    });
  });

  it("can replace streaming assistant text with cleaned final text", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문");
    entries = upsertStreamingAssistant(entries, "<title>숨김</title>\n최종 **응답**");

    entries = finalizeStreamingAssistant(entries, "최종 **응답**", {
      overrideText: "최종 **응답**",
      phase: "final",
    });

    expect(entries[1]).toMatchObject({
      kind: "assistant",
      text: "최종 **응답**",
      streaming: false,
      phase: "final",
    });
  });

  it("does not treat an undefined overrideText property as an explicit empty override", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문");
    entries = upsertStreamingAssistant(entries, "스트리밍 응답");

    entries = finalizeStreamingAssistant(entries, "fallback", {
      overrideText: undefined,
      phase: "final",
    } as unknown as Parameters<typeof finalizeStreamingAssistant>[2]);

    expect(entries[1]).toMatchObject({
      kind: "assistant",
      text: "스트리밍 응답",
      streaming: false,
      phase: "final",
    });
  });

  it("keeps step reasoning stacked between tool bundles", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문");

    entries = upsertStreamingReasoning(entries, "관련 파일부터 찾겠습니다.");
    entries = finalizeStreamingReasoning(entries, "관련 파일부터 찾겠습니다.");
    entries = applyToolStart(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      name: "glob",
      displayOrder: 0,
      input: { pattern: "src/**/*.ts" },
    });
    entries = applyToolEnd(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      result: "src/renderer.tsx",
      isError: false,
    });
    entries = upsertStreamingReasoning(entries, "렌더러 흐름을 정리하겠습니다.");
    entries = finalizeStreamingReasoning(entries, "렌더러 흐름을 정리하겠습니다.");
    entries = applyToolStart(entries, {
      groupId: "round-2",
      toolUseId: "tool-2",
      name: "view",
      displayOrder: 0,
      input: { path: "src/renderer.tsx", view_range: [1, 120] },
    });
    entries = applyToolEnd(entries, {
      groupId: "round-2",
      toolUseId: "tool-2",
      result: "ok",
      isError: false,
    });
    entries = upsertStreamingReasoning(entries, "도구 결과를 반영해 다음 응답을 준비합니다.");
    entries = upsertStreamingAssistant(entries, "이제 반영 방향을 설명하겠습니다.");
    entries = finalizeStreamingReasoning(entries, "도구 결과를 반영해 다음 응답을 준비합니다.");
    entries = finalizeStreamingAssistant(entries, "이제 반영 방향을 설명하겠습니다.");

    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "reasoning",
      "tool_group",
      "reasoning",
      "tool_group",
      "reasoning",
      "assistant",
    ]);
    expect(entries[1]).toMatchObject({
      kind: "reasoning",
      text: "관련 파일부터 찾겠습니다.",
      streaming: false,
    });
    expect(entries[3]).toMatchObject({
      kind: "reasoning",
      text: "렌더러 흐름을 정리하겠습니다.",
      streaming: false,
    });
    expect(entries[5]).toMatchObject({
      kind: "reasoning",
      text: "도구 결과를 반영해 다음 응답을 준비합니다.",
      streaming: false,
    });
    expect(entries[6]).toMatchObject({
      kind: "assistant",
      text: "이제 반영 방향을 설명하겠습니다.",
      streaming: false,
    });
  });

  it("adds a user answer recap bubble when ask_user_question resolves", () => {
    let entries: ChatEntry[] = appendUserEntry([], "뉴스 헤드라인 정리해줄래?");
    entries = applyToolStart(entries, {
      groupId: "round-ask",
      toolUseId: "ask-1",
      name: "ask_user_question",
      displayOrder: 0,
      input: {
        questions: [
          {
            question: "헤드라인 범위는요?",
            summaryHint: "범위",
            choices: ["국내", "국제", "IT/경제"],
          },
          {
            question: "몇 개로 정리할까요?",
            summaryHint: "개수",
          },
        ],
      },
    });
    entries = applyToolEnd(entries, {
      groupId: "round-ask",
      toolUseId: "ask-1",
      result: JSON.stringify({
        answers: [{ choice: "IT/경제" }, { freeText: "10개" }],
        dismissed: false,
      }),
      isError: false,
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool_group", "ask_user_answer"]);
    expect(entries[2]).toMatchObject({
      kind: "ask_user_answer",
      sourceToolUseId: "ask-1",
      rows: [
        { label: "범위", value: "IT/경제" },
        { label: "개수", value: "10개" },
      ],
    });
  });

  it("adds a dismissed recap when ask_user_question is skipped", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문 필요");
    entries = applyToolStart(entries, {
      groupId: "round-ask",
      toolUseId: "ask-1",
      name: "ask_user_question",
      displayOrder: 0,
      input: { questions: [{ question: "계속할까요?" }] },
    });
    entries = applyToolEnd(entries, {
      groupId: "round-ask",
      toolUseId: "ask-1",
      result: JSON.stringify({ dismissed: true }),
      isError: false,
    });

    expect(entries[2]).toMatchObject({
      kind: "ask_user_answer",
      sourceToolUseId: "ask-1",
      dismissed: true,
      rows: [],
    });
  });

  it("preserves durationMs on the completed tool entry", () => {
    let entries: ChatEntry[] = appendUserEntry([], "타이밍");
    entries = applyToolStart(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      name: "web_fetch",
      displayOrder: 0,
      input: { url: "https://example.com" },
    });
    entries = applyToolEnd(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      result: "ok",
      isError: false,
      durationMs: 1400,
    });

    const group = entries.find((e) => e.kind === "tool_group");
    if (group?.kind !== "tool_group") throw new Error("expected tool_group");
    expect(group.tools[0]?.durationMs).toBe(1400);
  });

  it("omits durationMs when the payload doesn't carry one (legacy)", () => {
    let entries: ChatEntry[] = appendUserEntry([], "legacy");
    entries = applyToolStart(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      name: "web_fetch",
      displayOrder: 0,
    });
    entries = applyToolEnd(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      result: "ok",
      isError: false,
    });

    const group = entries.find((e) => e.kind === "tool_group");
    if (group?.kind !== "tool_group") throw new Error("expected tool_group");
    expect(group.tools[0]?.durationMs).toBeUndefined();
  });

  it("preserves assistant entry with empty text on tool-only turn (no placeholder)", () => {
    // Tool-only turn: assistant streamed marker-only text (stripped to "") but
    // a tool_group sibling exists.  finalizeStreamingAssistant must keep the
    // entry with text "" rather than splicing it out — and must NOT inject the
    // user-visible placeholder.
    let entries: ChatEntry[] = appendUserEntry([], "작업 실행");
    // Simulate a marker-only delta that was accumulated during streaming
    entries = upsertStreamingAssistant(entries, "<title>임시</title>");
    entries = applyToolStart(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      name: "bash",
      displayOrder: 0,
      input: { command: "ls" },
    });
    entries = applyToolEnd(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      result: "file.ts",
      isError: false,
    });
    // overrideText "" simulates detectFromStream stripping markers to empty
    entries = finalizeStreamingAssistant(entries, "", { phase: "work", overrideText: "" });

    const assistantEntry = entries.find((e) => e.kind === "assistant");
    expect(assistantEntry).toBeDefined();
    expect(assistantEntry).toMatchObject({ kind: "assistant", text: "", streaming: false });
    // Must NOT contain EMPTY_ASSISTANT_RESPONSE_TEXT placeholder
    expect((assistantEntry as Extract<ChatEntry, { kind: "assistant" }>).text).toBe("");
  });

  it("splices assistant entry on truly empty turn with no tool_group or checkpoint siblings", () => {
    // Assistant had a streaming entry (marker-only delta) but no tool siblings.
    // finalizeStreamingAssistant should splice it out entirely.
    let entries: ChatEntry[] = appendUserEntry([], "질문");
    entries = upsertStreamingAssistant(entries, "<title>임시</title>");
    entries = finalizeStreamingAssistant(entries, "", { overrideText: "" });

    expect(entries.find((e) => e.kind === "assistant")).toBeUndefined();
    expect(entries.map((e) => e.kind)).toEqual(["user"]);
  });
});

describe("imported_trigger helpers (overlay import marker lifecycle)", () => {
  const trigger = {
    sessionId: "s1",
    source: "overlay:meeting-detection",
    prompt: "p",
    summary: "s",
    toolCallCount: 0,
    importedAt: "2026-04-26T00:00:00.000Z",
  };

  it("appendImportedTriggerEntry inserts an input provenance marker only", () => {
    const next = appendImportedTriggerEntry([], trigger);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      kind: "imported_trigger",
      sessionId: "s1",
      prompt: "p",
      summary: "s",
    });
    expect(Object.keys(next[0]).sort()).toEqual([
      "importedAt",
      "kind",
      "prompt",
      "sessionId",
      "source",
      "summary",
      "toolCallCount",
    ]);
  });

  it("appendImportedTriggerEntry is idempotent on duplicate sessionId", () => {
    const first = appendImportedTriggerEntry([], trigger);
    const second = appendImportedTriggerEntry(first, trigger);
    expect(second).toHaveLength(1);
    expect(second).toBe(first); // identity preserved
  });

  it("keeps assistant output in the normal chat flow after an imported trigger", () => {
    let entries = appendImportedTriggerEntry([], trigger);
    entries = upsertStreamingAssistant(entries, "assistant reply");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ kind: "imported_trigger", sessionId: "s1" });
    expect(entries[1]).toMatchObject({
      kind: "assistant",
      text: "assistant reply",
      streaming: true,
    });
  });

  it("does not preserve an empty imported-trigger assistant because of prior turn siblings", () => {
    let entries: ChatEntry[] = appendUserEntry([], "이전 질문");
    entries = applyToolStart(entries, {
      groupId: "prior-round",
      toolUseId: "prior-tool",
      name: "calendar_list",
      displayOrder: 0,
    });
    entries = applyToolEnd(entries, {
      groupId: "prior-round",
      toolUseId: "prior-tool",
      result: "ok",
      isError: false,
    });
    entries = upsertStreamingAssistant(entries, "이전 답변");
    entries = finalizeStreamingAssistant(entries, "이전 답변", { phase: "final" });
    entries = [
      ...entries,
      {
        kind: "turn_summary",
        turnDurationMs: 1000,
        toolCount: 1,
        cumulativeToolMs: 100,
        tokensIn: 100,
        freshInputTokens: 10,
        tokensOut: 1,
      },
    ];

    entries = appendImportedTriggerEntry(entries, trigger);
    entries = upsertStreamingAssistant(entries, "생각 중...");
    entries = finalizeStreamingAssistant(entries, "", { phase: "final", overrideText: "" });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "tool_group",
      "assistant",
      "turn_summary",
      "imported_trigger",
    ]);
    expect(entries[entries.length - 1]).toMatchObject({ kind: "imported_trigger", sessionId: "s1" });
  });
});

describe("setAssistantError — Issue #911 systemNotice option", () => {
  it("stamps systemNotice on the streaming-assistant replacement", () => {
    const initial: ChatEntry[] = [
      { kind: "user", text: "hi" },
      { kind: "assistant", text: "partial...", streaming: true },
    ];
    const out = setAssistantError(initial, "대화 이력이 모델 한도를 초과했습니다.", "", "context-error");
    const last = out[out.length - 1] as Extract<ChatEntry, { kind: "assistant" }>;
    expect(last.systemNotice).toBe("context-error");
    expect(last.streaming).toBe(false);
  });

  it("stamps systemNotice on the pushed entry when no streaming assistant exists", () => {
    const out = setAssistantError(
      [{ kind: "user", text: "hi" }],
      "응답 스트림이 끊겼습니다.",
      "",
      "stream-error",
    );
    const last = out[out.length - 1] as Extract<ChatEntry, { kind: "assistant" }>;
    expect(last.systemNotice).toBe("stream-error");
  });

  it("omits systemNotice when option not passed (backward compat)", () => {
    const out = setAssistantError([{ kind: "user", text: "hi" }], "일반 오류");
    const last = out[out.length - 1] as Extract<ChatEntry, { kind: "assistant" }>;
    expect(last.systemNotice).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import {
  appendDeltaToImportedTriggerResponse,
  appendImportedTriggerEntry,
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  finalizeImportedTriggerResponse,
  finalizeStreamingReasoning,
  finalizeStreamingAssistant,
  isImportedTriggerStreaming,
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

describe("imported_trigger helpers (brain-import card lifecycle)", () => {
  const trigger = {
    sessionId: "s1",
    source: "proactive:meeting-detection",
    prompt: "p",
    summary: "s",
    toolCallCount: 0,
    importedAt: "2026-04-26T00:00:00.000Z",
  };

  it("appendImportedTriggerEntry inserts a streaming card", () => {
    const next = appendImportedTriggerEntry([], trigger);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({
      kind: "imported_trigger",
      sessionId: "s1",
      response: "",
      responseStreaming: true,
    });
  });

  it("appendImportedTriggerEntry is idempotent on duplicate sessionId", () => {
    const first = appendImportedTriggerEntry([], trigger);
    const second = appendImportedTriggerEntry(first, trigger);
    expect(second).toHaveLength(1);
    expect(second).toBe(first); // identity preserved
  });

  it("appendDeltaToImportedTriggerResponse appends to the open card's response", () => {
    let entries = appendImportedTriggerEntry([], trigger);
    entries = appendDeltaToImportedTriggerResponse(entries, "hello ");
    entries = appendDeltaToImportedTriggerResponse(entries, "world");
    const card = entries[0] as Extract<ChatEntry, { kind: "imported_trigger" }>;
    expect(card.response).toBe("hello world");
    expect(card.responseStreaming).toBe(true);
  });

  it("appendDeltaToImportedTriggerResponse is a no-op when no card is open", () => {
    const before: ChatEntry[] = [{ kind: "user", text: "hi" }];
    const after = appendDeltaToImportedTriggerResponse(before, "x");
    expect(after).toBe(before);
  });

  it("finds the streaming card even when later entries (tool_group) follow", () => {
    let entries = appendImportedTriggerEntry([], trigger);
    entries = applyToolStart(entries, {
      groupId: "g1",
      toolUseId: "t1",
      displayOrder: 0,
      name: "email_read",
      input: {},
    });
    entries = appendDeltaToImportedTriggerResponse(entries, "after-tool");
    const card = entries.find(
      (e): e is Extract<ChatEntry, { kind: "imported_trigger" }> =>
        e.kind === "imported_trigger",
    );
    expect(card?.response).toBe("after-tool");
  });

  it("finalizeImportedTriggerResponse flips responseStreaming to false", () => {
    let entries = appendImportedTriggerEntry([], trigger);
    entries = appendDeltaToImportedTriggerResponse(entries, "done");
    expect(isImportedTriggerStreaming(entries)).toBe(true);
    entries = finalizeImportedTriggerResponse(entries);
    expect(isImportedTriggerStreaming(entries)).toBe(false);
    const card = entries[0] as Extract<ChatEntry, { kind: "imported_trigger" }>;
    expect(card.responseStreaming).toBe(false);
    expect(card.response).toBe("done");
  });

  it("appendDeltaToImportedTriggerResponse is a no-op after finalize", () => {
    let entries = appendImportedTriggerEntry([], trigger);
    entries = appendDeltaToImportedTriggerResponse(entries, "first");
    entries = finalizeImportedTriggerResponse(entries);
    const before = entries;
    const after = appendDeltaToImportedTriggerResponse(entries, "leaked");
    expect(after).toBe(before);
    const card = after[0] as Extract<ChatEntry, { kind: "imported_trigger" }>;
    expect(card.response).toBe("first");
  });
});

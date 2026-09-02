import { describe, expect, it, vi } from "vitest";

import { t } from "../../i18n/index.js";
import {
  appendImportedTriggerEntry,
  appendUserEntry,
  applyReasoningDelta,
  applyTranscriptFrame,
  applyUserMessageFrame,
  applyToolEnd,
  applyToolStart,
  dropPendingLlmStatusAssistant,
  isTranscriptFrame,
  parseTurnSummaryEvent,
  clearTurnAssistantInterrupted,
  dropOptimisticUserEntry,
  finalizeStreamingReasoning,
  finalizeStreamingAssistant,
  markTurnAssistantInterrupted,
  setAssistantError,
  upsertPermissionReview,
  upsertStreamingReasoning,
  upsertStreamingAssistant,
  type ChatEntry,
  type ChatStreamEvent,
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

  it("keeps the permission review verdict after the matching tool starts", () => {
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

    entries = applyToolStart(entries, {
      groupId: "round-review",
      toolUseId: "tool-review",
      name: "internal_kb_query",
      displayOrder: 0,
    });
    entries = applyToolEnd(entries, {
      groupId: "round-review",
      toolUseId: "tool-review",
      result: "ok",
      isError: false,
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "permission_review",
      "tool_group",
    ]);
    expect(entries[1]).toMatchObject({
      kind: "permission_review",
      status: "needs_approval",
      toolUseId: "tool-review",
    });
  });

  it("keeps one verdict per tool call when sibling tools share a group", () => {
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
    entries = upsertPermissionReview(entries, {
      status: "auto_approved",
      toolName: "first_tool",
      groupId: "shared-group",
      toolUseId: "tool-a",
    });

    expect(entries.map((entry) => entry.kind)).toEqual([
      "user",
      "permission_review",
      "permission_review",
    ]);
    expect(entries[1]).toMatchObject({
      kind: "permission_review",
      toolUseId: "tool-a",
      status: "auto_approved",
    });
    expect(entries[2]).toMatchObject({
      kind: "permission_review",
      toolUseId: "tool-b",
      status: "reviewing",
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
          {
            question: "관심 분야는요?",
            summaryHint: "분야",
            choices: ["AI", "보안", "UX"],
            allowMultiple: true,
          },
        ],
      },
    });
    entries = applyToolEnd(entries, {
      groupId: "round-ask",
      toolUseId: "ask-1",
      result: JSON.stringify({
        answers: [
          { choice: "IT/경제" },
          { freeText: "10개" },
          { choices: ["AI", "UX"], freeText: "기타 도구" },
        ],
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
        { label: "분야", value: "AI, UX, 기타 도구" },
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

describe("finalizeStreamingAssistant — the turn that owns the entry", () => {
  it("keeps an empty interrupted entry whose tool cards belong to it, even after the next question was appended", () => {
    let entries: ChatEntry[] = appendUserEntry([], "first");
    entries = upsertStreamingAssistant(entries, "x");
    entries = [...entries.slice(0, 1), { ...(entries[1] as Extract<ChatEntry, { kind: "assistant" }>), text: "", interrupted: true }];
    entries = applyToolStart(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      name: "web_fetch",
      displayOrder: 0,
      input: { url: "https://example.com/a" },
    });
    entries = appendUserEntry(entries, "second");

    const closed = finalizeStreamingAssistant(entries, "", { overrideText: "" });

    expect(closed.map((e) => e.kind)).toEqual(["user", "assistant", "tool_group", "user"]);
    expect(closed[1]).toMatchObject({ kind: "assistant", text: "", streaming: false, interrupted: true });
  });

  it("drops an empty entry whose only tool cards belong to the next turn", () => {
    let entries: ChatEntry[] = appendUserEntry([], "first");
    entries = upsertStreamingAssistant(entries, "x");
    entries = [...entries.slice(0, 1), { ...(entries[1] as Extract<ChatEntry, { kind: "assistant" }>), text: "" }];
    entries = appendUserEntry(entries, "second");
    entries = applyToolStart(entries, {
      groupId: "round-2",
      toolUseId: "tool-2",
      name: "web_fetch",
      displayOrder: 0,
      input: { url: "https://example.com/b" },
    });

    const closed = finalizeStreamingAssistant(entries, "", { overrideText: "" });
    expect(closed.map((e) => e.kind)).toEqual(["user", "user", "tool_group"]);
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

  it("live error path never stamps restored — the marker is replay-only (Issue #2113)", () => {
    const out = setAssistantError(
      [{ kind: "user", text: "hi" }],
      "응답 스트림이 끊겼습니다.",
      "",
      "stream-error",
    );
    const last = out[out.length - 1] as Extract<ChatEntry, { kind: "assistant" }>;
    expect(last.restored).toBeUndefined();
  });
});

/**
 * The optimistic user bubble exists so a send feels immediate. When the send is
 * REFUSED, main recorded no turn — so leaving the bubble shows the user a message that
 * exists only in this renderer: absent from the session file, gone on reload, and
 * indistinguishable from one that was actually sent.
 */
describe("markTurnAssistantInterrupted — the turn the abort cut short", () => {
  const answered = (text: string): ChatEntry[] => [
    { kind: "user", text: "q" },
    { kind: "assistant", text, streaming: false },
  ];

  it("marks the last assistant entry whether or not it is still streaming", () => {
    const out = markTurnAssistantInterrupted(answered("done"));
    expect(out[1]).toMatchObject({ interrupted: true, streaming: false });
  });

  it("stops at the current turn's start — a previous answer is never marked", () => {
    const entries: ChatEntry[] = [...answered("earlier"), { kind: "user", text: "next" }];
    expect(markTurnAssistantInterrupted(entries)).toBe(entries);
  });

  it("crosses an injected user line to a still-streaming answer, but not to a finished one", () => {
    const streaming: ChatEntry[] = [
      { kind: "user", text: "q" },
      { kind: "assistant", text: "partial", streaming: true },
      { kind: "user", text: "steer", injectHint: "queue" },
    ];
    expect(markTurnAssistantInterrupted(streaming)[1]).toMatchObject({ interrupted: true });
    const finished: ChatEntry[] = [
      { kind: "user", text: "q" },
      { kind: "assistant", text: "earlier", streaming: false },
      { kind: "user", text: "queued", injectHint: "queue" },
    ];
    expect(markTurnAssistantInterrupted(finished)).toBe(finished);
  });

  it("is a no-op on an already marked entry, and clear restores the unmarked shape", () => {
    const marked = markTurnAssistantInterrupted(answered("done"));
    expect(markTurnAssistantInterrupted(marked)).toBe(marked);
    const cleared = clearTurnAssistantInterrupted(marked);
    expect(cleared[1]).not.toHaveProperty("interrupted");
    expect(clearTurnAssistantInterrupted(cleared)).toBe(cleared);
  });
});

describe("setAssistantError — the interrupted turn keeps what it had", () => {
  it("keeps an empty interrupted answer empty instead of showing the abort as its text", () => {
    const entries = markTurnAssistantInterrupted([
      { kind: "user", text: "q" },
      { kind: "assistant", text: "", streaming: true },
    ]);
    const out = setAssistantError(entries, "aborted", "");
    expect(out[1]).toMatchObject({ kind: "assistant", text: "", interrupted: true, streaming: false });
  });

  it("carries the streaming entry's other fields through the error close", () => {
    const entries = upsertStreamingAssistant([{ kind: "user", text: "q" }], "partial");
    entries[1] = { ...(entries[1] as Extract<ChatEntry, { kind: "assistant" }>), phase: "final", interrupted: true };
    const out = setAssistantError(entries, "aborted", "");
    expect(out[1]).toMatchObject({ text: "partial", phase: "final", interrupted: true, streaming: false });
  });
});

describe("dropOptimisticUserEntry", () => {
  it("removes the bubble the refused send appended", () => {
    const entries: ChatEntry[] = [
      { kind: "user", text: "earlier" },
      { kind: "assistant", text: "reply" },
      { kind: "user", text: "refused turn" },
    ];
    expect(dropOptimisticUserEntry(entries, "refused turn")).toEqual(entries.slice(0, 2));
  });

  it("leaves the transcript alone when the last entry is not that bubble", () => {
    // A stream frame for a PREVIOUS turn can land between the append and the rejection.
    // Dropping whatever is last would delete an assistant's answer instead.
    const withAssistant: ChatEntry[] = [
      { kind: "user", text: "refused turn" },
      { kind: "assistant", text: "still streaming" },
    ];
    expect(dropOptimisticUserEntry(withAssistant, "refused turn")).toEqual(withAssistant);

    // And a different user bubble is somebody else's content, not ours to remove.
    const otherUser: ChatEntry[] = [{ kind: "user", text: "a different message" }];
    expect(dropOptimisticUserEntry(otherUser, "refused turn")).toEqual(otherUser);

    expect(dropOptimisticUserEntry([], "refused turn")).toEqual([]);
  });
});

/**
 * `user_message` normalization — every turn announces its input on the one
 * stream; this single chokepoint decides whether the desktop transcript still
 * needs a row for it. External-surface turns (bridge/Tailnet/loopback) do;
 * origins this surface echoed optimistically at send time must not duplicate.
 */
describe("applyUserMessageFrame", () => {
  it("appends a user row carrying its external origin for a bridge turn", () => {
    const entries: ChatEntry[] = [{ kind: "assistant", text: "earlier reply" }];
    const next = applyUserMessageFrame(entries, {
      text: "텔레그램에서 보낸 메시지",
      origin: "platform-bridge",
    });
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({
      kind: "user",
      text: "텔레그램에서 보낸 메시지",
      origin: "platform-bridge",
    });
  });

  it("appends for every external surface origin", () => {
    for (const origin of ["surface-user", "tailnet-surface", "platform-bridge"]) {
      const next = applyUserMessageFrame([], { text: "remote input", origin });
      expect(next).toHaveLength(1);
    }
  });

  it("adds no second row for origins the desktop already echoed optimistically", () => {
    for (const origin of [
      "user-keyboard",
      "queue-auto",
      "plugin-emitted",
      "app-emitted",
      "mcp-prompt-emitted",
      "agent-message",
      undefined,
    ]) {
      const entries: ChatEntry[] = [{ kind: "user", text: "already echoed" }];
      const next = applyUserMessageFrame(entries, { text: "already echoed", origin });
      expect(next).toHaveLength(1);
    }
  });

  it("binds the host's row identity onto the bubble this surface echoed", () => {
    const entries = appendUserEntry([], "already echoed");
    const next = applyUserMessageFrame(entries, {
      text: "already echoed",
      origin: "user-keyboard",
      messageId: "row-9",
    });
    expect(next[0]).toMatchObject({ kind: "user", messageId: "row-9" });
  });

  it("binds turns in arrival order when two echoes are still waiting", () => {
    const entries = appendUserEntry(appendUserEntry([], "first"), "second");
    const first = applyUserMessageFrame(entries, {
      text: "first", origin: "user-keyboard", messageId: "row-1",
    });
    const second = applyUserMessageFrame(first, {
      text: "second", origin: "user-keyboard", messageId: "row-2",
    });
    expect(second.map((e) => (e.kind === "user" ? e.messageId : null))).toEqual(["row-1", "row-2"]);
  });

  it("leaves the mid-turn bubbles that merely lack an id alone", () => {
    // The control group for binding by marker instead of by inference. A
    // drained guide and a child's report are user bubbles the host announced
    // separately; neither is waiting for this turn's identity, and each sits
    // ahead of the echo in the transcript. Binding to "the first user entry
    // without an id" would hand this turn's row id to one of them, and every
    // action that names a row would then act on the wrong message.
    const entries: ChatEntry[] = appendUserEntry(
      [
        { kind: "user", text: "queued guide", injectHint: "queue" },
        { kind: "user", text: "child report", injectHint: "sub-agent" },
      ],
      "the message just sent",
    );

    const next = applyUserMessageFrame(entries, {
      text: "the message just sent",
      origin: "user-keyboard",
      messageId: "row-of-this-turn",
    });

    expect(next.map((e) => (e.kind === "user" ? e.messageId : null))).toEqual([
      undefined, undefined, "row-of-this-turn",
    ]);
  });

  it("claims nothing in a transcript whose rows were rebuilt from disk", () => {
    // A reloaded session's bubbles carry the ids they were saved with, and a
    // session written before ids existed carries none — but neither is an
    // optimistic echo, so a turn announced from another surface must not
    // rewrite one of them.
    const entries: ChatEntry[] = [
      { kind: "user", text: "a row from a legacy session file" },
    ];

    expect(
      applyUserMessageFrame(entries, {
        text: "a row from a legacy session file",
        origin: "user-keyboard",
        messageId: "row-of-this-turn",
      }),
    ).toBe(entries);
  });

  it("hands the id to one echo only, leaving nothing claimable behind", () => {
    const entries = appendUserEntry([], "sent once");
    const bound = applyUserMessageFrame(entries, {
      text: "sent once", origin: "user-keyboard", messageId: "row-1",
    });
    // A second frame for the same turn (a resubscribe replay) finds no pending
    // echo, so it cannot overwrite the identity already bound.
    const again = applyUserMessageFrame(bound, {
      text: "sent once", origin: "user-keyboard", messageId: "row-2",
    });
    expect(again).toBe(bound);
    expect(again[0]).toMatchObject({ kind: "user", messageId: "row-1" });
  });

  it("leaves an already-identified bubble alone when no id rides the frame", () => {
    const entries: ChatEntry[] = [{ kind: "user", text: "echoed", messageId: "row-3" }];
    expect(applyUserMessageFrame(entries, { text: "echoed", origin: "user-keyboard" })).toBe(entries);
  });

  it("ignores an empty or missing text payload", () => {
    const entries: ChatEntry[] = [];
    expect(applyUserMessageFrame(entries, { origin: "platform-bridge" })).toBe(entries);
    expect(applyUserMessageFrame(entries, { text: "", origin: "platform-bridge" })).toBe(entries);
  });
});

describe("transcript frame reducer (shared by the main and the side chat)", () => {
  const frame = (f: Partial<ChatStreamEvent> & { type: ChatStreamEvent["type"] }): ChatStreamEvent =>
    f as ChatStreamEvent;
  /** The provider-status placeholder the main chat shows while retrying. */
  const pendingStatus = (): ChatEntry => ({
    kind: "assistant",
    text: `${t("useChatState.llmStatusAttemptFirst")} (2/5)`,
    streaming: true,
  });
  const toolStart = frame({ type: "tool_start", groupId: "g1", toolUseId: "t1", name: "web_fetch", displayOrder: 0, input: {} });

  it("names exactly the frames it owns", () => {
    for (const type of ["permission_review", "tool_start", "tool_end", "turn_summary", "compact_notice"] as const) {
      expect(isTranscriptFrame(frame({ type }))).toBe(true);
    }
    for (const type of ["text_delta", "reasoning_delta", "assistant_round", "done", "error", "llm_status"] as const) {
      expect(isTranscriptFrame(frame({ type }))).toBe(false);
    }
  });

  it("drops the pending provider-status placeholder before a tool starts, a verdict lands, or reasoning begins", () => {
    const base: ChatEntry[] = [...appendUserEntry([], "q"), pendingStatus()];
    expect(dropPendingLlmStatusAssistant(base).map((e) => e.kind)).toEqual(["user"]);

    const afterTool = applyTranscriptFrame(base, toolStart);
    expect(afterTool.map((e) => e.kind)).toEqual(["user", "tool_group"]);

    const afterReview = applyTranscriptFrame(base, frame({
      type: "permission_review", reviewStatus: "auto_approved", name: "web_fetch", groupId: "g1", toolUseId: "t1",
    }));
    expect(afterReview.some((e) => e.kind === "assistant")).toBe(false);
    expect(afterReview.some((e) => e.kind === "permission_review")).toBe(true);

    const afterThought = applyReasoningDelta(base, "thinking…");
    expect(afterThought.map((e) => e.kind)).toEqual(["user", "reasoning"]);
  });

  it("keeps a streaming assistant entry that carries real text", () => {
    const base: ChatEntry[] = [...appendUserEntry([], "q"), { kind: "assistant", text: "partial reply", streaming: true }];
    expect(applyTranscriptFrame(base, toolStart).map((e) => e.kind)).toEqual(["user", "assistant", "tool_group"]);
  });

  it("carries a user stop and the duration through tool_end (the side chat used to drop both)", () => {
    let entries = applyTranscriptFrame(appendUserEntry([], "q"), toolStart);
    entries = applyTranscriptFrame(entries, frame({
      type: "tool_end", groupId: "g1", toolUseId: "t1", name: "web_fetch", result: "stopped", isError: false, cancelled: true, durationMs: 12,
    }));
    const group = entries.find((e): e is Extract<ChatEntry, { kind: "tool_group" }> => e.kind === "tool_group");
    expect(group?.tools[0]).toMatchObject({ toolUseId: "t1", status: "cancelled", durationMs: 12 });
  });

  it("leaves the list alone for a frame missing its identifying fields, and for frames it does not own", () => {
    const base = appendUserEntry([], "q");
    expect(applyTranscriptFrame(base, frame({ type: "tool_start", name: "x" }))).toBe(base);
    expect(applyTranscriptFrame(base, frame({ type: "permission_review", name: "x", groupId: "g" }))).toBe(base);
    expect(applyTranscriptFrame(base, frame({ type: "text_delta", text: "hi" }))).toBe(base);
  });

  it("appends a validated turn_summary with cache and breakdown fields and ignores a malformed one", () => {
    const base = appendUserEntry([], "q");
    const totals = { turnDurationMs: 1200, toolCount: 1, cumulativeToolMs: 300, tokensIn: 50, freshInputTokens: 40, tokensOut: 20 };
    const next = applyTranscriptFrame(base, frame({
      type: "turn_summary", ...totals, cacheReadTokens: 7, breakdown: { web_fetch: { count: 1, ms: 300 } }, vendorModel: "m",
    }));
    expect(next[next.length - 1]).toMatchObject({ kind: "turn_summary", ...totals, cacheReadTokens: 7, breakdown: { web_fetch: { count: 1, ms: 300 } }, vendorModel: "m" });
    expect(parseTurnSummaryEvent(frame({ type: "turn_summary", ...totals, tokensOut: -1 }))).toBeNull();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(applyTranscriptFrame(base, frame({ type: "turn_summary", ...totals, tokensOut: Number.NaN }))).toBe(base);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("renders compact_notice as a checkpoint, with a context estimate only when the engine reported a reliable one", () => {
    const base = appendUserEntry([], "q");
    const withEstimate = applyTranscriptFrame(base, frame({ type: "compact_notice", removedMessages: 3, freedTokens: 900, estimatedAfter: 1200, trigger: "manual" }));
    expect(withEstimate.slice(-2)).toEqual([
      { kind: "checkpoint", removedMessages: 3, freedTokens: 900, trigger: "manual" },
      { kind: "context_usage", tokensIn: 1200, source: "compact-estimate" },
    ]);
    const withoutEstimate = applyTranscriptFrame(base, frame({ type: "compact_notice", removedMessages: 3, freedTokens: 900, estimatedAfter: -1 }));
    expect(withoutEstimate.slice(-1)).toEqual([{ kind: "checkpoint", removedMessages: 3, freedTokens: 900 }]);
  });
});

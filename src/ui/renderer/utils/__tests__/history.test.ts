import { describe, expect, it } from "vitest";

import { historyToEntries } from "../history.js";

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
});

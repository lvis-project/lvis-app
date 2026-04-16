import { describe, expect, it } from "vitest";

import {
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  finalizeStreamingReasoning,
  finalizeStreamingAssistant,
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
});

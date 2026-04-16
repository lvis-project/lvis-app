import { describe, expect, it } from "vitest";

import {
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  finalizeStreamingAssistant,
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

  it("places the tool bundle before the streaming assistant entry", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문");
    entries = upsertStreamingAssistant(entries, "초안", "");
    entries = applyToolStart(entries, {
      groupId: "round-1",
      toolUseId: "tool-1",
      name: "web_fetch",
      displayOrder: 0,
      input: { url: "https://example.com" },
    });

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool_group", "assistant"]);
  });

  it("finalizes the assistant after the tool bundle when no streaming placeholder exists", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문");
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
    });

    entries = finalizeStreamingAssistant(entries, "최종 답변", "");

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "tool_group", "assistant"]);
    expect(entries[2]).toMatchObject({
      kind: "assistant",
      text: "최종 답변",
      streaming: false,
    });
  });

  it("keeps assistant ping-pong rounds visible between tool bundles", () => {
    let entries: ChatEntry[] = appendUserEntry([], "질문");

    entries = upsertStreamingAssistant(entries, "먼저 구조를 보겠습니다.", "관련 파일부터 찾겠습니다.");
    entries = finalizeStreamingAssistant(entries, "먼저 구조를 보겠습니다.", "관련 파일부터 찾겠습니다.");
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
    entries = upsertStreamingAssistant(entries, "이제 렌더러 흐름을 정리하겠습니다.", "도구 결과를 반영해 다음 응답을 준비합니다.");
    entries = finalizeStreamingAssistant(entries, "이제 렌더러 흐름을 정리하겠습니다.", "도구 결과를 반영해 다음 응답을 준비합니다.");

    expect(entries.map((entry) => entry.kind)).toEqual(["user", "assistant", "tool_group", "assistant"]);
    expect(entries[1]).toMatchObject({
      kind: "assistant",
      text: "먼저 구조를 보겠습니다.",
      thought: "관련 파일부터 찾겠습니다.",
      streaming: false,
    });
    expect(entries[3]).toMatchObject({
      kind: "assistant",
      text: "이제 렌더러 흐름을 정리하겠습니다.",
      thought: "도구 결과를 반영해 다음 응답을 준비합니다.",
      streaming: false,
    });
  });
});

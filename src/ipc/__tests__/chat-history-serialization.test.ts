import { describe, expect, it } from "vitest";

import { serializeHistoryMessage } from "../../shared/chat-history.js";
import type { GenericMessage } from "../../engine/llm/types.js";

describe("chat history IPC serialization", () => {
  it("passes through persisted assistant/tool structure used by renderer replay", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: [{ type: "text", text: "첨부 확인" }, { type: "image", image: "data:image/png;base64,abc", mimeType: "image/png" }] },
      {
        role: "assistant",
        content: "",
        thought: "도구를 호출합니다.",
        toolCalls: [{ id: "tool-1", name: "calendar_list", input: { range: "today" } }],
      },
      {
        role: "tool_result",
        toolUseId: "tool-1",
        toolName: "calendar_list",
        content: "[]",
        isError: false,
      },
    ];

    expect(messages.map(serializeHistoryMessage)).toEqual([
      { index: 0, role: "user", content: "첨부 확인\n[image:image/png]" },
      {
        index: 1,
        role: "assistant",
        content: "",
        thought: "도구를 호출합니다.",
        toolCalls: [{ id: "tool-1", name: "calendar_list", input: { range: "today" } }],
      },
      {
        index: 2,
        role: "tool_result",
        content: "[]",
        toolUseId: "tool-1",
        toolName: "calendar_list",
        isError: false,
      },
    ]);
  });

  it("keeps absent optional structural fields absent", () => {
    expect(serializeHistoryMessage({ role: "assistant", content: "완료" }, 7)).toEqual({
      index: 7,
      role: "assistant",
      content: "완료",
    });
  });
});

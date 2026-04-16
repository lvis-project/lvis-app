import { describe, expect, it } from "vitest";
import { restoreChatEntries } from "../chat-history-state.js";
import type { GenericMessage } from "../../engine/llm/types.js";

describe("restoreChatEntries", () => {
  it("restores user and assistant messages", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "world" },
    ];

    expect(restoreChatEntries(messages)).toEqual([
      { kind: "user", text: "hello" },
      { kind: "assistant", text: "world" },
    ]);
  });

  it("restores tool groups from assistant tool calls and tool results", () => {
    const messages: GenericMessage[] = [
      { role: "user", content: "latest meeting summary" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "tool-1", name: "meeting_sessions", input: {} },
          { id: "tool-2", name: "meeting_transcript", input: { payload: { sessionId: "abc" } } },
        ],
      },
      { role: "tool_result", toolUseId: "tool-1", toolName: "meeting_sessions", content: "sessions" },
      { role: "tool_result", toolUseId: "tool-2", toolName: "meeting_transcript", content: "transcript" },
      { role: "assistant", content: "summary done" },
    ];

    expect(restoreChatEntries(messages)).toEqual([
      { kind: "user", text: "latest meeting summary" },
      {
        kind: "tool_group",
        groupId: "tool-1",
        groupIds: ["tool-1", "tool-2"],
        status: "done",
        tools: [
          {
            toolUseId: "tool-1",
            name: "meeting_sessions",
            displayOrder: 0,
            status: "done",
            input: {},
            result: "sessions",
          },
          {
            toolUseId: "tool-2",
            name: "meeting_transcript",
            displayOrder: 1,
            status: "done",
            input: { payload: { sessionId: "abc" } },
            result: "transcript",
          },
        ],
      },
      { kind: "assistant", text: "summary done" },
    ]);
  });
});

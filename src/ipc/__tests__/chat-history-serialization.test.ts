import { afterEach, describe, expect, it } from "vitest";

import { serializeHistoryMessage } from "../../shared/chat-history.js";
import { initPiiRedactionPolicy } from "../../shared/dlp.js";
import type { GenericMessage } from "../../engine/llm/types.js";

// The renderer history payload is one of the surfaces `privacy.piiRedactEnabled`
// governs, so every case here has to say which side of the toggle it is on.
// Restore the shipped default afterwards: the policy is process-wide.
afterEach(() => initPiiRedactionPolicy(() => false));

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

  it("masks sensitive tool_result content for renderer history replay without mutating history", () => {
    initPiiRedactionPolicy(() => true);
    const message: GenericMessage = {
      role: "tool_result",
      toolUseId: "tool-email",
      toolName: "ask_user_question",
      content: JSON.stringify({ recipient: "real.user@gmail.com" }),
      isError: false,
    };

    expect(serializeHistoryMessage(message, 3)).toEqual({
      index: 3,
      role: "tool_result",
      content: JSON.stringify({ recipient: "***@gmail.com" }),
      toolUseId: "tool-email",
      toolName: "ask_user_question",
      isError: false,
    });
    if (message.role === "tool_result") {
      expect(message.content).toContain("real.user@gmail.com");
    }
  });

  it("leaves PII in tool_result content when PII redaction is off, and still scrubs a credential", () => {
    initPiiRedactionPolicy(() => false);
    const message: GenericMessage = {
      role: "tool_result",
      toolUseId: "tool-email",
      toolName: "ask_user_question",
      content: JSON.stringify({
        recipient: "real.user@gmail.com",
        phone: "010-1234-5678",
        authorization: "Bearer abcdef0123456789",
      }),
      isError: false,
    };

    const serialized = serializeHistoryMessage(message, 3);
    expect(serialized.content).toContain("real.user@gmail.com");
    expect(serialized.content).toContain("010-1234-5678");
    // Credential scrubbing is a security control, not a privacy preference.
    expect(serialized.content).not.toContain("abcdef0123456789");
    expect(serialized.content).toContain("[REDACTED:TOKEN]");
  });
});

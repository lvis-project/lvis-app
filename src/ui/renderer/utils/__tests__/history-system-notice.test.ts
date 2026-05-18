/**
 * Issue #911 — systemNotice marker flows from persisted history through
 * historyToEntries onto the ChatEntry assistant kind so AssistantCard
 * can render destructive styling on session reload.
 */
import { describe, expect, it } from "vitest";
import { historyToEntries, type PersistedHistoryMessage } from "../history.js";

describe("historyToEntries — systemNotice marker (Issue #911)", () => {
  it("passes context-error marker onto assistant ChatEntry", () => {
    const messages: PersistedHistoryMessage[] = [
      { index: 0, role: "user", content: "hi" },
      {
        index: 1,
        role: "assistant",
        content: "대화 이력이 모델 한도를 초과했습니다. 새 메시지를 보내면 자동 압축이 다시 시도됩니다.",
        systemNotice: "context-error",
      },
    ];
    const entries = historyToEntries(messages);
    const assistant = entries.find((e) => e.kind === "assistant") as Extract<
      ReturnType<typeof historyToEntries>[number],
      { kind: "assistant" }
    >;
    expect(assistant.systemNotice).toBe("context-error");
  });

  it("passes stream-error marker onto assistant ChatEntry", () => {
    const messages: PersistedHistoryMessage[] = [
      { index: 0, role: "user", content: "go" },
      {
        index: 1,
        role: "assistant",
        content: "응답 스트림이 끊겼습니다.",
        systemNotice: "stream-error",
      },
    ];
    const entries = historyToEntries(messages);
    const assistant = entries.find((e) => e.kind === "assistant") as Extract<
      ReturnType<typeof historyToEntries>[number],
      { kind: "assistant" }
    >;
    expect(assistant.systemNotice).toBe("stream-error");
  });

  it("omits systemNotice when the persisted assistant message has no marker", () => {
    const messages: PersistedHistoryMessage[] = [
      { index: 0, role: "user", content: "hi" },
      { index: 1, role: "assistant", content: "ordinary reply" },
    ];
    const entries = historyToEntries(messages);
    const assistant = entries.find((e) => e.kind === "assistant") as Extract<
      ReturnType<typeof historyToEntries>[number],
      { kind: "assistant" }
    >;
    expect(assistant.systemNotice).toBeUndefined();
  });

  it("interrupted is *not* a systemNotice — user-initiated, styled normally", () => {
    const messages: PersistedHistoryMessage[] = [
      { index: 0, role: "user", content: "hi" },
      {
        index: 1,
        role: "assistant",
        content: "partial output\n\n[중단됨]",
        systemNotice: "interrupted",
      },
    ];
    const entries = historyToEntries(messages);
    const assistant = entries.find((e) => e.kind === "assistant") as Extract<
      ReturnType<typeof historyToEntries>[number],
      { kind: "assistant" }
    >;
    // historyToEntries strips "interrupted" before passing — it's not a
    // host error and should render with normal assistant styling.
    expect(assistant.systemNotice).toBeUndefined();
  });
});

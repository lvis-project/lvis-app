/**
 * A user stop must not render as a tool failure — live or after a reload.
 *
 * Stopping a turn mid-tool-call recorded the in-flight call with
 * `is_error: true`. The engine knew better (`interruptionReason === "user-abort"`)
 * but had no carrier to say so, so the deliberate halt reached the renderer as
 * an ordinary failure: a destructive "Failed" badge, and — because the group
 * rolls up with `some(t => t.status === "error")` — the whole multi-tool group
 * flipped to error styling too.
 *
 * The assistant-text path already draws this distinction (`interrupted` vs
 * `systemNotice`, see history-interrupted.test.ts). These tests pin the same
 * distinction for tool rows, on BOTH entry points: the live stream event and
 * the persisted `toolDisplay` replay, which is the only witness on reload.
 */
import { describe, expect, it } from "vitest";
import { historyToEntries, type PersistedHistoryMessage } from "../history.js";
import { applyToolStart, applyToolEnd, type ChatEntry, type ToolEntryItem } from "../../../../lib/chat-stream-state.js";

function toolsOf(entries: ChatEntry[]): ToolEntryItem[] {
  const group = entries.find((e) => e.kind === "tool_group");
  if (!group || group.kind !== "tool_group") throw new Error("no tool_group entry");
  return group.tools;
}

const GROUP = "g1";

function started(toolUseId: string): ChatEntry[] {
  return applyToolStart([], { groupId: GROUP, toolUseId, name: "bash", displayOrder: 0 });
}

describe("cancelled tool calls", () => {
  it("marks a stopped call cancelled rather than error (live)", () => {
    const entries = applyToolEnd(started("t1"), {
      groupId: GROUP,
      toolUseId: "t1",
      result: "도구 실행이 취소되었습니다.",
      // The wire flag stays true — the model must know no usable result came
      // back, and tool-result schemas have no third state.
      isError: true,
      cancelled: true,
    });

    expect(toolsOf(entries)[0]?.status).toBe("cancelled");
  });

  it("still marks a genuine failure as error", () => {
    const entries = applyToolEnd(started("t1"), {
      groupId: GROUP,
      toolUseId: "t1",
      result: "command not found",
      isError: true,
    });

    expect(toolsOf(entries)[0]?.status).toBe("error");
  });

  it("keeps a cancelled call out of the group's error roll-up", () => {
    // This is the visible symptom: one stopped call turned the entire group
    // destructive. `hasError` filters on status === "error", so a distinct
    // status excludes it without that call site needing to change.
    let entries = applyToolStart([], { groupId: GROUP, toolUseId: "t1", name: "bash", displayOrder: 0 });
    entries = applyToolStart(entries, { groupId: GROUP, toolUseId: "t2", name: "read_file", displayOrder: 1 });
    entries = applyToolEnd(entries, { groupId: GROUP, toolUseId: "t1", result: "ok", isError: false });
    entries = applyToolEnd(entries, {
      groupId: GROUP,
      toolUseId: "t2",
      result: "도구 실행이 취소되었습니다.",
      isError: true,
      cancelled: true,
    });

    expect(toolsOf(entries).some((t) => t.status === "error")).toBe(false);
  });

  it("carries the persisted flag onto the replayed tool row", () => {
    // On reload there is no stream event; `toolDisplay.cancelled` is the only
    // witness that the halt was deliberate.
    const messages: PersistedHistoryMessage[] = [
      { index: 0, role: "user", content: "긴 작업 시작" },
      {
        index: 1,
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "bash", input: {} }],
      },
      {
        index: 2,
        role: "tool_result",
        toolUseId: "t1",
        toolName: "bash",
        content: "도구 실행이 취소되었습니다.",
        isError: true,
        toolDisplay: { cancelled: true },
      },
    ];

    expect(toolsOf(historyToEntries(messages))[0]?.status).toBe("cancelled");
  });

  it("replays a real failure as error after reload", () => {
    const messages: PersistedHistoryMessage[] = [
      { index: 0, role: "user", content: "실패하는 작업" },
      {
        index: 1,
        role: "assistant",
        content: "",
        toolCalls: [{ id: "t1", name: "bash", input: {} }],
      },
      {
        index: 2,
        role: "tool_result",
        toolUseId: "t1",
        toolName: "bash",
        content: "command not found",
        isError: true,
      },
    ];

    expect(toolsOf(historyToEntries(messages))[0]?.status).toBe("error");
  });
});

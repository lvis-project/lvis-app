// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSideChat } from "../use-side-chat.js";
import type { StreamEvent, ChatEntry } from "../../../../lib/chat-stream-state.js";
import type { LvisApi } from "../../types.js";

/**
 * A test double for the side-chat preload surface. Exposes an `emit` so the test
 * can push arbitrary stream frames (with arbitrary streamIds) to the subscriber,
 * plus spies for the invoke channels.
 */
function makeApi() {
  let handler: ((e: StreamEvent) => void) | null = null;
  const abort = vi.fn(async () => ({ ok: true as const }));
  const send = vi.fn(async () => ({ ok: true as const, result: {} }));
  const newSession = vi.fn(async () => ({ ok: true as const, sessionId: "side-2" }));
  const load = vi.fn(async () => ({ ok: true as const, sessionId: "side-3", messages: [] }));
  const list = vi.fn(async () => ({ current: "side-1", sessions: [] }));
  const api = {
    sideChat: {
      send,
      new: newSession,
      load,
      list,
      abort,
      onStream: (h: (e: StreamEvent) => void) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
      onFallback: () => () => {},
    },
  } as unknown as LvisApi;
  return {
    api,
    emit: (e: StreamEvent) => act(() => handler?.(e)),
    spies: { abort, send, newSession, load, list },
  };
}

function lastAssistant(entries: ChatEntry[]): Extract<ChatEntry, { kind: "assistant" }> | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e && e.kind === "assistant") return e;
  }
  return undefined;
}

describe("useSideChat stale-frame guard", () => {
  it("adopts the first frame's streamId and applies its deltas", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hello");
    });
    // First frame of the turn establishes the active streamId.
    emit({ type: "text_delta", text: "wor", streamId: 7 });
    emit({ type: "text_delta", text: "ld", streamId: 7 });

    expect(lastAssistant(result.current.entries)).toMatchObject({
      kind: "assistant",
      text: "world",
      streaming: true,
    });
  });

  it("drops frames from a superseded turn (different streamId)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hello");
    });
    // Turn A adopts streamId 1.
    emit({ type: "text_delta", text: "A", streamId: 1 });
    // A late frame from a SUPERSEDED turn (streamId 2) must be dropped, not
    // appended to the live transcript.
    emit({ type: "text_delta", text: "STALE", streamId: 2 });
    emit({ type: "text_delta", text: "A", streamId: 1 });

    const last = lastAssistant(result.current.entries);
    expect(last).toMatchObject({ text: "AA" });
    expect(last?.text).not.toContain("STALE");
  });

  it("re-arms on the next send so a new turn adopts its own streamId", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    // Turn 1 (streamId 1), completes.
    await act(async () => {
      await result.current.send("one");
    });
    emit({ type: "text_delta", text: "first", streamId: 1 });
    emit({ type: "done", streamId: 1 });
    expect(result.current.isStreaming).toBe(false);

    // Turn 2 (streamId 2): a stale frame from turn 1 must NOT bleed in.
    await act(async () => {
      await result.current.send("two");
    });
    emit({ type: "text_delta", text: "STALE", streamId: 1 });
    emit({ type: "text_delta", text: "second", streamId: 2 });

    expect(lastAssistant(result.current.entries)?.text).toBe("second");
  });

  it("aborts the in-flight turn on unmount (tab switch teardown, no orphan)", async () => {
    const { api, emit, spies } = makeApi();
    const { result, unmount } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hello");
    });
    emit({ type: "text_delta", text: "streaming…", streamId: 1 });
    expect(result.current.isStreaming).toBe(true);

    unmount();
    expect(spies.abort).toHaveBeenCalledTimes(1);
  });

  it("does NOT abort on unmount when idle", async () => {
    const { api, spies } = makeApi();
    const { unmount } = renderHook(() => useSideChat(api));
    unmount();
    expect(spies.abort).not.toHaveBeenCalled();
  });
});

describe("useSideChat unified-transcript rendering (tool / thinking / permission)", () => {
  it("renders a tool_start/tool_end pair as a tool_group entry (parity with main)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("run a tool");
    });
    emit({
      type: "tool_start",
      streamId: 1,
      name: "index_scan",
      groupId: "g1",
      toolUseId: "t1",
      displayOrder: 0,
    });
    emit({
      type: "tool_end",
      streamId: 1,
      name: "index_scan",
      groupId: "g1",
      toolUseId: "t1",
      result: "42 files",
    });

    const toolGroup = result.current.entries.find((e) => e.kind === "tool_group");
    expect(toolGroup).toBeDefined();
    expect(toolGroup).toMatchObject({ kind: "tool_group" });
  });

  it("renders reasoning_delta as a reasoning entry (thinking parity)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("think");
    });
    emit({ type: "reasoning_delta", text: "let me consider…", streamId: 1 });

    const reasoning = result.current.entries.find((e) => e.kind === "reasoning");
    expect(reasoning).toMatchObject({ kind: "reasoning", text: "let me consider…" });
  });

  it("upserts a permission_review status card (informational, not the modal)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("do something risky");
    });
    emit({
      type: "permission_review",
      streamId: 1,
      reviewStatus: "reviewing",
      name: "bash",
      groupId: "g1",
      toolUseId: "t1",
      displayOrder: 0,
    });

    const review = result.current.entries.find((e) => e.kind === "permission_review");
    expect(review).toMatchObject({ kind: "permission_review", status: "reviewing", toolName: "bash" });
  });

  it("appends a turn_summary entry and derives turnSummaryByTurnStart", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("hi");
    });
    emit({ type: "text_delta", text: "answer", streamId: 1 });
    emit({
      type: "turn_summary",
      streamId: 1,
      turnDurationMs: 1200,
      toolCount: 1,
      cumulativeToolMs: 300,
      tokensIn: 100,
      freshInputTokens: 90,
      tokensOut: 40,
    });
    emit({ type: "done", streamId: 1 });

    const summaryEntry = result.current.entries.find((e) => e.kind === "turn_summary");
    expect(summaryEntry).toMatchObject({ kind: "turn_summary", toolCount: 1, tokensIn: 100 });
    // The turn starts at the user entry (index 0); the derived map keys by it.
    expect(result.current.turnSummaryByTurnStart.get(0)).toMatchObject({ toolCount: 1, turnDurationMs: 1200 });
  });

  it("renders a checkpoint divider on a side-chat compact_notice (not silently dropped)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useSideChat(api));

    await act(async () => {
      await result.current.send("long conversation");
    });
    emit({
      type: "compact_notice",
      streamId: 1,
      removedMessages: 5,
      freedTokens: 2000,
      estimatedAfter: 800,
      trigger: "context-tokens",
    });

    const checkpoint = result.current.entries.find((e) => e.kind === "checkpoint");
    expect(checkpoint).toMatchObject({ kind: "checkpoint", removedMessages: 5 });
    const ctxUsage = result.current.entries.find((e) => e.kind === "context_usage");
    expect(ctxUsage).toMatchObject({ kind: "context_usage", tokensIn: 800 });
  });
});

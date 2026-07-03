// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSideChat } from "../use-side-chat.js";
import type { StreamEvent } from "../../../../lib/chat-stream-state.js";
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
  const api = {
    sideChat: {
      send,
      new: newSession,
      load: vi.fn(),
      list: vi.fn(),
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
    spies: { abort, send, newSession },
  };
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

    const last = result.current.messages.at(-1);
    expect(last).toMatchObject({ kind: "assistant", text: "world", streaming: true });
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

    const last = result.current.messages.at(-1);
    expect(last).toMatchObject({ kind: "assistant", text: "AA" });
    expect((last as { text: string }).text).not.toContain("STALE");
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

    const last = result.current.messages.at(-1);
    expect((last as { text: string }).text).toBe("second");
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

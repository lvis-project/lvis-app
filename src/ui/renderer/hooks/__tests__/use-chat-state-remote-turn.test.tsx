/**
 * useChatState — remote-origin turn rendering scenarios.
 *
 * A turn submitted by an external surface (chat-platform bridge, Tailnet,
 * loopback) reaches this renderer only through the shared stream. The
 * `user_message` frame must materialize the user's row exactly like a local
 * turn's optimistic echo, and the following deltas must attach to the same
 * live transcript — while the renderer's own origins never double-bubble.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatState } from "../use-chat-state.js";
import type { LvisApi } from "../../types.js";
import type { StreamEvent } from "../../../../lib/chat-stream-state.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

function setup() {
  const { api, emitChatStream } = makeMockLvisApi();
  const { result } = renderHook(() => useChatState(api as unknown as LvisApi));
  const dispatch = (ev: StreamEvent) => act(() => emitChatStream(ev));
  return { result, dispatch };
}

describe("useChatState — remote-origin turn rendering", () => {
  it("renders a bridge turn as user bubble + live assistant stream, like a local turn", () => {
    const { result, dispatch } = setup();

    dispatch({
      type: "user_message",
      streamId: 3,
      text: "원격에서 보낸 질문",
      origin: "platform-bridge",
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({
      kind: "user",
      text: "원격에서 보낸 질문",
      origin: "platform-bridge",
    });

    dispatch({ type: "text_delta", streamId: 3, text: "안녕하세요" });
    dispatch({ type: "done", streamId: 3 });

    const kinds = result.current.entries.map((e) => e.kind);
    expect(kinds).toEqual(["user", "assistant"]);
    expect(result.current.entries[1]).toMatchObject({
      kind: "assistant",
      text: "안녕하세요",
    });
  });

  it("does not duplicate the renderer's own optimistically echoed turn", () => {
    const { result, dispatch } = setup();

    // Local send path: the hook's appendUserEntry echoed the bubble already.
    act(() => result.current.appendUserEntry("typed locally"));
    dispatch({
      type: "user_message",
      streamId: 4,
      text: "typed locally",
      origin: "user-keyboard",
    });

    expect(
      result.current.entries.filter(
        (e) => e.kind === "user" && e.text === "typed locally",
      ),
    ).toHaveLength(1);
  });
});

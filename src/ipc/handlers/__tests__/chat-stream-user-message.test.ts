/**
 * Every streamed turn announces its input on the shared timeline.
 *
 * `user.message` is the uniform turn-input event: one emission point in
 * `runStreamedTurn` for every origin, so a surface that did not submit the
 * turn (e.g. the desktop renderer during a chat-platform-bridge turn) renders
 * the user row from the same stream it already consumes — no per-transport
 * side channel. These pin the emission order, the host-resolved origin, and
 * the `displayText` preference for folded replay rows.
 */
import { describe, expect, it, vi } from "vitest";
import type { PlatformConversationEvent } from "../../../engine/conversation-platform-protocol.js";
import { runStreamedTurn, STREAM_TURN_OPTIONS } from "../chat-stream.js";
import { makeLoop } from "./chat-stream-test-helpers.js";

function eventsOf(sink: ReturnType<typeof vi.fn>): PlatformConversationEvent[] {
  return sink.mock.calls.map((call) => call[0] as PlatformConversationEvent);
}

describe("runStreamedTurn user.message emission", () => {
  it("publishes the turn input with its host-resolved origin right after turn.started", async () => {
    const { loop } = makeLoop();
    const sink = vi.fn();

    await runStreamedTurn(loop, "안녕, 데스크톱", sink, {
      inputOrigin: "platform-bridge",
    });

    const events = eventsOf(sink);
    expect(events[0]).toEqual({ kind: "turn.started" });
    expect(events[1]).toEqual({
      kind: "user.message",
      origin: "platform-bridge",
      ownerDetail: { text: "안녕, 데스크톱" },
    });
  });

  it("emits uniformly for desktop keyboard turns too — one stream, two origins", async () => {
    const { loop } = makeLoop();
    const sink = vi.fn();

    await runStreamedTurn(loop, "local question", sink, STREAM_TURN_OPTIONS);

    expect(eventsOf(sink)).toContainEqual({
      kind: "user.message",
      origin: "user-keyboard",
      ownerDetail: { text: "local question" },
    });
  });

  it("prefers the caller-supplied displayText so folded replay rows keep what the user saw", async () => {
    const { loop } = makeLoop();
    const sink = vi.fn();

    await runStreamedTurn(loop, "summarize [Resource #1]\n<fenced resource body>", sink, {
      ...STREAM_TURN_OPTIONS,
      displayText: "summarize [Resource #1]",
    });

    expect(eventsOf(sink)).toContainEqual({
      kind: "user.message",
      origin: "user-keyboard",
      ownerDetail: { text: "summarize [Resource #1]" },
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
import { createPlatformConversationTimeline } from "../../engine/conversation-platform-protocol.js";
import {
  createPlatformConversationLegacyStreamAdapter,
  createPlatformTurnId,
} from "../platform-conversation-legacy-adapter.js";

describe("platform conversation legacy adapter", () => {
  it("fans one semantic timeline event out as the exact existing owner frame", () => {
    const timeline = createPlatformConversationTimeline();
    const electron = createPlatformConversationLegacyStreamAdapter(timeline);
    const sse = createPlatformConversationLegacyStreamAdapter(timeline);
    const electronSink = vi.fn();
    const sseSink = vi.fn();
    electron.subscribe(electronSink);
    sse.subscribe(sseSink);

    timeline.publish({
      conversationId: "main-session",
      turnId: createPlatformTurnId(41),
      event: {
        kind: "tool.started",
        tool: {
          name: "read_file",
          groupId: "group-1",
          toolUseId: "tool-1",
          displayOrder: 2,
          category: "read",
        },
        ownerDetail: { input: { path: "C:/workspace/readme.md" } },
      },
    });

    const expected = {
      streamId: 41,
      type: "tool_start",
      name: "read_file",
      groupId: "group-1",
      toolUseId: "tool-1",
      displayOrder: 2,
      toolCategory: "read",
      input: { path: "C:/workspace/readme.md" },
    };
    expect(electronSink).toHaveBeenCalledWith(CHANNELS.chat.stream, expected);
    expect(sseSink).toHaveBeenCalledWith(CHANNELS.chat.stream, expected);
  });

  it("projects the turn-input event as an owner user_message frame with its origin", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const sink = vi.fn();
    adapter.subscribe(sink);

    timeline.publish({
      conversationId: "main-session",
      turnId: createPlatformTurnId(7),
      event: {
        kind: "user.message",
        origin: "platform-bridge",
        ownerDetail: { text: "bridge-submitted input", messageId: "row-bridge" },
      },
    });

    expect(sink).toHaveBeenCalledWith(CHANNELS.chat.stream, {
      streamId: 7,
      type: "user_message",
      text: "bridge-submitted input",
      origin: "platform-bridge",
      // The row identity travels with the input; it is how a surface binds the
      // bubble it draws to the row the host stored.
      messageId: "row-bridge",
    });
  });

  it("keeps a pre-turn redaction notice compatible without inventing a stream id", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const sink = vi.fn();
    adapter.subscribe(sink);

    timeline.publish({
      conversationId: "main-session",
      event: {
        kind: "privacy.redacted",
        count: 1,
        byKind: { email: 1 },
      },
    });

    expect(sink).toHaveBeenCalledWith(CHANNELS.chat.stream, {
      type: "redact_notice",
      count: 1,
      byKind: { email: 1 },
    });
  });

  it("unsubscribes from the timeline when no owner surface remains", () => {
    const timeline = createPlatformConversationTimeline();
    const adapter = createPlatformConversationLegacyStreamAdapter(timeline);
    const first = adapter.subscribe(vi.fn());
    const second = adapter.subscribe(vi.fn());
    expect(timeline.subscriberCount()).toBe(1);

    first();
    expect(timeline.subscriberCount()).toBe(1);
    second();
    second();
    expect(timeline.subscriberCount()).toBe(0);
  });
});

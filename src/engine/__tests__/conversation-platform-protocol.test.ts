import { describe, expect, it, vi } from "vitest";
import {
  createPlatformConversationTimeline,
  projectSharedConversationEvent,
} from "../conversation-platform-protocol.js";

describe("platform conversation protocol", () => {
  it("delivers one semantic event source while keeping owner detail out of replay", () => {
    const timeline = createPlatformConversationTimeline();
    const listener = vi.fn();
    timeline.subscribe(listener);

    const input = {
      conversationId: "main-session",
      turnId: "local-stream/7",
      event: {
        kind: "tool.started" as const,
        tool: {
          name: "read_file",
          groupId: "group-1",
          toolUseId: "tool-1",
          displayOrder: 1,
          category: "read" as const,
        },
        ownerDetail: { input: { path: "C:/private/secret.txt" } },
      },
    };

    const envelope = timeline.publish(input);

    expect(envelope).toMatchObject({
      version: 1,
      conversationId: "main-session",
      turnId: "local-stream/7",
      cursor: 1,
      event: input.event,
    });
    expect(listener).toHaveBeenCalledWith(envelope);
    // Rich owner detail can never become an accidental reconnect protocol.
    expect(timeline.read("main-session").events).toEqual([]);
  });

  it("derives a narrow shared projection from the same event without raw detail", () => {
    const ownerOnly = {
      kind: "tool.completed" as const,
      tool: {
        name: "shell",
        groupId: "group-1",
        toolUseId: "tool-1",
        displayOrder: 1,
      },
      isError: false,
      durationMs: 12,
      ownerDetail: {
        result: "TOKEN=do-not-share",
        uiPayload: {
          serverId: "private-server",
          resourceUri: "ui://private-resource",
          slot: "chat" as const,
          height: 200,
          title: "private title",
        },
      },
    };

    const projected = projectSharedConversationEvent(ownerOnly);

    expect(projected).toEqual({ kind: "tool.state", state: "completed" });
    expect(JSON.stringify(projected)).not.toContain("do-not-share");
    expect(JSON.stringify(projected)).not.toContain("private-resource");
    expect(projectSharedConversationEvent({
      kind: "assistant.reasoning.delta",
      ownerDetail: { text: "private chain of thought" },
    })).toBeUndefined();
  });

  it("projects a failed turn with only the closed share-safe failure summary", () => {
    const projected = projectSharedConversationEvent({
      kind: "turn.error",
      failure: { category: "provider", summary: "The model provider returned an error." },
      ownerDetail: {
        message: "Failed after 3 attempts. Last error: token sk-FAKE-TOKEN-123",
        systemNotice: "stream-error",
      },
    });

    expect(projected).toEqual({
      kind: "turn.failed",
      failure: { category: "provider", summary: "The model provider returned an error." },
    });
    // The raw owner message never crosses the projection.
    expect(JSON.stringify(projected)).not.toContain("sk-FAKE-TOKEN-123");

    // A summary that fails closed re-validation is dropped, not forwarded.
    const forged = projectSharedConversationEvent({
      kind: "turn.error",
      failure: {
        category: "stack-trace",
        summary: "at C:\\private\\secret.ts:1",
      } as unknown as { category: "provider"; summary: string },
      ownerDetail: { message: "raw" },
    });
    expect(forged).toEqual({ kind: "turn.failed" });

    // A legacy event without a summary still projects the bare failure.
    expect(projectSharedConversationEvent({
      kind: "turn.error",
      ownerDetail: { message: "raw" },
    })).toEqual({ kind: "turn.failed" });
  });

  it("never projects a turn's user input to shared surfaces", () => {
    // The submitting chat platform already shows the sender their own message;
    // sharing it back would duplicate every remote turn and hand other
    // surfaces' input text to safe-projection observers.
    expect(projectSharedConversationEvent({
      kind: "user.message",
      origin: "platform-bridge",
      ownerDetail: { text: "the user's own words" },
    })).toBeUndefined();
  });
});

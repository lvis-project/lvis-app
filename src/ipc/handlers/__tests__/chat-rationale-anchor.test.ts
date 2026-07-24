import { describe, expect, it, vi } from "vitest";
import type { IpcDeps } from "../../types.js";
import {
  handleChatSend,
  type ChatSendContext,
} from "../chat.js";
import { formatAppMessageEnvelope } from "../../../shared/mcp-app-message-source.js";

const completedTurn = {
  text: "done",
  toolCalls: [],
  route: "default",
  stopReason: "end_turn",
} as const;

function makeFixture() {
  const runTurn = vi.fn(async (..._args: unknown[]) => completedTurn);
  const sink = vi.fn();
  const allocateStreamId = vi.fn(() => 41);
  const trackStreamTurn = vi.fn((factory: () => Promise<unknown>) => factory());
  const deps = {
    conversationLoop: {
      getSessionId: () => "session-anchor",
      getSessionKind: () => "subagent",
      runTurn,
    },
    settingsService: {
      get: (key: string) =>
        key === "privacy" ? { piiRedactEnabled: true } : undefined,
    },
    auditLogger: { log: vi.fn() },
  } as unknown as IpcDeps;
  const context: ChatSendContext = {
    sink,
    allocateStreamId,
    trackStreamTurn: trackStreamTurn as ChatSendContext["trackStreamTurn"],
  };
  return { deps, context, runTurn, sink, allocateStreamId, trackStreamTurn };
}

function turnOptions(runTurn: ReturnType<typeof makeFixture>["runTurn"]):
Record<string, unknown> {
  const call = runTurn.mock.calls[0] as unknown[];
  return call[3] as Record<string, unknown>;
}

describe("chat RequestAnchor trust boundary", () => {
  it("passes raw verified keyboard intent only as the anchor seed while the provider path is DLP-redacted", async () => {
    const fixture = makeFixture();
    const rawInput = "contact alice@example.com before deleting the build output";

    await expect(handleChatSend(
      fixture.deps,
      {
        input: rawInput,
        inputOrigin: "user-keyboard",
        userActivation: true,
      },
      fixture.context,
    )).resolves.toEqual(completedTurn);

    expect(fixture.runTurn).toHaveBeenCalledOnce();
    const call = fixture.runTurn.mock.calls[0] as unknown[];
    expect(call[0]).toBe(
      "contact [REDACTED:EMAIL] before deleting the build output",
    );
    expect(call[0]).not.toContain("alice@example.com");
    expect(turnOptions(fixture.runTurn)).toMatchObject({
      inputOrigin: "user-keyboard",
      requestAnchorRawIntent: rawInput,
    });
    expect(fixture.sink).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ type: "redact_notice", count: 1 }),
    );
  });

  it("rejects an unverified keyboard activation before an anchor seed can reach runTurn", async () => {
    const fixture = makeFixture();

    await expect(handleChatSend(
      fixture.deps,
      {
        input: "delete the build output",
        inputOrigin: "user-keyboard",
        userActivation: false,
      },
      fixture.context,
    )).resolves.toEqual({ ok: false, error: "user-keyboard-required" });

    expect(fixture.runTurn).not.toHaveBeenCalled();
  });

  it.each([
    [
      "queue",
      {
        input: "queued follow-up",
        inputOrigin: "queue-auto",
      },
    ],
    [
      "plugin",
      {
        input:
          '<imported-from-proactive source="overlay:test">plugin request</imported-from-proactive>',
        inputOrigin: "plugin-emitted",
      },
    ],
    [
      "app",
      {
        input: formatAppMessageEnvelope("app request", "app:test-server"),
        inputOrigin: "app-emitted",
      },
    ],
  ] as const)(
    "does not pass an anchor seed for %s input",
    async (_label, payload) => {
      const fixture = makeFixture();

      await expect(
        handleChatSend(fixture.deps, payload, fixture.context),
      ).resolves.toEqual(completedTurn);

      expect(fixture.runTurn).toHaveBeenCalledOnce();
      expect(turnOptions(fixture.runTurn)).not.toHaveProperty(
        "requestAnchorRawIntent",
      );
    },
  );

  it.each([
    [
      "plugin prefix",
      {
        input: '<imported-from-proactive source="overlay:test">plugin request',
        inputOrigin: "plugin-emitted",
      },
      "missing-plugin-envelope",
    ],
    [
      "plugin trailing text",
      {
        input: '<imported-from-proactive source="overlay:test">plugin request</imported-from-proactive> trailing',
        inputOrigin: "plugin-emitted",
      },
      "missing-plugin-envelope",
    ],
    [
      "plugin malformed source",
      {
        input: '<imported-from-proactive source="overlay:Bad">plugin request</imported-from-proactive>',
        inputOrigin: "plugin-emitted",
      },
      "missing-plugin-envelope",
    ],
    [
      "app prefix",
      {
        input: '<app-message source="app:test-server">app request',
        inputOrigin: "app-emitted",
      },
      "missing-app-envelope",
    ],
    [
      "app malformed source",
      {
        input: '<app-message source="app:bad id">app request</app-message>',
        inputOrigin: "app-emitted",
      },
      "missing-app-envelope",
    ],
    [
      "app trailing text",
      {
        input: '<app-message source="app:test-server">app request</app-message> trailing',
        inputOrigin: "app-emitted",
      },
      "missing-app-envelope",
    ],
  ] as const)("rejects %s before streaming", async (_label, payload, error) => {
    const fixture = makeFixture();

    await expect(handleChatSend(fixture.deps, payload, fixture.context)).resolves.toEqual({
      ok: false,
      error,
    });

    expect(fixture.allocateStreamId).not.toHaveBeenCalled();
    expect(fixture.trackStreamTurn).not.toHaveBeenCalled();
    expect(fixture.runTurn).not.toHaveBeenCalled();
  });

  it("rejects the private routine origin over public ChatSend", async () => {
    const fixture = makeFixture();

    await expect(handleChatSend(
      fixture.deps,
      { input: "scheduled prompt", inputOrigin: "routine" },
      fixture.context,
    )).resolves.toEqual({ ok: false, error: "missing-input-origin" });

    expect(fixture.runTurn).not.toHaveBeenCalled();
  });

  it.each([
    [
      "plugin",
      '<imported-from-proactive source="overlay:test">plugin request</imported-from-proactive>',
      "plugin-emitted",
      { inputOrigin: "plugin-emitted", source: "overlay:test", body: "plugin request" },
    ],
    [
      "app",
      formatAppMessageEnvelope("app request", "app:test-server"),
      "app-emitted",
      { inputOrigin: "app-emitted", source: "app:test-server", body: "app request" },
    ],
  ] as const)("carries canonical %s provenance into the streamed turn", async (
    _label,
    input,
    inputOrigin,
    canonicalStagedInput,
  ) => {
    const fixture = makeFixture();

    await expect(handleChatSend(
      fixture.deps,
      { input, inputOrigin },
      fixture.context,
    )).resolves.toEqual(completedTurn);

    expect(turnOptions(fixture.runTurn)).toMatchObject({
      inputOrigin,
      canonicalStagedInput,
    });
  });
});

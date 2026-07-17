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
    allocateStreamId: () => 41,
    trackStreamTurn: (factory) => factory(),
  };
  return { deps, context, runTurn, sink };
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
});

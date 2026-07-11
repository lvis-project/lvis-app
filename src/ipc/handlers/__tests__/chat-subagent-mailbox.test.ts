import { describe, expect, it, vi } from "vitest";
import type { TurnResult } from "../../../engine/conversation-loop.js";
import type { IpcDeps } from "../../types.js";
import {
  acknowledgeParentMailboxAfterTurn,
  prepareParentMailboxTurn,
} from "../chat.js";

function mailboxEntry(id: string, formattedText: string, approvalLabel: string) {
  return { id, formattedText, approvalLabel };
}

function makeDeps(entries: Array<ReturnType<typeof mailboxEntry>>) {
  let sessionId = "parent-1";
  const peekParentMailbox = vi.fn(async () => entries);
  const acknowledgeParentMailbox = vi.fn(async () => entries.length);
  const log = vi.fn();
  const deps = {
    conversationLoop: {
      getSessionKind: () => "main",
      getSessionId: () => sessionId,
    },
    getSubAgentRunner: () => ({ peekParentMailbox, acknowledgeParentMailbox }),
    auditLogger: { log },
  } as unknown as IpcDeps;
  return {
    deps,
    peekParentMailbox,
    acknowledgeParentMailbox,
    log,
    switchSession: (next: string) => { sessionId = next; },
  };
}

const completedTurn = { text: "done", toolCalls: [], route: "default", stopReason: "end_turn" } satisfies TurnResult;

describe("parent sub-agent mailbox turns", () => {
  it("joins the current parent's durable entries and preserves per-child approval provenance", async () => {
    const fixture = makeDeps([
      mailboxEntry("message-1", "child one", "[Sub-Agent: One]"),
      mailboxEntry("message-2", "child two", "[Sub-Agent: Two]"),
    ]);

    await expect(prepareParentMailboxTurn(fixture.deps)).resolves.toEqual({
      parentSessionId: "parent-1",
      entryIds: ["message-1", "message-2"],
      initialGuidance: "child one\n\nchild two",
      approvalReasonPrefix: "[Sub-Agent: multiple sources]",
    });
    expect(fixture.peekParentMailbox).toHaveBeenCalledWith("parent-1");
  });

  it("keeps a single approval label when all queued messages share one child", async () => {
    const fixture = makeDeps([
      mailboxEntry("message-1", "first", "[Sub-Agent: One]"),
      mailboxEntry("message-2", "second", "[Sub-Agent: One]"),
    ]);

    const mailboxTurn = await prepareParentMailboxTurn(fixture.deps);
    expect(mailboxTurn?.approvalReasonPrefix).toBe("[Sub-Agent: One]");
  });

  it("refuses a stale snapshot when the active parent changes during the mailbox read", async () => {
    const fixture = makeDeps([mailboxEntry("message-1", "first", "[Sub-Agent: One]")]);
    fixture.peekParentMailbox.mockImplementation(async () => {
      fixture.switchSession("parent-2");
      return [mailboxEntry("message-1", "first", "[Sub-Agent: One]")];
    });

    await expect(prepareParentMailboxTurn(fixture.deps)).resolves.toBeNull();
    expect(fixture.acknowledgeParentMailbox).not.toHaveBeenCalled();
  });

  it("keeps the mailbox durable and audits when reading fails", async () => {
    const fixture = makeDeps([mailboxEntry("message-1", "first", "[Sub-Agent: One]")]);
    fixture.peekParentMailbox.mockRejectedValue(new Error("storage-unavailable"));

    await expect(prepareParentMailboxTurn(fixture.deps)).resolves.toBeNull();
    expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "parent-1",
      type: "error",
      input: "subagent-mailbox-peek-failed:storage-unavailable",
    }));
  });

  it("acknowledges exactly the snapshot ids after a completed receiving turn", async () => {
    const fixture = makeDeps([mailboxEntry("message-1", "first", "[Sub-Agent: One]")]);
    const mailboxTurn = await prepareParentMailboxTurn(fixture.deps);

    await acknowledgeParentMailboxAfterTurn(fixture.deps, mailboxTurn, completedTurn);

    expect(fixture.acknowledgeParentMailbox).toHaveBeenCalledWith("parent-1", ["message-1"]);
  });

  it.each(["blocked", "interrupted", "context-error", "stream-error"] as const)(
    "does not acknowledge after a %s turn",
    async (stopReason) => {
      const fixture = makeDeps([mailboxEntry("message-1", "first", "[Sub-Agent: One]")]);
      const mailboxTurn = await prepareParentMailboxTurn(fixture.deps);

      await acknowledgeParentMailboxAfterTurn(fixture.deps, mailboxTurn, {
        ...completedTurn,
        stopReason,
      });

      expect(fixture.acknowledgeParentMailbox).not.toHaveBeenCalled();
    },
  );

  it("does not acknowledge when a slash command short-circuits before guidance consumption", async () => {
    const fixture = makeDeps([mailboxEntry("message-1", "first", "[Sub-Agent: One]")]);
    const mailboxTurn = await prepareParentMailboxTurn(fixture.deps);

    await acknowledgeParentMailboxAfterTurn(fixture.deps, mailboxTurn, {
      ...completedTurn,
      route: "command",
      stopReason: undefined,
    });

    expect(fixture.acknowledgeParentMailbox).not.toHaveBeenCalled();
  });

  it("does not acknowledge after the active parent switches", async () => {
    const fixture = makeDeps([mailboxEntry("message-1", "first", "[Sub-Agent: One]")]);
    const mailboxTurn = await prepareParentMailboxTurn(fixture.deps);
    fixture.switchSession("parent-2");

    await acknowledgeParentMailboxAfterTurn(fixture.deps, mailboxTurn, completedTurn);

    expect(fixture.acknowledgeParentMailbox).not.toHaveBeenCalled();
  });

  it("preserves the mailbox and audits an acknowledgement failure", async () => {
    const fixture = makeDeps([mailboxEntry("message-1", "first", "[Sub-Agent: One]")]);
    const mailboxTurn = await prepareParentMailboxTurn(fixture.deps);
    fixture.acknowledgeParentMailbox.mockRejectedValue(new Error("storage-unavailable"));

    await acknowledgeParentMailboxAfterTurn(fixture.deps, mailboxTurn, completedTurn);

    expect(fixture.log).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "parent-1",
      type: "error",
      input: "subagent-mailbox-ack-failed:storage-unavailable",
    }));
  });
});

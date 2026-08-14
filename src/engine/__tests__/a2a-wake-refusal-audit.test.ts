import { beforeEach, describe, expect, it, vi } from "vitest";
import { A2ASubAgentMessageBus } from "../a2a-subagent-message-bus.js";
import type { ConversationLoop } from "../conversation-loop.js";
import type { ResolvedSubAgentAddress } from "../subagent-message-mailbox.js";
import { A2A_ROLE_AGENT } from "../../shared/a2a.js";

/**
 * The field failure this pins: a child result reached the mailbox ("stored"
 * audit) and the parent was never woken, and NOTHING in the audit trail said
 * which wake condition failed. The refusal branch must name its reasons.
 */
function makeMessage() {
  return {
    messageId: "m-1",
    role: A2A_ROLE_AGENT,
    parts: [{ text: "done" }],
    contextId: "parent-session",
    taskId: "sub-child",
  } as never;
}

function makeBus(overrides: {
  wakeFlag?: boolean;
  activeSession?: string;
  hasActiveTurn?: boolean;
  registerHandler?: boolean;
  audit: ReturnType<typeof vi.fn>;
}) {
  const address: ResolvedSubAgentAddress = {
    parentSessionId: "parent-session",
    childSessionId: "sub-child",
    childTitle: "worker",
  };
  const entries: unknown[] = [];
  const bus = new A2ASubAgentMessageBus({
    parentLoop: {
      getSessionId: () => overrides.activeSession ?? "parent-session",
      hasActiveTurn: () => overrides.hasActiveTurn ?? false,
      queueGuidanceWithDisposition: vi.fn(() => "queued"),
    } as unknown as ConversationLoop,
    mailbox: {
      enqueue: vi.fn(async (entry: unknown) => { entries.push(entry); return { ok: true }; }),
      peekWithDiagnostics: vi.fn(async () => ({ entries: [], diagnostics: [] })),
      acknowledge: vi.fn(async () => 0),
    } as never,
    settingsService: {
      get: () => ({ subAgentAutonomousWake: overrides.wakeFlag ?? true }),
    } as never,
    auditLogger: { log: overrides.audit } as never,
    resolveChildAddress: vi.fn(async () => address),
  });
  if (overrides.registerHandler !== false) {
    bus.setWakeHandler(vi.fn(async () => {}));
  }
  return bus;
}

const DELIVERY = {
  parentSessionId: "parent-session",
  childSessionId: "sub-child",
  message: makeMessage(),
};

function lastAuditInput(audit: ReturnType<typeof vi.fn>): string {
  return String((audit.mock.calls.at(-1)?.[0] as { input?: string })?.input ?? "");
}

describe("wake refusal audit", () => {
  let audit: ReturnType<typeof vi.fn>;
  beforeEach(() => { audit = vi.fn(); });

  it("names an unregistered handler", async () => {
    const bus = makeBus({ audit, registerHandler: false });
    const result = await bus.deliverToParent(DELIVERY);
    expect(result).toMatchObject({ ok: true, disposition: "mailbox" });
    expect(lastAuditInput(audit)).toContain("mailbox-no-wake:handler-unregistered");
  });

  it("names a disabled flag", async () => {
    const bus = makeBus({ audit, wakeFlag: false });
    await bus.deliverToParent(DELIVERY);
    expect(lastAuditInput(audit)).toContain("mailbox-no-wake:flag-off");
  });

  it("names a session mismatch", async () => {
    const bus = makeBus({ audit, activeSession: "some-other-session" });
    await bus.deliverToParent(DELIVERY);
    expect(lastAuditInput(audit)).toContain("mailbox-no-wake:session-mismatch");
  });

  it("wakes — and audits nothing about refusal — when every condition holds", async () => {
    const bus = makeBus({ audit });
    const result = await bus.deliverToParent(DELIVERY);
    expect(result).toMatchObject({ ok: true, disposition: "wake-requested" });
    const all = audit.mock.calls.map((c) => String((c[0] as { input?: string })?.input ?? ""));
    expect(all.some((line) => line.includes("mailbox-no-wake"))).toBe(false);
  });
});

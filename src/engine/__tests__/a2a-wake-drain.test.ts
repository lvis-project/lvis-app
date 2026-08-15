import { beforeEach, describe, expect, it, vi } from "vitest";
import { A2ASubAgentMessageBus } from "../a2a-subagent-message-bus.js";
import type { DeliverToParentInput } from "../a2a-subagent-message-bus.js";
import type { ConversationLoop } from "../conversation-loop.js";
import type { SubAgentMessageMailbox } from "../subagent-message-mailbox.js";
import { A2A_ROLE_AGENT } from "../../shared/a2a.js";

/**
 * The wake drain has ONE invariant: the per-parent dirty token, spent before
 * dispatch, is the progress guarantee. These tests pin the two halves of it —
 * a wake that consumes nothing must stop, and every trigger that legitimately
 * owes a delivery must still reach exactly one wake.
 */
const PARENT = "parent-session";

function makeMessage(messageId = "message-1") {
  return {
    messageId,
    role: A2A_ROLE_AGENT,
    parts: [{ text: "child finished" }],
    contextId: PARENT,
    taskId: "sub-child",
  } as never;
}

function delivery(messageId?: string): DeliverToParentInput {
  return {
    parentSessionId: PARENT,
    childSessionId: "sub-child",
    message: makeMessage(messageId),
  };
}

/** Flush enough microtask turns for any detached drain chain to settle. */
async function settleDetachedWork(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

type ParentWake = (parentSessionId: string) => Promise<void>;

interface GuidanceCallbacks {
  onInjected?: () => void;
  onDropped?: (reason: "joined-limit" | "turn-ended") => void;
}

interface DrainFixture {
  bus: A2ASubAgentMessageBus;
  /** Callbacks the loop received for the most recent queued guidance. */
  lastGuidance: () => GuidanceCallbacks | undefined;
}

function makeBus(options: {
  audit: ReturnType<typeof vi.fn>;
  entries: unknown[];
  wake: ParentWake;
  activeSession?: () => string;
  hasActiveTurn?: () => boolean;
  queueGuidance?: () => string;
  peek?: ReturnType<typeof vi.fn>;
  acknowledge?: () => Promise<number>;
}): DrainFixture {
  let lastGuidance: GuidanceCallbacks | undefined;
  const bus = new A2ASubAgentMessageBus({
    parentLoop: {
      getSessionId: () => options.activeSession?.() ?? PARENT,
      hasActiveTurn: () => options.hasActiveTurn?.() ?? false,
      queueGuidanceWithDisposition: (_text: string, callbacks: GuidanceCallbacks) => {
        lastGuidance = callbacks;
        return options.queueGuidance?.() ?? "queued";
      },
    } as unknown as ConversationLoop,
    mailbox: {
      enqueue: vi.fn(async (entry: unknown) => {
        options.entries.push(entry);
        return { ok: true };
      }),
      peek: options.peek ?? vi.fn(async () => options.entries),
      acknowledge: vi.fn(options.acknowledge ?? (async () => 0)),
    } as unknown as SubAgentMessageMailbox,
    settingsService: { get: () => ({ subAgentAutonomousWake: true }) } as never,
    auditLogger: { log: options.audit } as never,
    resolveChildAddress: async () => ({
      parentSessionId: PARENT,
      childSessionId: "sub-child",
      childTitle: "worker",
    }),
  });
  bus.setWakeHandler(options.wake);
  return { bus, lastGuidance: () => lastGuidance };
}

function auditInputs(audit: ReturnType<typeof vi.fn>): string[] {
  return audit.mock.calls.map((call) => String((call[0] as { input?: string })?.input ?? ""));
}

describe("wake drain", () => {
  let audit: ReturnType<typeof vi.fn>;
  let entries: unknown[];
  beforeEach(() => {
    audit = vi.fn();
    entries = [];
  });

  it("does not loop on a poisoned entry the woken turn cannot consume", async () => {
    // The failure this exists to prevent: the wake runs, the entry survives
    // (refused turn / failed acknowledge / fail-closed mailbox turn), and a
    // mailbox-driven recheck wakes the parent again — forever.
    const peek = vi.fn(async () => entries);
    // Consumes nothing — recorded rather than asserted inside the handler,
    // whose rejection the bus would swallow into a "wake-failed" audit.
    const mailboxSizeDuringWake: number[] = [];
    const wake = vi.fn(async () => {
      mailboxSizeDuringWake.push(entries.length);
    });
    const { bus } = makeBus({ audit, entries, wake, peek });

    await expect(bus.deliverToParent(delivery())).resolves.toMatchObject({
      ok: true,
      disposition: "wake-requested",
    });
    expect(wake).toHaveBeenCalledTimes(1);

    await settleDetachedWork();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(peek).not.toHaveBeenCalled();
    expect(mailboxSizeDuringWake).toEqual([1]);
    expect(entries).toHaveLength(1);

    // A turn-settled notification is not a second chance either: the token was
    // already spent, and only a NEW delivery may mint another one.
    bus.notifyTurnSettled(PARENT);
    await settleDetachedWork();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("drains at turn end a delivery that reached the mailbox mid-turn", async () => {
    let activeTurn = true;
    const wake = vi.fn(async () => undefined);
    const { bus } = makeBus({
      audit,
      entries,
      wake,
      hasActiveTurn: () => activeTurn,
      queueGuidance: () => "queued",
    });

    // Accepted into the running turn's guidance queue, so the delivery reports
    // "queued" and requests no wake.
    await expect(bus.deliverToParent(delivery())).resolves.toMatchObject({
      ok: true,
      disposition: "queued",
    });
    expect(wake).not.toHaveBeenCalled();

    // The turn ends without ever reaching a round boundary and without firing a
    // drop disposition (the queue was detached by a crashing turn's cleanup).
    // The turn-settled hook is the only thing left that can deliver.
    activeTurn = false;
    bus.notifyTurnSettled(PARENT);
    await settleDetachedWork();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledWith(PARENT);
    expect(entries).toHaveLength(1);
  });

  it("spends the token on injection, so turn end does not wake an empty mailbox", async () => {
    let activeTurn = true;
    const wake = vi.fn(async () => undefined);
    const { bus, lastGuidance } = makeBus({
      audit,
      entries,
      wake,
      hasActiveTurn: () => activeTurn,
      queueGuidance: () => "queued",
      // The running turn consumed the entry at its round boundary.
      acknowledge: async () => {
        entries.pop();
        return 1;
      },
    });

    await expect(bus.deliverToParent(delivery())).resolves.toMatchObject({
      disposition: "queued",
    });
    lastGuidance()?.onInjected?.();
    await settleDetachedWork();
    expect(entries).toHaveLength(0);

    // The delivery is done. Waking here would take a real turn lease to look at
    // an empty mailbox — and would do it after every injected A2A message.
    activeTurn = false;
    bus.notifyTurnSettled(PARENT);
    await settleDetachedWork();
    expect(wake).not.toHaveBeenCalled();
  });

  it("coalesces a completion re-drain and a turn-end trigger into one wake", async () => {
    const wakeResolvers: Array<() => void> = [];
    const wake = vi.fn(() => new Promise<void>((resolve) => {
      wakeResolvers.push(resolve);
    }));
    const { bus } = makeBus({ audit, entries, wake });

    await expect(bus.deliverToParent(delivery("message-1"))).resolves.toMatchObject({
      disposition: "wake-requested",
    });
    expect(wake).toHaveBeenCalledTimes(1);

    // Both of these land while the first wake is still in flight and mint or
    // find the same single token.
    await expect(bus.deliverToParent(delivery("message-2"))).resolves.toMatchObject({
      disposition: "mailbox",
    });
    bus.notifyTurnSettled(PARENT);
    await settleDetachedWork();
    expect(wake).toHaveBeenCalledTimes(1);

    wakeResolvers.shift()?.();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));

    // One token, one extra wake — the overlapping triggers do not each buy one.
    wakeResolvers.shift()?.();
    await settleDetachedWork();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(entries).toHaveLength(2);
  });

  it("fails closed when the loop switched sessions, and keeps the token", async () => {
    let activeSession = PARENT;
    let activeTurn = true;
    const wake = vi.fn(async () => undefined);
    const { bus } = makeBus({
      audit,
      entries,
      wake,
      activeSession: () => activeSession,
      hasActiveTurn: () => activeTurn,
      queueGuidance: () => "queued",
    });

    await expect(bus.deliverToParent(delivery())).resolves.toMatchObject({
      disposition: "queued",
    });

    // The user navigates away before the turn settles. Waking now would run a
    // turn against a session that never asked for this child's message.
    activeSession = "other-session";
    activeTurn = false;
    bus.notifyTurnSettled(PARENT);
    await settleDetachedWork();
    expect(wake).not.toHaveBeenCalled();
    expect(auditInputs(audit).at(-1)).toContain("mailbox-no-wake:session-mismatch");

    // Fail-closed is a hold, not a discard: the token still buys a wake once
    // the parent session is active again.
    activeSession = PARENT;
    bus.notifyTurnSettled(PARENT);
    await settleDetachedWork();
    expect(wake).toHaveBeenCalledTimes(1);
  });
});

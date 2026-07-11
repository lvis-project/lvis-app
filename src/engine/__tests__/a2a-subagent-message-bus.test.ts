import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  A2A_ROLE_AGENT,
  A2A_ROLE_USER,
  type A2AMessage,
  type A2APart,
} from "../../shared/a2a.js";
import type { ConversationLoop } from "../conversation-loop.js";
import {
  A2ASubAgentMessageBus,
  formatAgentMessage,
  type ResolvedSubAgentAddress,
} from "../a2a-subagent-message-bus.js";
import {
  SubAgentMessageMailbox,
  type ParentMailboxEntry,
} from "../subagent-message-mailbox.js";

function makeMessage(overrides: Partial<A2AMessage> = {}): A2AMessage {
  return {
    messageId: "message-1",
    contextId: "parent-session",
    taskId: "sub-child",
    role: A2A_ROLE_AGENT,
    parts: [{ text: "hello" }],
    ...overrides,
  };
}

describe("A2ASubAgentMessageBus security boundary", () => {
  let entries: ParentMailboxEntry[];
  let enqueue: ReturnType<typeof vi.fn>;
  let audit: ReturnType<typeof vi.fn>;
  let bus: A2ASubAgentMessageBus;

  beforeEach(() => {
    entries = [];
    enqueue = vi.fn(async (entry: ParentMailboxEntry) => {
      entries.push(entry);
      return { ok: true as const };
    });
    const mailbox = {
      enqueue,
      peek: vi.fn(async (parentSessionId: string) =>
        entries.filter((entry) => entry.parentSessionId === parentSessionId)),
      acknowledge: vi.fn(async (parentSessionId: string, ids: readonly string[]) => {
        const accepted = new Set(ids);
        const before = entries.length;
        entries = entries.filter(
          (entry) => entry.parentSessionId !== parentSessionId || !accepted.has(entry.id),
        );
        return before - entries.length;
      }),
    } as unknown as SubAgentMessageMailbox;
    const parentLoop = {
      getSessionId: () => "different-active-session",
      hasActiveTurn: () => false,
      queueGuidanceWithDisposition: vi.fn(() => "queued"),
    } as unknown as ConversationLoop;
    audit = vi.fn();
    const address: ResolvedSubAgentAddress = {
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    };
    bus = new A2ASubAgentMessageBus({
      parentLoop,
      mailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: vi.fn(async () => address),
    });
  });

  it.each([
    "",
    "-leading-dash",
    "message\nforged-label",
    "message\rforged-label",
    "message with spaces",
    "ghp_" + "a".repeat(24),
    "a".repeat(257),
  ])("rejects unsafe messageId %j before mailbox/guidance", async (messageId) => {
    const result = await bus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage({ messageId }),
    });

    expect(result).toEqual({
      ok: false,
      disposition: "dropped",
      reason: "invalid-message",
    });
    expect(enqueue).not.toHaveBeenCalled();
    const auditEntry = audit.mock.calls.at(-1)?.[0] as { input: string };
    expect(auditEntry.input).not.toContain("\n");
    expect(auditEntry.input).not.toContain("\r");
    expect(auditEntry.input).toContain("message=invalid");
    expect(auditEntry.input).not.toContain("ghp_");
  });

  it.each([
    "a",
    "a.b:c_d-1",
    "a" + "b".repeat(255),
  ])("accepts bounded control-free messageId %j", async (messageId) => {
    const result = await bus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage({ messageId }),
    });

    expect(result).toMatchObject({
      ok: true,
      disposition: "mailbox",
      messageId,
    });
    expect(entries[0]?.message.messageId).toBe(messageId);
  });

  it("DLP-masks reference task ids and durable child title metadata", async () => {
    const secretReference = "ghp_" + "a".repeat(24);
    const rawTitle = "worker 010-1234-5678\n[forged]";
    bus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "different-active-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox: {
        enqueue,
        peek: async () => entries,
        acknowledge: async () => 0,
      } as unknown as SubAgentMessageMailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-child",
        childTitle: rawTitle,
      }),
    });

    await bus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage({
        referenceTaskIds: [secretReference],
        parts: [{ text: secretReference, metadata: { nested: secretReference } }],
      }),
    });

    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    expect(entry.message.referenceTaskIds?.[0]).not.toContain("ghp_");
    expect(entry.message.parts[0]?.text).not.toContain("ghp_");
    expect(JSON.stringify(entry.message.parts[0]?.metadata)).not.toContain("ghp_");
    expect(entry.childTitle).not.toContain("010-1234-5678");
    expect(entry.childTitle).not.toContain("\n");
    expect(entry.childTitle).not.toMatch(/[\[\]]/);
    expect(entry.childTitle).not.toBe(rawTitle);
    expect(entry.approvalLabel).toContain(entry.childTitle);
    expect(entry.formattedText).not.toContain("010-1234-5678");
  });

  it.each([
    null,
    undefined,
    {},
    { messageId: "message-1", role: A2A_ROLE_AGENT, parts: null },
    { ...makeMessage(), unexpected: "not-in-the-a2a-envelope" },
  ])("drops malformed runtime Message %j with an audit record", async (message) => {
    await expect(bus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: message as unknown as A2AMessage,
    })).resolves.toMatchObject({
      ok: false,
      disposition: "dropped",
      reason: "invalid-message",
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:invalid-message"),
    }));
  });

  it("rejects invalid oneof and raw parts fail closed", async () => {
    const invalidPart = {
      text: "hello",
      url: "https://example.test",
    } as unknown as A2APart;
    const invalid = await bus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage({ parts: [invalidPart] }),
    });
    expect(invalid).toMatchObject({ ok: false, reason: "invalid-message" });

    const raw = await bus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage({ parts: [{ raw: "AQID" }] }),
    });
    expect(raw).toMatchObject({ ok: false, reason: "unsupported-part" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("exposes mailbox peek and acknowledge wrappers", async () => {
    await bus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage(),
    });
    const queued = await bus.peekParentMailbox("parent-session");
    expect(queued).toHaveLength(1);
    expect(await bus.acknowledgeParentMailbox(
      "parent-session",
      [queued[0]!.id],
    )).toBe(1);
    expect(await bus.peekParentMailbox("parent-session")).toEqual([]);
  });
  it.each([
    ["unknown child", null, "unknown-child"],
    ["cross-origin child", { parentSessionId: "other-parent", childSessionId: "sub-child", childTitle: "worker" }, "cross-origin"],
  ] as const)("drops and audits %s before mailbox delivery", async (_label, resolved, reason) => {
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: { getSessionId: () => "parent-session", hasActiveTurn: () => false } as unknown as ConversationLoop,
      mailbox: { enqueue, peek: async () => [], acknowledge: async () => 0 } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: false }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => resolved,
    });
    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session", childSessionId: "sub-child", message: makeMessage(),
    })).resolves.toMatchObject({ ok: false, disposition: "dropped", reason });
    expect(enqueue).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:" + reason),
    }));
  });

  it("fails closed and audits when mailbox bounds are exhausted", async () => {
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: { getSessionId: () => "parent-session", hasActiveTurn: () => false } as unknown as ConversationLoop,
      mailbox: {
        enqueue: vi.fn(async () => ({ ok: false as const, reason: "mailbox-entry-budget" as const })),
        peek: async () => [],
        acknowledge: async () => 0,
      } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: false }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session", childSessionId: "sub-child", childTitle: "worker",
      }),
    });
    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session", childSessionId: "sub-child", message: makeMessage(),
    })).resolves.toMatchObject({ ok: false, disposition: "dropped", reason: "budget-exhausted" });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:budget-exhausted"),
    }));
  });

  it("acknowledges a running-parent message only after round-boundary injection", async () => {
    let dispositionCallbacks: {
      onInjected?: () => void;
      onDropped?: (reason: "joined-limit" | "turn-ended") => void;
      approvalReasonPrefix?: string;
    } | undefined;
    const mailbox = {
      enqueue,
      peek: vi.fn(async (parentSessionId: string) =>
        entries.filter((entry) => entry.parentSessionId === parentSessionId)),
      acknowledge: vi.fn(async (parentSessionId: string, ids: readonly string[]) => {
        const accepted = new Set(ids);
        const before = entries.length;
        entries = entries.filter(
          (entry) => entry.parentSessionId !== parentSessionId || !accepted.has(entry.id),
        );
        return before - entries.length;
      }),
    } as unknown as SubAgentMessageMailbox;
    const queueGuidanceWithDisposition = vi.fn(
      (_text: string, callbacks: NonNullable<typeof dispositionCallbacks>) => {
        dispositionCallbacks = callbacks;
        return "queued" as const;
      },
    );
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => true,
        queueGuidanceWithDisposition,
      } as unknown as ConversationLoop,
      mailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: false }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session", childSessionId: "sub-child", childTitle: "worker",
      }),
    });
    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session", childSessionId: "sub-child", message: makeMessage(),
    })).resolves.toMatchObject({ ok: true, disposition: "queued" });
    expect(entries).toHaveLength(1);
    expect(dispositionCallbacks?.approvalReasonPrefix).toBe("[Sub-Agent: worker]");
    dispositionCallbacks?.onInjected?.();
    expect(entries).toHaveLength(0);
    expect(mailbox.acknowledge).toHaveBeenCalledOnce();
  });

  it("keeps a running-parent message durable when the turn ends before injection", async () => {
    let dispositionCallbacks: {
      onInjected?: () => void;
      onDropped?: (reason: "joined-limit" | "turn-ended") => void;
      approvalReasonPrefix?: string;
    } | undefined;
    const acknowledge = vi.fn(async () => 0);
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => true,
        queueGuidanceWithDisposition: (
          _text: string,
          callbacks: NonNullable<typeof dispositionCallbacks>,
        ) => {
          dispositionCallbacks = callbacks;
          return "queued";
        },
      } as unknown as ConversationLoop,
      mailbox: { enqueue, peek: async () => entries, acknowledge } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: false }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session", childSessionId: "sub-child", childTitle: "worker",
      }),
    });
    await localBus.deliverToParent({
      parentSessionId: "parent-session", childSessionId: "sub-child", message: makeMessage(),
    });
    dispositionCallbacks?.onDropped?.("turn-ended");
    expect(entries).toHaveLength(1);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("deferred:turn-ended"),
    }));
  });

  it("requests an opt-in wake only for the current idle parent", async () => {
    const wake = vi.fn(async () => undefined);
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: { getSessionId: () => "parent-session", hasActiveTurn: () => false } as unknown as ConversationLoop,
      mailbox: { enqueue, peek: async () => entries, acknowledge: async () => 0 } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: true }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session", childSessionId: "sub-child", childTitle: "worker",
      }),
    });
    localBus.setWakeHandler(wake);
    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session", childSessionId: "sub-child", message: makeMessage(),
    })).resolves.toMatchObject({ ok: true, disposition: "wake-requested" });
    expect(wake).toHaveBeenCalledWith("parent-session");
  });

  it("rechecks once when a second message arrives during an autonomous wake", async () => {
    const wakeResolvers: Array<() => void> = [];
    const wake = vi.fn(() => new Promise<void>((resolve) => {
      wakeResolvers.push(resolve);
    }));
    const peek = vi.fn(async () => entries);
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox: {
        enqueue,
        peek,
        acknowledge: async () => 0,
      } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: true }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session", childSessionId: "sub-child", childTitle: "worker",
      }),
    });
    localBus.setWakeHandler(wake);

    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage({ messageId: "message-1" }),
    })).resolves.toMatchObject({ ok: true, disposition: "wake-requested" });
    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage({ messageId: "message-2" }),
    })).resolves.toMatchObject({ ok: true, disposition: "mailbox" });
    expect(wake).toHaveBeenCalledTimes(1);

    wakeResolvers.shift()?.();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
    expect(peek).toHaveBeenCalledWith("parent-session");

    wakeResolvers.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(entries).toHaveLength(2);
  });

  it("re-wakes a durable message once after its active turn ends before injection", async () => {
    let activeTurn = true;
    let dispositionCallbacks: {
      onInjected?: () => void;
      onDropped?: (reason: "joined-limit" | "turn-ended") => void;
      approvalReasonPrefix?: string;
    } | undefined;
    const wake = vi.fn(async () => undefined);
    const peek = vi.fn(async () => entries);
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => activeTurn,
        queueGuidanceWithDisposition: (
          _text: string,
          callbacks: NonNullable<typeof dispositionCallbacks>,
        ) => {
          dispositionCallbacks = callbacks;
          return "queued";
        },
      } as unknown as ConversationLoop,
      mailbox: {
        enqueue,
        peek,
        acknowledge: async () => 0,
      } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: true }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session", childSessionId: "sub-child", childTitle: "worker",
      }),
    });
    localBus.setWakeHandler(wake);

    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage(),
    })).resolves.toMatchObject({ ok: true, disposition: "queued" });
    expect(wake).not.toHaveBeenCalled();

    activeTurn = false;
    dispositionCallbacks?.onDropped?.("turn-ended");
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(peek).toHaveBeenCalledWith("parent-session");
    expect(entries).toHaveLength(1);

    await Promise.resolve();
    await Promise.resolve();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("bounds the full serialized envelope, not only rendered Part text", async () => {
    await expect(bus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage({
        metadata: { padding: "x".repeat(8_000) },
      }),
    })).resolves.toMatchObject({
      ok: false,
      disposition: "dropped",
      reason: "message-too-long",
    });
    expect(enqueue).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:message-too-long"),
    }));
  });

});
function createInMemoryNamespace() {
  let stored: unknown;
  let rejectNextWrite = false;
  return {
    handle: {
      dir: "memory",
      readJson: async (_name: string, fallback: unknown) =>
        structuredClone(stored === undefined ? fallback : stored),
      writeJson: async (_name: string, value: unknown) => {
        if (rejectNextWrite) {
          rejectNextWrite = false;
          throw new Error("mailbox-write-failed");
        }
        stored = structuredClone(value);
      },
      childDir: async (name: string) => name,
    } as never,
    rejectNextWrite: () => {
      rejectNextWrite = true;
    },
    setStored: (value: unknown) => {
      stored = structuredClone(value);
    },
  };
}

function makeMailboxEntry(
  id: string,
  formattedText: string,
  parentSessionId = "parent-session",
): ParentMailboxEntry {
  return {
    id,
    parentSessionId,
    childSessionId: "sub-child",
    childTitle: "worker",
    createdAt: "2026-07-11T00:00:00.000Z",
    message: makeMessage({ messageId: id }),
    formattedText,
    approvalLabel: "[Sub-Agent: worker]",
  };
}

function makeCanonicalMailboxEntry(
  id: string,
  body: string,
  parentSessionId = "parent-session",
): ParentMailboxEntry {
  const address: ResolvedSubAgentAddress = {
    parentSessionId,
    childSessionId: "sub-child",
    childTitle: "worker",
  };
  const message = makeMessage({
    messageId: id,
    contextId: parentSessionId,
    parts: [{ text: body }],
  });
  const formatted = formatAgentMessage(address, message);
  return {
    id,
    parentSessionId,
    childSessionId: address.childSessionId,
    childTitle: formatted.childTitle,
    createdAt: "2026-07-11T00:00:00.000Z",
    message,
    formattedText: formatted.text,
    approvalLabel: formatted.approvalLabel,
  };
}

describe("SubAgentMessageMailbox durability and bounds", () => {
  it("survives a new mailbox instance and persists acknowledgement", async () => {
    const namespace = createInMemoryNamespace();
    const first = new SubAgentMessageMailbox(namespace.handle);
    await expect(first.enqueue(makeCanonicalMailboxEntry("message-1", "first"))).resolves.toEqual({
      ok: true,
    });

    const reloaded = new SubAgentMessageMailbox(namespace.handle);
    await expect(reloaded.peek("parent-session")).resolves.toMatchObject([
      { id: "message-1", formattedText: expect.stringContaining("first") },
    ]);
    await expect(reloaded.acknowledge("parent-session", ["message-1"])).resolves.toBe(1);

    const afterAck = new SubAgentMessageMailbox(namespace.handle);
    await expect(afterAck.peek("parent-session")).resolves.toEqual([]);
  });

  it("does not expose an enqueue whose durable write failed", async () => {
    const namespace = createInMemoryNamespace();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    namespace.rejectNextWrite();

    await expect(mailbox.enqueue(
      makeMailboxEntry("message-failed-enqueue", "not durable"),
    )).rejects.toThrow("mailbox-write-failed");
    await expect(mailbox.peek("parent-session")).resolves.toEqual([]);

    const reloaded = new SubAgentMessageMailbox(namespace.handle);
    await expect(reloaded.peek("parent-session")).resolves.toEqual([]);
  });

  it("keeps an entry available when its acknowledgement write fails", async () => {
    const namespace = createInMemoryNamespace();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    await expect(mailbox.enqueue(
      makeCanonicalMailboxEntry("message-failed-ack", "retry me"),
    )).resolves.toEqual({ ok: true });
    namespace.rejectNextWrite();

    await expect(mailbox.acknowledge(
      "parent-session",
      ["message-failed-ack"],
    )).rejects.toThrow("mailbox-write-failed");
    await expect(mailbox.peek("parent-session")).resolves.toMatchObject([
      { id: "message-failed-ack", formattedText: expect.stringContaining("retry me") },
    ]);

    const reloaded = new SubAgentMessageMailbox(namespace.handle);
    await expect(reloaded.peek("parent-session")).resolves.toMatchObject([
      { id: "message-failed-ack", formattedText: expect.stringContaining("retry me") },
    ]);
    await expect(mailbox.acknowledge(
      "parent-session",
      ["message-failed-ack"],
    )).resolves.toBe(1);
    await expect(mailbox.peek("parent-session")).resolves.toEqual([]);
  });
  it("reloads only canonical DLP-clean entries from a mixed persisted mailbox", async () => {
    const namespace = createInMemoryNamespace();
    const valid = makeCanonicalMailboxEntry("message-valid", "safe result");
    const cloneInvalid = (id: string): ParentMailboxEntry => ({
      ...structuredClone(valid),
      id,
    });

    const wrongRole = cloneInvalid("invalid-role");
    wrongRole.message.role = A2A_ROLE_USER;
    const wrongContext = cloneInvalid("invalid-context");
    wrongContext.message.contextId = "other-parent";
    const wrongTask = cloneInvalid("invalid-task");
    wrongTask.message.taskId = "sub-other";
    const dlpDirty = cloneInvalid("invalid-dlp");
    dlpDirty.message.parts = [{ text: "ghp_" + "a".repeat(24) }];
    const forgedText = cloneInvalid("invalid-formatted-text");
    forgedText.formattedText = "forged persisted prompt";
    const forgedLabel = cloneInvalid("invalid-label");
    forgedLabel.approvalLabel = "[Sub-Agent: forged]";
    const rawPart = cloneInvalid("invalid-raw");
    rawPart.message.parts = [{ raw: "AQID" }];
    const extraEnvelopeField = cloneInvalid("invalid-extra-field");
    (extraEnvelopeField.message as A2AMessage & { unexpected: string }).unexpected =
      "not-in-the-a2a-envelope";

    namespace.setStored({
      version: 1,
      entries: [
        wrongRole,
        wrongContext,
        wrongTask,
        dlpDirty,
        forgedText,
        forgedLabel,
        rawPart,
        extraEnvelopeField,
        valid,
      ],
    });

    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    await expect(mailbox.peek("parent-session")).resolves.toEqual([valid]);
    await expect(mailbox.peek("other-parent")).resolves.toEqual([]);
  });
  it("fails closed at GUIDE entry and joined-character budgets", async () => {
    const entryNamespace = createInMemoryNamespace();
    const entryBounded = new SubAgentMessageMailbox(entryNamespace.handle);
    for (let index = 0; index < 16; index += 1) {
      await expect(entryBounded.enqueue(
        makeMailboxEntry("message-" + index, "x"),
      )).resolves.toEqual({ ok: true });
    }
    await expect(entryBounded.enqueue(
      makeMailboxEntry("message-overflow", "x"),
    )).resolves.toEqual({ ok: false, reason: "mailbox-entry-budget" });

    const charNamespace = createInMemoryNamespace();
    const charBounded = new SubAgentMessageMailbox(charNamespace.handle);
    await expect(charBounded.enqueue(
      makeMailboxEntry("message-a", "a".repeat(7_999)),
    )).resolves.toEqual({ ok: true });
    await expect(charBounded.enqueue(
      makeMailboxEntry("message-b", "b".repeat(7_999)),
    )).resolves.toEqual({ ok: true });
    await expect(charBounded.enqueue(
      makeMailboxEntry("message-c", "c"),
    )).resolves.toEqual({ ok: false, reason: "mailbox-char-budget" });
  });
});

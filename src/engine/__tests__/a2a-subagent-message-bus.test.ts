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

  it("drops and audits a self-consistent persisted entry from an unknown child", async () => {
    const fixture = createPersistedBusFixture(
      [makeCanonicalMailboxEntry("message-unknown", "unknown")],
      async () => null,
    );

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    await expect(fixture.mailbox.peek("parent-session")).resolves.toEqual([]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:unknown-child"),
    }));
  });

  it("drops and audits a persisted entry whose child belongs to another parent", async () => {
    const fixture = createPersistedBusFixture(
      [makeCanonicalMailboxEntry("message-cross-origin", "cross origin")],
      async () => ({
        parentSessionId: "other-parent",
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    );

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    await expect(fixture.mailbox.peek("parent-session")).resolves.toEqual([]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:cross-origin"),
    }));
  });

  it("rejects a persisted title and approval label that disagree with authoritative identity", async () => {
    const forged = makeCanonicalMailboxEntry(
      "message-forged-title",
      "forged title",
      "parent-session",
      "forged",
    );
    const fixture = createPersistedBusFixture([forged], async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    await expect(fixture.mailbox.peek("parent-session")).resolves.toEqual([]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:invalid-message"),
    }));
  });

  it("fails closed but retains a persisted entry when authoritative lookup fails", async () => {
    const fixture = createPersistedBusFixture(
      [makeCanonicalMailboxEntry("message-resolver-failed", "retry lookup")],
      async () => {
        throw new Error("address-store-unavailable");
      },
    );

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    await expect(fixture.mailbox.peek("parent-session")).resolves.toMatchObject([
      { id: "message-resolver-failed" },
    ]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:storage-failed"),
    }));
  });

  it("keeps a rejected entry quarantined when its removal cannot be persisted", async () => {
    const namespace = createInMemoryNamespace();
    namespace.setStored({
      version: 1,
      entries: [makeCanonicalMailboxEntry("message-reject-ack-failed", "quarantine")],
    });
    namespace.rejectNextWrite();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    const audit = vi.fn();
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => null,
    });

    await expect(localBus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    await expect(mailbox.peek("parent-session")).resolves.toMatchObject([
      { id: "message-reject-ack-failed" },
    ]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("drop-ack-failed"),
    }));
  });

  it("returns a canonical persisted entry only after authoritative revalidation", async () => {
    const entry = makeCanonicalMailboxEntry("message-valid-reload", "valid");
    const resolveChildAddress = vi.fn(async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));
    const fixture = createPersistedBusFixture([entry], resolveChildAddress);

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([entry]);
    await expect(fixture.mailbox.peek("parent-session")).resolves.toEqual([entry]);
    expect(resolveChildAddress).toHaveBeenCalledWith("parent-session", "sub-child", "message-valid-reload");
  });

  it("returns no accepted guidance when authoritative rejection cleanup cannot persist", async () => {
    const valid = makeCanonicalMailboxEntry("authoritative-valid", "valid");
    const rejected = makeCanonicalMailboxEntry(
      "authoritative-rejected",
      "rejected",
      "parent-session",
      "forged",
    );
    const namespace = createInMemoryNamespace();
    namespace.setStored({ version: 1, entries: [valid, rejected] });
    namespace.rejectNextWrite();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    const audit = vi.fn();
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    });

    await expect(localBus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    const stored = namespace.getStored() as { entries: ParentMailboxEntry[] };
    expect(stored.entries).toEqual([valid, rejected]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("drop-ack-failed"),
    }));
  });

  it("returns no accepted guidance when authoritative rejection cleanup is partial", async () => {
    const valid = makeCanonicalMailboxEntry("partial-valid", "valid");
    const rejected = makeCanonicalMailboxEntry(
      "partial-rejected",
      "rejected",
      "parent-session",
      "forged",
    );
    const acknowledge = vi.fn(async () => 0);
    const audit = vi.fn();
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox: {
        enqueue: vi.fn(async () => ({ ok: true as const })),
        peek: vi.fn(async () => [valid, rejected]),
        acknowledge,
      } as unknown as SubAgentMessageMailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    });

    await expect(localBus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    expect(acknowledge).toHaveBeenCalledWith("parent-session", ["partial-rejected"]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("drop-ack-failed"),
    }));
  });
  it("quarantines every persisted copy of a duplicate storage id before acceptance", async () => {
    const duplicateValid = makeCanonicalMailboxEntry(
      "duplicate-storage-id",
      "valid duplicate",
      "parent-session",
      "worker",
      "semantic-valid",
    );
    const duplicateRejected = makeCanonicalMailboxEntry(
      "duplicate-storage-id",
      "rejected duplicate",
      "parent-session",
      "worker",
      "semantic-rejected",
    );
    duplicateRejected.approvalLabel = "[Sub-Agent: forged]";
    const survivor = makeCanonicalMailboxEntry("survivor-storage-id", "survivor");
    const fixture = createPersistedBusFixture(
      [duplicateValid, duplicateRejected, survivor],
      async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    );

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([survivor]);
    const stored = fixture.namespace.getStored() as { entries: ParentMailboxEntry[] };
    expect(stored.entries).toEqual([survivor]);
    const invalidAudits = fixture.audit.mock.calls.filter(
      ([entry]) => (entry as { input: string }).input.includes("dropped:invalid-message"),
    );
    expect(invalidAudits).toHaveLength(2);
  });

  it("retains all duplicate storage-id entries and injects none when quarantine persistence fails", async () => {
    const first = makeCanonicalMailboxEntry(
      "duplicate-storage-id",
      "first",
      "parent-session",
      "worker",
      "semantic-first",
    );
    const second = makeCanonicalMailboxEntry(
      "duplicate-storage-id",
      "second",
      "parent-session",
      "worker",
      "semantic-second",
    );
    const survivor = makeCanonicalMailboxEntry("survivor-storage-id", "survivor");
    const resolveChildAddress = vi.fn(async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));
    const fixture = createPersistedBusFixture(
      [first, second, survivor],
      resolveChildAddress,
    );
    fixture.namespace.rejectNextWrite();

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    const stored = fixture.namespace.getStored() as { entries: ParentMailboxEntry[] };
    expect(stored.entries).toEqual([first, second, survivor]);
    expect(resolveChildAddress).not.toHaveBeenCalled();
    expect(fixture.audit).not.toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:invalid-message"),
    }));
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("drop-cleanup-failed"),
    }));
  });

  it("keeps only the first persisted semantic message after durable duplicate cleanup", async () => {
    const first = makeCanonicalMailboxEntry(
      "storage-first",
      "same semantic body",
      "parent-session",
      "worker",
      "semantic-message",
    );
    const replay = makeCanonicalMailboxEntry(
      "storage-replay",
      "same semantic body",
      "parent-session",
      "worker",
      "semantic-message",
    );
    const fixture = createPersistedBusFixture([first, replay], async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([first]);
    const stored = fixture.namespace.getStored() as { entries: ParentMailboxEntry[] };
    expect(stored.entries).toEqual([first]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:invalid-message"),
    }));
  });

  it("injects no persisted semantic replay when duplicate cleanup cannot be persisted", async () => {
    const first = makeCanonicalMailboxEntry(
      "storage-first",
      "same semantic body",
      "parent-session",
      "worker",
      "semantic-message",
    );
    const replay = makeCanonicalMailboxEntry(
      "storage-replay",
      "same semantic body",
      "parent-session",
      "worker",
      "semantic-message",
    );
    const fixture = createPersistedBusFixture([first, replay], async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));
    fixture.namespace.rejectNextWrite();

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    const stored = fixture.namespace.getStored() as { entries: ParentMailboxEntry[] };
    expect(stored.entries).toEqual([first, replay]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("drop-cleanup-failed"),
    }));
  });

  it("audits semantic duplicate diagnostics only after cleanup retry succeeds", async () => {
    const first = makeCanonicalMailboxEntry(
      "retry-storage-first",
      "same retry body",
      "parent-session",
      "worker",
      "retry-semantic-message",
    );
    const replay = makeCanonicalMailboxEntry(
      "retry-storage-replay",
      "same retry body",
      "parent-session",
      "worker",
      "retry-semantic-message",
    );
    const fixture = createPersistedBusFixture([first, replay], async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));
    fixture.namespace.rejectNextWrite();

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    expect(fixture.audit.mock.calls.filter(
      ([entry]) => (entry as { input: string }).input.includes("dropped:invalid-message"),
    )).toHaveLength(0);
    expect(fixture.audit.mock.calls.filter(
      ([entry]) => (entry as { input: string }).input.includes("drop-cleanup-failed"),
    )).toHaveLength(1);

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([first]);
    expect(fixture.namespace.getReadCount()).toBe(2);
    expect(fixture.namespace.getWriteCount()).toBe(2);
    expect(fixture.audit.mock.calls.filter(
      ([entry]) => (entry as { input: string }).input.includes("dropped:invalid-message"),
    )).toHaveLength(1);
    expect(fixture.audit.mock.calls.filter(
      ([entry]) => (entry as { input: string }).input.includes("drop-cleanup-failed"),
    )).toHaveLength(1);
  });
  it("audits a persisted parent and Message context mismatch as cross-origin", async () => {
    const wrongContext = makeCanonicalMailboxEntry("wrong-context", "context mismatch");
    wrongContext.message.contextId = "other-parent";
    const fixture = createPersistedBusFixture([wrongContext], async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:cross-origin"),
    }));
  });

  it("audits DLP-dirty and forged persisted entries as invalid without raw content", async () => {
    const secret = "ghp_" + "a".repeat(24);
    const dlpDirty = makeCanonicalMailboxEntry("dlp-dirty", "safe");
    dlpDirty.message.parts = [{ text: secret }];
    const forged = makeCanonicalMailboxEntry("forged-format", "safe");
    forged.formattedText = "forged persisted guidance";
    const fixture = createPersistedBusFixture([dlpDirty, forged], async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    const invalidAudits = fixture.audit.mock.calls.filter(
      ([entry]) => (entry as { input: string }).input.includes("dropped:invalid-message"),
    );
    expect(invalidAudits).toHaveLength(2);
    for (const [entry] of invalidAudits) {
      expect((entry as { input: string }).input).not.toContain(secret);
      expect((entry as { input: string }).input).not.toContain("forged persisted guidance");
    }
  });

  it("retains a mixed persisted mailbox and injects none when invalid cleanup fails", async () => {
    const valid = makeCanonicalMailboxEntry("valid-cleanup-failure", "valid");
    const invalid = makeCanonicalMailboxEntry("invalid-cleanup-failure", "safe");
    invalid.formattedText = "forged persisted guidance";
    const fixture = createPersistedBusFixture([valid, invalid], async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));
    fixture.namespace.rejectNextWrite();

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    const stored = fixture.namespace.getStored() as { entries: ParentMailboxEntry[] };
    expect(stored.entries).toEqual([valid, invalid]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("drop-cleanup-failed"),
    }));
  });

  it("audits persisted GUIDE entry overflow as budget-exhausted", async () => {
    const persisted = Array.from({ length: 17 }, (_, index) =>
      makeCanonicalMailboxEntry("entry-" + index, "body-" + index));
    const fixture = createPersistedBusFixture(persisted, async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toHaveLength(16);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:budget-exhausted"),
    }));
  });

  it("audits persisted GUIDE joined-character overflow as budget-exhausted", async () => {
    const persisted = [
      makeCanonicalMailboxEntry("joined-a", "a".repeat(7_800)),
      makeCanonicalMailboxEntry("joined-b", "b".repeat(7_800)),
      makeCanonicalMailboxEntry("joined-overflow", "c".repeat(500)),
    ];
    const fixture = createPersistedBusFixture(persisted, async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toHaveLength(2);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:budget-exhausted"),
    }));
  });

  it("audits persisted tracked-parent overflow as budget-exhausted", async () => {
    const persisted = Array.from({ length: 101 }, (_, index) =>
      makeCanonicalMailboxEntry(
        "tracked-entry-" + index,
        "body-" + index,
        "tracked-parent-" + index,
      ));
    const fixture = createPersistedBusFixture(persisted, async (parentSessionId) => ({
      parentSessionId,
      childSessionId: "sub-child",
      childTitle: "worker",
    }));

    await expect(fixture.bus.peekParentMailbox("tracked-parent-100")).resolves.toEqual([]);
    const stored = fixture.namespace.getStored() as { entries: ParentMailboxEntry[] };
    expect(stored.entries).toHaveLength(100);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:budget-exhausted"),
    }));
  });
  it("audits a metadata-only oversized persisted envelope as budget-exhausted", async () => {
    const oversized = makeCanonicalMailboxEntry("oversized-metadata", "small rendered body");
    oversized.message.metadata = { padding: "x".repeat(9_000) };
    const fixture = createPersistedBusFixture([oversized], async () => ({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      childTitle: "worker",
    }));

    await expect(fixture.bus.peekParentMailbox("parent-session")).resolves.toEqual([]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:budget-exhausted"),
    }));
    const auditInput = (fixture.audit.mock.calls[0]?.[0] as { input: string }).input;
    expect(auditInput).not.toContain("x".repeat(100));
  });

  it("audits every attributed parent before durable cleanup erases diagnostics", async () => {
    const secret = "ghp_" + "a".repeat(24);
    const invalidA = makeCanonicalMailboxEntry(
      "a-diagnostic",
      "safe A",
      "parent-a",
    );
    invalidA.formattedText = "forged A";
    const invalidB = makeCanonicalMailboxEntry(
      "b-diagnostic",
      "safe B",
      "parent-b",
    );
    invalidB.message.parts = [{ text: secret }];
    const fixture = createPersistedBusFixture(
      [invalidA, invalidB],
      async (parentSessionId) => ({
        parentSessionId,
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    );

    await expect(fixture.bus.peekParentMailbox("parent-a")).resolves.toEqual([]);
    const auditEntries = fixture.audit.mock.calls.map(
      ([entry]) => entry as { sessionId: string; input: string },
    );
    expect(auditEntries).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "parent-a",
        input: expect.stringContaining("message=a-diagnostic"),
      }),
      expect.objectContaining({
        sessionId: "parent-b",
        input: expect.stringContaining("message=b-diagnostic"),
      }),
    ]));
    expect(auditEntries.every(
      (entry) => !(entry.sessionId === "parent-a" && entry.input.includes("message=b-diagnostic")),
    )).toBe(true);
    expect(auditEntries.every(
      (entry) => !(entry.sessionId === "parent-b" && entry.input.includes("message=a-diagnostic")),
    )).toBe(true);
    expect(auditEntries.every((entry) => !entry.input.includes(secret))).toBe(true);
    const stored = fixture.namespace.getStored() as { entries: ParentMailboxEntry[] };
    expect(stored.entries).toEqual([]);

    const restartedAudit = vi.fn();
    const restartedBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-b",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox: new SubAgentMessageMailbox(fixture.namespace.handle),
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: restartedAudit } as never,
      resolveChildAddress: async (parentSessionId) => ({
        parentSessionId,
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    });
    await expect(restartedBus.peekParentMailbox("parent-b")).resolves.toEqual([]);
    expect(restartedAudit).not.toHaveBeenCalled();
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

  it("rejects a live resolver child-id mismatch before mailbox storage", async () => {
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox: {
        enqueue,
        peek: async () => [],
        acknowledge: async () => 0,
      } as unknown as SubAgentMessageMailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-other",
        childTitle: "worker",
      }),
    });

    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage(),
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

  it("requests opt-in wake while an active parent queue is full and lets the handler await turn release", async () => {
    let activeTurn = true;
    let releaseTurn!: () => void;
    const turnReleased = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const peek = vi.fn(async () => entries);
    let wakeCompleted = false;
    let localBus!: A2ASubAgentMessageBus;
    const wake = vi.fn(async (parentSessionId: string) => {
      expect(activeTurn).toBe(true);
      expect(peek).not.toHaveBeenCalled();
      await turnReleased;
      expect(activeTurn).toBe(false);
      expect(await localBus.peekParentMailbox(parentSessionId)).toHaveLength(1);
      wakeCompleted = true;
    });
    localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => activeTurn,
        queueGuidanceWithDisposition: () => "queue-full",
      } as unknown as ConversationLoop,
      mailbox: { enqueue, peek, acknowledge: async () => 0 } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: true }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    });
    localBus.setWakeHandler(wake);

    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage(),
    })).resolves.toMatchObject({ ok: true, disposition: "wake-requested" });
    expect(entries).toHaveLength(1);
    expect(wake).toHaveBeenCalledOnce();
    expect(peek).not.toHaveBeenCalled();

    activeTurn = false;
    releaseTurn();
    await vi.waitFor(() => expect(wakeCompleted).toBe(true));
    expect(peek).toHaveBeenCalledWith("parent-session");
  });

  it("keeps queue-full delivery manual when autonomous wake is disabled", async () => {
    const wake = vi.fn(async () => undefined);
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "parent-session",
        hasActiveTurn: () => true,
        queueGuidanceWithDisposition: () => "queue-full",
      } as unknown as ConversationLoop,
      mailbox: { enqueue, peek: async () => entries, acknowledge: async () => 0 } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: false }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    });
    localBus.setWakeHandler(wake);

    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage(),
    })).resolves.toMatchObject({ ok: true, disposition: "mailbox" });
    expect(entries).toHaveLength(1);
    expect(wake).not.toHaveBeenCalled();
  });

  it("requests opt-in wake when joined guidance exceeds the active turn limit", async () => {
    let activeTurn = true;
    let dispositionCallbacks: {
      onInjected?: () => void;
      onDropped?: (reason: "joined-limit" | "turn-ended") => void;
      approvalReasonPrefix?: string;
    } | undefined;
    let releaseTurn!: () => void;
    const turnReleased = new Promise<void>((resolve) => {
      releaseTurn = resolve;
    });
    const peek = vi.fn(async () => entries);
    let wakeCompleted = false;
    let localBus!: A2ASubAgentMessageBus;
    const wake = vi.fn(async (parentSessionId: string) => {
      expect(activeTurn).toBe(true);
      expect(peek).not.toHaveBeenCalled();
      await turnReleased;
      expect(activeTurn).toBe(false);
      expect(await localBus.peekParentMailbox(parentSessionId)).toHaveLength(1);
      wakeCompleted = true;
    });
    localBus = new A2ASubAgentMessageBus({
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
      mailbox: { enqueue, peek, acknowledge: async () => 0 } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: true }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    });
    localBus.setWakeHandler(wake);

    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage(),
    })).resolves.toMatchObject({ ok: true, disposition: "queued" });
    dispositionCallbacks?.onDropped?.("joined-limit");
    expect(entries).toHaveLength(1);
    expect(wake).toHaveBeenCalledOnce();
    expect(peek).not.toHaveBeenCalled();

    activeTurn = false;
    releaseTurn();
    await vi.waitFor(() => expect(wakeCompleted).toBe(true));
    expect(peek).toHaveBeenCalledWith("parent-session");
  });

  it("keeps joined-limit delivery manual when autonomous wake is disabled", async () => {
    let dispositionCallbacks: {
      onInjected?: () => void;
      onDropped?: (reason: "joined-limit" | "turn-ended") => void;
      approvalReasonPrefix?: string;
    } | undefined;
    const wake = vi.fn(async () => undefined);
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
      mailbox: { enqueue, peek: async () => entries, acknowledge: async () => 0 } as unknown as SubAgentMessageMailbox,
      settingsService: { get: () => ({ subAgentAutonomousWake: false }) } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    });
    localBus.setWakeHandler(wake);

    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: makeMessage(),
    })).resolves.toMatchObject({ ok: true, disposition: "queued" });
    dispositionCallbacks?.onDropped?.("joined-limit");
    expect(entries).toHaveLength(1);
    expect(wake).not.toHaveBeenCalled();
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

  it("drops a live semantic replay while the first message remains durable", async () => {
    const namespace = createInMemoryNamespace();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);
    const localBus = new A2ASubAgentMessageBus({
      parentLoop: {
        getSessionId: () => "different-active-session",
        hasActiveTurn: () => false,
      } as unknown as ConversationLoop,
      mailbox,
      settingsService: {
        get: () => ({ subAgentAutonomousWake: false }),
      } as never,
      auditLogger: { log: audit } as never,
      resolveChildAddress: async () => ({
        parentSessionId: "parent-session",
        childSessionId: "sub-child",
        childTitle: "worker",
      }),
    });
    const replay = makeMessage({ messageId: "semantic-replay" });

    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: replay,
    })).resolves.toMatchObject({ ok: true, disposition: "mailbox" });
    await expect(localBus.deliverToParent({
      parentSessionId: "parent-session",
      childSessionId: "sub-child",
      message: structuredClone(replay),
    })).resolves.toMatchObject({
      ok: false,
      disposition: "dropped",
      reason: "duplicate-message",
    });

    await expect(mailbox.peek("parent-session")).resolves.toHaveLength(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:duplicate-message"),
    }));
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
  let readCount = 0;
  let writeCount = 0;
  let rejectNextRead = false;
  let rejectNextWrite = false;
  return {
    handle: {
      dir: "memory",
      readJson: async (_name: string, fallback: unknown) => {
        readCount += 1;
        if (rejectNextRead) {
          rejectNextRead = false;
          throw new Error("mailbox-read-failed");
        }
        return structuredClone(stored === undefined ? fallback : stored);
      },
      writeJson: async (_name: string, value: unknown) => {
        writeCount += 1;
        if (rejectNextWrite) {
          rejectNextWrite = false;
          throw new Error("mailbox-write-failed");
        }
        stored = structuredClone(value);
      },
      childDir: async (name: string) => name,
    } as never,
    rejectNextRead: () => {
      rejectNextRead = true;
    },
    rejectNextWrite: () => {
      rejectNextWrite = true;
    },
    setStored: (value: unknown) => {
      stored = structuredClone(value);
    },
    getStored: () => structuredClone(stored),
    getReadCount: () => readCount,
    getWriteCount: () => writeCount,
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
  childTitle = "worker",
  messageId = id,
): ParentMailboxEntry {
  const address: ResolvedSubAgentAddress = {
    parentSessionId,
    childSessionId: "sub-child",
    childTitle,
  };
  const message = makeMessage({
    messageId,
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

function createPersistedBusFixture(
  persistedEntries: ParentMailboxEntry[],
  resolveChildAddress: (
    parentSessionId: string,
    childSessionId: string,
  ) => Promise<ResolvedSubAgentAddress | null>,
) {
  const namespace = createInMemoryNamespace();
  namespace.setStored({ version: 1, entries: persistedEntries });
  const mailbox = new SubAgentMessageMailbox(namespace.handle);
  const audit = vi.fn();
  const bus = new A2ASubAgentMessageBus({
    parentLoop: {
      getSessionId: () => "parent-session",
      hasActiveTurn: () => false,
    } as unknown as ConversationLoop,
    mailbox,
    settingsService: {
      get: () => ({ subAgentAutonomousWake: false }),
    } as never,
    auditLogger: { log: audit } as never,
    resolveChildAddress,
  });
  return { audit, bus, mailbox, namespace };
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

  it("retries a rejected persisted mailbox read on the next peek", async () => {
    const namespace = createInMemoryNamespace();
    const entry = makeCanonicalMailboxEntry("read-retry", "retry read");
    namespace.setStored({ version: 1, entries: [entry] });
    namespace.rejectNextRead();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);

    await expect(mailbox.peek("parent-session")).rejects.toThrow("mailbox-read-failed");
    await expect(mailbox.peek("parent-session")).resolves.toEqual([entry]);
  });

  it("retries failed normalization cleanup and exposes entries only after it persists", async () => {
    const first = makeCanonicalMailboxEntry(
      "cleanup-first",
      "same body",
      "parent-session",
      "worker",
      "cleanup-semantic",
    );
    const replay = makeCanonicalMailboxEntry(
      "cleanup-replay",
      "same body",
      "parent-session",
      "worker",
      "cleanup-semantic",
    );
    const namespace = createInMemoryNamespace();
    namespace.setStored({ version: 1, entries: [first, replay] });
    namespace.rejectNextWrite();
    const mailbox = new SubAgentMessageMailbox(namespace.handle);

    await expect(mailbox.peekWithDiagnostics("parent-session")).resolves.toMatchObject({
      entries: [],
      cleanupFailed: true,
    });
    await expect(mailbox.peekWithDiagnostics("parent-session")).resolves.toMatchObject({
      entries: [first],
      cleanupFailed: false,
    });
    const stored = namespace.getStored() as { entries: ParentMailboxEntry[] };
    expect(stored.entries).toEqual([first]);
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

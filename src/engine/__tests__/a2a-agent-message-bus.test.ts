import { describe, expect, it, vi } from "vitest";
import {
  A2ATaskState,
  type A2AProjectedTaskState,
} from "../../shared/a2a.js";
import type { ConversationLoop } from "../conversation-loop.js";
import {
  A2A_AGENT_ENVELOPE_VERSION,
  A2A_AGENT_MAX_HOPS,
  A2A_AGENT_MAX_TRACKED_TREES,
  A2A_AGENT_TREE_MESSAGE_BUDGET,
  A2A_PARENT_RECIPIENT,
  causalContextForEnvelopes,
  mergeA2AAgentCausalContexts,
  type A2AAgentCausalContext,
  type A2AAgentSendRequest,
  type ResolveSubAgentPeerResult,
  type ResolvedA2ASender,
} from "../a2a-agent-message-envelope.js";
import { A2AAgentMessageBus } from "../a2a-agent-message-bus.js";
import { A2AAgentMessageMailbox } from "../a2a-agent-message-mailbox.js";

const ORIGIN = "origin-session";
const SENDER = "sub-sender";
const RECIPIENT = "sub-recipient";

type QueueResult = "queued" | "queue-full" | "no-active-turn";
type CapturedGuidance = {
  text: string;
  disposition: {
    approvalReasonPrefix?: string;
    a2aCausalContext?: A2AAgentCausalContext;
    onInjected?: () => void | Promise<void>;
    onDropped?: (reason: string) => void;
  };
};

function createInMemoryNamespace() {
  let stored: unknown;
  return {
    handle: {
      dir: "memory",
      readJson: async (_name: string, fallback: unknown) =>
        structuredClone(stored === undefined ? fallback : stored),
      writeJson: async (_name: string, value: unknown) => {
        stored = structuredClone(value);
      },
      childDir: async (name: string) => name,
    } as never,
    getStored: () => structuredClone(stored),
  };
}

function routeFor(
  taskState: A2AProjectedTaskState,
  activeLoop?: ConversationLoop,
  originSessionId = ORIGIN,
): Extract<ResolveSubAgentPeerResult, { ok: true }> {
  return {
    ok: true,
    originSessionId,
    sender: { childSessionId: SENDER, title: "sender-worker" },
    recipient: {
      childSessionId: RECIPIENT,
      title: "recipient-worker",
      taskState,
      ...(activeLoop ? { activeLoop } : {}),
    },
  };
}

function makeSend(
  messageId: string,
  overrides: Partial<A2AAgentSendRequest> = {},
): A2AAgentSendRequest {
  return {
    senderChildSessionId: SENDER,
    recipient: RECIPIENT,
    messageId,
    parts: [{ text: "hello" }],
    ...overrides,
  };
}

function createHarness(options: {
  sender?: ResolvedA2ASender | null;
  route?: ResolveSubAgentPeerResult;
  queueResult?: QueueResult;
  parentResult?: unknown;
} = {}) {
  const namespace = createInMemoryNamespace();
  const mailbox = new A2AAgentMessageMailbox(namespace.handle);
  const audit = vi.fn();
  let captured: CapturedGuidance | undefined;
  const loop = {
    hasActiveTurn: () => true,
    queueGuidanceWithDisposition: vi.fn((
      text: string,
      disposition: CapturedGuidance["disposition"],
    ) => {
      captured = { text, disposition };
      return options.queueResult ?? "queued";
    }),
  } as unknown as ConversationLoop;
  const sender = options.sender === undefined
    ? {
        originSessionId: ORIGIN,
        childSessionId: SENDER,
        title: "sender-worker",
        background: true,
        taskState: A2ATaskState.WORKING,
      } satisfies ResolvedA2ASender
    : options.sender;
  const route = options.route ?? routeFor(A2ATaskState.WORKING, loop);
  const parentDeliver = vi.fn(async (input: {
    message: { messageId: string };
  }) => options.parentResult ?? {
    ok: true,
    disposition: "mailbox",
    messageId: input.message.messageId,
  });
  const resolveSender = vi.fn(async () => sender);
  const resolvePeer = vi.fn(async () => route);
  const bus = new A2AAgentMessageBus({
    parentBus: { deliverToParent: parentDeliver } as never,
    mailbox,
    auditLogger: { log: audit } as never,
    resolveSender,
    resolvePeer,
  });

  return {
    audit,
    bus,
    captured: () => captured,
    loop,
    mailbox,
    namespace,
    parentDeliver,
    resolvePeer,
    resolveSender,
    route,
  };
}

describe("A2A agent message bus", () => {
  it("stores before active delivery, masks DLP data, propagates a host causal hop, and acknowledges only on injection", async () => {
    const harness = createHarness();
    const secret = "ghp_" + "a".repeat(24);

    const result = await harness.bus.send(makeSend("message-active", {
      parts: [{ text: "use " + secret }],
      causalContext: {
        kind: "a2a-causal-hop",
        version: A2A_AGENT_ENVELOPE_VERSION,
        originSessionId: ORIGIN,
        recipientChildSessionId: SENDER,
        hopCount: 2,
      },
    }));

    expect(result).toMatchObject({
      ok: true,
      disposition: "queued",
      messageId: "message-active",
    });
    const captured = harness.captured();
    expect(captured?.text).toContain("[REDACTED:TOKEN]");
    expect(captured?.text).not.toContain(secret);
    expect(captured?.disposition.approvalReasonPrefix)
      .toBe("[Sub-Agent: sender-worker]");
    expect(captured?.disposition.a2aCausalContext).toEqual({
      kind: "a2a-causal-hop",
      version: A2A_AGENT_ENVELOPE_VERSION,
      originSessionId: ORIGIN,
      recipientChildSessionId: RECIPIENT,
      hopCount: 3,
    });

    const before = await harness.mailbox.peekWithDiagnostics(RECIPIENT);
    expect(before.entries).toHaveLength(1);
    expect(JSON.stringify(before.entries[0]?.message)).not.toContain(secret);

    await captured?.disposition.onInjected?.();
    const after = await harness.mailbox.peekWithDiagnostics(RECIPIENT);
    expect(after.entries).toHaveLength(0);
  });

  it("keeps the injection boundary pending until the durable mailbox ACK attempt settles", async () => {
    const harness = createHarness();
    const originalAcknowledge = harness.mailbox.acknowledge.bind(harness.mailbox);
    let releaseAck!: () => void;
    const ackGate = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    vi.spyOn(harness.mailbox, "acknowledge").mockImplementation(
      async (recipientChildSessionId, ids) => {
        await ackGate;
        return originalAcknowledge(recipientChildSessionId, ids);
      },
    );

    await expect(harness.bus.send(makeSend("message-ack-order"))).resolves.toMatchObject({
      ok: true,
      disposition: "queued",
    });
    const injected = harness.captured()?.disposition.onInjected?.();
    expect(injected).toBeInstanceOf(Promise);
    let settled = false;
    void Promise.resolve(injected).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect((await harness.mailbox.peekWithDiagnostics(RECIPIENT)).entries)
      .toHaveLength(1);

    releaseAck();
    await injected;
    expect(settled).toBe(true);
    expect((await harness.mailbox.peekWithDiagnostics(RECIPIENT)).entries)
      .toHaveLength(0);
  });

  it("keeps INPUT_REQUIRED delivery durable and derives the next causal hop after reload", async () => {
    const harness = createHarness({
      route: routeFor(A2ATaskState.INPUT_REQUIRED),
    });

    await expect(harness.bus.send(makeSend("message-idle"))).resolves.toMatchObject({
      ok: true,
      disposition: "mailbox",
    });

    const reloaded = new A2AAgentMessageMailbox(harness.namespace.handle);
    const stored = await reloaded.peekWithDiagnostics(RECIPIENT);
    expect(stored.diagnostics).toEqual([]);
    expect(stored.entries).toHaveLength(1);
    expect(causalContextForEnvelopes(RECIPIENT, stored.entries.map(
      (entry) => entry.envelope,
    ))).toEqual({
      kind: "a2a-causal-hop",
      version: A2A_AGENT_ENVELOPE_VERSION,
      originSessionId: ORIGIN,
      recipientChildSessionId: RECIPIENT,
      hopCount: 1,
    });
    await expect(harness.bus.peekRecipientMailbox(RECIPIENT)).resolves.toHaveLength(1);
  });

  it("drops and audits an active guidance queue budget overflow", async () => {
    const harness = createHarness({ queueResult: "queue-full" });

    await expect(harness.bus.send(makeSend("message-queue-full"))).resolves.toEqual({
      ok: false,
      disposition: "dropped",
      reason: "budget-exhausted",
    });
    const stored = await harness.mailbox.peekWithDiagnostics(RECIPIENT);
    expect(stored.entries).toEqual([]);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:budget-exhausted"),
    }));
  });

  it("fails closed and audits untrusted, cross-origin, terminal, and unavailable routes", async () => {
    const secretId = "ghp_" + "b".repeat(24);
    const cases: Array<{
      name: string;
      harness: ReturnType<typeof createHarness>;
      recipient?: string;
      reason: string;
    }> = [
      {
        name: "unknown sender",
        harness: createHarness({ sender: null }),
        reason: "unknown-sender",
      },
      {
        name: "unknown recipient",
        harness: createHarness({
          route: { ok: false, reason: "unknown-recipient" },
        }),
        reason: "unknown-recipient",
      },
      {
        name: "unsafe recipient id",
        harness: createHarness(),
        recipient: secretId,
        reason: "unknown-recipient",
      },
      {
        name: "self send",
        harness: createHarness(),
        recipient: SENDER,
        reason: "self-send",
      },
      {
        name: "cross origin",
        harness: createHarness({
          route: routeFor(A2ATaskState.WORKING, undefined, "other-origin"),
        }),
        reason: "cross-origin",
      },
      {
        name: "terminal recipient",
        harness: createHarness({
          route: routeFor(A2ATaskState.COMPLETED),
        }),
        reason: "terminal-recipient",
      },
      {
        name: "unavailable recipient",
        harness: createHarness({
          route: routeFor(A2ATaskState.SUBMITTED),
        }),
        reason: "recipient-unavailable",
      },
    ];

    for (const entry of cases) {
      const result = await entry.harness.bus.send(makeSend(
        "message-drop-" + entry.name.replaceAll(" ", "-"),
        { recipient: entry.recipient ?? RECIPIENT },
      ));
      expect(result, entry.name).toEqual({
        ok: false,
        disposition: "dropped",
        reason: entry.reason,
      });
      expect(entry.harness.audit, entry.name).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.stringContaining("dropped:" + entry.reason),
        }),
      );
      expect(JSON.stringify(entry.harness.namespace.getStored() ?? {}), entry.name)
        .not.toContain("message-drop-");
    }
    expect(JSON.stringify(cases[2]!.harness.audit.mock.calls)).not.toContain(secretId);
  });

  it("rejects forged causal state, raw FilePart, and hop overflow before enqueue", async () => {
    const forged = createHarness();
    await expect(forged.bus.send(makeSend("message-forged-hop", {
      causalContext: {
        kind: "a2a-causal-hop",
        version: A2A_AGENT_ENVELOPE_VERSION,
        originSessionId: ORIGIN,
        recipientChildSessionId: "sub-other",
        hopCount: 1,
      },
    }))).resolves.toMatchObject({ ok: false, reason: "cross-origin" });

    const raw = createHarness();
    await expect(raw.bus.send(makeSend("message-raw", {
      parts: [{ raw: "opaque" }] as never,
    }))).resolves.toMatchObject({ ok: false, reason: "unsupported-part" });

    const overflow = createHarness();
    await expect(overflow.bus.send(makeSend("message-hop-overflow", {
      causalContext: {
        kind: "a2a-causal-hop",
        version: A2A_AGENT_ENVELOPE_VERSION,
        originSessionId: ORIGIN,
        recipientChildSessionId: SENDER,
        hopCount: A2A_AGENT_MAX_HOPS,
      },
    }))).resolves.toMatchObject({ ok: false, reason: "hop-limit" });

    for (const harness of [forged, raw, overflow]) {
      expect(JSON.stringify(harness.namespace.getStored() ?? {}))
        .not.toContain("message-");
    }
  });

  it("enforces the durable parent-owned tree budget", async () => {
    const harness = createHarness();

    for (let i = 0; i < A2A_AGENT_TREE_MESSAGE_BUDGET; i += 1) {
      const delivered = await harness.bus.send(makeSend("message-tree-" + i, {
        recipient: A2A_PARENT_RECIPIENT,
      }));
      expect(delivered).toMatchObject({ ok: true, disposition: "parent" });
    }
    await expect(harness.bus.send(makeSend("message-tree-overflow", {
      recipient: A2A_PARENT_RECIPIENT,
    }))).resolves.toEqual({
      ok: false,
      disposition: "dropped",
      reason: "budget-exhausted",
    });
    expect(harness.parentDeliver)
      .toHaveBeenCalledTimes(A2A_AGENT_TREE_MESSAGE_BUDGET);
  });
  it("evicts only the oldest authoritatively inactive tree at the tracked-tree ceiling", async () => {
    const namespace = createInMemoryNamespace();
    const mailbox = new A2AAgentMessageMailbox(namespace.handle);
    const allocate = (
      originSessionId: string,
      isOriginActive?: (candidateOriginSessionId: string) => boolean | Promise<boolean>,
    ) => mailbox.allocateEnvelope({
      version: A2A_AGENT_ENVELOPE_VERSION,
      originSessionId,
      senderChildSessionId: SENDER,
      recipientChildSessionId: A2A_PARENT_RECIPIENT,
      hopCount: 1,
    }, isOriginActive);
    const activeOrigin = "origin-active";

    for (let sequence = 1; sequence <= 5; sequence += 1) {
      await expect(allocate(activeOrigin)).resolves.toMatchObject({
        ok: true,
        envelope: { treeSequence: sequence },
      });
    }
    for (let index = 0; index < A2A_AGENT_MAX_TRACKED_TREES - 1; index += 1) {
      await expect(allocate("origin-inactive-" + index)).resolves.toMatchObject({
        ok: true,
      });
    }

    const isOriginActive = vi.fn(async (originSessionId: string) =>
      originSessionId === activeOrigin);
    await expect(allocate("origin-new", isOriginActive)).resolves.toMatchObject({
      ok: true,
      envelope: { treeSequence: 1 },
    });
    await expect(allocate(activeOrigin, isOriginActive)).resolves.toMatchObject({
      ok: true,
      envelope: { treeSequence: 6 },
    });

    const stored = namespace.getStored() as {
      trees: Array<{ originSessionId: string; messageCount: number }>;
    };
    expect(stored.trees).toHaveLength(A2A_AGENT_MAX_TRACKED_TREES);
    expect(stored.trees).toContainEqual({
      originSessionId: activeOrigin,
      messageCount: 6,
    });
    expect(stored.trees).toContainEqual({
      originSessionId: "origin-new",
      messageCount: 1,
    });
    expect(stored.trees.some((tree) =>
      tree.originSessionId === "origin-inactive-0")).toBe(false);
    expect(isOriginActive).toHaveBeenCalledWith(activeOrigin);
  });

  it("never evicts a tree while its durable mailbox entry is pending", async () => {
    const harness = createHarness({
      route: routeFor(A2ATaskState.INPUT_REQUIRED),
    });
    await expect(harness.bus.send(makeSend("message-pending")))
      .resolves.toMatchObject({ ok: true, disposition: "mailbox" });

    const allocate = (originSessionId: string) =>
      harness.mailbox.allocateEnvelope({
        version: A2A_AGENT_ENVELOPE_VERSION,
        originSessionId,
        senderChildSessionId: SENDER,
        recipientChildSessionId: A2A_PARENT_RECIPIENT,
        hopCount: 1,
      });
    for (let index = 0; index < A2A_AGENT_MAX_TRACKED_TREES - 1; index += 1) {
      await expect(allocate("origin-inactive-" + index)).resolves.toMatchObject({
        ok: true,
      });
    }

    await expect(harness.mailbox.allocateEnvelope({
      version: A2A_AGENT_ENVELOPE_VERSION,
      originSessionId: "origin-new",
      senderChildSessionId: SENDER,
      recipientChildSessionId: A2A_PARENT_RECIPIENT,
      hopCount: 1,
    }, async () => false)).resolves.toMatchObject({
      ok: true,
      envelope: { treeSequence: 1 },
    });

    const stored = harness.namespace.getStored() as {
      entries: Array<{ envelope: { originSessionId: string } }>;
      trees: Array<{ originSessionId: string; messageCount: number }>;
    };
    expect(stored.entries).toHaveLength(1);
    expect(stored.entries[0]?.envelope.originSessionId).toBe(ORIGIN);
    expect(stored.trees).toContainEqual({
      originSessionId: ORIGIN,
      messageCount: 1,
    });
    expect(stored.trees.some((tree) =>
      tree.originSessionId === "origin-inactive-0")).toBe(false);
    expect(stored.trees).toContainEqual({
      originSessionId: "origin-new",
      messageCount: 1,
    });
  });

  it("preserves every active tree and fails closed when no authoritative eviction exists", async () => {
    const namespace = createInMemoryNamespace();
    const mailbox = new A2AAgentMessageMailbox(namespace.handle);
    for (let index = 0; index < A2A_AGENT_MAX_TRACKED_TREES; index += 1) {
      await mailbox.allocateEnvelope({
        version: A2A_AGENT_ENVELOPE_VERSION,
        originSessionId: "origin-active-" + index,
        senderChildSessionId: SENDER,
        recipientChildSessionId: A2A_PARENT_RECIPIENT,
        hopCount: 1,
      });
    }

    await expect(mailbox.allocateEnvelope({
      version: A2A_AGENT_ENVELOPE_VERSION,
      originSessionId: "origin-overflow",
      senderChildSessionId: SENDER,
      recipientChildSessionId: A2A_PARENT_RECIPIENT,
      hopCount: 1,
    }, async () => true)).resolves.toEqual({
      ok: false,
      reason: "tracked-tree-budget",
    });
    const stored = namespace.getStored() as {
      trees: Array<{ originSessionId: string }>;
    };
    expect(stored.trees).toHaveLength(A2A_AGENT_MAX_TRACKED_TREES);
    expect(stored.trees.some((tree) =>
      tree.originSessionId === "origin-overflow")).toBe(false);
  });

  it("drops final-round active guidance after authoritative terminal commit", async () => {
    const harness = createHarness();
    await expect(harness.bus.send(makeSend("message-final-round-terminal")))
      .resolves.toMatchObject({ ok: true, disposition: "queued" });
    harness.captured()?.disposition.onDropped?.("turn-ended");
    if (!harness.route.ok) throw new Error("route unavailable");
    harness.route.recipient.taskState = A2ATaskState.COMPLETED;
    delete harness.route.recipient.activeLoop;

    await expect(harness.bus.cleanupTerminalRecipientMailbox(RECIPIENT))
      .resolves.toEqual({ ok: true, removed: 1, retained: 0 });
    expect((await harness.mailbox.peekWithDiagnostics(RECIPIENT)).entries).toEqual([]);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("dropped:terminal-recipient"),
    }));
  });

  it("retains final-round active guidance when the durable state is INPUT_REQUIRED", async () => {
    const harness = createHarness();
    await expect(harness.bus.send(makeSend("message-final-round-waiting")))
      .resolves.toMatchObject({ ok: true, disposition: "queued" });
    harness.captured()?.disposition.onDropped?.("turn-ended");
    if (!harness.route.ok) throw new Error("route unavailable");
    harness.route.recipient.taskState = A2ATaskState.INPUT_REQUIRED;
    delete harness.route.recipient.activeLoop;

    await expect(harness.bus.cleanupTerminalRecipientMailbox(RECIPIENT))
      .resolves.toEqual({ ok: true, removed: 0, retained: 1 });
    expect((await harness.mailbox.peekWithDiagnostics(RECIPIENT)).entries)
      .toHaveLength(1);
  });

  it("stages a background question before committing one metadata-bearing parent edge", async () => {
    const harness = createHarness();

    const staged = await harness.bus.stageQuestion(makeSend(
      "message-background-question",
      {
        recipient: A2A_PARENT_RECIPIENT,
        waitForReply: true,
      },
    ));
    expect(staged).toMatchObject({
      ok: true,
      result: { ok: true, disposition: "question-staged" },
    });
    expect(harness.parentDeliver).not.toHaveBeenCalled();
    if (!staged.ok) throw new Error("question staging failed");

    await expect(harness.bus.commitStagedQuestion(staged.stage)).resolves.toMatchObject({
      ok: true,
      disposition: "parent",
    });

    expect(harness.parentDeliver).toHaveBeenCalledTimes(1);
    expect(harness.parentDeliver.mock.calls[0]?.[0].message).toMatchObject({
      messageId: "message-background-question",
      parts: [{ text: "hello" }],
      metadata: {
        taskState: A2ATaskState.INPUT_REQUIRED,
        suspension: {
          reason: "question",
          prompt: "hello",
          resumeId: SENDER,
        },
      },
    });
    const stored = harness.namespace.getStored() as {
      trees: Array<{ originSessionId: string; messageCount: number }>;
    };
    expect(stored.trees).toEqual([{
      originSessionId: ORIGIN,
      messageCount: 1,
    }]);
    const deliveredEdges = harness.audit.mock.calls.filter(([entry]) =>
      String(entry.input).includes("delivered:parent"));
    expect(deliveredEdges).toHaveLength(1);
  });

  it("returns foreground questions only after their staged commit", async () => {
    const harness = createHarness({
      sender: {
        originSessionId: ORIGIN,
        childSessionId: SENDER,
        title: "sender-worker",
        background: false,
        taskState: A2ATaskState.WORKING,
      },
    });

    await expect(harness.bus.send(makeSend("message-foreground-normal", {
      recipient: A2A_PARENT_RECIPIENT,
    }))).resolves.toMatchObject({
      ok: false,
      reason: "recipient-unavailable",
    });
    const staged = await harness.bus.stageQuestion(makeSend(
      "message-foreground-question",
      {
        recipient: A2A_PARENT_RECIPIENT,
        waitForReply: true,
      },
    ));
    expect(staged).toMatchObject({
      ok: true,
      result: { disposition: "question-staged" },
    });
    if (!staged.ok) throw new Error("question staging failed");
    await expect(harness.bus.commitStagedQuestion(staged.stage)).resolves.toMatchObject({
      ok: true,
      disposition: "foreground-return",
      canonicalMessage: {
        metadata: {
          taskState: A2ATaskState.INPUT_REQUIRED,
          suspension: { reason: "question", resumeId: SENDER },
        },
      },
    });
    expect(harness.parentDeliver).not.toHaveBeenCalled();
    const stored = harness.namespace.getStored() as {
      entries?: unknown[];
      trees?: Array<{ messageCount: number }>;
    };
    expect(stored.entries ?? []).toEqual([]);
    expect(stored.trees).toEqual([expect.objectContaining({ messageCount: 1 })]);
    expect(harness.audit).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.stringContaining("delivered:foreground-return"),
    }));
  });

  it("rejects a question whose host status metadata would exceed the message bound", async () => {
    const harness = createHarness();
    await expect(harness.bus.stageQuestion(makeSend("message-question-too-long", {
      recipient: A2A_PARENT_RECIPIENT,
      parts: [{ text: "x".repeat(5_000) }],
      waitForReply: true,
    }))).resolves.toMatchObject({
      ok: false,
      result: { reason: "message-too-long" },
    });
    expect(harness.parentDeliver).not.toHaveBeenCalled();
    const stored = harness.namespace.getStored() as { trees?: unknown[] } | undefined;
    expect(stored?.trees ?? []).toEqual([]);
  });

  it("rolls back the staged tree allocation when question commit fails", async () => {
    const harness = createHarness({
      parentResult: { ok: false, reason: "storage-failed" },
    });
    const staged = await harness.bus.stageQuestion(makeSend(
      "message-question-commit-failure",
      {
        recipient: A2A_PARENT_RECIPIENT,
        waitForReply: true,
      },
    ));
    if (!staged.ok) throw new Error("question staging failed");

    await expect(harness.bus.commitStagedQuestion(staged.stage)).resolves.toMatchObject({
      ok: false,
      reason: "storage-failed",
    });
    const stored = harness.namespace.getStored() as { trees?: unknown[] };
    expect(stored.trees ?? []).toEqual([]);
    expect(harness.audit.mock.calls.some(([entry]) =>
      String(entry.input).includes("delivered:parent"))).toBe(false);
  });

  it("terminalizes a staged question when commit and envelope rollback both fail", async () => {
    const harness = createHarness({
      parentResult: { ok: false, reason: "storage-failed" },
    });
    const staged = await harness.bus.stageQuestion(makeSend(
      "message-question-indeterminate",
      {
        recipient: A2A_PARENT_RECIPIENT,
        waitForReply: true,
      },
    ));
    if (!staged.ok) throw new Error("question staging failed");
    vi.spyOn(harness.mailbox, "rollbackEnvelope").mockResolvedValue(false);

    await expect(harness.bus.commitStagedQuestion(staged.stage)).resolves.toMatchObject({
      ok: false,
      reason: "storage-failed",
    });
    await expect(harness.bus.commitStagedQuestion(staged.stage)).resolves.toMatchObject({
      ok: false,
      reason: "duplicate-message",
    });
    await expect(harness.bus.rollbackStagedQuestion(staged.stage)).resolves.toBe(false);
    expect(harness.parentDeliver).toHaveBeenCalledTimes(1);
    const stored = harness.namespace.getStored() as {
      trees?: Array<{ originSessionId: string; messageCount: number }>;
    };
    expect(stored.trees).toEqual([{
      originSessionId: ORIGIN,
      messageCount: 1,
    }]);
    expect(harness.audit.mock.calls.some(([entry]) =>
      String(entry.input).includes("dropped:storage-failed"))).toBe(true);
  });

  it("strictly merges only same-origin causal contexts for the exact recipient", () => {
    const first: A2AAgentCausalContext = {
      kind: "a2a-causal-hop",
      version: A2A_AGENT_ENVELOPE_VERSION,
      originSessionId: ORIGIN,
      recipientChildSessionId: RECIPIENT,
      hopCount: 2,
    };
    const second: A2AAgentCausalContext = { ...first, hopCount: 5 };

    expect(mergeA2AAgentCausalContexts(RECIPIENT, [first, second]))
      .toEqual(second);
    expect(mergeA2AAgentCausalContexts(RECIPIENT, [])).toBeUndefined();
    expect(mergeA2AAgentCausalContexts(RECIPIENT, [
      { ...first, originSessionId: "other-origin" },
      second,
    ])).toBeUndefined();
    expect(mergeA2AAgentCausalContexts(RECIPIENT, [
      { ...first, recipientChildSessionId: "sub-other" },
    ])).toBeUndefined();
    expect(mergeA2AAgentCausalContexts(RECIPIENT, [
      { ...first, extra: true },
    ])).toBeUndefined();
  });
});

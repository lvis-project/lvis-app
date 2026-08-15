/**
 * The three operator-facing options of tier 2, exercised through the gate.
 *
 * Each asks the same two questions. Does the option do nothing at all in its
 * default setting — so a machine that never touches the settings file behaves
 * exactly as it did before these existed? And when it is turned on, can it
 * produce an allow, or send something it should not have sent?
 */
import { describe, it, expect, vi } from "vitest";
import {
  ApprovalGate,
  deferredParentEscalationOf,
  isHostApprovalRejectedDecision,
  type ApprovalRequest,
  type ApprovalRequestInput,
  type ParentAdjudicationGateDeps,
} from "../approval-gate.js";
import type {
  ParentAdjudicationEvidence,
  ParentAdjudicationOptions,
  ParentAdjudicationResult,
  ParentAdjudicator,
} from "../parent-adjudicator.js";
import type { DeferredQueue } from "../reviewer/deferred-queue.js";
import type {
  ParentAdjudicationModelSource,
  ReviewerParentAdjudicationBlock,
} from "../permission-settings-store.js";
import type { ParentContextTurn } from "../parent-context-evidence.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { auditRowTexts } from "./test-helpers.js";

const CHILD_SESSION = "child-session-1";
const PARENT_SESSION = "parent-session-1";

const DEFAULT_POLICY: ReviewerParentAdjudicationBlock = {
  maxVerdict: "medium",
  timeoutMs: 30_000,
  maxPerChildRun: 200,
  includeParentContextTurns: 0,
  backgroundEscalation: "deferred",
  model: "reviewer",
};

class ScriptedParentAdjudicator implements ParentAdjudicator {
  readonly seen: ParentAdjudicationEvidence[] = [];

  constructor(private readonly answer: ParentAdjudicationResult) {}

  async adjudicate(
    evidence: ParentAdjudicationEvidence,
    _options: ParentAdjudicationOptions,
  ): Promise<ParentAdjudicationResult> {
    this.seen.push(evidence);
    return this.answer;
  }

  forgetChildRun(): void {
    // Nothing is tracked by this double.
  }
}

const ESCALATION: ParentAdjudicationResult = {
  outcome: "escalate",
  cause: "parent-escalated",
  reason: "I cannot tell whether this path belongs to the task",
};

function makeGate(options: {
  answer?: ParentAdjudicationResult;
  policy?: Partial<ReviewerParentAdjudicationBlock>;
  parentContext?: (
    parentSessionId: string,
    maxTurns: number,
  ) => readonly ParentContextTurn[];
  deferredQueue?: DeferredQueue | null;
  bySource?: Partial<Record<ParentAdjudicationModelSource, ParentAdjudicator>>;
} = {}) {
  const wc = makeMockWebContents();
  const auditLogger = { log: vi.fn() };
  const notificationService = { fire: vi.fn() };
  const reviewerAdjudicator = new ScriptedParentAdjudicator(
    options.answer ?? ESCALATION,
  );
  const askedSources: ParentAdjudicationModelSource[] = [];
  const deps: ParentAdjudicationGateDeps = {
    adjudicator: (source) => {
      askedSources.push(source);
      return options.bySource?.[source] ?? reviewerAdjudicator;
    },
    isEnabled: () => true,
    policy: () => ({ ...DEFAULT_POLICY, ...options.policy }),
    ...(options.parentContext === undefined
      ? {}
      : { parentContext: options.parentContext }),
    ...(options.deferredQueue === undefined
      ? {}
      : { deferredQueue: () => options.deferredQueue ?? null }),
  };
  const gate = new ApprovalGate(
    wc as never,
    undefined,
    1_000,
    auditLogger as never,
    notificationService as never,
    deps,
  );
  return {
    wc,
    auditLogger,
    notificationService,
    gate,
    askedSources,
    reviewerAdjudicator,
  };
}

function makeChildRequest(
  overrides: Partial<ApprovalRequestInput> = {},
): ApprovalRequestInput {
  return {
    id: "child-req-1",
    category: "tool",
    toolName: "fs_write",
    toolCategory: "write",
    sessionId: CHILD_SESSION,
    source: "builtin",
    args: { path: "/srv/work/report.md", content: "hello" },
    reason: "state-changing tool",
    createdAt: Date.now(),
    isReadOnly: false,
    reviewerVerdict: { level: "medium", reason: "writes inside the workspace" },
    childProvenance: {
      childSessionId: CHILD_SESSION,
      childTitle: "report writer",
      originSessionId: PARENT_SESSION,
      spawnTaskSummary: "write the weekly report",
      background: true,
    },
    parentAdjudicationEligible: true,
    ...overrides,
  };
}

/** A child run somebody is watching. */
function foregroundRequest(): ApprovalRequestInput {
  return makeChildRequest({
    childProvenance: {
      childSessionId: CHILD_SESSION,
      childTitle: "report writer",
      originSessionId: PARENT_SESSION,
      spawnTaskSummary: "write the weekly report",
      background: false,
    },
  });
}

function fakeQueue(
  append: (params: unknown) => Promise<string> = async () => "deferred-1",
) {
  const spy = vi.fn(append);
  return { queue: { append: spy } as unknown as DeferredQueue, append: spy };
}

function rowStartingWith(
  auditLogger: { log: ReturnType<typeof vi.fn> },
  marker: string,
): string | undefined {
  return auditRowTexts(auditLogger).find((row) => row.startsWith(marker));
}

describe("tier 2 — parent context evidence", () => {
  it("sends none by default, and does not even read the transcript", async () => {
    const parentContext = vi.fn(() => [
      { speaker: "user" as const, text: "index the reports" },
    ]);
    const { gate, reviewerAdjudicator, wc } = makeGate({
      answer: { outcome: "allow-once", reason: "in task" },
      parentContext,
    });

    await gate.requestAndWait(makeChildRequest());

    expect(parentContext).not.toHaveBeenCalled();
    expect(reviewerAdjudicator.seen[0]).not.toHaveProperty("parentContext");
    expect(wc.send).not.toHaveBeenCalled();
  });

  it("carries the host-composed turns when the operator opts in", async () => {
    const parentContext = vi.fn(() => [
      { speaker: "user" as const, text: "index the reports" },
      { speaker: "assistant" as const, text: "starting the indexer" },
    ]);
    const { gate, reviewerAdjudicator } = makeGate({
      answer: { outcome: "allow-once", reason: "in task" },
      policy: { includeParentContextTurns: 2 },
      parentContext,
    });

    await gate.requestAndWait(makeChildRequest());

    // The parent session, and the policy's own bound — never the child's.
    expect(parentContext).toHaveBeenCalledWith(PARENT_SESSION, 2);
    expect(reviewerAdjudicator.seen[0]?.parentContext).toEqual([
      { speaker: "user", text: "index the reports" },
      { speaker: "assistant", text: "starting the indexer" },
    ]);
  });

  it("still answers the ask when the transcript cannot be read", async () => {
    const parentContext = vi.fn(() => {
      throw new Error("session file unreadable");
    });
    const { gate, reviewerAdjudicator } = makeGate({
      answer: { outcome: "allow-once", reason: "in task" },
      policy: { includeParentContextTurns: 3 },
      parentContext,
    });

    const decision = await gate.requestAndWait(makeChildRequest());

    expect(decision.choice).toBe("allow-once");
    expect(reviewerAdjudicator.seen[0]).not.toHaveProperty("parentContext");
  });

  it("omits an empty block rather than sending an empty field", async () => {
    const { gate, reviewerAdjudicator } = makeGate({
      answer: { outcome: "allow-once", reason: "in task" },
      policy: { includeParentContextTurns: 5 },
      parentContext: () => [],
    });

    await gate.requestAndWait(makeChildRequest());

    expect(reviewerAdjudicator.seen[0]).not.toHaveProperty("parentContext");
  });
});

describe("tier 2 — which model answers", () => {
  it("asks the reviewer's adjudicator by default", async () => {
    const { gate, askedSources } = makeGate({
      answer: { outcome: "allow-once", reason: "in task" },
    });

    await gate.requestAndWait(makeChildRequest());

    expect(askedSources).toEqual(["reviewer"]);
  });

  it("asks the parent session's own model when the policy says so", async () => {
    const parentSession = new ScriptedParentAdjudicator({
      outcome: "allow-once",
      reason: "answered on the chat model",
    });
    const { gate, askedSources, reviewerAdjudicator } = makeGate({
      policy: { model: "parent-session" },
      bySource: { "parent-session": parentSession },
    });

    const decision = await gate.requestAndWait(makeChildRequest());

    expect(askedSources).toEqual(["parent-session"]);
    expect(parentSession.seen).toHaveLength(1);
    expect(reviewerAdjudicator.seen).toHaveLength(0);
    expect(decision.choice).toBe("allow-once");
  });
});

describe("tier 3 — where a background escalation goes", () => {
  it("queues it, denies fail-closed, and never paints a dock", async () => {
    const { queue, append } = fakeQueue();
    const { gate, wc, auditLogger, notificationService } = makeGate({
      deferredQueue: queue,
    });

    const decision = await gate.requestAndWait(makeChildRequest());

    expect(decision.choice).toBe("deny-once");
    // A host denial, not a user's refusal, and nothing durable behind it.
    expect(isHostApprovalRejectedDecision(decision)).toBe(true);
    expect(decision.rememberPattern).toBeUndefined();
    expect(wc.send).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledTimes(1);

    const entry = append.mock.calls[0]?.[0] as Record<string, unknown>;
    // No grant: the resolve path refuses "approved" for an entry with none, so
    // reviewing this later can record an opinion and can never become
    // permission for a call whose turn is over.
    expect(entry).not.toHaveProperty("grant");
    expect(entry.toolName).toBe("fs_write");
    expect(entry.category).toBe("write");
    expect(String(entry.inputSummary)).toContain("cause=parent-escalated");

    expect(deferredParentEscalationOf(decision)).toEqual({
      cause: "parent-escalated",
      deferredId: "deferred-1",
    });
    expect(notificationService.fire).toHaveBeenCalledTimes(1);
    const row = rowStartingWith(auditLogger, "[approval:parent-escalation-deferred]");
    expect(row).toContain("deferredId=deferred-1");
    expect(row).toContain("cause=parent-escalated");
    expect(row).toContain("→ deny-once");
  });

  it("cannot turn any escalation cause into an allow", async () => {
    // Every cause, including the two the host raises on its own.
    for (const cause of ["timeout", "adjudicator-unavailable"] as const) {
      const { queue } = fakeQueue();
      const { gate, wc } = makeGate({
        answer: { outcome: "escalate", cause, reason: "no answer" },
        deferredQueue: queue,
      });

      const decision = await gate.requestAndWait(makeChildRequest());

      expect(decision.choice).toBe("deny-once");
      expect(deferredParentEscalationOf(decision)?.cause).toBe(cause);
      expect(wc.send).not.toHaveBeenCalled();
    }
  });

  it("keeps the immediate dock for a foreground child", async () => {
    const { queue, append } = fakeQueue();
    const { gate, wc } = makeGate({ deferredQueue: queue });

    void gate.requestAndWait(foregroundRequest());
    await vi.waitFor(() => expect(wc.send).toHaveBeenCalled());

    expect(append).not.toHaveBeenCalled();
    const sent = wc.send.mock.calls[0]?.[1] as ApprovalRequest;
    expect(sent.parentEscalation?.cause).toBe("parent-escalated");
  });

  it("keeps the immediate dock when the operator chose modal", async () => {
    const { queue, append } = fakeQueue();
    const { gate, wc } = makeGate({
      policy: { backgroundEscalation: "modal" },
      deferredQueue: queue,
    });

    void gate.requestAndWait(makeChildRequest());
    await vi.waitFor(() => expect(wc.send).toHaveBeenCalled());

    expect(append).not.toHaveBeenCalled();
  });

  it("queues a foreground child's escalation while the desk is armed away", async () => {
    const { queue, append } = fakeQueue();
    const harness = makeGate({ deferredQueue: queue });
    expect(
      harness.gate.armAwayAuthority({
        conversationId: PARENT_SESSION,
        categories: ["read"],
        directories: [],
        ttlMs: 60 * 60 * 1000,
        budget: 5,
      }),
    ).toBe(true);

    const decision = await harness.gate.requestAndWait(foregroundRequest());

    expect(append).toHaveBeenCalledTimes(1);
    expect(decision.choice).toBe("deny-once");
    expect(harness.wc.send).not.toHaveBeenCalled();
  });

  it("falls back to the dock — never to an allow — when the queue fails", async () => {
    const { queue, append } = fakeQueue(async () => {
      throw new Error("queue file locked");
    });
    const { gate, wc } = makeGate({ deferredQueue: queue });

    void gate.requestAndWait(makeChildRequest());
    await vi.waitFor(() => expect(wc.send).toHaveBeenCalled());

    expect(append).toHaveBeenCalledTimes(1);
    const sent = wc.send.mock.calls[0]?.[1] as ApprovalRequest;
    expect(sent.parentEscalation?.cause).toBe("parent-escalated");
  });

  it("takes the dock when no queue is wired at all", async () => {
    const { gate, wc } = makeGate();

    void gate.requestAndWait(makeChildRequest());
    await vi.waitFor(() => expect(wc.send).toHaveBeenCalled());
  });

  it("leaves a parent's own answer untouched — the route is tier 3 only", async () => {
    const { queue, append } = fakeQueue();
    const { gate, wc } = makeGate({
      answer: { outcome: "deny", reason: "outside the task" },
      deferredQueue: queue,
    });

    const decision = await gate.requestAndWait(makeChildRequest());

    expect(decision.choice).toBe("deny-once");
    expect(deferredParentEscalationOf(decision)).toBeUndefined();
    expect(append).not.toHaveBeenCalled();
    expect(wc.send).not.toHaveBeenCalled();
  });
});

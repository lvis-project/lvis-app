/**
 * What the tool lane does with a parent's answer.
 *
 * The gate decides; this file is about the three things the lane owes everyone
 * else afterwards — the eligibility assertion it hands the gate, the review
 * event the panels render, and what the CHILD is told when its own parent
 * refuses. A child told "the user denied this" is told something untrue and
 * has no idea what to do differently.
 *
 * The last block walks the whole chain through one lane — tier-1 auto-approve,
 * tier-2 allow, tier-2 deny, tier-3 escalate — because each tier is defined by
 * what it hands the next one, and four separately-passing tiers can still
 * compose into a chain that skips one.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { IPC_APPROVAL_REQUEST } from "../../permissions/approval-gate.js";
import type { ApprovalDecision } from "../../permissions/approval-gate.js";
import type {
  ParentAdjudicationEvidence,
  ParentAdjudicationOptions,
  ParentAdjudicationResult,
  ParentAdjudicator,
} from "../../permissions/parent-adjudicator.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import { makeWriteProbeTool } from "./approval-memory-test-fixtures.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";

const CHILD_SESSION = "sub-11112222-3333-child";
const PARENT_SESSION = "conv-parent";

/** One adjudication as the host composed it, kept so a test can inspect it. */
type SeenAdjudication = {
  evidence: ParentAdjudicationEvidence;
  options: ParentAdjudicationOptions;
};

function scriptedAdjudicator(
  answer: ParentAdjudicationResult,
  seen: SeenAdjudication[],
): ParentAdjudicator {
  return {
    adjudicate: async (evidence, options) => {
      seen.push({ evidence, options });
      return answer;
    },
    forgetChildRun: () => {},
  };
}

/**
 * A tool lane wired the way a sub-agent's turn reaches it: an `ask` verdict
 * from layer 3 with a tier-1 review behind it, and a real gate whose tier-2
 * stage is live.
 */
async function runChildToolCall(options: {
  answer?: ParentAdjudicationResult;
  provenance?: boolean;
  forceModal?: boolean;
  verdict?: boolean;
  layer?: number;
  /** Tier 1's own answer. `allow` is the leg that never reaches the gate. */
  tier1?: "allow" | "ask";
  /** How the user answers a dock that tier 2 handed back. */
  userAnswer?: "allow-once" | "deny-once";
}): Promise<{
  content: string;
  isError: boolean | undefined;
  events: PermissionReviewEvent[];
  requests: Record<string, unknown>[];
  /** What the dock was actually sent, notice included. */
  docked: Record<string, unknown>[];
  /** What the gate returned for each ask — who decided it, and on what terms. */
  decisions: ApprovalDecision[];
  /** What `gate.resolve` made of each user answer. `null` = it was not accepted. */
  resolutions: (ApprovalDecision | null)[];
  /** What the host actually put to the parent. */
  adjudications: SeenAdjudication[];
  executed: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), "lvis-parent-adjudication-"));
  try {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));
    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.checkDetailed = () => ({
      decision: options.tier1 === "allow" ? "allow" : "ask",
      reason: "sub-agent write",
      layer: options.layer ?? 3,
      ...(options.forceModal === true ? { forceModal: true as const } : {}),
      ...(options.verdict === false
        ? {}
        : {
            // The `headless` lane is the one the interactive dispatcher does
            // not re-run, so the verdict this stub states is the verdict the
            // approval request carries — which is what these tests are about.
            reviewer: {
              route: "headless" as const,
              outcome: "fresh" as const,
              verdict: { level: "medium" as const, reason: "writes a file" },
            },
          }),
    });

    const requests: Record<string, unknown>[] = [];
    const docked: Record<string, unknown>[] = [];
    const decisions: ApprovalDecision[] = [];
    const resolutions: (ApprovalDecision | null)[] = [];
    const adjudications: SeenAdjudication[] = [];
    const wc = makeMockWebContents();
    // The user, when the chain reaches them: answer whatever the dock was
    // sent, echoing the nonce and hmac the gate minted for it. What `resolve`
    // returns is kept, because a gate that rejected the answer (stale entry,
    // failed integrity check, narrowed choice) denies the call too — and a
    // test that looked only at the outcome could not tell the two apart.
    wc.send.mockImplementation((channel: string, sent: Record<string, unknown>) => {
      if (channel !== IPC_APPROVAL_REQUEST) return;
      docked.push(sent);
      if (options.userAnswer === undefined) return;
      queueMicrotask(() => {
        resolutions.push(
          gate.resolve(sent.id as string, {
            requestId: sent.id as string,
            choice: options.userAnswer as "allow-once" | "deny-once",
            nonce: sent.nonce as string,
            hmac: sent.hmac as string,
          }),
        );
      });
    });
    const gate = new ApprovalGate(
      wc as never,
      undefined,
      1_000,
      undefined,
      undefined,
      {
        adjudicator: () =>
          scriptedAdjudicator(
            options.answer ?? {
              outcome: "escalate",
              cause: "parent-escalated",
              reason: "cannot tell",
            },
            adjudications,
          ),
        isEnabled: () => true,
        policy: () => ({
          maxVerdict: "medium",
          timeoutMs: 5_000,
          maxPerChildRun: 200,
          includeParentContextTurns: 0,
          // The dock, not the queue: this chain test is about the four legs
          // the user can see, and the deferred route removes the last one.
          backgroundEscalation: "modal",
          model: "reviewer",
        }),
      },
    );
    const baseRequestAndWait = gate.requestAndWait.bind(gate);
    gate.requestAndWait = async (req) => {
      requests.push(req as unknown as Record<string, unknown>);
      const decision = await baseRequestAndWait(
        options.provenance === false
          ? req
          : {
              ...req,
              childProvenance: {
                childSessionId: CHILD_SESSION,
                childTitle: "release notes",
                originSessionId: PARENT_SESSION,
                spawnTaskSummary: "write the release notes",
              },
            },
      );
      decisions.push(decision);
      return decision;
    };

    const events: PermissionReviewEvent[] = [];
    const executor = new ToolExecutor(
      registry,
      undefined,
      permMgr,
      undefined,
      gate,
    );
    const results = await executor.executeAll(
      [{ id: "tu-1", name: "write_probe", input: { path: join(dir, "notes.md") } }],
      {
        sessionId: CHILD_SESSION,
        permissionContext: {
          trustOrigin: "user-keyboard",
          additionalDirectories: [dir],
        },
        callbacks: { onPermissionReview: (event) => events.push(event) },
      },
    );

    return {
      content: String(results[0]?.content ?? ""),
      isError: results[0]?.is_error,
      events,
      requests,
      docked,
      decisions,
      resolutions,
      adjudications,
      executed: executeSpy.mock.calls.length,
    };
  } finally {
    await cleanupTmpDir(dir);
  }
}

describe("the eligibility the lane asserts", () => {
  it("asserts it for a layer-3 ask that carries a tier-1 verdict", async () => {
    const run = await runChildToolCall({ provenance: false });
    expect(run.requests[0]?.parentAdjudicationEligible).toBe(true);
  });

  it("withholds it when policy already forced a modal", async () => {
    const run = await runChildToolCall({ provenance: false, forceModal: true });
    expect(run.requests[0]?.parentAdjudicationEligible).toBe(false);
  });

  it("withholds it when there is no tier-1 verdict to refine", async () => {
    const run = await runChildToolCall({ provenance: false, verdict: false });
    expect(run.requests[0]?.parentAdjudicationEligible).toBe(false);
  });

  it("withholds it below layer 3", async () => {
    const run = await runChildToolCall({ provenance: false, layer: 2 });
    expect(run.requests[0]?.parentAdjudicationEligible).toBe(false);
  });
});

describe("what happens after the parent answers", () => {
  it("runs the tool and reports the parent approved it", async () => {
    const run = await runChildToolCall({
      answer: { outcome: "allow-once", reason: "that is the task I gave it" },
    });

    expect(run.executed).toBe(1);
    expect(run.isError).toBeUndefined();
    const event = run.events.find((e) => e.status === "parent_approved");
    expect(event?.reason).toBe("that is the task I gave it");
    expect(event?.verdictLevel).toBe("medium");
  });

  it("tells the child which party refused, and why", async () => {
    const run = await runChildToolCall({
      answer: { outcome: "deny", reason: "that file is outside the task" },
    });

    expect(run.executed).toBe(0);
    expect(run.isError).toBe(true);
    expect(run.content).toContain("that file is outside the task");
    // Not the user's refusal — the child would act on that differently.
    expect(run.content).not.toContain("사용자가 실행을 거부");
    expect(run.events.some((e) => e.status === "parent_denied")).toBe(true);
  });

  it("emits no parent event when the ask reached the user instead", async () => {
    const run = await runChildToolCall({
      answer: {
        outcome: "escalate",
        cause: "timeout",
        reason: "the parent did not answer in time",
      },
    });

    // The dock owns it now; the gate's own timeout answers this test's request.
    expect(
      run.events.some(
        (e) => e.status === "parent_approved" || e.status === "parent_denied",
      ),
    ).toBe(false);
  });
});

describe("the chain, end to end", () => {
  it("tier 1: an automatic allow never reaches the parent or the dock", async () => {
    const run = await runChildToolCall({
      tier1: "allow",
      // Scripted to deny, so a lane that consulted the parent anyway would
      // fail here rather than pass for the wrong reason.
      answer: { outcome: "deny", reason: "the parent should never see this" },
    });

    expect(run.executed).toBe(1);
    expect(run.isError).toBeUndefined();
    // The wrapper that fills `requests` is installed before the executor is
    // built, so an empty list proves the gate — and therefore the lane and the
    // parent — was never entered at all.
    expect(run.requests).toHaveLength(0);
    expect(run.adjudications).toHaveLength(0);
    expect(run.docked).toHaveLength(0);
    expect(
      run.events.some(
        (e) => e.status === "parent_approved" || e.status === "parent_denied",
      ),
    ).toBe(false);
  });

  it("tier 2: a parent allow runs the call with no dock", async () => {
    const run = await runChildToolCall({
      answer: { outcome: "allow-once", reason: "writing the notes is the task" },
    });

    expect(run.requests).toHaveLength(1);
    expect(run.executed).toBe(1);
    expect(run.docked).toHaveLength(0);
    expect(run.decisions[0]?.choice).toBe("allow-once");
    expect(run.decisions[0]?.rememberPattern).toBeUndefined();
    expect(run.events.some((e) => e.status === "parent_approved")).toBe(true);
    // What the host actually put to the parent: the task the PARENT wrote, and
    // none of the dock's purpose sentence, which for a sub-agent turn can only
    // have come from the child's own arguments.
    expect(run.adjudications).toHaveLength(1);
    expect(run.adjudications[0]?.evidence.child.spawnTaskSummary).toBe(
      "write the release notes",
    );
    expect(run.adjudications[0]?.evidence).not.toHaveProperty("approvalPurpose");
    expect(run.adjudications[0]?.options.parentSessionId).toBe(PARENT_SESSION);
  });

  it("tier 2: a parent deny stops the call with no dock, and mints no rule", async () => {
    const run = await runChildToolCall({
      answer: { outcome: "deny", reason: "that file is outside the task" },
    });

    expect(run.executed).toBe(0);
    expect(run.isError).toBe(true);
    expect(run.docked).toHaveLength(0);
    expect(run.events.some((e) => e.status === "parent_denied")).toBe(true);
    // The refusal decides one call. A pattern here would be a parent minting
    // policy for a user who never saw the request.
    expect(run.decisions[0]?.choice).toBe("deny-once");
    expect(run.decisions[0]?.rememberPattern).toBeUndefined();
  });

  it("tier 3: an escalation reaches the user, notice and all, and the user decides", async () => {
    const run = await runChildToolCall({
      answer: {
        outcome: "escalate",
        cause: "parent-escalated",
        reason: "I cannot tell whether that file belongs to the task",
      },
      userAnswer: "allow-once",
    });

    expect(run.docked).toHaveLength(1);
    expect(run.docked[0]?.parentEscalation).toEqual({
      cause: "parent-escalated",
      reason: "I cannot tell whether that file belongs to the task",
      childTitle: "release notes",
    });
    // Host-only inputs stop at the gate.
    expect(run.docked[0]).not.toHaveProperty("childProvenance");
    expect(run.docked[0]).not.toHaveProperty("parentAdjudicationEligible");
    // The user's answer is the one that decided it — accepted by the gate,
    // not rejected into a forced deny — and it is attributed to the user, not
    // to a parent that explicitly declined to decide.
    expect(run.resolutions).toHaveLength(1);
    expect(run.resolutions[0]?.choice).toBe("allow-once");
    expect(run.executed).toBe(1);
    expect(
      run.events.some(
        (e) => e.status === "parent_approved" || e.status === "parent_denied",
      ),
    ).toBe(false);
  });

  it("tier 3: the user's refusal is what stops the call", async () => {
    const run = await runChildToolCall({
      answer: {
        outcome: "escalate",
        cause: "adjudicator-unavailable",
        reason: "no parent reviewer is configured",
      },
      userAnswer: "deny-once",
    });

    expect(run.docked[0]?.parentEscalation).toMatchObject({
      cause: "adjudicator-unavailable",
    });
    expect(run.executed).toBe(0);
    expect(run.isError).toBe(true);
    // A dock timeout, a failed integrity check and a narrowed choice all end in
    // a deny too, so the outcome alone proves nothing. The gate accepting this
    // answer — and returning it without a pattern it would have forced — is
    // what makes it the USER's refusal.
    expect(run.resolutions).toHaveLength(1);
    expect(run.resolutions[0]).not.toBeNull();
    expect(run.resolutions[0]?.choice).toBe("deny-once");
    expect(run.decisions[0]?.choice).toBe("deny-once");
    expect(run.decisions[0]?.rememberPattern).toBeUndefined();
  });
});

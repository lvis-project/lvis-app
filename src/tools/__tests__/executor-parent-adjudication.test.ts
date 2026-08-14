/**
 * What the tool lane does with a parent's answer.
 *
 * The gate decides; this file is about the three things the lane owes everyone
 * else afterwards — the eligibility assertion it hands the gate, the review
 * event the panels render, and what the CHILD is told when its own parent
 * refuses. A child told "the user denied this" is told something untrue and
 * has no idea what to do differently.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import type {
  ParentAdjudicationResult,
  ParentAdjudicator,
} from "../../permissions/parent-adjudicator.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import { makeWriteProbeTool } from "./approval-memory-test-fixtures.js";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";

const CHILD_SESSION = "sub-11112222-3333-child";
const PARENT_SESSION = "conv-parent";

function scriptedAdjudicator(answer: ParentAdjudicationResult): ParentAdjudicator {
  return {
    adjudicate: async () => answer,
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
}): Promise<{
  content: string;
  isError: boolean | undefined;
  events: PermissionReviewEvent[];
  requests: Record<string, unknown>[];
  executed: number;
}> {
  const dir = mkdtempSync(join(tmpdir(), "lvis-parent-adjudication-"));
  try {
    const executeSpy = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(executeSpy));
    const permMgr = new PermissionManager(join(dir, "permissions.json"));
    permMgr.checkDetailed = () => ({
      decision: "ask",
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
    const gate = new ApprovalGate(
      makeMockWebContents() as never,
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
          ),
        isEnabled: () => true,
        policy: () => ({
          maxVerdict: "medium",
          timeoutMs: 5_000,
          maxPerChildRun: 200,
        }),
      },
    );
    const baseRequestAndWait = gate.requestAndWait.bind(gate);
    gate.requestAndWait = (req) => {
      requests.push(req as unknown as Record<string, unknown>);
      return baseRequestAndWait(
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

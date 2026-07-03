/**
 * Permission SOT V3 — reviewer-dispatch delegates the verdict→decision mapping.
 *
 * After P1-b the pipeline lanes no longer branch on `verdict.level` to build
 * the allow/deny/ask decision; they call
 * `PermissionManager.resolveReviewerDecision(verdict, lane)` and only wire the
 * human-facing message + deferred-queue metadata around the returned result.
 *
 * These tests prove the delegation contract:
 *   - `resolveReviewerDecision` is invoked with the reviewer verdict and the
 *     correct lane string,
 *   - the returned `permissionResult` is the SOT decision (verbatim for the
 *     allow lanes; deferred metadata layered on for a headless non-allow).
 * The exhaustive low/medium/high truth-table lives in
 * `permission-manager-resolve-reviewer-decision.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  dispatchReviewerForHeadless,
  dispatchReviewerForInteractiveAuto,
} from "../reviewer-dispatch.js";
import type { PermissionManager, PermissionCheckResult, ReviewerLane } from "../../../permissions/permission-manager.js";
import type { RiskVerdict } from "../../../permissions/reviewer/risk-classifier.js";
import type { ToolPermissionContext, ToolCallMeta } from "../../executor.js";
import type { PermissionEvaluationContext } from "../../../permissions/evaluation-context.js";

const evaluationContext = {} as PermissionEvaluationContext;
const context = { trustOrigin: "user" } as unknown as ToolPermissionContext;
const meta = {} as ToolCallMeta;

/**
 * Minimal PermissionManager stub exposing only the surface the lanes touch.
 * `resolveReviewerDecision` is the REAL implementation (bound) so the
 * delegation return value is genuine SOT output; every other method is a
 * hand-stubbed spy.
 */
function makeStub(opts: {
  verdict: RiskVerdict;
  deferredId?: string;
  mode?: string;
  interactiveAutoApprove?: "off" | "low";
}): {
  pm: PermissionManager;
  resolveSpy: ReturnType<typeof vi.fn>;
} {
  const real = (verdict: RiskVerdict, lane: ReviewerLane): PermissionCheckResult => {
    const isLow = verdict.level === "low";
    if (lane === "headless") {
      return isLow
        ? { decision: "allow", reason: `reviewer ${verdict.level}: ${verdict.reason}`, layer: 5, reviewer: { route: "headless", verdict } }
        : { decision: "deny", reason: `reviewer ${verdict.level}: ${verdict.reason}`, layer: 5, reviewer: { route: "headless", verdict } };
    }
    return isLow
      ? { decision: "allow", reason: `reviewer low: ${verdict.reason}`, layer: 5, reviewer: { route: "foreground-auto", verdict } }
      : { decision: "ask", reason: `reviewer ${verdict.level}: ${verdict.reason}`, layer: 5, reviewer: { route: "foreground-auto", verdict } };
  };
  const resolveSpy = vi.fn(real);
  const pm = {
    getMode: () => opts.mode ?? "auto",
    getInteractiveAutoApprove: () => opts.interactiveAutoApprove ?? "low",
    hasReviewer: () => true,
    dispatchReviewer: vi.fn(async () => ({ verdict: opts.verdict, deferredId: opts.deferredId })),
    resolveReviewerDecision: resolveSpy,
  } as unknown as PermissionManager;
  return { pm, resolveSpy };
}

function dispatch(pm: PermissionManager, kind: ReviewerLane, category: "write" = "write") {
  const args = [
    pm,
    "some_tool",
    "plugin" as const,
    category as never,
    [] as string[],
    {} as Record<string, unknown>,
    {} as Record<string, unknown>,
    [] as string[],
    [] as string[],
    context,
    evaluationContext,
    {} as { writesToOwnSandbox?: boolean; ownerPluginSandboxRoot?: string },
    undefined,
    meta,
    undefined,
  ] as const;
  return kind === "headless"
    ? dispatchReviewerForHeadless(...(args as Parameters<typeof dispatchReviewerForHeadless>))
    : dispatchReviewerForInteractiveAuto(...(args as Parameters<typeof dispatchReviewerForInteractiveAuto>));
}

describe("reviewer-dispatch delegates verdict→decision to PermissionManager (V3 SOT)", () => {
  it("headless: calls resolveReviewerDecision(verdict, 'headless') and wires its allow result", async () => {
    const verdict: RiskVerdict = { level: "low", reason: "safe" };
    const { pm, resolveSpy } = makeStub({ verdict });
    const result = await dispatch(pm, "headless");
    expect(resolveSpy).toHaveBeenCalledWith(verdict, "headless");
    expect(result.allowed).toBe(true);
    expect(result.permissionResult).toEqual(resolveSpy.mock.results[0]!.value);
  });

  it("headless: non-allow decision is wired with deferred metadata layered on", async () => {
    const verdict: RiskVerdict = { level: "high", reason: "danger" };
    const { pm, resolveSpy } = makeStub({ verdict, deferredId: "q-1" });
    const result = await dispatch(pm, "headless");
    expect(resolveSpy).toHaveBeenCalledWith(verdict, "headless");
    expect(result.allowed).toBe(false);
    // SOT decision preserved verbatim; pipeline layers deferred metadata.
    expect(result.permissionResult).toMatchObject({
      decision: "deny",
      layer: 5,
      reviewer: { route: "headless", verdict },
      deferred: { queueId: "q-1", reviewerVerdict: verdict },
    });
  });

  it("foreground-auto: calls resolveReviewerDecision(verdict, 'foreground-auto') and returns its result", async () => {
    const verdict: RiskVerdict = { level: "medium", reason: "review me" };
    const { pm, resolveSpy } = makeStub({ verdict });
    const result = await dispatch(pm, "foreground-auto");
    expect(resolveSpy).toHaveBeenCalledWith(verdict, "foreground-auto");
    expect(result).toEqual(resolveSpy.mock.results[0]!.value);
  });
});

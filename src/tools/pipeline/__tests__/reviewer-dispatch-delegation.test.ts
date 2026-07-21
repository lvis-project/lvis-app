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
import type {
  PermissionManager,
  PermissionCheckResult,
  ReviewerDispatchOutcome,
  ReviewerLane,
} from "../../../permissions/permission-manager.js";
import type { RiskVerdict } from "../../../permissions/reviewer/risk-classifier.js";
import type { ToolPermissionContext, ToolCallMeta, ToolExecutorCallbacks } from "../../executor.js";
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
  interactiveAutoApprove?: "off" | "low" | "medium";
  outcome?: ReviewerDispatchOutcome;
  onDispatch?: () => void;
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
    dispatchReviewer: vi.fn(async () => {
      opts.onDispatch?.();
      return { verdict: opts.verdict, deferredId: opts.deferredId, outcome: opts.outcome ?? "fresh" };
    }),
    resolveReviewerDecision: resolveSpy,
  } as unknown as PermissionManager;
  return { pm, resolveSpy };
}

function dispatch(
  pm: PermissionManager,
  kind: ReviewerLane,
  category: "write" = "write",
  callbacks?: ToolExecutorCallbacks,
  abortSignal?: AbortSignal,
) {
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
    callbacks,
    meta,
    undefined,
    undefined,
    abortSignal,
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
    expect(result.permissionResult).toMatchObject(resolveSpy.mock.results[0]!.value);
    expect(result.permissionResult.reviewer?.outcome).toBe("fresh");
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
    expect(result).toMatchObject(resolveSpy.mock.results[0]!.value);
    expect(result?.reviewer?.outcome).toBe("fresh");
  });

  it.each([
    "unavailable",
    "error",
    "timeout",
    "malformed",
    "sandbox-state-changed",
  ] satisfies ReviewerDispatchOutcome[])(
    "foreground-auto: %s fallback verdict never auto-decides and forces the modal",
    async (outcome) => {
      for (const level of ["low", "medium"] as const) {
        const verdict: RiskVerdict = { level, reason: "rule fallback" };
        const { pm, resolveSpy } = makeStub({ verdict, outcome });
        const result = await dispatch(pm, "foreground-auto");

        expect(resolveSpy).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          decision: "ask",
          layer: 5,
          forceModal: true,
          reviewer: { route: "foreground-auto", verdict, outcome },
        });
      }
    },
  );

  it.each([
    "unavailable",
    "error",
    "timeout",
    "malformed",
    "sandbox-state-changed",
  ] satisfies ReviewerDispatchOutcome[])(
    "headless: %s fallback verdict always denies",
    async (outcome) => {
      for (const level of ["low", "medium"] as const) {
        const verdict: RiskVerdict = { level, reason: "rule fallback" };
        const { pm, resolveSpy } = makeStub({ verdict, outcome });
        const result = await dispatch(pm, "headless");

        expect(resolveSpy).not.toHaveBeenCalled();
        expect(result.allowed).toBe(false);
        expect(result.permissionResult).toMatchObject({
          decision: "deny",
          layer: 5,
          reviewer: { route: "headless", verdict, outcome },
        });
      }
    },
  );


  it.each([
    "fresh", "cache", "approval-memory", "unavailable",
    "error", "timeout", "malformed", "sandbox-state-changed",
  ] satisfies ReviewerDispatchOutcome[])(
    "%s has an explicit foreground and headless dispatcher decision",
    async (outcome) => {
      const successful = ["fresh", "cache", "approval-memory"].includes(outcome);
      const verdict: RiskVerdict = { level: "low", reason: "matrix" };

      const foregroundStub = makeStub({ verdict, outcome });
      const foreground = await dispatch(
        foregroundStub.pm, "foreground-auto",
      ) as PermissionCheckResult;
      expect(foregroundStub.resolveSpy).toHaveBeenCalledTimes(successful ? 1 : 0);
      expect(foreground.decision).toBe(successful ? "allow" : "ask");
      expect(foreground.reviewer?.outcome).toBe(outcome);
      expect(foreground.forceModal === true).toBe(!successful);

      const headlessStub = makeStub({ verdict, outcome });
      const headless = await dispatch(headlessStub.pm, "headless") as {
        allowed: boolean;
        permissionResult: PermissionCheckResult;
      };
      expect(headlessStub.resolveSpy).toHaveBeenCalledTimes(successful ? 1 : 0);
      expect(headless.allowed).toBe(successful);
      expect(headless.permissionResult.decision).toBe(successful ? "allow" : "deny");
      expect(headless.permissionResult.reviewer?.outcome).toBe(outcome);
    },
  );
  it("treats caller abort after a valid fresh result as terminal and non-recordable", async () => {
    const abortController = new AbortController();
    const statuses: string[] = [];
    const { pm, resolveSpy } = makeStub({
      verdict: { level: "low", reason: "valid fresh result" },
      outcome: "fresh",
      onDispatch: () => abortController.abort(),
    });
    const result = await dispatch(pm, "foreground-auto", "write", {
      onPermissionReview: (event) => statuses.push(event.status),
    }, abortController.signal);

    expect(resolveSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      decision: "deny",
      reason: "foreground reviewer cancelled by caller",
      layer: 5,
    });
    expect(result?.reviewer).toBeUndefined();
    expect(statuses).toEqual(["reviewing", "failed"]);
  });
});

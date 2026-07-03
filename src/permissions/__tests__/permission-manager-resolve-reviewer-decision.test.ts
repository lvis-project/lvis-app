/**
 * Permission SOT V3 — PermissionManager.resolveReviewerDecision.
 *
 * Pure unit coverage of the reviewer verdict→decision mapping that P1-b moved
 * out of `src/tools/pipeline/reviewer-dispatch.ts` into the PermissionManager
 * SOT. The mapping is behavior-neutral (tighten-0): these six cases encode the
 * EXACT rules the pipeline used before the move, so they double as the
 * behavior-neutrality proof.
 *
 * Rules:
 *   headless        : low → allow(layer 5) ; medium/high → deny(layer 5)
 *   foreground-auto : low → allow(layer 5) ; medium/high → ask(layer 5)
 * Every result carries `reviewer: { route, verdict }`.
 */
import { describe, it, expect } from "vitest";
import { PermissionManager } from "../permission-manager.js";
import type { RiskVerdict } from "../reviewer/risk-classifier.js";

function verdict(level: RiskVerdict["level"]): RiskVerdict {
  return { level, reason: `${level} reason` };
}

describe("PermissionManager.resolveReviewerDecision", () => {
  // Pure method — no reviewer wiring, cache, or queue required.
  const pm = new PermissionManager();

  describe("headless lane", () => {
    it("low → allow(layer 5) with route+verdict", () => {
      const v = verdict("low");
      expect(pm.resolveReviewerDecision(v, "headless")).toEqual({
        decision: "allow",
        reason: "reviewer low: low reason",
        layer: 5,
        reviewer: { route: "headless", verdict: v },
      });
    });

    it("medium → deny(layer 5) with route+verdict", () => {
      const v = verdict("medium");
      expect(pm.resolveReviewerDecision(v, "headless")).toEqual({
        decision: "deny",
        reason: "reviewer medium: medium reason",
        layer: 5,
        reviewer: { route: "headless", verdict: v },
      });
    });

    it("high → deny(layer 5) with route+verdict", () => {
      const v = verdict("high");
      expect(pm.resolveReviewerDecision(v, "headless")).toEqual({
        decision: "deny",
        reason: "reviewer high: high reason",
        layer: 5,
        reviewer: { route: "headless", verdict: v },
      });
    });
  });

  describe("foreground-auto lane", () => {
    it("low → allow(layer 5) with route+verdict", () => {
      const v = verdict("low");
      expect(pm.resolveReviewerDecision(v, "foreground-auto")).toEqual({
        decision: "allow",
        reason: "reviewer low: low reason",
        layer: 5,
        reviewer: { route: "foreground-auto", verdict: v },
      });
    });

    it("medium → ask(layer 5) with route+verdict", () => {
      const v = verdict("medium");
      expect(pm.resolveReviewerDecision(v, "foreground-auto")).toEqual({
        decision: "ask",
        reason: "reviewer medium: medium reason",
        layer: 5,
        reviewer: { route: "foreground-auto", verdict: v },
      });
    });

    it("high → ask(layer 5) with route+verdict", () => {
      const v = verdict("high");
      expect(pm.resolveReviewerDecision(v, "foreground-auto")).toEqual({
        decision: "ask",
        reason: "reviewer high: high reason",
        layer: 5,
        reviewer: { route: "foreground-auto", verdict: v },
      });
    });
  });
});

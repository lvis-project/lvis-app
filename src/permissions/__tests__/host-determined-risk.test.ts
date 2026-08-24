import { describe, expect, it, vi } from "vitest";
import {
  LlmRiskClassifier,
  type LlmReviewerProvider,
} from "../reviewer/risk-classifier.js";
import { isReviewerAutoDecisionOutcome } from "../permission-manager.js";
import { makeRiskClassifierContext as ctx } from "./test-helpers.js";

/**
 * Host-determined bypass: `agent_spawn`'s risk is settled by system structure
 * (every effectful call the child makes re-enters PermissionManager), a fact
 * absent from the reviewer prompt — so the LLM is a question it cannot answer,
 * and its habitual HIGH kept overriding the host's LOW through max(rule, llm).
 * These cases pin that the LLM is never consulted for it, and ONLY for it.
 */
function alwaysHighProvider(): { provider: LlmReviewerProvider; spy: ReturnType<typeof vi.fn> } {
  const spy = vi.fn(async () => ({
    text: '{"level":"high","reason":"in-process execution without sandbox isolation"}',
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0,
  }));
  return { provider: { complete: spy }, spy };
}

const SPAWN = ctx({
  toolName: "agent_spawn",
  source: "builtin",
  category: "meta",
  pathFields: [],
  finalInput: { title: "t", instructions: "do" },
});

describe("host-determined risk bypass", () => {
  it("never calls the LLM provider for builtin agent_spawn", async () => {
    const { provider, spy } = alwaysHighProvider();
    const classifier = new LlmRiskClassifier(provider, "test-model");

    await classifier.classify(SPAWN);

    expect(spy).not.toHaveBeenCalled();
  });

  it("keeps the rule verdict as final — the composition cannot raise it", async () => {
    const { provider } = alwaysHighProvider();
    const classifier = new LlmRiskClassifier(provider, "test-model");

    const trace = await classifier.classifyWithTrace(SPAWN);

    // The meta rule for agent_spawn is LOW; had the provider been consulted,
    // max(rule, llm) would have produced HIGH.
    expect(trace.finalVerdict.level).toBe("low");
    expect(trace.finalVerdict).toEqual(trace.ruleVerdict);
    expect(trace.llmVerdict).toBeNull();
    expect(trace.outcome).toBe("host-determined");
  });

  it("host-determined may auto-decide — it is a deterministic host verdict", () => {
    expect(isReviewerAutoDecisionOutcome("host-determined")).toBe(true);
  });

  it("does NOT bypass a non-builtin tool that shares the name", async () => {
    const { provider, spy } = alwaysHighProvider();
    const classifier = new LlmRiskClassifier(provider, "test-model");

    const trace = await classifier.classifyWithTrace(
      ctx({ ...SPAWN, source: "plugin" }),
    );

    // A plugin claiming the builtin's name gets no host authority: the full
    // composed path runs and the LLM's HIGH stands.
    expect(spy).toHaveBeenCalled();
    expect(trace.outcome).toBe("fresh");
    expect(trace.finalVerdict.level).toBe("high");
  });

  it("does NOT bypass agent_spawn under a non-meta category", async () => {
    const { provider, spy } = alwaysHighProvider();
    const classifier = new LlmRiskClassifier(provider, "test-model");

    // The bypass is co-scoped with the meta rule that justifies it: a category
    // drift must send the call down the full composed path, never hand the
    // final verdict to a different rule with no LLM cross-check.
    const trace = await classifier.classifyWithTrace(
      ctx({ ...SPAWN, category: "shell" }),
    );

    expect(spy).toHaveBeenCalled();
    expect(trace.outcome).toBe("fresh");
  });

  it("never calls the LLM for builtin agent_status and keeps the rule LOW", async () => {
    const { provider, spy } = alwaysHighProvider();
    const classifier = new LlmRiskClassifier(provider, "test-model");

    const trace = await classifier.classifyWithTrace(
      ctx({ toolName: "agent_status", source: "builtin", category: "meta", pathFields: [], finalInput: {} }),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(trace.outcome).toBe("host-determined");
    expect(trace.finalVerdict.level).toBe("low");
    expect(trace.llmVerdict).toBeNull();
  });

  it("never calls the LLM for builtin agent_list under its declared read category", async () => {
    const { provider, spy } = alwaysHighProvider();
    const classifier = new LlmRiskClassifier(provider, "test-model");

    // agent_list honestly declares `read`, not `meta`. The bypass tracks each
    // tool's own declared category rather than a single hard-coded one.
    const trace = await classifier.classifyWithTrace(
      ctx({ toolName: "agent_list", source: "builtin", category: "read", pathFields: [], finalInput: {} }),
    );

    expect(spy).not.toHaveBeenCalled();
    expect(trace.outcome).toBe("host-determined");
    expect(trace.finalVerdict.level).toBe("low");
  });

  it("does NOT bypass agent_list under a category it does not declare", async () => {
    const { provider, spy } = alwaysHighProvider();
    const classifier = new LlmRiskClassifier(provider, "test-model");

    const trace = await classifier.classifyWithTrace(
      ctx({ toolName: "agent_list", source: "builtin", category: "meta", pathFields: [], finalInput: {} }),
    );

    expect(spy).toHaveBeenCalled();
    expect(trace.outcome).toBe("fresh");
  });

  it("does NOT bypass agent_interrupt — a mutating meta tool keeps the LLM lane", async () => {
    const { provider, spy } = alwaysHighProvider();
    const classifier = new LlmRiskClassifier(provider, "test-model");

    const trace = await classifier.classifyWithTrace(
      ctx({ toolName: "agent_interrupt", source: "builtin", category: "meta", pathFields: [], finalInput: { id: "x" } }),
    );

    expect(spy).toHaveBeenCalled();
    expect(trace.outcome).toBe("fresh");
    expect(trace.finalVerdict.level).toBe("high");
  });

  it("does NOT bypass other builtin tools — write still composes with the LLM", async () => {
    const { provider, spy } = alwaysHighProvider();
    const classifier = new LlmRiskClassifier(provider, "test-model");

    // A rule-HIGH input would be composition-pinned and skip the provider,
    // so the non-bypass is shown on a non-HIGH rule verdict: the LLM is
    // consulted and its escalation lands in the composed verdict.
    const trace = await classifier.classifyWithTrace(
      ctx({
        toolName: "write_file",
        category: "write",
        finalInput: { path: "/Users/example/work/x.md" },
      }),
    );

    expect(spy).toHaveBeenCalled();
    expect(trace.outcome).toBe("fresh");
    expect(trace.ruleVerdict.level).not.toBe("high");
    expect(trace.finalVerdict.level).toBe("high");
  });
});

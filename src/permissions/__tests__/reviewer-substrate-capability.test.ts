/**
 * Substrate-aware reviewer sandbox capability.
 *
 * The reviewer's `asrt` strong-relaxation (isWeakSandbox === false → the LLM
 * may downgrade a rule-based MEDIUM/HIGH verdict to LOW) must apply ONLY to
 * executions GENUINELY isolated by ASRT — the `wrapToolCommand`-wrapped
 * `bash`/`powershell` host-shell path. Plugin/MCP tool effects run in the
 * unwrapped long-lived MCP worker (isolation=none) and other in-process
 * builtins are not OS-jailed, so they must NEVER receive the asrt relaxation
 * even when the process-global capability is `asrt` (gate ON). Otherwise
 * enabling the host sandbox would SILENTLY relax the approval gate for
 * unsandboxed plugin/MCP tools — the opposite of intent.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetActiveSandboxCapabilityForTest,
  isWeakSandbox,
  resolveReviewerSandboxCapability,
  setActiveSandboxCapability,
  type SandboxCapability,
} from "../sandbox-capability.js";
import {
  LlmRiskClassifier,
  type LlmReviewerProvider,
} from "../reviewer/risk-classifier.js";
import { makeRiskClassifierContext as ctx } from "./test-helpers.js";

describe("resolveReviewerSandboxCapability — execution-substrate awareness", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
  });

  it("returns the genuine asrt capability for the ASRT-wrapped host-shell tools when the gate is ON", () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
    });

    for (const toolName of ["bash", "powershell"]) {
      const cap = resolveReviewerSandboxCapability("builtin", toolName);
      expect(cap.kind).toBe("asrt");
      // The host-shell substrate genuinely runs wrapped → NOT weak → reviewer
      // may relax for these calls.
      expect(isWeakSandbox(cap)).toBe(false);
    }
  });

  it("forces kind=none (weak) for plugin/MCP tools EVEN WHEN the global capability is asrt", () => {
    // Gate ON: the process-global capability is asrt…
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active — fs+process+network contained",
    });

    // …but plugin/MCP effects run in the unwrapped long-lived worker.
    for (const source of ["plugin", "mcp"] as const) {
      const cap = resolveReviewerSandboxCapability(source, "any_tool");
      expect(cap.kind).toBe("none");
      expect(cap.confidence).toBe("verified");
      expect(cap.reason).toMatch(/worker not ASRT-wrapped/i);
      // Machine-checkable: nothing is confined for this substrate.
      expect(cap.confines).toEqual({ filesystem: false, process: false, network: false });
      // WEAK → the reviewer CANNOT relax (no MEDIUM/HIGH → LOW downgrade).
      expect(isWeakSandbox(cap)).toBe(true);
    }
  });

  it("forces kind=none (weak) for in-process builtin tools (not bash/powershell) even when gate is ON", () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active",
    });

    // A non-shell builtin (e.g. write_file/read_file) runs in-process — no OS jail.
    const cap = resolveReviewerSandboxCapability("builtin", "write_file");
    expect(cap.kind).toBe("none");
    expect(cap.reason).toMatch(/in-process builtin/i);
    expect(isWeakSandbox(cap)).toBe(true);
  });

  it("host-shell tools stay none when the gate is OFF (no over-grant)", () => {
    // No setActiveSandboxCapability call → global capability is none.
    const cap = resolveReviewerSandboxCapability("builtin", "bash");
    expect(cap.kind).toBe("none");
    expect(isWeakSandbox(cap)).toBe(true);
  });
});

describe("substrate-aware capability — end-to-end reviewer prompt + downgrade guard", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
  });

  // Capture the userPrompt the reviewer hands the LLM so we can prove which
  // executionSandbox value reaches the model per substrate.
  const capturingProvider = (): { provider: LlmReviewerProvider; complete: ReturnType<typeof vi.fn> } => {
    const complete = vi.fn(async () => ({
      text: '{"level":"low","reason":"looks fine"}',
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    return { provider: { complete }, complete };
  };

  it("a plugin-sourced tool presents executionSandbox=none to the reviewer EVEN WHEN the global cap is asrt", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active",
    });

    const { provider, complete } = capturingProvider();
    const classifier = new LlmRiskClassifier(provider, "gpt-4o-mini");
    await classifier.classify(
      ctx({
        toolName: "plugin_run",
        source: "plugin",
        category: "shell",
        finalInput: { command: "make build" },
        // The substrate resolver is what production threads in — a plugin call
        // resolves to none even though the global capability is asrt.
        sandboxCapability: resolveReviewerSandboxCapability("plugin", "plugin_run"),
        conversationContext: { recentUserMessage: "please build the project for me" },
      }),
    );
    const userPrompt = complete.mock.calls[0]![0].userPrompt as string;
    // PROOF: the worker-routed (unwrapped) substrate is reported as none — the
    // reviewer is told NOT to relax for this unsandboxed effect.
    expect(userPrompt).toContain("executionSandbox=none");
    expect(userPrompt).not.toContain("executionSandbox=asrt");
  });

  it("an ASRT-wrapped host bash tool presents executionSandbox=asrt to the reviewer when the gate is ON", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active",
    });

    const { provider, complete } = capturingProvider();
    const classifier = new LlmRiskClassifier(provider, "gpt-4o-mini");
    await classifier.classify(
      ctx({
        toolName: "bash",
        source: "builtin",
        category: "shell",
        finalInput: { command: "make build" },
        sandboxCapability: resolveReviewerSandboxCapability("builtin", "bash"),
        conversationContext: { recentUserMessage: "please build the project for me" },
      }),
    );
    const userPrompt = complete.mock.calls[0]![0].userPrompt as string;
    // The genuinely-wrapped host-shell substrate earns the asrt report.
    expect(userPrompt).toContain("executionSandbox=asrt");
  });

  it("the weak-sandbox no-downgrade guard fires for the plugin substrate (rule MEDIUM not downgraded to LOW)", async () => {
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "linux",
      reason: "ASRT (bwrap) active",
    });

    const { provider } = capturingProvider(); // always returns LLM LOW
    const classifier = new LlmRiskClassifier(provider, "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "plugin_run",
        source: "plugin",
        category: "shell",
        finalInput: { command: "make build" }, // rule → MEDIUM
        sandboxCapability: resolveReviewerSandboxCapability("plugin", "plugin_run"),
        conversationContext: { recentUserMessage: "please build the project for me" },
      }),
    );
    // weak substrate → LLM LOW cannot pull the MEDIUM rule verdict down.
    expect(verdict.level).toBe("medium");
  });
});

describe("network-only asrt — per-category relaxation gating (Windows posture, dormant)", () => {
  // A synthetic NETWORK-ONLY ASRT capability — confines egress but provides no
  // filesystem jail. No producer emits this yet (Windows ASRT lands in a later
  // PR), so these tests exercise the DORMANT category-gating path directly.
  //
  // Composition contract (design §401/§512): final = max(rule, llm); the LLM is
  // escalate-only and can NEVER pull a verdict below the rule. The per-category
  // guard therefore manifests as the explicit no-downgrade enforcement: for a
  // category the sandbox does NOT relax (no matching confines dimension), an LLM
  // LOW is rejected and the rule verdict is honoured. For a category the sandbox
  // DOES relax (e.g. network egress is jailed), the guard does not fire and the
  // max(rule, llm) composition applies — an LLM escalation is still honoured.
  const networkOnlyAsrt = (): SandboxCapability => ({
    kind: "asrt",
    confidence: "verified",
    platform: "win32",
    reason: "ASRT (srt-win) active — network egress contained, no fs jail",
    confines: { filesystem: false, process: false, network: true },
  });

  const llmProvider = (level: "low" | "high"): LlmReviewerProvider => ({
    complete: vi.fn(async () => ({
      text: `{"level":"${level}","reason":"llm opinion"}`,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    })),
  });

  it("guard FIRES for a shell-category rule-MEDIUM (no fs jail → LLM LOW cannot downgrade)", async () => {
    const classifier = new LlmRiskClassifier(llmProvider("low"), "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "bash",
        source: "builtin",
        category: "shell",
        finalInput: { command: "make build" }, // rule → MEDIUM (shell unclassified)
        sandboxCapability: networkOnlyAsrt(),
        conversationContext: { recentUserMessage: "please build the project for me" },
      }),
    );
    // confines.filesystem === false → sandboxRelaxesCategory('shell') === false
    // → guard fires → MEDIUM rule verdict survives the LLM LOW.
    expect(verdict.level).toBe("medium");
  });

  it("guard FIRES for a write-category rule-MEDIUM (no fs jail → LLM LOW cannot downgrade)", async () => {
    const classifier = new LlmRiskClassifier(llmProvider("low"), "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "write_file",
        source: "builtin",
        category: "write",
        pathFields: ["path"],
        // Deep inside an allowed dir → rule → MEDIUM ("write deep inside allowed").
        finalInput: { path: "/Users/ken/work/nested/dir/output.txt" },
        sandboxCapability: networkOnlyAsrt(),
        conversationContext: { recentUserMessage: "please write the output file for me" },
      }),
    );
    expect(verdict.level).toBe("medium");
  });

  it("relaxation IS allowed for the network category — guard does NOT fire, max(rule, llm) applies (LLM escalation honoured)", async () => {
    // Network egress IS jailed → sandboxRelaxesCategory('network') === true →
    // the no-downgrade guard does NOT short-circuit; the standard max(rule, llm)
    // composition runs. An escalating LLM (HIGH) is still honoured.
    const classifier = new LlmRiskClassifier(llmProvider("high"), "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "http_request",
        source: "builtin",
        category: "network",
        finalInput: { url: "http://localhost:8080/build" }, // rule → MEDIUM (localhost)
        sandboxCapability: networkOnlyAsrt(),
        conversationContext: { recentUserMessage: "please fetch the local build status for me" },
      }),
    );
    expect(verdict.level).toBe("high");
  });

  it("network-category relaxation does NOT bleed into a write call on the SAME network-only cap (guard still fires for write)", async () => {
    // Same capability, escalate-only LLM is irrelevant here: an LLM LOW on a
    // write-category call must NOT relax (filesystem is not jailed) even though
    // the same cap WOULD relax the network category — proves the gate is keyed
    // on the call's category, not the capability alone.
    const classifier = new LlmRiskClassifier(llmProvider("low"), "gpt-4o-mini");
    const verdict = await classifier.classify(
      ctx({
        toolName: "write_file",
        source: "builtin",
        category: "write",
        pathFields: ["path"],
        finalInput: { path: "/Users/ken/work/nested/dir/output.txt" }, // rule → MEDIUM
        sandboxCapability: networkOnlyAsrt(),
        conversationContext: { recentUserMessage: "please write the output file for me" },
      }),
    );
    expect(verdict.level).toBe("medium");
  });
});

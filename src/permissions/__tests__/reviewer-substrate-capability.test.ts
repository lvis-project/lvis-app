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

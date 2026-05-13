import { describe, expect, it } from "vitest";

import {
  detectSandboxCapability,
  formatSandboxCapabilityForPrompt,
  isSandboxWeak,
  type SandboxCapability,
} from "../sandbox-capability.js";

describe("sandbox-capability", () => {
  it("detectSandboxCapability returns kind=none/confidence=verified for the current host", () => {
    const cap = detectSandboxCapability();
    expect(cap.kind).toBe("none");
    expect(cap.confidence).toBe("verified");
    expect(cap.platform).toBe(process.platform);
    expect(cap.reason).toMatch(/no OS sandbox/i);
  });

  it("formatSandboxCapabilityForPrompt produces a grep-stable single-line string", () => {
    const cap: SandboxCapability = {
      kind: "none",
      confidence: "verified",
      platform: "darwin",
      reason: "no OS sandbox configured for the host process",
    };
    expect(formatSandboxCapabilityForPrompt(cap)).toBe(
      "executionSandbox=none (verified, darwin) — no OS sandbox configured for the host process",
    );
  });

  it("isSandboxWeak treats kind=none as weak regardless of confidence", () => {
    expect(
      isSandboxWeak({
        kind: "none",
        confidence: "verified",
        platform: "linux",
        reason: "",
      }),
    ).toBe(true);
  });

  it("isSandboxWeak treats assumed confidence as weak even for non-none kinds", () => {
    expect(
      isSandboxWeak({
        kind: "bubblewrap",
        confidence: "assumed",
        platform: "linux",
        reason: "",
      }),
    ).toBe(true);
  });

  it("isSandboxWeak returns false for a verified non-none capability", () => {
    expect(
      isSandboxWeak({
        kind: "bubblewrap",
        confidence: "verified",
        platform: "linux",
        reason: "bwrap present + invocable",
      }),
    ).toBe(false);
    expect(
      isSandboxWeak({
        kind: "sandbox-exec",
        confidence: "verified",
        platform: "darwin",
        reason: "sandbox-exec gating enforced",
      }),
    ).toBe(false);
  });
});

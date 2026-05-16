import { describe, expect, it } from "vitest";

import {
  detectSandboxCapability,
  formatSandboxCapabilityForPrompt,
  isWeakSandbox,
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

// ─── PR-A1 additions: new SandboxKind union members ──────────────────────────

describe("sandbox-capability — PR-A1 new kind union members", () => {
  it("SandboxKind type includes 'partial' and 'fs-only' (compile-time check via assignment)", () => {
    // If SandboxKind did not include these values, this block would fail
    // to compile (caught by typecheck). Runtime assertion confirms the
    // value round-trips through the type.
    const partial: SandboxCapability = {
      kind: "partial",
      confidence: "verified",
      platform: "darwin",
      reason: "sandbox-exec partial profile active",
    };
    const fsOnly: SandboxCapability = {
      kind: "fs-only",
      confidence: "verified",
      platform: "linux",
      reason: "landlock filesystem isolation only",
    };
    expect(partial.kind).toBe("partial");
    expect(fsOnly.kind).toBe("fs-only");
  });

  // ── isWeakSandbox (canonical, exported as isWeakSandbox + isSandboxWeak alias) ──

  it("isWeakSandbox returns true for kind='partial' (D5: partial evidence → weak)", () => {
    expect(
      isWeakSandbox({
        kind: "partial",
        confidence: "verified",
        platform: "darwin",
        reason: "partial sandbox-exec profile",
      }),
    ).toBe(true);
  });

  it("isWeakSandbox returns false for kind='fs-only' (strong-for-fs, not weak)", () => {
    expect(
      isWeakSandbox({
        kind: "fs-only",
        confidence: "verified",
        platform: "linux",
        reason: "landlock active",
      }),
    ).toBe(false);
  });

  it("isWeakSandbox returns false for verified bubblewrap (unchanged)", () => {
    expect(
      isWeakSandbox({
        kind: "bubblewrap",
        confidence: "verified",
        platform: "linux",
        reason: "bwrap present",
      }),
    ).toBe(false);
  });

  it("isWeakSandbox returns false for verified appcontainer", () => {
    expect(
      isWeakSandbox({
        kind: "appcontainer",
        confidence: "verified",
        platform: "win32",
        reason: "AppContainer active",
      }),
    ).toBe(false);
  });

  // isSandboxWeak is an alias — spot-check that it delegates to isWeakSandbox
  it("isSandboxWeak (alias) agrees with isWeakSandbox for kind='partial'", () => {
    const cap: SandboxCapability = {
      kind: "partial",
      confidence: "verified",
      platform: "darwin",
      reason: "partial",
    };
    expect(isSandboxWeak(cap)).toBe(isWeakSandbox(cap));
  });

  // ── formatSandboxCapabilityForPrompt — new kind labels ────────────────────

  it("formatSandboxCapabilityForPrompt includes Korean label for kind='partial'", () => {
    const cap: SandboxCapability = {
      kind: "partial",
      confidence: "assumed",
      platform: "darwin",
      reason: "partial sandbox-exec",
    };
    const result = formatSandboxCapabilityForPrompt(cap);
    expect(result).toContain("partial");
    expect(result).toContain("OS 격리 부분적");
    expect(result).toContain("(assumed, darwin)");
  });

  it("formatSandboxCapabilityForPrompt includes Korean label for kind='fs-only'", () => {
    const cap: SandboxCapability = {
      kind: "fs-only",
      confidence: "verified",
      platform: "linux",
      reason: "landlock only",
    };
    const result = formatSandboxCapabilityForPrompt(cap);
    expect(result).toContain("fs-only");
    expect(result).toContain("파일시스템만 격리");
    expect(result).toContain("(verified, linux)");
  });

  it("formatSandboxCapabilityForPrompt preserves original stable format for kind='none'", () => {
    const cap: SandboxCapability = {
      kind: "none",
      confidence: "verified",
      platform: "darwin",
      reason: "no OS sandbox configured for the host process",
    };
    // Existing tests rely on this exact format — must not regress.
    expect(formatSandboxCapabilityForPrompt(cap)).toBe(
      "executionSandbox=none (verified, darwin) — no OS sandbox configured for the host process",
    );
  });
});

// ─── Fixture snapshot: sandbox-eval-verdicts.json ────────────────────────────

describe("sandbox-eval-verdicts fixture", () => {
  it("fixture file has all 8 expected cases (PR-A3: +sandbox-exec +appcontainer)", async () => {
    const fixture = (await import("./__fixtures__/sandbox-eval-verdicts.json", {
      with: { type: "json" },
    })).default as Record<string, { rule: string; llm: string; final: string }>;

    expect(Object.keys(fixture)).toHaveLength(8);
    expect(fixture["kind=none + benign tool"]).toEqual({ rule: "low", llm: "low", final: "low" });
    expect(fixture["kind=none + risky tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
    expect(fixture["kind=bubblewrap + risky tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
    expect(fixture["kind=partial + risky tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
    expect(fixture["kind=fs-only + high-risk write"]).toEqual({ rule: "high", llm: "medium", final: "high" });
    expect(fixture["weak context + benign tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
  });
});

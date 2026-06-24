import { afterEach, describe, expect, it } from "vitest";

import {
  __resetActiveSandboxCapabilityForTest,
  detectSandboxCapability,
  formatSandboxCapabilityForPrompt,
  isWeakSandbox,
  setActiveSandboxCapability,
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

  it("isWeakSandbox treats kind=none as weak regardless of confidence", () => {
    expect(
      isWeakSandbox({
        kind: "none",
        confidence: "verified",
        platform: "linux",
        reason: "",
      }),
    ).toBe(true);
  });

  it("isWeakSandbox treats assumed confidence as weak even for non-none kinds", () => {
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "assumed",
        platform: "linux",
        reason: "",
      }),
    ).toBe(true);
  });

  it("isWeakSandbox returns false for a verified non-none capability", () => {
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "verified",
        platform: "linux",
        reason: "ASRT (bwrap) active",
      }),
    ).toBe(false);
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "verified",
        platform: "darwin",
        reason: "ASRT (Seatbelt) active",
      }),
    ).toBe(false);
  });

  it("formatSandboxCapabilityForPrompt emits the 'asrt' kind label", () => {
    const cap: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
    };
    expect(formatSandboxCapabilityForPrompt(cap)).toBe(
      "executionSandbox=asrt (verified, darwin) — ASRT (Seatbelt) active — fs+process+network contained",
    );
  });
});

// ─── Active capability publish (boot ASRT-init path) ─────────────────────────

describe("sandbox-capability — setActiveSandboxCapability publish", () => {
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
  });

  it("publishes kind='asrt' (verified) so detectSandboxCapability + the reviewer strong-relaxation become reachable when the gate is ON", () => {
    // Mirrors boot.ts: when the gate is ON and initializeAsrtSandbox succeeds,
    // boot publishes the active capability to the SOT.
    setActiveSandboxCapability({
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT (Seatbelt) active — fs+process+network contained",
    });
    const cap = detectSandboxCapability();
    expect(cap.kind).toBe("asrt");
    expect(cap.confidence).toBe("verified");
    // The 'asrt'-strong branch in isWeakSandbox is now reachable: a verified
    // ASRT capability is NOT weak, so the reviewer's strong relaxation applies.
    expect(isWeakSandbox(cap)).toBe(false);
  });

  it("falls back to kind='none' (verified) when no capability was published (gate OFF / Windows fail-closed / Linux deps-missing)", () => {
    // No setActiveSandboxCapability call — the SOT reports the absence of OS
    // isolation, matching the default-OFF posture and the non-initialized paths.
    const cap = detectSandboxCapability();
    expect(cap.kind).toBe("none");
    expect(cap.confidence).toBe("verified");
    expect(isWeakSandbox(cap)).toBe(true);
  });
});

// ─── SandboxKind union members ───────────────────────────────────────────────

describe("sandbox-capability — SandboxKind union members", () => {
  it("SandboxKind type includes 'asrt', 'partial' and 'fs-only' (compile-time check via assignment)", () => {
    // If SandboxKind did not include these values, this block would fail
    // to compile (caught by typecheck). Runtime assertion confirms the
    // value round-trips through the type.
    const asrt: SandboxCapability = {
      kind: "asrt",
      confidence: "verified",
      platform: "darwin",
      reason: "ASRT active",
    };
    const partial: SandboxCapability = {
      kind: "partial",
      confidence: "verified",
      platform: "darwin",
      reason: "partial profile active",
    };
    const fsOnly: SandboxCapability = {
      kind: "fs-only",
      confidence: "verified",
      platform: "linux",
      reason: "landlock filesystem isolation only",
    };
    expect(asrt.kind).toBe("asrt");
    expect(partial.kind).toBe("partial");
    expect(fsOnly.kind).toBe("fs-only");
  });

  // ── isWeakSandbox (canonical) ──

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

  it("isWeakSandbox returns false for verified asrt (strong)", () => {
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "verified",
        platform: "linux",
        reason: "ASRT (bwrap) active",
      }),
    ).toBe(false);
    expect(
      isWeakSandbox({
        kind: "asrt",
        confidence: "verified",
        platform: "darwin",
        reason: "ASRT (Seatbelt) active",
      }),
    ).toBe(false);
  });

  // ── formatSandboxCapabilityForPrompt — new kind labels ────────────────────

  it("formatSandboxCapabilityForPrompt includes Korean label for kind='partial'", () => {
    const cap: SandboxCapability = {
      kind: "partial",
      confidence: "assumed",
      platform: "darwin",
      reason: "partial OS isolation",
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
  it("fixture file has all 6 expected cases (per-OS runner kinds replaced by 'asrt')", async () => {
    const fixture = (await import("./__fixtures__/sandbox-eval-verdicts.json", {
      with: { type: "json" },
    })).default as Record<string, { rule: string; llm: string; final: string }>;

    expect(Object.keys(fixture)).toHaveLength(6);
    expect(fixture["kind=none + benign tool"]).toEqual({ rule: "low", llm: "low", final: "low" });
    expect(fixture["kind=none + risky tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
    expect(fixture["kind=asrt + risky tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
    expect(fixture["kind=partial + risky tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
    expect(fixture["kind=fs-only + high-risk write"]).toEqual({ rule: "high", llm: "medium", final: "high" });
    expect(fixture["weak context + benign tool"]).toEqual({ rule: "medium", llm: "low", final: "medium" });
  });
});

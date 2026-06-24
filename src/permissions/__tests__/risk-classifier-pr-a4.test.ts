/**
 * PR-A4 tests for risk-classifier: grapheme + entropy intent classifier (R-1),
 * HIGH-1 / HIGH-2 / MEDIUM-2 dedicated test cases (PR-A2 #779 gap fill).
 *
 * Issue: #691 PR-A4
 */
import { describe, it, expect } from "vitest";
import {
  isContextMissingIntent,
  RuleBasedRiskClassifier,
  LlmRiskClassifier,
  type ToolInvocationContext,
} from "../reviewer/risk-classifier.js";
import type { SandboxCapability } from "../sandbox-capability.js";

const STRONG_CAP: SandboxCapability = {
  kind: "asrt",
  confidence: "verified",
  platform: "linux",
  reason: "ASRT (bwrap) detected",
};

const WEAK_CAP: SandboxCapability = {
  kind: "none",
  confidence: "verified",
  platform: "linux",
  reason: "no sandbox",
};

function makeCtx(overrides: Partial<ToolInvocationContext> = {}): ToolInvocationContext {
  return {
    toolName: "bash_run",
    source: "user-keyboard",
    category: "shell",
    pathFields: [],
    trustOrigin: "user-keyboard",
    finalInput: { command: "ls" },
    allowedDirectories: ["/home/user"],
    sensitivePathsAdjacent: [],
    sandboxCapability: WEAK_CAP,
    ...overrides,
  };
}

// ─── isContextMissingIntent tests ────────────────────────────────────────────

describe("isContextMissingIntent — PR-A4 grapheme + entropy classifier", () => {
  it("returns true for absent message", () => {
    expect(isContextMissingIntent(makeCtx({ conversationContext: undefined }))).toBe(true);
  });

  it("returns true for empty string", () => {
    expect(isContextMissingIntent(makeCtx({ conversationContext: { recentUserMessage: "" } }))).toBe(true);
  });

  it("returns true for short message (< 15 graphemes)", () => {
    expect(isContextMissingIntent(makeCtx({ conversationContext: { recentUserMessage: "ls 해줘" } }))).toBe(true);
  });

  it("returns true for 3-char Korean utterance (PR-A1 false-positive fixed)", () => {
    // Old v1 heuristic would return true for < 5 chars; new grapheme check
    // also returns true but for a different reason (< 15 graphemes). What matters
    // is that SHORT Korean is still treated as weak — the F1 finding was about
    // LONGER Korean messages being incorrectly flagged.
    expect(isContextMissingIntent(makeCtx({ conversationContext: { recentUserMessage: "확인해" } }))).toBe(true);
  });

  it("returns false for a clear Korean sentence with sufficient graphemes", () => {
    // 25+ graphemes, 3+ unique words, good diversity
    const msg = "프로젝트 빌드 결과물을 정리하고 싶어서 임시 파일들을 삭제해주세요";
    expect(isContextMissingIntent(makeCtx({ conversationContext: { recentUserMessage: msg } }))).toBe(false);
  });

  it("returns false for a clear English sentence", () => {
    const msg = "Please delete the build artifacts from the temporary directory";
    expect(isContextMissingIntent(makeCtx({ conversationContext: { recentUserMessage: msg } }))).toBe(false);
  });

  it("returns true for low-entropy repeated-char spam", () => {
    // 20 graphemes but diversity ratio < 0.25
    const msg = "aaaaaaaaaaaaaaaaaaaaaa"; // 22 chars, 1 unique → ratio = 0.045
    expect(isContextMissingIntent(makeCtx({ conversationContext: { recentUserMessage: msg } }))).toBe(true);
  });

  it("returns true for insufficient unique words (< 3)", () => {
    // Long enough graphemes but only 2 unique words
    const msg = "test test test test test test test test"; // 38 chars, 2 unique words
    expect(isContextMissingIntent(makeCtx({ conversationContext: { recentUserMessage: msg } }))).toBe(true);
  });

  it("returns false for Korean with 15+ graphemes and 3+ unique words", () => {
    const msg = "사용자가 요청한 파일 디렉터리를 조회하기 위해 ls 명령어를 실행합니다"; // 30+ graphemes
    expect(isContextMissingIntent(makeCtx({ conversationContext: { recentUserMessage: msg } }))).toBe(false);
  });
});

// ─── RuleBasedRiskClassifier HIGH/MEDIUM dedicated tests ──────────────────────

describe("RuleBasedRiskClassifier — HIGH-1 / HIGH-2 / MEDIUM-2 (PR-A2 gap fill)", () => {
  const classifier = new RuleBasedRiskClassifier();

  // HIGH-1: shell with destructive verb
  it("HIGH-1: shell rm -rf → high verdict", () => {
    const verdict = classifier.classify(makeCtx({
      category: "shell",
      finalInput: { command: "rm -rf /tmp/test" },
    }));
    expect(verdict.level).toBe("high");
  });

  // HIGH-2: write outside allowed dirs
  it("HIGH-2: write outside allowed dirs → high verdict", () => {
    const verdict = classifier.classify(makeCtx({
      category: "write",
      finalInput: { path: "/etc/passwd" },
      pathFields: ["/etc/passwd"],
      allowedDirectories: ["/home/user"],
    }));
    expect(verdict.level).toBe("high");
  });

  // HIGH-3: network to untrusted host
  it("HIGH-3: network to untrusted host → high verdict", () => {
    const verdict = classifier.classify(makeCtx({
      category: "network",
      finalInput: { url: "https://evil.example.com/exfil" },
    }));
    expect(verdict.level).toBe("high");
  });

  // MEDIUM-2: shell with unclassified command (no destructive/reversible match)
  it("MEDIUM-2: shell with unclassified command → medium verdict", () => {
    const verdict = classifier.classify(makeCtx({
      category: "shell",
      finalInput: { command: "git status" },
    }));
    // "git" doesn't match destructive or reversible patterns → medium
    expect(verdict.level).toBe("medium");
  });

  // LOW via reversible shell verb
  it("LOW: shell echo → low verdict (reversible verb)", () => {
    const verdict = classifier.classify(makeCtx({
      category: "shell",
      finalInput: { command: "echo hello" },
    }));
    expect(verdict.level).toBe("low");
  });

  // LOW: read inside allowed
  it("LOW: read inside allowed dirs → low verdict", () => {
    const verdict = classifier.classify(makeCtx({
      category: "read",
      finalInput: { path: "/home/user/file.txt" },
      pathFields: ["/home/user/file.txt"],
    }));
    expect(verdict.level).toBe("low");
  });
});

// ─── LlmRiskClassifier R-1 no-downgrade rule ─────────────────────────────────

describe("LlmRiskClassifier — R-1 no-downgrade with weak context", () => {
  function makeLlmProvider(responseLevel: "low" | "medium" | "high") {
    return {
      complete: async () => ({
        text: JSON.stringify({ level: responseLevel, reason: "llm response" }),
        tokensIn: 10,
        tokensOut: 5,
        costUsd: 0.0001,
      }),
    };
  }

  it("LLM cannot downgrade rule HIGH to LOW when context is weak", async () => {
    const classifier = new LlmRiskClassifier(makeLlmProvider("low"), "gpt-4o-mini");
    const verdict = await classifier.classify(makeCtx({
      category: "shell",
      finalInput: { command: "rm -rf /" },
      sandboxCapability: WEAK_CAP,
      conversationContext: { recentUserMessage: "해줘" }, // weak context
    }));
    expect(verdict.level).toBe("high"); // rule-based HIGH must win
  });

  it("LLM can upgrade rule LOW to MEDIUM when context is strong", async () => {
    const classifier = new LlmRiskClassifier(makeLlmProvider("medium"), "gpt-4o-mini");
    const msg = "지정된 경로의 파일을 읽어서 내용을 요약해주세요 세부 정보 포함";
    const verdict = await classifier.classify(makeCtx({
      category: "read",
      finalInput: { path: "/home/user/secret.txt" },
      sandboxCapability: STRONG_CAP,
      conversationContext: { recentUserMessage: msg },
    }));
    // Rule is LOW, LLM says MEDIUM → max → MEDIUM
    expect(verdict.level).toBe("medium");
  });
});

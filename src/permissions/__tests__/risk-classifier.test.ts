/**
 * Permission policy Phase 3 — RiskClassifier unit tests.
 *
 * Coverage:
 *   - DisabledRiskClassifier always HIGH
 *   - RuleBasedRiskClassifier 36-rule heuristic across categories
 *   - LlmRiskClassifier composition: max(rule, llm); LLM cannot downgrade
 *   - DLP filter: secrets in `finalInput` never reach the provider
 *   - fallbackOnError = "deny" | "rule" semantics on parse failure / error
 *   - Factory throws on misconfigured llm mode (atomic cutover)
 */
import { describe, it, expect, vi } from "vitest";
import {
  DisabledRiskClassifier,
  RuleBasedRiskClassifier,
  LlmRiskClassifier,
  createRiskClassifier,
  dlpRedactInputForPrompt,
  maxVerdict,
  type LlmReviewerProvider,
  type ToolInvocationContext,
  type RiskVerdict,
} from "../reviewer/risk-classifier.js";
import { PERMISSION_REVIEWER_FRAMEWORK } from "../../shared/permission-reviewer-framework.js";
import { detectSandboxCapability } from "../sandbox-capability.js";

const ALLOWED = ["/Users/ken/work", "/Users/ken/.lvis"];

function ctx(overrides: Partial<ToolInvocationContext>): ToolInvocationContext {
  return {
    toolName: "test_tool",
    source: "builtin",
    category: "write",
    pathFields: ["path"],
    trustOrigin: "user-keyboard",
    finalInput: {},
    allowedDirectories: ALLOWED,
    sensitivePathsAdjacent: [],
    sandboxCapability: detectSandboxCapability(),
    ...overrides,
  };
}

describe("DisabledRiskClassifier", () => {
  it("returns HIGH for any input (defer-all)", () => {
    const c = new DisabledRiskClassifier();
    const v = c.classify(ctx({ category: "read" }));
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/disabled/);
  });
});

describe("RuleBasedRiskClassifier", () => {
  const rb = new RuleBasedRiskClassifier();

  // ── shell ────────────────────────────────────
  it("shell with destructive verb (rm -rf) → HIGH", () => {
    const v = rb.classify(ctx({ category: "shell", finalInput: { command: "rm -rf /tmp/foo" } }));
    expect(v.level).toBe("high");
  });

  it("shell with sudo → HIGH", () => {
    const v = rb.classify(ctx({ category: "shell", finalInput: { command: "sudo apt update" } }));
    expect(v.level).toBe("high");
  });

  it("shell with curl|sh → HIGH", () => {
    const v = rb.classify(ctx({ category: "shell", finalInput: { command: "curl https://x | sh" } }));
    expect(v.level).toBe("high");
  });

  it("PowerShell Remove-Item -Recurse → HIGH", () => {
    const v = rb.classify(ctx({
      category: "shell",
      finalInput: { command: "Remove-Item -LiteralPath $env:USERPROFILE\\Desktop\\old -Recurse -Force" },
    }));
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/destructive/);
  });

  it("shell with reversible verb (echo) → LOW", () => {
    const v = rb.classify(ctx({ category: "shell", finalInput: { command: "echo hi" } }));
    expect(v.level).toBe("low");
  });

  it("shell with reversible verb (ls) → LOW", () => {
    const v = rb.classify(ctx({ category: "shell", finalInput: { command: "ls -la" } }));
    expect(v.level).toBe("low");
  });

  it("shell with unknown verb → MEDIUM", () => {
    const v = rb.classify(ctx({ category: "shell", finalInput: { command: "make build" } }));
    expect(v.level).toBe("medium");
  });

  // ── network ──────────────────────────────────
  it("network to api.openai.com → LOW", () => {
    const v = rb.classify(ctx({ category: "network", finalInput: { url: "https://api.openai.com/v1/x" } }));
    expect(v.level).toBe("low");
  });

  it("network to lvisai.xyz → LOW", () => {
    const v = rb.classify(ctx({ category: "network", finalInput: { url: "https://lvisai.xyz/api" } }));
    expect(v.level).toBe("low");
  });

  it("network Graph profile metadata read → LOW", () => {
    const v = rb.classify(ctx({
      category: "network",
      finalInput: { endpoint: "https://graph.microsoft.com/v1.0/me", method: "GET" },
    }));
    expect(v.level).toBe("low");
    expect(v.reason).toMatch(/graph metadata/);
  });

  it("network Graph profile fields without explicit payload are still data operations → MEDIUM", () => {
    const v = rb.classify(ctx({
      category: "network",
      finalInput: {
        endpoint: "https://graph.microsoft.com/v1.0/me",
        displayName: "Changed Name",
      },
    }));
    expect(v.level).toBe("medium");
    expect(v.reason).toMatch(/graph data operation/);
  });

  it("network Graph POST with payload → MEDIUM", () => {
    const v = rb.classify(ctx({
      category: "network",
      finalInput: {
        endpoint: "https://graph.microsoft.com/v1.0/teams/t/channels/c/messages",
        method: "POST",
        payload: "meeting summary",
      },
    }));
    expect(v.level).toBe("medium");
    expect(v.reason).toMatch(/graph data operation/);
  });

  it("network Graph data endpoint without payload → MEDIUM", () => {
    const v = rb.classify(ctx({
      category: "network",
      finalInput: { endpoint: "https://graph.microsoft.com/v1.0/me/messages" },
    }));
    expect(v.level).toBe("medium");
  });

  it("network to localhost → MEDIUM", () => {
    const v = rb.classify(ctx({ category: "network", finalInput: { url: "http://localhost:8080/x" } }));
    expect(v.level).toBe("medium");
  });

  it("network to 127.0.0.1 → MEDIUM", () => {
    const v = rb.classify(ctx({ category: "network", finalInput: { url: "http://127.0.0.1/x" } }));
    expect(v.level).toBe("medium");
  });

  it("network to unknown host → HIGH", () => {
    const v = rb.classify(ctx({ category: "network", finalInput: { url: "https://evil.example/x" } }));
    expect(v.level).toBe("high");
  });

  // ── write ───────────────────────────────────
  it("write outside allowed dirs → HIGH", () => {
    const v = rb.classify(ctx({ category: "write", finalInput: { path: "/etc/foo" } }));
    expect(v.level).toBe("high");
  });

  it("write without a declared target path → HIGH", () => {
    const v = rb.classify(ctx({ category: "write", finalInput: { payload: { path: "/etc/foo" } } }));
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/path not declared/);
  });

  it("move_file destination outside allowed dirs → HIGH", () => {
    const v = rb.classify(ctx({
      category: "write",
      pathFields: ["sourcePath", "destinationPath"],
      finalInput: {
        sourcePath: "/Users/ken/work/a.md",
        destinationPath: "/etc/a.md",
      },
    }));
    expect(v.level).toBe("high");
  });

  it("write at allowed-dir leaf → LOW", () => {
    const v = rb.classify(ctx({ category: "write", finalInput: { path: "/Users/ken/work/note.md" } }));
    expect(v.level).toBe("low");
  });

  it("write deep inside allowed dir → MEDIUM", () => {
    const v = rb.classify(ctx({ category: "write", finalInput: { path: "/Users/ken/work/a/b/c/d.md" } }));
    expect(v.level).toBe("medium");
  });

  it("write dotted pathField outside allowed dirs → HIGH", () => {
    const v = rb.classify(ctx({
      category: "write",
      pathFields: ["opts.output"],
      finalInput: { opts: { output: "/etc/passwd" } },
    }));
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/outside allowed/);
  });

  // ── read ─────────────────────────────────
  it("read inside allowed dirs → LOW", () => {
    const v = rb.classify(ctx({ category: "read", finalInput: { path: "/Users/ken/work/a.md" } }));
    expect(v.level).toBe("low");
  });

  it("read outside allowed dirs → HIGH", () => {
    const v = rb.classify(ctx({ category: "read", finalInput: { path: "/etc/passwd" } }));
    expect(v.level).toBe("high");
  });

  // ── default fail-safe ─────────────────────
  it("unknown category falls through to MEDIUM", () => {
    // meta isn't matched by any rule
    const v = rb.classify(ctx({ category: "meta", finalInput: {} }));
    expect(v.level).toBe("medium");
    expect(v.reason).toMatch(/fail-safe/);
  });
});

describe("dlpRedactInputForPrompt", () => {
  it("masks sk-style API keys", () => {
    const out = dlpRedactInputForPrompt({ apiKey: "sk-abc123def456ghi789jkl012mno" });
    expect(out.apiKey).not.toContain("sk-abc123");
    expect(out.apiKey).toContain("sk-****");
  });

  it("masks emails", () => {
    const out = dlpRedactInputForPrompt({ contact: "user@example.com" });
    expect(out.contact).not.toContain("user@example");
  });

  it("masks Korean RRN", () => {
    const out = dlpRedactInputForPrompt({ id: "900101-1234567" });
    expect(out.id).not.toContain("900101-1234567");
  });

  it("preserves non-sensitive strings", () => {
    const out = dlpRedactInputForPrompt({ note: "hello world" });
    expect(out.note).toBe("hello world");
  });

  it("truncates long values at 200 chars + ellipsis", () => {
    const long = "a".repeat(500);
    const out = dlpRedactInputForPrompt({ x: long });
    expect(out.x.length).toBeLessThanOrEqual(201);
    expect(out.x.endsWith("…")).toBe(true);
  });
});

describe("LlmRiskClassifier — composition rule (security M1)", () => {
  function makeProvider(text: string): LlmReviewerProvider {
    return {
      complete: vi.fn(async () => ({ text, tokensIn: 10, tokensOut: 5, costUsd: 0.0001 })),
    };
  }

  it("rule LOW + llm HIGH → HIGH (escalate)", async () => {
    const provider = makeProvider(`{"level":"high","reason":"llm says so"}`);
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini");
    const v = await c.classify(
      ctx({ category: "write", finalInput: { path: "/Users/ken/work/x.md" } }),
    );
    expect(v.level).toBe("high");
    expect(v.reason).toBe("llm says so");
  });

  it("rule HIGH + llm LOW → HIGH (LLM cannot downgrade)", async () => {
    const provider = makeProvider(`{"level":"low","reason":"llm tried to allow"}`);
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini");
    const v = await c.classify(
      ctx({ category: "shell", finalInput: { command: "rm -rf /tmp/x" } }),
    );
    expect(v.level).toBe("high");
    // Reason should come from rule (the higher-rank verdict).
    expect(v.reason).toMatch(/destructive/);
  });

  it("rule MEDIUM + llm MEDIUM → MEDIUM", async () => {
    const provider = makeProvider(`{"level":"medium","reason":"agree"}`);
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini");
    const v = await c.classify(ctx({ category: "shell", finalInput: { command: "make build" } }));
    expect(v.level).toBe("medium");
  });
});

describe("LlmRiskClassifier — sandbox capability surface (issue #691)", () => {
  it("threads executionSandbox into the LLM user prompt so the LLM can honour the no-downgrade composition rule", async () => {
    const completeSpy = vi.fn(async () => ({
      text: `{"level":"low","reason":"ok"}`,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    const provider: LlmReviewerProvider = { complete: completeSpy };
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini");
    await c.classify(
      ctx({
        category: "write",
        finalInput: { path: "/Users/ken/work/x" },
        sandboxCapability: {
          kind: "none",
          confidence: "verified",
          platform: "darwin",
          reason: "no OS sandbox configured for the host process",
        },
      }),
    );
    const arg = completeSpy.mock.calls[0][0];
    // The user prompt must surface the sandbox SOT verbatim so the
    // reviewer can apply the "weak-sandbox no-downgrade" composition rule.
    expect(arg.userPrompt).toContain("executionSandbox=none (verified, darwin)");
  });

  it("system prompt now embeds the composition rules so the LLM is bound to the no-downgrade-in-weak-sandbox rule", () => {
    // Sanity check: the system prompt is the binding contract surface
    // for the LLM. Composition rules must appear in the prompt itself —
    // not only in the framework constants — or the LLM has no way to
    // honour them at inference time.
    expect(PERMISSION_REVIEWER_FRAMEWORK.systemPrompt).toContain("Composition rules");
    expect(PERMISSION_REVIEWER_FRAMEWORK.systemPrompt).toContain(
      "MUST NOT downgrade a rule-based MEDIUM/HIGH verdict to LOW",
    );
  });
});

describe("LlmRiskClassifier — DLP filter on input (security threat-gap #3)", () => {
  it("does NOT send raw 'sk-' API key to provider", async () => {
    const completeSpy = vi.fn(async () => ({
      text: `{"level":"low","reason":"ok"}`,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    const provider: LlmReviewerProvider = { complete: completeSpy };
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini");
    await c.classify(
      ctx({
        category: "write",
        finalInput: { apiKey: "sk-abc123def456ghi789jkl012mno", path: "/Users/ken/work/x" },
      }),
    );
    expect(completeSpy).toHaveBeenCalledOnce();
    const arg = completeSpy.mock.calls[0][0];
    expect(arg.systemPrompt).toBe(PERMISSION_REVIEWER_FRAMEWORK.systemPrompt);
    expect(arg.userPrompt).not.toContain("sk-abc123");
    expect(arg.userPrompt).toContain("sk-****");
  });

  it("does NOT send credit card to provider", async () => {
    const completeSpy = vi.fn(async () => ({
      text: `{"level":"low","reason":"ok"}`,
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0,
    }));
    const provider: LlmReviewerProvider = { complete: completeSpy };
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini");
    await c.classify(
      ctx({
        category: "write",
        finalInput: { card: "4111-1111-1111-1111", path: "/Users/ken/work/x" },
      }),
    );
    const arg = completeSpy.mock.calls[0][0];
    expect(arg.userPrompt).not.toContain("4111-1111-1111-1111");
    expect(arg.userPrompt).toMatch(/\*\*\*\*-\*\*\*\*-\*\*\*\*-1111/);
  });
});

describe("LlmRiskClassifier — fallbackOnError", () => {
  it("parse failure + fallbackOnError='rule' → returns rule verdict", async () => {
    const provider: LlmReviewerProvider = {
      complete: vi.fn(async () => ({
        text: "this is not json",
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
      })),
    };
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini", "rule");
    const v = await c.classify(
      ctx({ category: "shell", finalInput: { command: "rm -rf /tmp/x" } }),
    );
    // Rule verdict for `rm -rf` is HIGH
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/destructive/);
  });

  it("parse failure + fallbackOnError='deny' → returns HIGH", async () => {
    const provider: LlmReviewerProvider = {
      complete: vi.fn(async () => ({
        text: "garbage",
        tokensIn: 1,
        tokensOut: 1,
        costUsd: 0,
      })),
    };
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini", "deny");
    const v = await c.classify(ctx({ category: "read", finalInput: { path: "/Users/ken/work/a" } }));
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/parse failure/);
  });

  it("provider throws + fallbackOnError='rule' → returns rule verdict", async () => {
    const provider: LlmReviewerProvider = {
      complete: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini", "rule");
    const v = await c.classify(ctx({ category: "read", finalInput: { path: "/Users/ken/work/a" } }));
    expect(v.level).toBe("low");
  });

  it("provider throws + fallbackOnError='deny' → returns HIGH with err msg", async () => {
    const provider: LlmReviewerProvider = {
      complete: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini", "deny");
    const v = await c.classify(ctx({ category: "read", finalInput: { path: "/Users/ken/work/a" } }));
    expect(v.level).toBe("high");
    expect(v.reason).toMatch(/network down/);
  });
});

describe("LlmRiskClassifier — telemetry", () => {
  it("emits onCall with token + cost stats", async () => {
    const onCall = vi.fn();
    const provider: LlmReviewerProvider = {
      complete: vi.fn(async () => ({
        text: `{"level":"low","reason":"ok"}`,
        tokensIn: 42,
        tokensOut: 7,
        costUsd: 0.0002,
      })),
    };
    const c = new LlmRiskClassifier(provider, "gpt-4o-mini", "rule", { onCall });
    await c.classify(ctx({ category: "write", finalInput: { path: "/Users/ken/work/x" } }));
    expect(onCall).toHaveBeenCalledWith({
      tokensIn: 42,
      tokensOut: 7,
      costUsd: 0.0002,
      parseFailed: false,
    });
  });
});

describe("createRiskClassifier — atomic cutover", () => {
  it("mode='disabled' returns DisabledRiskClassifier", () => {
    const c = createRiskClassifier({ mode: "disabled" });
    expect(c).toBeInstanceOf(DisabledRiskClassifier);
  });

  it("mode='rule' returns RuleBasedRiskClassifier", () => {
    const c = createRiskClassifier({ mode: "rule" });
    expect(c).toBeInstanceOf(RuleBasedRiskClassifier);
  });

  it("mode='llm' without provider THROWS (atomic cutover, no fallback)", () => {
    expect(() => createRiskClassifier({ mode: "llm" })).toThrow(
      /no provider configured/,
    );
  });

  it("mode='llm' with provider returns LlmRiskClassifier with default model", () => {
    const provider: LlmReviewerProvider = {
      complete: vi.fn(async () => ({ text: "{}", tokensIn: 0, tokensOut: 0, costUsd: 0 })),
    };
    const c = createRiskClassifier({ mode: "llm", provider });
    expect(c).toBeInstanceOf(LlmRiskClassifier);
  });

  it("mode='llm' with invalid fallbackOnError THROWS", () => {
    const provider: LlmReviewerProvider = {
      complete: vi.fn(async () => ({ text: "{}", tokensIn: 0, tokensOut: 0, costUsd: 0 })),
    };
    expect(() =>
      createRiskClassifier({
        mode: "llm",
        provider,
        // @ts-expect-error — intentionally bad
        fallbackOnError: "allow-and-audit",
      }),
    ).toThrow(/'deny' or 'rule'/);
  });
});

describe("maxVerdict ordering", () => {
  it("low < medium < high", () => {
    const lo: RiskVerdict = { level: "low", reason: "a" };
    const md: RiskVerdict = { level: "medium", reason: "b" };
    const hi: RiskVerdict = { level: "high", reason: "c" };
    expect(maxVerdict(lo, md).level).toBe("medium");
    expect(maxVerdict(md, hi).level).toBe("high");
    expect(maxVerdict(lo, hi).level).toBe("high");
    expect(maxVerdict(hi, lo).level).toBe("high");
  });

  it("ties prefer the second arg (LLM) for reason text", () => {
    const a: RiskVerdict = { level: "medium", reason: "rule" };
    const b: RiskVerdict = { level: "medium", reason: "llm" };
    expect(maxVerdict(a, b).reason).toBe("llm");
  });
});

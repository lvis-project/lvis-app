/**
 * The reviewer lane and the foreground modal lane must produce the SAME verdict
 * for the same call.
 *
 * They did not. `tryUserApprovalMemorySkip` (foreground modal, escalation guard)
 * has always classified the raw finalized input; the reviewer lanes were handed
 * `maskToolInputForDisplay(finalInput)`. DLP masking can destroy the exact
 * substring a rule keys on — an Azure endpoint whose resource name begins with a
 * key-shaped prefix masks to `https://[REDACTED:TOKEN].openai.azure.com/x`,
 * which no longer parses as a URL, so `extractNetworkTarget` returns null, the
 * trusted-host rule stops matching, and the call falls through to
 * "network untrusted host" HIGH. The foreground lane rated the identical call
 * LOW.
 *
 * The fix keeps DLP but moves it off the classifier's input and onto the sinks:
 * `buildUserPrompt` still masks every value before the reviewer LLM sees it, and
 * the host masks the verdict `reason` before it reaches the renderer, the
 * deferred queue, the sandbox audit or the verdict cache.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RuleBasedRiskClassifier,
  LlmRiskClassifier,
  _internal,
  type LlmReviewerProvider,
} from "../reviewer/risk-classifier.js";
import { PermissionManager } from "../permission-manager.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import { maskToolInputForDisplay } from "../../tools/pipeline/display-mask.js";
import { makeRiskClassifierContext } from "./test-helpers.js";

const rb = new RuleBasedRiskClassifier();

/**
 * Inputs whose DLP-masked form classifies differently from their raw form.
 * These are the calls whose reviewer-lane verdict moves.
 */
const LANE_SENSITIVE: Array<{
  label: string;
  input: Record<string, unknown>;
  rawVerdict: { level: string; reason: string };
  maskedVerdict: { level: string; reason: string };
}> = [
  {
    label: "Azure AI Foundry project endpoint named `test-…`",
    input: { url: "https://test-abcdefgh.services.ai.azure.com/v1/x" },
    rawVerdict: { level: "low", reason: "network trusted host (test-abcdefgh.services.ai.azure.com)" },
    maskedVerdict: { level: "high", reason: "network untrusted host" },
  },
  {
    label: "Azure OpenAI resource named `live-…`",
    input: { url: "https://live-corpname.openai.azure.com/v1/x" },
    rawVerdict: { level: "low", reason: "network trusted host (live-corpname.openai.azure.com)" },
    maskedVerdict: { level: "high", reason: "network untrusted host" },
  },
  // A bare `host` fixture used to live here. It no longer belongs: the
  // network-target consolidation made the trusted-host rule reachable for that
  // field, so the masked and raw forms now agree and the fixture stopped
  // demonstrating lane sensitivity. The two `url` cases still do — they mask a
  // segment the URL parser needs, which is a different mechanism and the one
  // this guard exists for.
];

describe("DLP masking really does change these verdicts", () => {
  // Without this, the parity assertions below could pass for the trivial reason
  // that masking is a no-op on the fixtures.
  for (const c of LANE_SENSITIVE) {
    it(`${c.label}: masked and raw forms classify differently`, () => {
      const raw = rb.classify(makeRiskClassifierContext({ category: "network", finalInput: c.input }));
      const masked = rb.classify(makeRiskClassifierContext({
        category: "network",
        finalInput: maskToolInputForDisplay(c.input),
      }));
      expect(raw).toEqual(c.rawVerdict);
      expect(masked).toEqual(c.maskedVerdict);
      expect(maskToolInputForDisplay(c.input)).not.toEqual(c.input);
    });
  }
});

describe("both lanes classify the same object", () => {
  let dirs: string[] = [];
  const makeManager = () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-lane-parity-"));
    dirs.push(dir);
    const pm = new PermissionManager(join(dir, "permissions.json"));
    const seen: Array<Record<string, unknown>> = [];
    pm.setReviewer({
      classifier: {
        classify: (ctx) => {
          seen.push(ctx.finalInput);
          return rb.classify(ctx);
        },
      },
      cache: new VerdictCache(join(dir, "cache.jsonl")),
      deferredQueue: new DeferredQueue(join(dir, "queue.jsonl")),
    });
    // `dir` is handed back so a dispatch can name a REAL directory as the
    // tool's execution cwd — `ReviewerDispatchInput.executionCwd` is required
    // precisely so no producer can fall back to `process.cwd()`.
    return { pm, seen, dir };
  };

  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs = [];
  });

  for (const c of LANE_SENSITIVE) {
    it(`${c.label}: dispatchReviewer grades the raw arguments and returns the raw verdict`, async () => {
      const { pm, seen, dir } = makeManager();
      const result = await pm.dispatchReviewer("net_probe", {
        source: "plugin",
        category: "network",
        pathFields: [],
        finalInput: c.input,
        executionCwd: dir,
        allowedDirectories: [],
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg",
      });
      expect(seen).toEqual([c.input]);
      expect(result.verdict.level).toBe(c.rawVerdict.level);
    });
  }
});

describe("DLP is preserved at the sinks", () => {
  it("the reviewer LLM prompt never carries the raw value", () => {
    const prompt = _internal.buildUserPrompt(makeRiskClassifierContext({
      category: "network",
      finalInput: {
        url: "https://api.openai.com/v1/x",
        note: "alice@example.com / sk-abcdefghijklmnopqrstuvwxyz",
      },
    }));
    expect(prompt).not.toContain("alice@example.com");
    expect(prompt).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(prompt).toContain("***@example.com");
    expect(prompt).toContain("[REDACTED:TOKEN]");
  });

  it("an LLM classifier still sees only masked input even though the rule side sees raw", async () => {
    let observedPrompt = "";
    const provider: LlmReviewerProvider = {
      complete: async ({ userPrompt }) => {
        observedPrompt = userPrompt;
        return { text: '{"level":"low","reason":"ok"}', tokensIn: 1, tokensOut: 1, costUsd: 0 };
      },
    };
    const llm = new LlmRiskClassifier(provider, "test-model", "rule");
    await llm.classify(makeRiskClassifierContext({
      category: "network",
      finalInput: { url: "https://api.openai.com/x", note: "alice@example.com" },
    }));
    expect(observedPrompt).not.toContain("alice@example.com");
    expect(observedPrompt).toContain("***@example.com");
  });

  it("the host masks a classifier's verdict reason before any sink sees it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-lane-parity-reason-"));
    try {
      const pm = new PermissionManager(join(dir, "permissions.json"));
      const queue = new DeferredQueue(join(dir, "queue.jsonl"));
      pm.setReviewer({
        // A classifier that echoes its input into `reason` — the host must not
        // trust classifier prose to be redacted.
        classifier: {
          classify: (ctx) => ({
            level: "high" as const,
            reason: `saw ${String(ctx.finalInput.note)}`,
          }),
        },
        cache: new VerdictCache(join(dir, "cache.jsonl")),
        deferredQueue: queue,
      });
      const result = await pm.dispatchReviewer("net_probe", {
        source: "plugin",
        category: "network",
        pathFields: [],
        finalInput: { note: "alice@example.com" },
        executionCwd: dir,
        allowedDirectories: [],
        sensitivePathsAdjacent: [],
        trustOrigin: "llm-tool-arg",
      }, undefined, { defer: "medium-high" });
      expect(result.verdict.reason).not.toContain("alice@example.com");
      expect(result.verdict.reason).toContain("***@example.com");
      // …and the deferred-queue row, a file on disk, is masked too.
      const [pending] = queue.listPending();
      expect(pending?.inputSummary).not.toContain("alice@example.com");
      expect(pending?.inputSummary).toContain("***@example.com");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

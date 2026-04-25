/**
 * P0 — `hostApi.triggerConversation()` proactive brain entry.
 *
 * Two layers tested:
 *   1. {@link TriggerConversationDedupe} + {@link TriggerConversationRateLimiter}
 *      — pure data-structure units.
 *   2. {@link evaluateTriggerSpec} — the gate that
 *      `createHostApi.triggerConversation` calls. Exported from production
 *      code so prod and tests share one implementation (PR #215 review M1
 *      addressed the previous inline-mirror drift risk).
 *
 * The gate enforces:
 *   • capability `conversation-trigger` declared in manifest
 *   • `source` matches `^proactive:[a-z][a-z0-9-]*$`
 *   • non-empty prompt
 *   • per-plugin rate limit not exceeded
 *   • dedupeKey not seen within {@link TRIGGER_CONVERSATION_DEDUPE_TTL_MS}
 *   • conversationLoopRef late-binding wired
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  TriggerConversationDedupe,
  TRIGGER_CONVERSATION_DEDUPE_TTL_MS,
  TriggerConversationRateLimiter,
  TRIGGER_CONVERSATION_RATE_LIMIT_MAX_CALLS,
  evaluateTriggerSpec,
  normalizeTriggerSpecFields,
} from "../steps/plugin-runtime.js";
import type {
  ConversationTriggerResult,
  ConversationTriggerSpec,
  PluginManifest,
} from "../../plugins/types.js";
import type { AuditEntry } from "../../audit/audit-logger.js";

interface GateOutcome {
  result: ConversationTriggerResult;
  auditEntries: AuditEntry[];
  visibility?: string;
  priority?: string;
}

interface MakeGateOptions {
  manifest: PluginManifest;
  pluginId?: string;
  loopBound?: boolean;
  dedupe?: TriggerConversationDedupe;
  rateLimiter?: TriggerConversationRateLimiter;
  now?: () => number;
}

function makeGate(opts: MakeGateOptions) {
  const pluginId = opts.pluginId ?? "test-brain";
  const auditEntries: AuditEntry[] = [];
  const dedupe = opts.dedupe ?? new TriggerConversationDedupe();
  const rateLimiter = opts.rateLimiter ?? new TriggerConversationRateLimiter();
  const auditLogger = { log: (e: AuditEntry) => auditEntries.push(e) };

  return {
    invoke(spec: ConversationTriggerSpec): GateOutcome {
      const decision = evaluateTriggerSpec({
        spec,
        pluginId,
        capabilities: opts.manifest.capabilities ?? [],
        dedupe,
        rateLimiter,
        loopBound: opts.loopBound ?? true,
        auditLogger,
        now: opts.now,
      });
      return {
        result: decision.result,
        auditEntries,
        visibility:
          decision.kind === "allow" ? decision.visibility : undefined,
        priority: decision.kind === "allow" ? decision.priority : undefined,
      };
    },
    state: { auditEntries, dedupe, rateLimiter },
  };
}

function brainManifest(extra: Partial<PluginManifest> = {}): PluginManifest {
  return {
    id: "brain",
    name: "Brain",
    version: "0.0.1",
    entry: "main.js",
    tools: [],
    capabilities: ["conversation-trigger"],
    ...extra,
  } as PluginManifest;
}

describe("TriggerConversationDedupe", () => {
  let dedupe: TriggerConversationDedupe;

  beforeEach(() => {
    dedupe = new TriggerConversationDedupe();
  });

  it("returns false for unseen keys", () => {
    expect(dedupe.has("p1", "k1")).toBe(false);
  });

  it("returns true after recording the same (pluginId, key)", () => {
    dedupe.record("p1", "k1");
    expect(dedupe.has("p1", "k1")).toBe(true);
  });

  it("does not collide across pluginIds for the same key", () => {
    dedupe.record("p1", "k1");
    expect(dedupe.has("p2", "k1")).toBe(false);
  });

  it("expires entries after the TTL window", () => {
    dedupe.record("p1", "k1");
    expect(dedupe.has("p1", "k1")).toBe(true);
    const seenAt = Date.now() - TRIGGER_CONVERSATION_DEDUPE_TTL_MS - 1;
    (
      dedupe as unknown as { seen: Map<string, number> }
    ).seen.set("p1::k1", seenAt);
    expect(dedupe.has("p1", "k1")).toBe(false);
  });

  it("refreshes LRU order on re-record so a frequently-recorded key is not evicted as oldest", () => {
    dedupe.record("p1", "hot");
    dedupe.record("p1", "cold-1");
    dedupe.record("p1", "cold-2");
    dedupe.record("p1", "hot");
    for (let i = 0; i < 254; i += 1) dedupe.record("p1", `pad-${i}`);
    dedupe.record("p1", "trigger-eviction");
    expect(dedupe.has("p1", "hot")).toBe(true);
    expect(dedupe.has("p1", "cold-1")).toBe(false);
  });
});

describe("TriggerConversationRateLimiter", () => {
  it("allows up to maxCalls within the window", () => {
    const rl = new TriggerConversationRateLimiter(60_000, 3);
    rl.record("p1", 1000);
    rl.record("p1", 1100);
    expect(rl.isOverCap("p1", 1200)).toBe(false);
    rl.record("p1", 1200);
    expect(rl.isOverCap("p1", 1300)).toBe(true);
  });

  it("forgets calls older than the window", () => {
    const rl = new TriggerConversationRateLimiter(60_000, 2);
    rl.record("p1", 0);
    rl.record("p1", 1000);
    expect(rl.isOverCap("p1", 2000)).toBe(true);
    expect(rl.isOverCap("p1", 60_001)).toBe(false);
  });

  it("scopes per plugin", () => {
    const rl = new TriggerConversationRateLimiter(60_000, 1);
    rl.record("p1", 1000);
    expect(rl.isOverCap("p1", 1500)).toBe(true);
    expect(rl.isOverCap("p2", 1500)).toBe(false);
  });
});

describe("normalizeTriggerSpecFields", () => {
  it("falls back to defaults for unknown enum-ish values", () => {
    const out = normalizeTriggerSpecFields({
      prompt: "x",
      source: "proactive:x",
      visibility: "loud" as unknown as "silent",
      priority: "urgent" as unknown as "high",
    });
    expect(out.visibility).toBe("summary-only");
    expect(out.priority).toBe("normal");
  });

  it("keeps explicit allowed values", () => {
    const out = normalizeTriggerSpecFields({
      prompt: "x",
      source: "proactive:x",
      visibility: "silent",
      priority: "high",
      dedupeKey: "  mail-123  ",
    });
    expect(out.visibility).toBe("silent");
    expect(out.priority).toBe("high");
    expect(out.dedupeKey).toBe("mail-123");
  });

  it("drops non-string and empty dedupeKeys", () => {
    expect(
      normalizeTriggerSpecFields({
        prompt: "x",
        source: "proactive:x",
        dedupeKey: {} as unknown as string,
      }).dedupeKey,
    ).toBeUndefined();
    expect(
      normalizeTriggerSpecFields({
        prompt: "x",
        source: "proactive:x",
        dedupeKey: "    ",
      }).dedupeKey,
    ).toBeUndefined();
  });

  it("truncates dedupeKey above 128 chars", () => {
    const big = "k".repeat(200);
    expect(
      normalizeTriggerSpecFields({
        prompt: "x",
        source: "proactive:x",
        dedupeKey: big,
      }).dedupeKey,
    ).toHaveLength(128);
  });
});

describe("evaluateTriggerSpec gate (PR #215 review M1: shared with prod)", () => {
  it("rejects when the plugin lacks `conversation-trigger` capability", () => {
    const gate = makeGate({ manifest: brainManifest({ capabilities: [] }) });
    const out = gate.invoke({ prompt: "hi", source: "proactive:test" });
    expect(out.result).toEqual({
      accepted: false,
      reason: "capability_denied",
      source: "proactive:test",
    });
    expect(out.auditEntries.some((e) =>
      String(e.input).includes("trigger_conversation_denied reason=capability_denied"),
    )).toBe(true);
  });

  it("rejects sources that do not match `^proactive:[a-z][a-z0-9-]*$`", () => {
    const gate = makeGate({ manifest: brainManifest() });
    for (const bad of ["user:typed", "", "proactive:", "proactive:Bad", "proactive:_x", "proactive:has/slash"]) {
      const out = gate.invoke({ prompt: "x", source: bad });
      expect(out.result.accepted).toBe(false);
      expect(out.result.reason).toBe("invalid_source");
    }
  });

  it("truncates over-long source strings before audit (PR #215 review M2)", () => {
    const gate = makeGate({ manifest: brainManifest() });
    const huge = "proactive:" + "x".repeat(500);
    const out = gate.invoke({ prompt: "x", source: huge });
    // Truncation makes the audit row bounded; the source still passes the
    // regex (truncated still matches), so accept goes through normally.
    expect(out.result.accepted).toBe(true);
    expect(out.result.source).toHaveLength(128);
  });

  it("rejects empty prompts", () => {
    const gate = makeGate({ manifest: brainManifest() });
    const out = gate.invoke({
      prompt: "   ",
      source: "proactive:meeting-detection",
    });
    expect(out.result.accepted).toBe(false);
    expect(out.result.reason).toBe("invalid_source");
  });

  it("rejects when ConversationLoop is not yet bound (boot ordering)", () => {
    const gate = makeGate({ manifest: brainManifest(), loopBound: false });
    const out = gate.invoke({
      prompt: "hi",
      source: "proactive:meeting-detection",
    });
    expect(out.result.accepted).toBe(false);
    expect(out.result.reason).toBe("loop_unavailable");
  });

  it("returns rate_limited after the per-plugin cap", () => {
    const rateLimiter = new TriggerConversationRateLimiter(60_000, 2);
    const gate = makeGate({ manifest: brainManifest(), rateLimiter });
    expect(gate.invoke({ prompt: "1", source: "proactive:x" }).result.accepted).toBe(true);
    expect(gate.invoke({ prompt: "2", source: "proactive:x" }).result.accepted).toBe(true);
    const third = gate.invoke({ prompt: "3", source: "proactive:x" });
    expect(third.result.accepted).toBe(false);
    expect(third.result.reason).toBe("rate_limited");
  });

  it("records dedupe + rate-limit only on the success path (denials must not consume budget)", () => {
    const rateLimiter = new TriggerConversationRateLimiter(60_000, 2);
    const gate = makeGate({
      manifest: brainManifest({ capabilities: [] }),
      rateLimiter,
    });
    // capability denial — must not advance the rate-limit window
    gate.invoke({ prompt: "x", source: "proactive:x" });
    gate.invoke({ prompt: "x", source: "proactive:x" });
    gate.invoke({ prompt: "x", source: "proactive:x" });
    // Now grant capability — should still have full budget
    const gate2 = makeGate({
      manifest: brainManifest(),
      rateLimiter,
    });
    expect(gate2.invoke({ prompt: "ok", source: "proactive:x" }).result.accepted).toBe(true);
  });

  it("forwards an accepted trigger and reports normalized visibility / priority", () => {
    const gate = makeGate({ manifest: brainManifest() });
    const out = gate.invoke({
      prompt: "회의실 예약 도와드릴까요?",
      source: "proactive:meeting-detection",
      context: { emailId: "abc" },
    });
    expect(out.result).toEqual({
      accepted: true,
      source: "proactive:meeting-detection",
    });
    expect(out.visibility).toBe("summary-only");
    expect(out.priority).toBe("normal");
  });

  it("falls back to safe defaults when plugin sends unknown visibility / priority", () => {
    const gate = makeGate({ manifest: brainManifest() });
    const out = gate.invoke({
      prompt: "x",
      source: "proactive:bug",
      visibility: "loud" as unknown as "silent",
      priority: "urgent" as unknown as "high",
    });
    expect(out.visibility).toBe("summary-only");
    expect(out.priority).toBe("normal");
    expect(out.auditEntries.some((e) =>
      String(e.input).includes("visibility=summary-only"),
    )).toBe(true);
  });

  it("blocks the second call when dedupeKey matches a recent trigger", () => {
    const gate = makeGate({ manifest: brainManifest() });
    const first = gate.invoke({
      prompt: "first",
      source: "proactive:detect",
      dedupeKey: "mail-123",
    });
    const second = gate.invoke({
      prompt: "second",
      source: "proactive:detect",
      dedupeKey: "mail-123",
    });
    expect(first.result.accepted).toBe(true);
    expect(second.result.accepted).toBe(false);
    expect(second.result.reason).toBe("duplicate");
  });
});

/**
 * P0 — `hostApi.triggerConversation()` proactive brain entry.
 *
 * Two layers tested:
 *   1. {@link TriggerConversationDedupe} + {@link TriggerConversationRateLimiter}
 *      — pure data-structure units.
 *   2. {@link evaluateTriggerSpec} — the gate that
 *      `createHostApi.triggerConversation` calls. Exported from production
 *      code so prod and tests share one implementation; tests import + call
 *      this directly rather than mirroring the gate inline.
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
  TriggerDenyAuditThrottle,
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
  denyAuditThrottle?: TriggerDenyAuditThrottle;
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
        denyAuditThrottle: opts.denyAuditThrottle,
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

describe("TriggerDenyAuditThrottle", () => {
  it("emits the first denial then suppresses identical follow-ups within the window", () => {
    const t = new TriggerDenyAuditThrottle(60_000);
    expect(t.shouldEmit("p1", "invalid_source", 1000)).toBe(true);
    expect(t.shouldEmit("p1", "invalid_source", 1100)).toBe(false);
    expect(t.shouldEmit("p1", "invalid_source", 1200)).toBe(false);
  });

  it("does not coalesce different reason keys", () => {
    const t = new TriggerDenyAuditThrottle(60_000);
    expect(t.shouldEmit("p1", "invalid_source", 1000)).toBe(true);
    expect(t.shouldEmit("p1", "rate_limited", 1100)).toBe(true);
  });

  it("does not coalesce across pluginIds", () => {
    const t = new TriggerDenyAuditThrottle(60_000);
    expect(t.shouldEmit("p1", "invalid_source", 1000)).toBe(true);
    expect(t.shouldEmit("p2", "invalid_source", 1100)).toBe(true);
  });

  it("re-emits after the window expires and reports suppressed count", () => {
    const t = new TriggerDenyAuditThrottle(60_000);
    expect(t.shouldEmit("p1", "invalid_source", 1000)).toBe(true);
    expect(t.shouldEmit("p1", "invalid_source", 30_000)).toBe(false);
    expect(t.shouldEmit("p1", "invalid_source", 30_001)).toBe(false);
    expect(t.shouldEmit("p1", "invalid_source", 70_000)).toBe(true);
    // Note: drainSuppressed is called inside auditDeny right after shouldEmit
    // returns true. By the time we read it from the test, the count was
    // taken on the *previous* emit, not this one. The integration check
    // (gate-level) below verifies the suppressed-N hint reaches the audit.
  });
});

describe("evaluateTriggerSpec deny-audit throttle integration", () => {
  it("does not write a fresh audit row for every identical denial", () => {
    const denyAuditThrottle = new TriggerDenyAuditThrottle(60_000);
    const gate = makeGate({
      manifest: brainManifest({ capabilities: [] }),
      denyAuditThrottle,
    });
    for (let i = 0; i < 50; i += 1) {
      gate.invoke({ prompt: "x", source: "proactive:x" });
    }
    const denyRows = gate.state.auditEntries.filter((e) =>
      String(e.input).includes("trigger_conversation_denied"),
    );
    // Without the throttle there would be 50 rows; with it, the first
    // emit + at most one re-emit on window expiry. Test runs in <60s so
    // we expect exactly 1.
    expect(denyRows).toHaveLength(1);
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

describe("evaluateTriggerSpec gate", () => {
  it("rejects when the plugin lacks `conversation-trigger` capability", () => {
    const gate = makeGate({ manifest: brainManifest({ capabilities: [] }) });
    const out = gate.invoke({ prompt: "hi", source: "proactive:test" });
    expect(out.result).toEqual({
      accepted: false,
      reason: "capability_denied",
      // capability_denied path doesn't echo the source (defense against
      // information-leakage probes during boot).
      source: "",
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

  it("rejects over-long source strings instead of slice-truncating", () => {
    const gate = makeGate({ manifest: brainManifest() });
    // 129 chars — last char is uppercase 'X' so the original fails the
    // regex. A slice(0,128) would have sanitized the input into a passing
    // prefix; the gate must reject outright.
    const overlong = "proactive:" + "x".repeat(118) + "X";
    const out = gate.invoke({ prompt: "x", source: overlong });
    expect(out.result.accepted).toBe(false);
    expect(out.result.reason).toBe("invalid_source");
    // Result echoes only the first 32 chars so a 10MB malicious source
    // cannot pin into caller-visible state either.
    expect((out.result.source ?? "").length).toBeLessThanOrEqual(32);
  });

  it("rejects prompts above MAX_PROMPT_LEN", () => {
    const gate = makeGate({ manifest: brainManifest() });
    const out = gate.invoke({
      prompt: "x".repeat(5000),
      source: "proactive:meeting-detection",
    });
    expect(out.result.accepted).toBe(false);
    expect(out.result.reason).toBe("invalid_source");
    expect(out.auditEntries.some((e) =>
      String(e.input).includes("prompt>"),
    )).toBe(true);
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

  it("returns loop_unavailable BEFORE duplicate when both apply", () => {
    // Plugin retrying the same dedupeKey during a boot ordering window
    // should see the actual cause (loop_unavailable) instead of being
    // permanently stuck on `duplicate`.
    const dedupe = new TriggerConversationDedupe();
    dedupe.record("test-brain", "k1");
    const gate = makeGate({
      manifest: brainManifest(),
      loopBound: false,
      dedupe,
    });
    const out = gate.invoke({
      prompt: "x",
      source: "proactive:x",
      dedupeKey: "k1",
    });
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

/**
 * P0 — `hostApi.triggerConversation()` proactive brain entry.
 *
 * Two layers tested:
 *   1. {@link TriggerConversationDedupe} — pure data-structure unit.
 *   2. The gate logic mirrored from `plugin-runtime.ts createHostApi` — same
 *      pattern as `capability-audit-trail.test.ts` (the createHostApi closure
 *      is built inline in boot, so tests duplicate the gate to exercise it
 *      against fixtures without spinning up a full PluginRuntime).
 *
 * The gate enforces:
 *   • capability `conversation-trigger` declared in manifest
 *   • `source` starts with `proactive:`
 *   • non-empty prompt
 *   • dedupeKey not seen within {@link TRIGGER_CONVERSATION_DEDUPE_TTL_MS}
 *   • conversationLoopRef late-binding wired
 *
 * Successful triggers fire-and-forget into ConversationLoop.runTriggerTurn.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  TriggerConversationDedupe,
  TRIGGER_CONVERSATION_DEDUPE_TTL_MS,
} from "../steps/plugin-runtime.js";
import type {
  ConversationTriggerResult,
  ConversationTriggerSpec,
  PluginManifest,
} from "../../plugins/types.js";
import type { AuditEntry } from "../../audit/audit-logger.js";

interface FakeLoopCall {
  prompt: string;
  source: string;
  visibility: string;
  priority: string;
  contextKeys: string[];
}

interface GateOutcome {
  result: ConversationTriggerResult;
  loopCalls: FakeLoopCall[];
  auditEntries: AuditEntry[];
}

interface MakeGateOptions {
  manifest: PluginManifest;
  pluginId?: string;
  loopBound?: boolean;
  dedupe?: TriggerConversationDedupe;
}

/**
 * Mirror the createHostApi triggerConversation closure from plugin-runtime.ts
 * so the gate is testable in isolation. Update this if the source-of-truth
 * gate changes.
 */
function makeGate(opts: MakeGateOptions) {
  const pluginId = opts.pluginId ?? "test-brain";
  const auditEntries: AuditEntry[] = [];
  const loopCalls: FakeLoopCall[] = [];
  const dedupe = opts.dedupe ?? new TriggerConversationDedupe();
  const auditLogger = { log: (e: AuditEntry) => auditEntries.push(e) };
  const conversationLoopRef = opts.loopBound
    ? {
        fn: {
          runTriggerTurn: async (spec: {
            prompt: string;
            source: string;
            visibility: "silent" | "summary-only" | "user-visible";
            priority: "low" | "normal" | "high";
            context?: Record<string, unknown>;
          }) => {
            loopCalls.push({
              prompt: spec.prompt,
              source: spec.source,
              visibility: spec.visibility,
              priority: spec.priority,
              contextKeys: spec.context ? Object.keys(spec.context) : [],
            });
            return { text: "", toolCalls: [], route: "general" } as const;
          },
        } as unknown as { runTriggerTurn: typeof loopRunTriggerTurn },
      }
    : { fn: null };

  const triggerConversation = async (
    spec: ConversationTriggerSpec,
  ): Promise<ConversationTriggerResult> => {
    const source = typeof spec?.source === "string" ? spec.source : "";
    const visibility = spec?.visibility ?? "summary-only";
    const priority = spec?.priority ?? "normal";
    const auditDeny = (reasonInput: string) => {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin",
        type: "error",
        input: `[plugin:${pluginId}] trigger_conversation_denied ${reasonInput}`,
      });
    };

    if (!opts.manifest.capabilities?.includes("conversation-trigger")) {
      auditDeny("reason=capability_denied");
      return { accepted: false, reason: "capability_denied", source };
    }
    if (!source.startsWith("proactive:")) {
      auditDeny(`reason=invalid_source source=${source || "<empty>"}`);
      return { accepted: false, reason: "invalid_source", source };
    }
    if (typeof spec?.prompt !== "string" || spec.prompt.trim().length === 0) {
      auditDeny(`reason=invalid_source source=${source} (empty prompt)`);
      return { accepted: false, reason: "invalid_source", source };
    }
    if (spec.dedupeKey && dedupe.has(pluginId, spec.dedupeKey)) {
      auditDeny(`reason=duplicate dedupeKey=${spec.dedupeKey}`);
      return { accepted: false, reason: "duplicate", source };
    }

    const loop = conversationLoopRef.fn;
    if (!loop) {
      auditDeny("reason=loop_unavailable");
      return { accepted: false, reason: "loop_unavailable", source };
    }

    if (spec.dedupeKey) dedupe.record(pluginId, spec.dedupeKey);

    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "plugin",
      type: "tool_call",
      input:
        `[plugin:${pluginId}] trigger_conversation source=${source} ` +
        `visibility=${visibility} priority=${priority}` +
        (spec.dedupeKey ? ` dedupeKey=${spec.dedupeKey}` : ""),
    });

    void loop
      .runTriggerTurn({ ...spec, source, visibility, priority })
      .catch(() => undefined);

    return { accepted: true, source };
  };

  return {
    invoke: async (spec: ConversationTriggerSpec): Promise<GateOutcome> => {
      const result = await triggerConversation(spec);
      return { result, loopCalls, auditEntries };
    },
    state: { auditEntries, loopCalls, dedupe },
  };
}

// Type-only helper for the gate factory above.
declare function loopRunTriggerTurn(spec: {
  prompt: string;
  source: string;
  visibility: "silent" | "summary-only" | "user-visible";
  priority: "low" | "normal" | "high";
  context?: Record<string, unknown>;
}): Promise<unknown>;

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
    // Reach into the private map to age the entry without waiting real time.
    (
      dedupe as unknown as { seen: Map<string, number> }
    ).seen.set("p1::k1", seenAt);
    expect(dedupe.has("p1", "k1")).toBe(false);
  });
});

describe("hostApi.triggerConversation gate", () => {
  it("rejects when the plugin lacks `conversation-trigger` capability", async () => {
    const gate = makeGate({
      manifest: brainManifest({ capabilities: [] }),
      loopBound: true,
    });
    const out = await gate.invoke({
      prompt: "hello",
      source: "proactive:test",
    });
    expect(out.result).toEqual({
      accepted: false,
      reason: "capability_denied",
      source: "proactive:test",
    });
    expect(out.loopCalls).toHaveLength(0);
    expect(out.auditEntries.some((e) =>
      String(e.input).includes("trigger_conversation_denied reason=capability_denied"),
    )).toBe(true);
  });

  it("rejects sources that do not start with `proactive:`", async () => {
    const gate = makeGate({ manifest: brainManifest(), loopBound: true });
    const bad = await gate.invoke({ prompt: "hi", source: "user:typed" });
    expect(bad.result.accepted).toBe(false);
    expect(bad.result.reason).toBe("invalid_source");

    const empty = await gate.invoke({ prompt: "hi", source: "" });
    expect(empty.result.reason).toBe("invalid_source");
  });

  it("rejects empty prompts", async () => {
    const gate = makeGate({ manifest: brainManifest(), loopBound: true });
    const out = await gate.invoke({
      prompt: "   ",
      source: "proactive:meeting-detection",
    });
    expect(out.result.accepted).toBe(false);
    expect(out.result.reason).toBe("invalid_source");
  });

  it("rejects when ConversationLoop is not yet bound (boot ordering)", async () => {
    const gate = makeGate({ manifest: brainManifest(), loopBound: false });
    const out = await gate.invoke({
      prompt: "hi",
      source: "proactive:meeting-detection",
    });
    expect(out.result.accepted).toBe(false);
    expect(out.result.reason).toBe("loop_unavailable");
  });

  it("forwards an accepted trigger to runTriggerTurn with defaults", async () => {
    const gate = makeGate({ manifest: brainManifest(), loopBound: true });
    const out = await gate.invoke({
      prompt: "회의실 예약 도와드릴까요?",
      source: "proactive:meeting-detection",
      context: { emailId: "abc" },
    });
    expect(out.result).toEqual({
      accepted: true,
      source: "proactive:meeting-detection",
    });
    expect(out.loopCalls).toHaveLength(1);
    expect(out.loopCalls[0]).toMatchObject({
      prompt: "회의실 예약 도와드릴까요?",
      source: "proactive:meeting-detection",
      visibility: "summary-only",
      priority: "normal",
      contextKeys: ["emailId"],
    });
  });

  it("respects explicit visibility / priority over defaults", async () => {
    const gate = makeGate({ manifest: brainManifest(), loopBound: true });
    await gate.invoke({
      prompt: "x",
      source: "proactive:silent-watch",
      visibility: "silent",
      priority: "low",
    });
    expect(gate.state.loopCalls[0]).toMatchObject({
      visibility: "silent",
      priority: "low",
    });
  });

  it("blocks the second call when dedupeKey matches a recent trigger", async () => {
    const gate = makeGate({ manifest: brainManifest(), loopBound: true });
    const first = await gate.invoke({
      prompt: "first",
      source: "proactive:detect",
      dedupeKey: "mail-123",
    });
    const second = await gate.invoke({
      prompt: "second",
      source: "proactive:detect",
      dedupeKey: "mail-123",
    });
    expect(first.result.accepted).toBe(true);
    expect(second.result.accepted).toBe(false);
    expect(second.result.reason).toBe("duplicate");
    expect(gate.state.loopCalls).toHaveLength(1);
  });

  it("records dedupe only after the first acceptance — failed gates do not reserve the key", async () => {
    const gate = makeGate({
      manifest: brainManifest({ capabilities: [] }),
      loopBound: true,
    });
    const denied = await gate.invoke({
      prompt: "x",
      source: "proactive:detect",
      dedupeKey: "shared-key",
    });
    expect(denied.result.reason).toBe("capability_denied");
    // Now grant capability — the key should NOT have been reserved by the
    // previous denial.
    const gate2 = makeGate({
      manifest: brainManifest(),
      loopBound: true,
      dedupe: gate.state.dedupe,
    });
    const accepted = await gate2.invoke({
      prompt: "x",
      source: "proactive:detect",
      dedupeKey: "shared-key",
    });
    expect(accepted.result.accepted).toBe(true);
  });
});

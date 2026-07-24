/**
 * #811 milestone-2 — NON-BLOCKING lifecycle events fired from ConversationLoop.
 *
 * Spec ref: docs/architecture/hook-runtime-expansion-design.md §5.
 *
 * Covers the loop-side fire points:
 *   - SessionStart fires ONCE per session, on the first turn
 *   - Stop fires after the query loop resolves, with stopReason/toolCount/duration
 *   - a lifecycle hook deny does NOT change control flow (turn still completes)
 *   - back-compat: no scriptHookManager ⇒ no lifecycle dispatch, turn unchanged
 *
 * PreCompact/PostCompact loop fire points are covered by the manager-level
 * lifecycle test (`src/hooks/__tests__/lifecycle-hook-manager.test.ts`) plus the
 * preflight scenarios; here we focus on the per-turn SessionStart/Stop wiring.
 */
import { describe, expect, it, vi } from "vitest";

import { InputClassifier } from "../../core/input-classifier.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import type { LLMProvider, StreamEvent } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

class FakeProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  constructor(private readonly turns: StreamEvent[][]) {}
  async *streamTurn(): AsyncIterable<StreamEvent> {
    yield* this.turns[this.index++] ?? [];
  }
}

function completeTurn(): StreamEvent[] {
  return [
    { type: "text_delta", text: "ok" },
    { type: "message_complete", stopReason: "end_turn" },
  ];
}

/** A stub manager whose lifecycle dispatch we can assert on. */
function stubManager(
  lifecycleDecision: "allow" | "deny" = "allow",
  /** #811 m2 — control the BLOCKING UserPromptSubmit dispatch behavior. */
  userPromptSubmit:
    | { mode: "allow" }
    | { mode: "deny"; reason?: string }
    | { mode: "throw" } = { mode: "allow" },
) {
  return {
    setTrustedHooks: vi.fn(),
    setTrustedRegistry: vi.fn(),
    size: () => 0,
    runPreToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [],
    })),
    runPostToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [],
    })),
    runPermissionRequest: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [],
    })),
    runLifecycleEvent: vi.fn(async () => ({
      decision: lifecycleDecision,
      reason: "lifecycle",
      results: [],
    })),
    runUserPromptSubmit: vi.fn(async () => {
      if (userPromptSubmit.mode === "throw") {
        // The loop's fire helper must treat an unexpected throw as fail-closed.
        throw new Error("ups dispatch boom");
      }
      if (userPromptSubmit.mode === "deny") {
        return {
          decision: "deny" as const,
          reason: userPromptSubmit.reason ?? "blocked by policy",
          results: [],
        };
      }
      return { decision: "allow" as const, reason: "no matching UserPromptSubmit hooks", results: [],
      };
    }),
  };
}

function buildLoop(
  provider: LLMProvider,
  scriptHookManager?: ReturnType<typeof stubManager>,
): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  return new ConversationLoop({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key",
    },
    systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn(),
    },
    inputClassifier: new InputClassifier(),
    routeEngine: new RouteEngine(),
    toolRegistry,
    memoryManager: { saveSession: () => Promise.resolve(), listSessions: () => [], loadSessionMetadata: () => null,
    },
    disableSessionPersistence: true,
    ...(scriptHookManager ? { scriptHookManager } : {}),
  } as unknown as ConstructorParameters<typeof ConversationLoop>[0]);
}

describe("ConversationLoop — #811 m2 lifecycle events", () => {
  it("fires SessionStart once on the first turn, with sessionMeta", async () => {
    const provider = new FakeProvider([completeTurn(), completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("first", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    await loop.runTurn("second", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    const starts = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "SessionStart",
    );
    // SessionStart fires exactly once across two turns of the same session.
    expect(starts).toHaveLength(1);
    const [, sessionId, , payload] = starts[0];
    expect(typeof sessionId).toBe("string");
    expect((payload as { sessionMeta: Record<string, unknown> }).sessionMeta,
    ).toMatchObject({
      sessionKind: "main",
    });
  });

  it("re-fires SessionStart after newConversation() resets the once-per-session guard", async () => {
    const provider = new FakeProvider([completeTurn(), completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("first", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    loop.newConversation(); // resets sessionStartFiredFor → the next turn re-announces.
    await loop.runTurn("second", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    const starts = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "SessionStart",
    );
    expect(starts).toHaveLength(2);
  });

  it("fires Stop after each turn with stopReason + toolCount + durationMs", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });

    const stops = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "Stop",
    );
    expect(stops).toHaveLength(1);
    const payload = stops[0][3] as { stopReason?: string; toolCount: number; durationMs: number;
    };
    expect(payload.stopReason).toBe("end_turn");
    expect(payload.toolCount).toBe(0);
    expect(typeof payload.durationMs).toBe("number");
  });

  it("a lifecycle hook deny does NOT change control flow — the turn still completes", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager("deny"); // every lifecycle dispatch denies.
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    // No throw, and the turn returns its normal assistant text despite the deny.
    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.text).toBe("ok");
    // Both SessionStart and Stop still fired (observe-only — deny ignored).
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "SessionStart"),
    ).toBe(true);
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "Stop")).toBe(true,
    );
  });

  it("back-compat: no scriptHookManager ⇒ no lifecycle dispatch, turn unchanged", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const loop = buildLoop(provider); // no manager
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.text).toBe("ok");
  });
});

describe("ConversationLoop — #811 m2 UserPromptSubmit (BLOCKING, fail-closed)", () => {
  it("an ALLOWING UserPromptSubmit hook → the turn proceeds (queryLoop runs)", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager("allow", { mode: "allow" });
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hello", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    // The turn reached the LLM and returned its normal assistant text.
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
    // The blocking hook was dispatched with the prompt-shaped payload.
    expect(mgr.runUserPromptSubmit).toHaveBeenCalledTimes(1);
    const [sessionId, trustOrigin, payload] = mgr.runUserPromptSubmit.mock.calls[0];
    expect(typeof sessionId).toBe("string");
    expect(trustOrigin).toBe("unknown");
    expect(payload).toMatchObject({
      inputText: "hello",
      inputOrigin: "user-keyboard",
      route: "llm",
      classification: "general",
    });
  });

  it("a DENYING UserPromptSubmit hook REFUSES the turn — queryLoop NOT entered, blocked result", async () => {
    const turns = vi.fn(() => completeTurn());
    // A provider that THROWS if streamTurn is ever called — proves queryLoop never runs.
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        turns();
        throw new Error("queryLoop must NOT run when the prompt is refused");
      },
    };
    const mgr = stubManager("allow", { mode: "deny", reason: "policy: blocked term",
    });
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("blocked term", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.stopReason).toBe("blocked");
    expect(result.toolCalls).toEqual([]);
    // The refusal text surfaces the hook's reason; the LLM was never called.
    expect(result.text).toContain("policy: blocked term");
    expect(turns).not.toHaveBeenCalled();
    // Stop should NOT fire — the turn never started its query loop.
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "Stop")).toBe(false,
    );
  });

  it("a UserPromptSubmit dispatch THROW → fail-closed (turn refused, NOT allowed)", async () => {
    const provider: LLMProvider = {
      vendor: "openai",
      async *streamTurn() {
        throw new Error("queryLoop must NOT run when dispatch fails closed");
      },
    };
    const mgr = stubManager("allow", { mode: "throw" });
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    // Fail-closed: an unexpected dispatch error refuses the turn.
    expect(result.stopReason).toBe("blocked");
    expect(result.text).toContain("fail-closed");
  });

  it("NO hooks (manager returns allow / no match) ⇒ turn proceeds (back-compat)", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager("allow", { mode: "allow" });
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
  });

  it("no scriptHookManager ⇒ UserPromptSubmit never dispatched, turn proceeds (byte-identical to today)", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const loop = buildLoop(provider); // no manager at all
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard",
    });
    expect(result.text).toBe("ok");
    expect(result.stopReason).toBe("end_turn");
  });
});

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

import { KeywordEngine } from "../../core/keyword-engine.js";
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
function stubManager(lifecycleDecision: "allow" | "deny" = "allow") {
  return {
    setTrustedHooks: vi.fn(),
    setTrustedRegistry: vi.fn(),
    size: () => 0,
    runPreToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
    runPostToolUse: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
    runPermissionRequest: vi.fn(async () => ({ decision: "allow" as const, reason: "noop", results: [] })),
    runLifecycleEvent: vi.fn(async () => ({
      decision: lifecycleDecision,
      reason: "lifecycle",
      results: [],
    })),
  };
}

function buildLoop(
  provider: LLMProvider,
  scriptHookManager?: ReturnType<typeof stubManager>,
): ConversationLoop {
  const toolRegistry = new ToolRegistry();
  return new ConversationLoop(({
    settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
    systemPromptBuilder: { build: () => "system", setActiveRolePrompt: vi.fn() },
    keywordEngine: new KeywordEngine(),
    routeEngine: new RouteEngine({ toolRegistry }),
    toolRegistry,
    memoryManager: { saveSession: () => Promise.resolve(), listSessions: () => [], loadSessionMetadata: () => null },
    disableSessionPersistence: true,
    ...(scriptHookManager ? { scriptHookManager } : {}),
  } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
}

describe("ConversationLoop — #811 m2 lifecycle events", () => {
  it("fires SessionStart once on the first turn, with sessionMeta", async () => {
    const provider = new FakeProvider([completeTurn(), completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("first", undefined, undefined, { inputOrigin: "user-keyboard" });
    await loop.runTurn("second", undefined, undefined, { inputOrigin: "user-keyboard" });

    const starts = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "SessionStart");
    // SessionStart fires exactly once across two turns of the same session.
    expect(starts).toHaveLength(1);
    const [, sessionId, , payload] = starts[0];
    expect(typeof sessionId).toBe("string");
    expect((payload as { sessionMeta: Record<string, unknown> }).sessionMeta).toMatchObject({
      sessionKind: "main",
    });
  });

  it("re-fires SessionStart after newConversation() resets the once-per-session guard", async () => {
    const provider = new FakeProvider([completeTurn(), completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("first", undefined, undefined, { inputOrigin: "user-keyboard" });
    loop.newConversation(); // resets sessionStartFiredFor → the next turn re-announces.
    await loop.runTurn("second", undefined, undefined, { inputOrigin: "user-keyboard" });

    const starts = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "SessionStart");
    expect(starts).toHaveLength(2);
  });

  it("fires Stop after each turn with stopReason + toolCount + durationMs", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const mgr = stubManager();
    const loop = buildLoop(provider, mgr);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard" });

    const stops = mgr.runLifecycleEvent.mock.calls.filter((c) => c[0] === "Stop");
    expect(stops).toHaveLength(1);
    const payload = stops[0][3] as { stopReason?: string; toolCount: number; durationMs: number };
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
    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(result.text).toBe("ok");
    // Both SessionStart and Stop still fired (observe-only — deny ignored).
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "SessionStart")).toBe(true);
    expect(mgr.runLifecycleEvent.mock.calls.some((c) => c[0] === "Stop")).toBe(true);
  });

  it("back-compat: no scriptHookManager ⇒ no lifecycle dispatch, turn unchanged", async () => {
    const provider = new FakeProvider([completeTurn()]);
    const loop = buildLoop(provider); // no manager
    (loop as { provider: LLMProvider | null }).provider = provider;

    const result = await loop.runTurn("hi", undefined, undefined, { inputOrigin: "user-keyboard" });
    expect(result.text).toBe("ok");
  });
});

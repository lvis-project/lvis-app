/**
 * Intra-turn tool-result stubbing (issue #1171).
 *
 * A deep tool loop must not resend the full accumulated tool_result history
 * verbatim on every round. Between rounds the loop marks older tool_results
 * stale (memory verbatim; wire stubbed on next send), so the per-round
 * provider input PLATEAUS once the protect window fills instead of growing
 * monotonically.
 */
import { afterEach, describe, expect, it } from "vitest";

import { KeywordEngine } from "../../core/keyword-engine.js";
import { RouteEngine } from "../../core/route-engine.js";
import { ConversationLoop } from "../conversation-loop.js";
import { estimateMessagesTokens } from "../auto-compact.js";
import type { LLMProvider, StreamEvent, StreamTurnParams } from "../llm/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import { createDynamicTool } from "../../tools/base.js";
import { fakeLlmSettings } from "../../shared/__tests__/fake-llm-settings.js";

// Mirrors conversation-loop's module-private INTRA_TURN_PRESERVE_RECENT_RESULTS
// (= 2 × MAX_TOOL_CALLS_PER_ROUND(10)); kept here so the plateau assertions
// reason about the same protect-window boundary.
const INTRA_TURN_PRESERVE_RECENT_RESULTS = 16;

/**
 * Emits a tool_use for `toolRounds` rounds, then ends the turn. Records the
 * wire-message token estimate the provider actually receives each round (the
 * loop stubs marked tool_results before send, so this is the real payload).
 */
class RecordingToolLoopProvider implements LLMProvider {
  readonly vendor = "openai" as const;
  private index = 0;
  readonly perRoundWireTokens: number[] = [];

  constructor(private readonly toolRounds: number) {}

  async *streamTurn(input: StreamTurnParams): AsyncIterable<StreamEvent> {
    this.perRoundWireTokens.push(estimateMessagesTokens(input.messages));
    const round = this.index++;
    if (round < this.toolRounds) {
      yield { type: "text_delta", text: `round ${round}` };
      yield { type: "tool_call", id: `tu-${round}`, name: "probe", input: { n: round } };
      yield { type: "message_complete", stopReason: "tool_use" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "message_complete", stopReason: "end_turn" };
  }
}

describe("ConversationLoop intra-turn tool-result stubbing (issue #1171)", () => {
  afterEach(() => {
    delete process.env.LVIS_DEV_PREFLIGHT_OVERRIDE;
  });

  it("plateaus per-round wire input after the protect window fills instead of growing monotonically", async () => {
    // Force the micro-compact gate on without filling a real 200K context:
    // floor = override * 0.5 = 1000 tokens, exceeded well before the protect
    // window (16 results) fills.
    process.env.LVIS_DEV_PREFLIGHT_OVERRIDE = "2000";

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(createDynamicTool({
      name: "probe",
      description: "returns a sizeable result",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: { n: { type: "number" } } },
      // Each result well above the 200-char minStubThreshold so marking frees real tokens.
      execute: async () => ({ output: "RESULT " + "x".repeat(400), isError: false }),
    }));

    // Run more rounds than the protect window (16) so older results actually
    // age out and get stubbed — the deep-indexer turn shape from #1171.
    const TOOL_ROUNDS = 24;
    const provider = new RecordingToolLoopProvider(TOOL_ROUNDS);
    const loop = new ConversationLoop(({
      settingsService: { get: () => fakeLlmSettings(), getSecret: () => "test-key" },
      systemPromptBuilder: { build: () => "system" },
      keywordEngine: new KeywordEngine(),
      routeEngine: new RouteEngine({ toolRegistry }),
      toolRegistry,
      memoryManager: { saveSession: () => {}, listSessions: () => [] },
      disableSessionPersistence: true,
    } as unknown) as ConstructorParameters<typeof ConversationLoop>[0]);
    (loop as { provider: LLMProvider | null }).provider = provider;

    await loop.runTurn("deep tool loop", undefined, undefined, { inputOrigin: "user-keyboard" });

    const tokens = provider.perRoundWireTokens;
    // Sanity: the loop ran enough rounds to exceed the protect window so older
    // results actually age out and get stubbed.
    expect(tokens.length).toBeGreaterThan(INTRA_TURN_PRESERVE_RECENT_RESULTS + 4);

    // Per-round growth slope. While the protect window (16) is filling, each
    // round appends one full verbatim tool_result — a fixed ~constant slope.
    // Once results exceed the window, every new round ages one older result
    // out to a wire stub, so the net per-round growth DROPS sharply: the turn
    // plateaus instead of growing at the full verbatim rate. A regression that
    // removed intra-turn stubbing would keep the full slope to the last round.
    const deltas = tokens.slice(1).map((t, i) => t - tokens[i]);
    // Pre-stub slope: rounds while the window is still filling (results <= 16).
    const fillingDeltas = deltas.slice(2, INTRA_TURN_PRESERVE_RECENT_RESULTS - 2);
    // Post-stub slope: the tail where stubbing is actively aging results out.
    const stubbingDeltas = deltas.slice(-4);
    const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const fillingSlope = avg(fillingDeltas);
    const stubbingSlope = avg(stubbingDeltas);

    // The stubbing tail must grow at well under half the verbatim fill slope —
    // the plateau signal. (Empirically the fill slope is ~one full result/round
    // and the stubbing slope is the result minus the freed stub.)
    expect(stubbingSlope).toBeLessThan(fillingSlope * 0.6);

    // Monotonic-growth guard: the final round must stay far below a no-stubbing
    // projection (every round's full verbatim result summed). Without stubbing
    // the last round would equal first-round growth × round count.
    const noStubLastRound = tokens[0] + fillingSlope * (tokens.length - 1);
    const last = tokens[tokens.length - 1];
    expect(last).toBeLessThan(noStubLastRound);
  });
});

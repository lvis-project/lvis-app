/**
 * Loop decisions reach the platform stream.
 *
 * `--exec --exec-output=stream-json` serialises the closed event union
 * verbatim, so a decision that stops at the callback boundary is a decision no
 * headless reader can ever see. These pin the mapping and the shared-projection
 * verdict for the new kind.
 */
import { describe, expect, it, vi } from "vitest";

import type { PlatformConversationEvent } from "../../../engine/conversation-platform-protocol.js";
import { projectSharedConversationEvent } from "../../../engine/conversation-platform-protocol.js";
import type { TurnCallbacks, TurnDecisionEvent } from "../../../engine/turn/types.js";
import { runStreamedTurn, STREAM_TURN_OPTIONS } from "../chat-stream.js";
import { makeLoop } from "./chat-stream-test-helpers.js";

const DECISION: TurnDecisionEvent = {
  kind: "early_exit",
  branch: "round-cap",
  data: { assistantRoundsRun: 30, effectiveMaxRounds: 30, toolCalls: 41 },
};

describe("runStreamedTurn loop.decision emission", () => {
  it("publishes each decision the turn reports, verbatim", async () => {
    const { loop, runTurn } = makeLoop();
    runTurn.mockImplementation(async (..._args: unknown[]) => {
      (_args[1] as TurnCallbacks).onDecision?.(DECISION);
      return { text: "done", toolCalls: [], route: "default", stopReason: "end_turn" };
    });
    const sink = vi.fn();

    await runStreamedTurn(loop, "go", sink, STREAM_TURN_OPTIONS);

    const events = sink.mock.calls.map((call) => call[0] as PlatformConversationEvent);
    expect(events).toContainEqual({ kind: "loop.decision", decision: DECISION });
  });

  it("carries the per-kind counts through the usage report", async () => {
    const { loop, runTurn } = makeLoop();
    runTurn.mockImplementation(async (..._args: unknown[]) => {
      (_args[1] as TurnCallbacks).onTurnSummary?.({
        turnDurationMs: 12,
        toolCount: 1,
        cumulativeToolMs: 4,
        tokensIn: 100,
        freshInputTokens: 90,
        tokensOut: 10,
        decisionCounts: { tool_batch: 2, early_exit: 1 },
      });
      return { text: "done", toolCalls: [], route: "default", stopReason: "end_turn" };
    });
    const sink = vi.fn();

    await runStreamedTurn(loop, "go", sink, STREAM_TURN_OPTIONS);

    const events = sink.mock.calls.map((call) => call[0] as PlatformConversationEvent);
    expect(events).toContainEqual(expect.objectContaining({
      kind: "usage.reported",
      ownerDetail: expect.objectContaining({
        decisionCounts: { tool_batch: 2, early_exit: 1 },
      }),
    }));
  });

  it("stays out of the shared projection — a remote observer watches a conversation, not control flow", () => {
    expect(projectSharedConversationEvent({
      kind: "loop.decision",
      decision: DECISION,
    })).toBeUndefined();
  });
});

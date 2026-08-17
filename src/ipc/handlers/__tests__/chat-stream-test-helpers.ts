/**
 * Shared fixture for `runStreamedTurn` boundary suites: a minimal
 * ConversationLoop stub whose `runTurn` records its arguments, plus accessors
 * for the turn options it received. Kept in one helper module so the staged
 * provenance and turn-input emission suites do not carry divergent copies.
 */
import { vi } from "vitest";
import type { ConversationLoop } from "../../../engine/conversation-loop.js";

const completedTurn = {
  text: "done",
  toolCalls: [],
  route: "default",
  stopReason: "end_turn",
} as const;

export function makeLoop() {
  const runTurn = vi.fn(async (..._args: unknown[]) => completedTurn);
  const loop = { runTurn } as unknown as ConversationLoop;
  return { loop, runTurn };
}

export function turnOptions(
  runTurn: ReturnType<typeof makeLoop>["runTurn"],
): Record<string, unknown> {
  return (runTurn.mock.calls[0] as unknown[])[3] as Record<string, unknown>;
}

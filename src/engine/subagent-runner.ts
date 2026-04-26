/**
 * SubAgentRunner — host-side orchestrator for the `agent_spawn` tool.
 *
 * Spawns a child {@link ConversationLoop} with:
 *   - A fresh history (instructions become the system prompt overlay; the
 *     user input is the spawn task).
 *   - A scoped {@link ToolRegistry} restricted to the parent-supplied
 *     `sourceTools` list (or the parent's full tool set if omitted).
 *   - A turn cap (default 5) — the runner halts when the cap is hit even
 *     if the LLM still wants tools.
 *
 * Per-turn updates are streamed back as events so the renderer can show a
 * live SubAgentCard. Final summary is delivered as `summary` in the result.
 *
 * Rationale (vs. mutating the main loop): a sub-loop helper file keeps the
 * primary ConversationLoop unchanged, avoids reentrancy hazards on the
 * shared state (`sessionId`, `history`, `cumulativeUsage`), and lets each
 * spawn audit-log under a child sessionId tagged with the parent's id.
 */
import { randomUUID } from "node:crypto";
import { ConversationLoop, type ConversationLoopDeps } from "./conversation-loop.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface SubAgentSpawnInput {
  title: string;
  instructions: string;
  sourceTools?: string[];
  maxTurns?: number;
  /** Parent session id — propagated for audit attribution. */
  parentSessionId?: string;
}

export interface SubAgentTurnUpdate {
  turn: number;
  text: string;
  toolCallCount: number;
}

export interface SubAgentSpawnResult {
  summary: string;
  toolCallCount: number;
  turnCount: number;
  childSessionId: string;
}

export interface SubAgentSpawnCallbacks {
  onTurn?: (update: SubAgentTurnUpdate) => void;
  onError?: (message: string) => void;
}

export interface SubAgentRunnerDeps {
  /** Parent's ConversationLoopDeps. We clone but swap toolRegistry to a scoped view. */
  parentDeps: ConversationLoopDeps;
  toolRegistry: ToolRegistry;
}

const MAX_TURNS_DEFAULT = 5;
const MAX_TURNS_CAP = 20;

export class SubAgentRunner {
  constructor(private readonly deps: SubAgentRunnerDeps) {}

  /**
   * Spawn a sub-agent and run it inline. Returns the final summary text.
   */
  async spawn(
    input: SubAgentSpawnInput,
    callbacks?: SubAgentSpawnCallbacks,
  ): Promise<SubAgentSpawnResult> {
    const childSessionId = `${input.parentSessionId ?? "spawn"}::${randomUUID()}`;
    const requestedTurns = input.maxTurns ?? MAX_TURNS_DEFAULT;
    const cappedTurns = Math.max(1, Math.min(MAX_TURNS_CAP, requestedTurns));

    const scopedRegistry = input.sourceTools && input.sourceTools.length > 0
      ? this.deps.toolRegistry.createScopedView(input.sourceTools)
      : this.deps.toolRegistry;

    // Compose deps for the child loop. We share the parent's permissionManager,
    // approvalGate, hookRunner so the child plays by the same security rules.
    // History is fresh because ConversationLoop.constructor instantiates a new
    // ConversationHistory.
    const childDeps: ConversationLoopDeps = {
      ...this.deps.parentDeps,
      toolRegistry: scopedRegistry,
      // Sub-agent runs are fire-and-forget — no post-turn hook chain to keep
      // the parent session unaffected.
      postTurnHookChain: undefined,
      // Sub-agent does not request_plugin (its tool surface is fixed at spawn).
      pluginRuntime: undefined,
    };

    const child = new ConversationLoop(childDeps);
    if (!child.hasProvider()) {
      const msg = "sub-agent: LLM provider not configured";
      callbacks?.onError?.(msg);
      return {
        summary: msg,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId,
      };
    }

    let totalToolCalls = 0;
    let lastText = "";
    let turn = 0;

    // The sub-agent has a single user input: the instructions. We loop only
    // when the LLM emits tool calls; by default the queryLoop handles tool
    // rounds internally so a single runTurn() is usually enough. We still
    // bound turns externally as a defense-in-depth cap by counting the
    // assistant rounds emitted via the callback.
    const initialPrompt = input.instructions;
    let assistantRounds = 0;

    try {
      const result = await child.runTurn(initialPrompt, {
        onAssistantRound: (round) => {
          assistantRounds += 1;
          turn = assistantRounds;
          callbacks?.onTurn?.({
            turn: assistantRounds,
            text: round.text,
            toolCallCount: 0, // updated on next round when we know tool count
          });
          if (assistantRounds >= cappedTurns) {
            // Abort so the child stops emitting more rounds. The current
            // round's tool calls (if any) will still execute because abort
            // only halts the next streaming turn.
            child.abortCurrentTurn();
          }
        },
        onError: (e) => {
          callbacks?.onError?.(e);
        },
      });
      totalToolCalls = result.toolCalls.length;
      lastText = result.text;
    } catch (err) {
      const msg = (err as Error).message ?? "sub-agent run failed";
      callbacks?.onError?.(msg);
      lastText = msg;
    }

    return {
      summary: lastText,
      toolCallCount: totalToolCalls,
      turnCount: turn,
      childSessionId,
    };
  }
}

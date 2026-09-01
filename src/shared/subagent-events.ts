import type { A2AProjectedTaskState } from "./a2a.js";

export type SubAgentSuspensionReason = "budget" | "question";

export interface SubAgentSuspension {
  reason: SubAgentSuspensionReason;
  prompt?: string;
  resumeId: string;
}

export type SubAgentRunStatus = "running" | "waiting" | "done" | "error" | "interrupted";

/**
 * Canonical agent_spawn lifecycle payload shared by main, preload, renderer,
 * and test fixtures. `taskState` is the required A2A projection for every
 * phase; boundary fixtures must stay typed to this interface so field additions
 * cannot be silently dropped by `unknown` or record-shaped adapters.
 */
export interface AgentSpawnEvent<TEntry = unknown> {
  spawnId: string;
  /**
   * The conversation that spawned this sub-agent. Every tile receives every
   * frame on one channel; a tile keeps only the frames of the conversation it
   * is showing, so an unlabelled frame is one every tile keeps — N cards for
   * one sub-agent, and the tile that acts on it is not the one that spawned it.
   * Required for that reason: a spawn is always requested by a parent that has
   * a session, and the id survives the whole way (`agent-spawn.ts` stamps it on
   * every frame), so there is nothing for an absent value to mean.
   */
  parentSessionId: string;
  taskState: A2AProjectedTaskState;
  type: "start" | "activity" | "done" | "error";
  title?: string;
  instructions?: string;
  entries?: TEntry[];
  summary?: string;
  toolCallCount?: number;
  message?: string;
  status?: SubAgentRunStatus;
  suspension?: SubAgentSuspension;
  toolUseId?: string;
  childSessionId?: string;
}

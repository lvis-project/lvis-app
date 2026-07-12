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

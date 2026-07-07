import type { ChatEntry } from "../../../lib/chat-stream-state.js";

export interface SubAgentSpawn {
  spawnId: string;
  title: string;
  status: "running" | "done" | "error" | "interrupted";
  /** The prompt sent to the sub-agent, rendered as a user bubble in the viewer. */
  instructions?: string;
  /**
   * Full sub-agent transcript as `ChatEntry[]` — the same model the main chat
   * renders. Populated from forwarded child-loop activity.
   */
  entries: ChatEntry[];
  summary?: string;
  toolCallCount: number;
  errorMessage?: string;
  /**
   * The originating `agent_spawn` tool_use id. Set on `start` event and
   * preserved across activity/done/error updates.
   */
  toolUseId?: string;
  /**
   * The addressable sub-agent session id — the JOIN KEY that unifies a spawn
   * and its resume(s) into one transcript in the sub-agent viewer.
   */
  childSessionId?: string;
}

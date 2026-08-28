/**
 * useWorkflowTools — consolidates renderer-side state for the 5 workflow
 * system tools (S1+S2):
 *   - askUserQuestionRequests: FIFO queue for the non-modal composer-dock card
 *   - subAgentSpawns: live list of in-flight + recently-completed sub-agents
 *   - loadedSkills: badges shown inline for `skill_load` calls
 *
 * `RemindersList` and `SessionTodoPanel` own their own state since they're
 * simple list views; they live alongside this hook in the App.
 */
import { useCallback, useEffect, useState } from "react";
import { A2ATaskState } from "../../../shared/a2a.js";

/** A sub-agent row rebuilt from disk, as sent by `chat:session-history`. */
export interface RestoredSubAgentRow {
  spawnId: string;
  childSessionId: string;
  title: string;
  modifiedAt: string;
  /** Last durable A2A projection the child recorded, when it recorded one. */
  taskState?: string;
  toolUseId?: string;
}

/**
 * Status to show for a sub-agent row rebuilt from disk.
 *
 * Never returns `"running"`. The panel sorts running rows to the top, and a
 * restored row cannot be running by construction: the process that ran it died
 * with the app. Returning it would push a dead agent above a live one.
 *
 * `WORKING`/`SUBMITTED` are the interesting case. The last thing the child
 * durably recorded was "in progress", and that record is accurate about the
 * past and wrong about the present — the run cannot be reattached, only
 * resumed. `"interrupted"` is the honest reading, and it is why that value
 * exists in the union.
 *
 * An absent `taskState` resolves the same way, pessimistically: a child that
 * never recorded a projection died before reaching one, so it is at least as
 * unfinished as a WORKING row. Calling it `"done"` would be a claim the file
 * does not support.
 */
function restoredSpawnStatus(row: RestoredSubAgentRow): SubAgentSpawn["status"] {
  switch (row.taskState) {
    case A2ATaskState.COMPLETED:
      return "done";
    case A2ATaskState.FAILED:
    case A2ATaskState.REJECTED:
      return "error";
    case A2ATaskState.INPUT_REQUIRED:
      // Stopped on a question it never got an answer to — still actionable.
      return "waiting";
    case A2ATaskState.CANCELED:
      return "interrupted";
    default:
      return "interrupted";
  }
}

/** Test seam for the mapping above; not used by the hook itself. */
export const restoredSpawnStatusForTest = restoredSpawnStatus;
import type { LvisApi } from "../types.js";
import type { AskUserQuestionRequest } from "../components/AskUserQuestionCard.js";
import type { SubAgentSpawn } from "../subagents/types.js";
import type { SkillBadgeProps } from "../components/SkillBadge.js";

/**
 * M4: cap the inline skill badges so a chatty assistant cannot grow the
 * list unbounded across a long session. 10 is large enough that legitimate
 * use is unaffected and small enough that abuse is bounded. Newest-first
 * dedup: re-loading the same skill replaces the prior entry rather than
 * stacking duplicates.
 */
const SKILL_BADGE_CAP = 10;

export interface WorkflowToolsOptions {
  /**
   * Whether `sessionId` is a conversation this surface is showing. Sub-agent
   * frames and question cards arrive on window-wide channels; a tile keeps only
   * what belongs to its own conversation, or four tiles would each list every
   * tile's agents and draw every tile's questions. A tile also owns the child
   * sessions of the agents IT spawned, so a question a sub-agent asks lands in
   * the tile that started it.
   * A surface showing the whole window passes nothing and keeps every frame.
   * Must be referentially stable (`useCallback`): it is a dependency of the
   * channel subscription, and a frame arriving during a resubscribe is lost.
   */
  ownsSession?: (sessionId: string) => boolean;
}

export function useWorkflowTools(api: LvisApi, options: WorkflowToolsOptions = {}) {
  const { ownsSession } = options;
  const [askQuestions, setAskQuestions] = useState<AskUserQuestionRequest[]>([]);
  const [subAgentSpawns, setSubAgentSpawns] = useState<SubAgentSpawn[]>([]);
  const [loadedSkills, setLoadedSkills] = useState<SkillBadgeProps[]>([]);

  useEffect(() => {
    // Defensive: in test/preview environments some API surfaces are stubbed
    // and the workflow channels may be undefined. Skip wiring if absent —
    // the components above re-check on each render so a late stub still picks
    // up new requests.
    if (typeof api.onAskUserQuestion !== "function") return undefined;
    const unsubAsk = api.onAskUserQuestion?.((req) => {
      // A question belongs to ONE conversation. Drawn in every tile, it can be
      // answered from a tile that never asked — that answer resolves the gate,
      // and the asking tile is left holding a card the gate now refuses.
      if (ownsSession && !ownsSession(req.sessionId)) return;
      setAskQuestions((prev) =>
        prev.some((p) => p.id === req.id) ? prev : [...prev, req],
      );
    });
    const unsubSpawn = api.onAgentSpawnEvent?.((event) => {
      if (ownsSession && event.parentSessionId && !ownsSession(event.parentSessionId)) return;
      setSubAgentSpawns((prev) => {
        const existingIdx = prev.findIndex((s) => s.spawnId === event.spawnId);
        if (event.type === "start") {
          if (existingIdx >= 0) return prev;
          const fresh: SubAgentSpawn = {
            spawnId: event.spawnId,
            title: event.title ?? "(sub-agent)",
            status: "running",
            ...(event.instructions ? { instructions: event.instructions } : {}),
            entries: [],
            toolCallCount: 0,
            toolUseId: event.toolUseId,
            childSessionId: event.childSessionId,
          };
          return [...prev, fresh];
        }
        // `activity` / `done` / `error` may arrive before `start` (or after a
        // reload cleared the live list). Synthesize the spawn from what the
        // event carries. `entries` is a full-snapshot replace, never a delta.
        if (existingIdx < 0) {
          const synthetic: SubAgentSpawn = {
            spawnId: event.spawnId,
            title: event.title ?? "(sub-agent)",
            status:
              event.type === "done"
                ? (event.status ?? "done")
                : event.type === "error"
                  ? "error"
                  : "running",
            ...(event.instructions ? { instructions: event.instructions } : {}),
            entries: event.entries ?? [],
            toolCallCount: event.toolCallCount ?? 0,
            summary: event.summary,
            errorMessage: event.message,
            toolUseId: event.toolUseId,
            childSessionId: event.childSessionId,
            suspension: event.suspension,
          };
          return [...prev, synthetic];
        }
        const next = [...prev];
        const existing = next[existingIdx];
        // `childSessionId` (the resume JOIN KEY) may first arrive on a later
        // phase (the original spawn only learns it on `done`). Only overwrite
        // when the event carries a value so a known id is never clobbered with
        // undefined on a phase that omits it.
        const childSessionIdPatch = event.childSessionId
          ? { childSessionId: event.childSessionId }
          : {};
        const instructionsPatch = event.instructions
          ? { instructions: event.instructions }
          : {};
        if (event.type === "activity") {
          next[existingIdx] = {
            ...existing,
            // Full snapshot replace — the accumulator forwards the whole child
            // transcript each time, so overwriting (not appending) is correct
            // and idempotent against re-emitted events.
            ...(event.entries ? { entries: event.entries } : {}),
            toolCallCount: event.toolCallCount ?? existing.toolCallCount,
            ...instructionsPatch,
            ...childSessionIdPatch,
          };
        } else if (event.type === "done") {
          next[existingIdx] = {
            ...existing,
            status: event.status ?? "done",
            summary: event.summary,
            ...(event.entries ? { entries: event.entries } : {}),
            toolCallCount: event.toolCallCount ?? existing.toolCallCount,
            ...instructionsPatch,
            ...childSessionIdPatch,
            ...(event.suspension ? { suspension: event.suspension } : {}),
          };
        } else if (event.type === "error") {
          next[existingIdx] = {
            ...existing,
            status: "error",
            errorMessage: event.message,
            ...(event.entries ? { entries: event.entries } : {}),
            ...instructionsPatch,
            ...childSessionIdPatch,
          };
        }
        return next;
      });
    });
    const unsubSkill = api.onSkillLoaded?.((event) => {
      // Same conversation scoping as the cards above: a skill loaded in one
      // tile's turn is not a badge on the tile beside it.
      if (ownsSession && !ownsSession(event.sessionId)) return;
      // M4: dedupe by name (newest wins) and cap to last SKILL_BADGE_CAP.
      // Without this, a chatty assistant could grow the badge list
      // unbounded over a long session.
      setLoadedSkills((prev) => {
        const filtered = prev.filter((s) => s.name !== event.name);
        const next = [
          ...filtered,
          {
            name: event.name,
            description: event.description,
          },
        ];
        if (next.length > SKILL_BADGE_CAP) {
          return next.slice(next.length - SKILL_BADGE_CAP);
        }
        return next;
      });
    });
    // M2: ask-user-question timeout — drop the stale card so the user
    // does not silently click into a no-op. The renderer subscribes to
    // the explicit timeout channel emitted by AskUserQuestionGate.
    const unsubAskTimeout = api.onAskUserQuestionTimeout?.(({ requestId }) => {
      setAskQuestions((prev) => prev.filter((q) => q.id !== requestId));
    });
    return () => {
      unsubAsk?.();
      unsubSpawn?.();
      unsubSkill?.();
      unsubAskTimeout?.();
    };
  }, [api, ownsSession]);

  const dismissAskQuestion = useCallback((id: string) => {
    setAskQuestions((prev) => prev.filter((q) => q.id !== id));
  }, []);

  /**
   * Seed the panel from sub-agent rows rebuilt on disk after a restart.
   *
   * Merges rather than replaces: a live event may already have produced a row
   * for the same `spawnId` (a restored session whose child is running again via
   * resume), and a restored row must never clobber live state that is strictly
   * fresher than the file it came from.
   */
  const restoreSubAgentSpawns = useCallback((restored: readonly RestoredSubAgentRow[]) => {
    setSubAgentSpawns((prev) => {
      const known = new Set(prev.map((spawn) => spawn.spawnId));
      const rows = restored
        .filter((row) => !known.has(row.spawnId))
        .map((row): SubAgentSpawn => ({
          spawnId: row.spawnId,
          title: row.title || "(sub-agent)",
          status: restoredSpawnStatus(row),
          entries: [],
          toolCallCount: 0,
          childSessionId: row.childSessionId,
          ...(row.toolUseId ? { toolUseId: row.toolUseId } : {}),
        }));
      return rows.length > 0 ? [...prev, ...rows] : prev;
    });
  }, []);

  /**
   * M4: explicit reset hook callable from the App (e.g. when the user
   * clicks "new chat"). Clears the per-session skill badge list so a
   * brand-new conversation does not inherit prior session badges.
   */
  const resetForNewSession = useCallback(() => {
    setLoadedSkills([]);
    setSubAgentSpawns([]);
    setAskQuestions([]);
  }, []);

  return {
    askQuestions,
    subAgentSpawns,
    restoreSubAgentSpawns,
    loadedSkills,
    dismissAskQuestion,
    resetForNewSession,
  };
}

/**
 * useWorkflowTools — consolidates renderer-side state for the 5 workflow
 * system tools (S1+S2):
 *   - askUserQuestionRequests: queue of inline questions awaiting user input
 *   - subAgentSpawns: live list of in-flight + recently-completed sub-agents
 *   - loadedSkills: badges shown inline for `skill_load` calls
 *
 * `RemindersList` and `SessionTodoPanel` own their own state since they're
 * simple list views; they live alongside this hook in the App.
 */
import { useCallback, useEffect, useState } from "react";
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

export function useWorkflowTools(api: LvisApi) {
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
      setAskQuestions((prev) =>
        prev.some((p) => p.id === req.id) ? prev : [...prev, req],
      );
    });
    const unsubSpawn = api.onAgentSpawnEvent?.((event) => {
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
  }, [api]);

  const dismissAskQuestion = useCallback((id: string) => {
    setAskQuestions((prev) => prev.filter((q) => q.id !== id));
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
    loadedSkills,
    dismissAskQuestion,
    resetForNewSession,
  };
}

/**
 * `session_goal` LLM tool — the objective this session is working towards.
 *
 * One tool with upsert semantics: no goal yet and it registers one, a goal
 * already there and it updates. There is deliberately no second tool for
 * finishing — `status: "complete"` on this same call is what ends the session's
 * revival loop, so the model has one name to remember and the goal has one
 * writer.
 *
 * Every call answers with the whole goal record (text, status, round, ceiling),
 * so the model never has to remember how many rounds it has spent.
 */
import { createDynamicTool, type Tool } from "./base.js";
import {
  SessionGoalMissingError,
  SessionGoalTextError,
  type SessionGoalStore,
} from "../main/session-goal-store.js";
import { isSessionGoalAtCeiling, type SessionGoal } from "../shared/session-goal.js";
import { t } from "../i18n/index.js";

const STATUSES = ["complete", "pause", "resume"] as const;
type SessionGoalToolStatus = (typeof STATUSES)[number];

function isStatus(value: unknown): value is SessionGoalToolStatus {
  return typeof value === "string" && (STATUSES as readonly string[]).includes(value);
}

function view(goal: SessionGoal) {
  return {
    goal: goal.text,
    status: goal.status,
    round: goal.round,
    ceiling: goal.ceiling,
    atCeiling: isSessionGoalAtCeiling(goal),
  };
}

function failure(error: string) {
  return { output: JSON.stringify({ error }), isError: true };
}

/**
 * A call that leaves the goal as it is burns a full-context round for nothing.
 * Reported as a failure for the same reason `session_tasks` reports one: it is
 * what engages the "do not retry the same failed tool input" prompt rule, and
 * a success answer had the model repeating the call until it hit TPM.
 */
function noChange(detail: string) {
  return failure(`${detail}: nothing changed. Do not retry session_goal with the same input; continue with work tools and call session_goal again only when the goal itself changes.`);
}

export function createSessionGoalTool(store: SessionGoalStore): Tool {
  return createDynamicTool({
    name: "session_goal",
    description: t("be_sessionGoal.toolDescription"),
    source: "builtin",
    // category="read" — for the same reason `session_tasks` is read: the goal
    // is this conversation's own bookkeeping, written into its own session
    // sidecar, with no external mutation and no cross-session impact. Raising
    // the approval dock for "the goal is met" would gate the one call that
    // STOPS the loop behind a click the user may not be there to give.
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      properties: {
        goal: { type: "string", description: t("be_sessionGoal.goalDesc") },
        status: {
          type: "string",
          enum: STATUSES,
          description: t("be_sessionGoal.statusDesc"),
        },
      },
    },
    execute: async (rawInput, ctx) => {
      if (typeof ctx.metadata?.sessionId !== "string" || ctx.metadata.sessionId.length === 0) {
        return failure("missing sessionId metadata");
      }
      const sessionId = ctx.metadata.sessionId;
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const text = typeof a.goal === "string" && a.goal.trim() ? a.goal.trim() : undefined;
      if (a.status !== undefined && !isStatus(a.status)) {
        return failure(`status must be one of ${STATUSES.join(", ")}`);
      }
      const status = isStatus(a.status) ? a.status : undefined;
      const before = store.get(sessionId);
      if (before !== null && status === undefined && text === before.text) {
        return noChange(`the goal is already "${before.text}"`);
      }
      if (before !== null && text === undefined) {
        const already =
          (status === "complete" && before.status === "complete")
          || (status === "pause" && before.status === "paused")
          || (status === "resume" && before.status === "running" && !isSessionGoalAtCeiling(before));
        if (already) return noChange(`the goal is already ${before.status}`);
      }
      const answer = (goal: SessionGoal) =>
        ({ output: JSON.stringify(view(goal)), isError: false });
      try {
        // Upsert first, then the status verb, so `goal` + `status: complete`
        // in one call registers the objective and closes it in that order.
        // A status verb on a session with no goal reaches the store, whose
        // missing-goal error is the answer — there is no second guard here to
        // drift from it.
        const upserted = text !== undefined ? await store.set(sessionId, text) : null;
        if (status === "complete") return answer(await store.complete(sessionId));
        if (status === "pause") return answer(await store.pause(sessionId));
        if (status === "resume") return answer(await store.resume(sessionId));
        if (upserted !== null) return answer(upserted);
        return failure("session_goal needs goal (the objective) and/or status");
      } catch (err) {
        if (err instanceof SessionGoalTextError || err instanceof SessionGoalMissingError) {
          return failure(err.message);
        }
        throw err;
      }
    },
  });
}

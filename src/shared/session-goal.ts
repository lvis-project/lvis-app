/**
 * Session goal — the objective the user registers for one chat session, and
 * the revival budget that keeps the session working towards it after each
 * turn ends (`session_goal` LLM tool, `/goal` slash command). Shared between
 * main (store + metadata sidecar + revival driver) and the renderer (composer
 * chip).
 *
 * `round` counts the revivals already spent and `ceiling` is the budget they
 * are spent from; both live with the goal in the sidecar, so a restart resumes
 * the same budget rather than handing the session a fresh 50.
 *
 * "Ceiling reached" is derived from those two numbers rather than stored as a
 * status: a status plus a counter would be two facts about one thing, and the
 * pair can disagree.
 */
import { isRecord } from "./is-record.js";

const SESSION_GOAL_STATUSES = ["running", "paused", "complete"] as const;

type SessionGoalStatus = (typeof SESSION_GOAL_STATUSES)[number];

export interface SessionGoal {
  /** What the session is working towards, as the user wrote it. */
  text: string;
  status: SessionGoalStatus;
  /** Revivals already spent on this goal. */
  round: number;
  /** Revival budget. Raised when the user chooses to continue past it. */
  ceiling: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Revivals granted when a goal is registered, and added again each time the
 * user chooses to continue past the ceiling.
 */
export const SESSION_GOAL_CEILING = 50;

/** Longest goal text kept. Longer input is refused, never silently trimmed. */
export const MAX_SESSION_GOAL_CHARS = 2000;

function isSessionGoalStatus(value: unknown): value is SessionGoalStatus {
  return typeof value === "string"
    && (SESSION_GOAL_STATUSES as readonly string[]).includes(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isSessionGoal(value: unknown): value is SessionGoal {
  return (
    isRecord(value)
    && typeof value.text === "string"
    && value.text.length > 0
    && isSessionGoalStatus(value.status)
    && isCount(value.round)
    && isCount(value.ceiling)
    && value.ceiling > 0
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string"
  );
}

/** The budget is spent: the user has to say whether the session keeps going. */
export function isSessionGoalAtCeiling(goal: SessionGoal): boolean {
  return goal.round >= goal.ceiling;
}

/**
 * Whether one more revival may be spent. The single predicate both the
 * main-process driver and the renderer chip read, so what the chip says is
 * running is what actually revives.
 */
export function canReviveSessionGoal(goal: SessionGoal): boolean {
  return goal.status === "running" && !isSessionGoalAtCeiling(goal);
}

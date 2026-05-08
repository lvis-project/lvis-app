/**
 * Shared routine type definitions and constants — safe to import from both
 * main-process and renderer (no Node.js built-in imports).
 *
 * The main-process `RoutinesStore` re-exports these for backwards compatibility.
 * The renderer imports from here to avoid pulling in Node.js `fs/path/os/crypto`
 * modules into the webpack renderer bundle.
 */

/**
 * Hard cap on persisted routines (Q6). Hitting the cap means add() throws —
 * the LLM receives a clear error and can prompt the user to dismiss old routines.
 */
export const MAX_PERSISTED_ROUTINES = 50;

/**
 * Sub-cap on llm-session routines (Q8). LLM session routines invoke a
 * ConversationLoop per fire — an unbounded count risks LLM cost runaway.
 * The sub-cap (10) is intentionally tighter than the total cap (50).
 */
export const MAX_LLM_SESSION_ROUTINES = 10;

export type RoutineExecution = "llm-session" | "notification-only";

export type RepeatKind =
  | "none"
  | "daily"
  | "weekly"
  | "monthly"
  | "interval"
  | "cron";

export type RoutineRepeat =
  | { kind: "none" }
  | { kind: "daily" }
  | { kind: "weekly" }
  | { kind: "monthly" }
  | { kind: "interval"; intervalMs: number }
  | { kind: "cron"; expression: string };

export interface RoutineSchedule {
  /** ISO timestamp for the first (or one-time) fire. */
  at?: string;
  repeat?: RoutineRepeat;
}

export interface RoutineRecord {
  id: string;
  /** wakeup trigger is removed (Q1) — only schedule and shutdown remain. */
  trigger: "shutdown" | "schedule";
  schedule?: RoutineSchedule;
  execution: RoutineExecution;
  /** System prompt injected when execution === "llm-session". */
  prePrompt?: string;
  title?: string;
  /** Shown as OS notification title when execution === "notification-only". */
  notificationTitle?: string;
  /** Shown as OS notification body when execution === "notification-only". */
  notificationBody?: string;
  createdAt: string;
  lastFiredAt?: string;
  dismissedAt?: string;
  /**
   * Persistent cron dedup key — ISO string of the UTC minute that last fired.
   * Survives app restarts so the same cron minute cannot re-fire after reboot.
   */
  lastFiredMinuteUTC?: string;
}

export interface AddRoutineInput {
  trigger: "shutdown" | "schedule";
  schedule?: RoutineSchedule;
  execution: RoutineExecution;
  prePrompt?: string;
  title?: string;
  notificationTitle?: string;
  notificationBody?: string;
}

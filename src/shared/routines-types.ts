/**
 * Shared routine type definitions and constants — safe to import from both
 * main-process and renderer (no Node.js built-in imports).
 *
 * The main-process `RoutinesStore` re-exports these as its public type boundary.
 * The renderer imports from here to avoid pulling in Node.js `fs/path/os/crypto`
 * modules into the webpack renderer bundle.
 */

/**
 * Hard cap on persisted routines. Hitting the cap means add() throws —
 * the LLM receives a clear error and can prompt the user to dismiss old routines.
 */
export const MAX_PERSISTED_ROUTINES = 50;

/**
 * Sub-cap on llm-session routines. LLM session routines invoke a
 * ConversationLoop per fire — an unbounded count risks LLM cost runaway.
 * The sub-cap (10) is intentionally tighter than the total cap (50).
 */
export const MAX_LLM_SESSION_ROUTINES = 10;

/**
 * Maximum length of the {@link RoutineRecord.source} marker. Caps the stored
 * identity string so a malformed/oversized `source` cannot bloat the persisted
 * routines file. Enforced both at the `routine_schedule` tool boundary and in
 * `RoutinesStore.add` (the SOT).
 */
export const MAX_ROUTINE_SOURCE_LENGTH = 128;

export type RoutineExecution = "llm-session" | "notification-only";

/**
 * Permission policy Layer 4 — discriminated union scoping which plugins a routine may
 * see during its isolated session.
 *
 * - `deny-all`  no plugin tools exposed
 * - `allow`     explicit allowlist
 * - `inherit`   adopt the user's currently-active plugin set at fire
 *               time. This mode is explicit only; missing scope normalizes
 *               to deny-all.
 */
export type RoutinePluginScope =
  | { mode: "deny-all" }
  | { mode: "allow"; ids: string[] }
  | { mode: "inherit" };

/**
 * Permission policy Layer 4 — `routine.scope` namespace bundling every per-routine
 * isolation knob. Replaces the flat `allowedPlugins?: string[]` field.
 *
 * - `pluginIds` plugin allow-list (discriminated union — see above).
 * - `forcedPluginIds` plugins guaranteed active for this routine even
 *    if the user has them disabled. Defaults to `[]` — NEVER mirror
 *    `pluginIds.ids` here; that would defeat the point of `pluginIds`.
 * - `directories` extra Layer 1 path allow-list scoped to this run.
 */
export interface RoutineScope {
  pluginIds: RoutinePluginScope;
  forcedPluginIds: string[];
  directories: string[];
}

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
  /** wakeup trigger is removed — only schedule and shutdown remain. */
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
  /**
   * Permission policy Layer 4 scope — plugin allow-list, forced plugin set, and
   * extra directories permitted during this routine's headless session.
   *
 * Missing scope → deny-all (fail-safe per Permission policy design §1). The
   * runtime normalizer in `RoutineEngine.normalizeScope` coerces a
   * missing/undefined scope into `{ pluginIds: { mode: "deny-all" } }`
   * rather than `inherit`, so a routine that never declared scope cannot
   * accidentally see the user's currently-active plugin set. Records with
   * non-canonical plugin scope fields are rejected by the store read path.
   */
  scope?: RoutineScope;
  createdAt: string;
  lastFiredAt?: string;
  /**
   * Last routine result the user explicitly acknowledged in the overlay UI.
   * When this differs from `lastFiredAt`, the renderer must rehydrate the
   * routine result card on next launch so completed-but-unseen runs are not lost.
   */
  lastResultAcknowledgedAt?: string;
  /**
   * Exact conversation session created by the latest llm-session run.
   * Cleared when a routine fires and set only after the run successfully
   * creates a session, so pending-result rehydration never guesses by date.
   */
  lastRoutineSessionId?: string;
  dismissedAt?: string;
  /**
   * Persistent cron dedup key — ISO string of the UTC minute that last fired.
   * Survives app restarts so the same cron minute cannot re-fire after reboot.
   */
  lastFiredMinuteUTC?: string;
  /**
   * Origin of this routine — the idempotency identity used by callers (e.g. a
   * plugin's "propose once" gate). Suggestion-derived routines use
   * `suggestion:<pluginId>:<intent>` (e.g.
   * `suggestion:local-indexer:nightly-rescan`); manual creation leaves it
   * unset. Capped at {@link MAX_ROUTINE_SOURCE_LENGTH} chars where accepted.
   */
  source?: string;
}

export interface AddRoutineInput {
  trigger: "shutdown" | "schedule";
  schedule?: RoutineSchedule;
  execution: RoutineExecution;
  prePrompt?: string;
  title?: string;
  notificationTitle?: string;
  notificationBody?: string;
  /**
   * Permission policy Layer 4 scope — see {@link RoutineScope}. When omitted, the
   * store fills `pluginIds: { mode: "deny-all" }` and empty defaults
   * for the rest. Callers that want active-plugin inheritance must pass
   * `{ pluginIds: { mode: "inherit" }, forcedPluginIds: [], directories: [] }`
   * explicitly so the runtime engine can snapshot the active plugin set
   * at fire time.
   */
  scope?: RoutineScope;
  /**
   * Origin marker persisted onto the created routine — see
   * {@link RoutineRecord.source}. Suggestion-derived routines use
   * `suggestion:<pluginId>:<intent>`; manual creation leaves it unset. Capped
   * at {@link MAX_ROUTINE_SOURCE_LENGTH} chars; the store rejects longer values.
   */
  source?: string;
}

/**
 * M1: explicit allowlist for the routine fired IPC payload.
 * Only these fields are sent to the renderer — no ...routine spread
 * to prevent PII from prePrompt and other fields leaking to the UI.
 */
export interface RoutineFiredPayload {
  id: string;
  trigger: "shutdown" | "schedule";
  execution: RoutineExecution;
  firedAt: string;
  title: string;
  summary: string;
  /** Present for llm-session routines so the overlay can open the routine conversation. */
  routineSessionId?: string;
}

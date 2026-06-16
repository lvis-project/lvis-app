/**
 * Shared work-board type definitions and constants — safe to import from both
 * main-process and renderer (no Node.js built-in imports).
 *
 * The main-process work-board store re-exports these as its public type
 * boundary. The renderer imports from here to avoid pulling Node.js
 * `fs/path/os/crypto` modules into the webpack renderer bundle.
 *
 * A WorkItem is a row on the personal board walking the 3-state lifecycle
 * (planned → in_progress → completed, any-to-any via transition) with an
 * optional due date. `overdue` is a derived projection — status ∈
 * {planned, in_progress} AND due_at < now — computed locally in the store.
 */

/**
 * Hard cap on persisted work items. Hitting the cap means add() throws —
 * the LLM receives a clear error and can prompt the user to complete or
 * remove old items.
 */
export const MAX_ITEMS = 200;

// ── Status & priority alphabets ─────────────────────────────────────────────

/** The 3 lifecycle states actually persisted to disk. */
export type WorkItemStatusStored = "planned" | "in_progress" | "completed";

/**
 * Stored states plus the locally-derived `overdue` projection. `overdue` is
 * never persisted — it is computed (status ∈ {planned, in_progress} AND
 * due_at < now) on every store read.
 */
export type WorkItemStatusResolved =
  | "planned"
  | "in_progress"
  | "completed"
  | "overdue";

/**
 * User-assigned priority bucket. `medium` is the default for new items.
 */
export type WorkItemPriority = "high" | "medium" | "low";

/**
 * Agent-orchestration run lifecycle for a single item, owned by the
 * {@link WorkBoardEngine} plan→approve→execute sequence. Distinct from the
 * board's 3-state lifecycle (`status`): an item can be `planned` (board status)
 * while its `runStatus` walks `planning → awaiting_approval → executing →
 * completed`. `idle` is the implicit default for items that have never been
 * run (the field is absent on disk for those — there is no fallback default,
 * consumers treat absent as "never run").
 *
 * `denied` = the user rejected (or let time out) the plan-approval modal.
 * `error` = the engine threw during plan or execute.
 */
export type WorkItemRunStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "denied"
  | "error";

// ── Work item record ────────────────────────────────────────────────────────

/**
 * Stored board row. This is the exact JSON shape persisted by the work-board
 * store. Timestamps are ISO-8601 strings. `due_at` / `completed_at` are absent
 * (omitted) when unset — there is no remote contract forcing `null`.
 */
export interface WorkItem {
  id: number;
  title: string;
  detail?: string;
  status: WorkItemStatusStored;
  priority: WorkItemPriority;
  due_at?: string;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  // ── Agent-orchestration run fields (WorkBoardEngine, P2) ──
  // All optional so existing `board.json` rows load unchanged (absent ⇒ never
  // run). These are engine-written only — they are deliberately NOT part of
  // `WorkItemUpdateInput`, so a user/LLM patch cannot forge a run result.
  /** Plan→approve→execute lifecycle. Absent ⇒ never run (treated as `idle`). */
  runStatus?: WorkItemRunStatus;
  /** Captured plan text produced by the plan-mode child agent. */
  plan?: string;
  /** Captured execution OUTPUT produced by the execute-mode child agent. */
  output?: string;
  /** The execute child's `childSessionId` — links the run to its isolated session for audit/trace. */
  runSessionId?: string;
  /** ISO-8601 instant the run fields were last written. */
  runUpdatedAt?: string;
}

/**
 * A `WorkItem` decorated with its locally-computed `status_resolved`. Returned
 * by every store read so consumers never re-derive the overdue projection.
 */
export interface WorkItemResolved extends WorkItem {
  status_resolved: WorkItemStatusResolved;
}

// ── Store / IPC payloads ────────────────────────────────────────────────────

/** Input for creating a work item. */
export interface WorkItemCreateInput {
  title: string;
  detail?: string;
  /** Omit → defaults to "medium". */
  priority?: WorkItemPriority;
  /** ISO-8601 deadline. Omit → no deadline. */
  due_at?: string;
  /** Initial stored status. Omit → "planned". */
  status?: WorkItemStatusStored;
}

/**
 * Patch for updating a work item. Every field is optional; at least one must be
 * supplied. `detail` / `due_at` set to `null` clears the field; an ISO string
 * sets it.
 */
export interface WorkItemUpdateInput {
  title?: string;
  detail?: string | null;
  due_at?: string | null;
  priority?: WorkItemPriority;
}

/** Filter for listing work items. Empty filter returns all items. */
export interface WorkItemListFilter {
  /** Match against `status_resolved` (so `"overdue"` is selectable). */
  status?: WorkItemStatusResolved;
  priority?: WorkItemPriority;
  /** Keep only items whose `due_at` is on/before this ISO instant. */
  due_before?: string;
  limit?: number;
}

// ── Result envelopes ────────────────────────────────────────────────────────
//
// Each operation maps store outcomes into a discriminated `status` envelope so
// an LLM caller can branch on the result without parsing exception messages.

export type WorkItemListResult =
  | { status: "ok"; items: WorkItemResolved[] }
  | { status: "invalid"; reason: string };

export type WorkItemCreateResult =
  | { status: "created"; itemId: number; item: WorkItemResolved }
  | { status: "invalid"; reason: string };

export type WorkItemGetResult =
  | { status: "found"; itemId: number; item: WorkItemResolved }
  | { status: "not_found"; itemId: number };

export type WorkItemUpdateResult =
  | { status: "updated"; itemId: number; item: WorkItemResolved }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

export type WorkItemTransitionResult =
  | {
      status: "transitioned";
      itemId: number;
      to: WorkItemStatusStored;
      item: WorkItemResolved;
    }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

export type WorkItemCompleteResult =
  | { status: "completed"; itemId: number; item: WorkItemResolved }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

export type WorkItemReopenResult =
  | { status: "reopened"; itemId: number; item: WorkItemResolved }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

export type WorkItemDeleteResult =
  | { status: "deleted"; itemId: number; reason?: string }
  | { status: "not_found"; itemId: number }
  | { status: "invalid"; itemId: number; reason: string };

// ── Report payloads ───────────────────────────────────────────────────────
//
// Renderer-safe wire shapes for the `WORK_BOARD.generateReport` channel. The
// host-side reporter (work-board/work-report.ts) only ever returns `ok` /
// `empty`; the IPC boundary adds the `error` variant when the underlying LLM
// call throws, so the renderer branches on exactly one discriminated shape.

export type WorkBoardReportKind = "daily" | "weekly";

export type WorkBoardReportResult =
  | { status: "ok"; kind: WorkBoardReportKind; period: string; markdown: string }
  | { status: "empty"; kind: WorkBoardReportKind; period: string; reason: string }
  | { status: "error"; kind: WorkBoardReportKind; reason: string };

// ── Bus events ──────────────────────────────────────────────────────────────

/**
 * Pre-due nudge payload emitted on the plugin event bus as
 * `work_board.work_item.due_soon`, consumed by a subscribed
 * work-item-due-soon detector. Intentionally slim (a pointer, not content):
 * the host emits it when a work item's `due_at` enters the next-24h window.
 */
export interface WorkItemDueSoonEventPayload {
  itemId: number;
  title: string;
  /** ISO instant the nudge was emitted. */
  notifiedAt: string;
}

/**
 * Slim event payload emitted whenever a WorkItem is created, updated,
 * transitioned, completed, reopened, or removed so the renderer can refresh
 * its board view without re-listing on a timer.
 */
export interface WorkItemChangedEventPayload {
  itemId: number;
  /** The operation that produced this change. */
  change:
    | "created"
    | "updated"
    | "transitioned"
    | "completed"
    | "reopened"
    | "removed";
  /** ISO-8601 timestamp the change was applied. */
  changedAt: string;
}

/**
 * Progress event streamed by the {@link WorkBoardEngine} while a single item's
 * plan→approve→execute run is in flight. Unlike {@link WorkItemChangedEventPayload}
 * (which fires on persisted board mutations), these are transient liveness
 * events so the renderer can show a per-item running indicator with the live
 * plan / output text and the current phase.
 *
 * `phase` mirrors the run lifecycle:
 *   - `planning`          — plan-mode child agent is running; `text` carries the latest turn text.
 *   - `awaiting_approval` — the plan-approval modal is shown; the run is blocked on the user.
 *   - `executing`         — execute-mode child agent is running; `text` carries the latest turn text.
 *   - `denied`            — the user rejected (or timed out) the plan approval; the run stopped.
 *   - `done`              — the run finished successfully (execute output persisted).
 *   - `error`             — the run threw; `message` carries the failure reason.
 */
export interface WorkBoardRunEvent {
  itemId: number;
  phase:
    | "planning"
    | "awaiting_approval"
    | "executing"
    | "denied"
    | "done"
    | "error";
  /** 1-based child-agent turn number (planning / executing phases). */
  turn?: number;
  /** Latest child-agent turn text (planning / executing phases). */
  text?: string;
  /** Failure reason (error phase) or denial reason (denied phase). */
  message?: string;
  /** The execute child's session id, set on the terminal `done` event. */
  runSessionId?: string;
  /** ISO-8601 timestamp the event was emitted. */
  at: string;
}

/**
 * Renderer-facing name for the run-progress wire payload. It is structurally
 * identical to {@link WorkBoardRunEvent} (the engine's per-phase event) — the
 * IPC layer forwards the engine event verbatim over {@link WORK_BOARD.runProgress},
 * so there is exactly one wire shape, not a divergent copy. The alias gives the
 * preload bridge + renderer a stable consumer-facing type name without
 * importing the engine module (which pulls Node built-ins).
 */
export type RunProgressEventPayload = WorkBoardRunEvent;

/**
 * Result envelope returned by the `WORK_BOARD.run` channel — the terminal
 * outcome of one plan→approve→execute run. Mirrors the engine's `RunItemResult`
 * but lives here so the renderer can type the `runWorkBoardItem` return without
 * importing the engine (Node-built-in-free). The IPC handler forwards the
 * engine result verbatim; `not_found` is the unknown-id outcome.
 */
export interface WorkItemRunResult {
  status: "completed" | "denied" | "not_found" | "error" | "already_running";
  /** Captured execution OUTPUT (completed). */
  output?: string;
  /** Captured plan text (completed / denied). */
  plan?: string;
  /** The execute child's session id (completed). */
  runSessionId?: string;
  /**
   * Failure / denial reason (error / denied), or the busy explanation when
   * `status === "already_running"` (a concurrent run of the same item is in
   * flight — no second sub-agent was spawned).
   */
  reason?: string;
}

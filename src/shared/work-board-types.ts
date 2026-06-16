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

/** Target status for an explicit lifecycle transition. */
export interface WorkItemTransitionInput {
  to: WorkItemStatusStored;
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

// ── Bus events ──────────────────────────────────────────────────────────────

/**
 * Plugin-bus event payload emitted when a WorkItem's `due_at` falls inside the
 * pre-due window. Consumed by proactive plugins to nudge the user before the
 * deadline. Slim pointer payload — consumers fetch full detail via the get tool.
 */
export interface WorkItemDueSoonEventPayload {
  /** WorkItem id; the lookup key for the get tool. */
  itemId: number;
  /** WorkItem title — sufficient for a user-facing toast / brain prompt. */
  title: string;
  /** ISO-8601 timestamp; lets consumers de-dupe replays against their own clock. */
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

// ── Reports ─────────────────────────────────────────────────────────────────

export type ReportKind = "daily" | "weekly";

/** Input for generating a board report. */
export interface ReportGenerateInput {
  kind: ReportKind;
  /** `YYYY-MM-DD` for daily, ISO-week (`YYYY-Www`) for weekly. Omit → now. */
  period?: string;
}

/**
 * Event payload emitted when a report is generated and persisted. `noteId` is
 * present when the report was also mirrored into the host notes store.
 */
export interface ReportGeneratedEventPayload {
  kind: ReportKind;
  /** `YYYY-MM-DD` for daily, ISO-week (`YYYY-Www`) for weekly. */
  period: string;
  noteId?: string;
  /**
   * Privacy-safe notification strings (no report body) — the host surfaces
   * these via `notificationEvents` (titleField/bodyField). Report content
   * itself is delivered through `saveNote`, never the OS notification.
   */
  title: string;
  body: string;
}

/** Result envelope for the report-generation tool. */
export type ReportGenerateResult =
  | {
      status: "generated";
      kind: ReportKind;
      period: string;
      markdown: string;
      noteId?: string;
    }
  | { status: "empty"; kind: ReportKind; period: string; reason: string };

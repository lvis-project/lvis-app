/**
 * WorkBoardStore — persistent backing for the `work-board` LLM tools and the
 * renderer board panel.
 *
 * Persists work items to `~/.lvis/work-board/board.json` with an in-process
 * async mutex (mirroring {@link RoutinesStore} `withFileLock`) so concurrent
 * add / update / transition / remove operations cannot corrupt the file. Each
 * mutation also appends one line to `activity.jsonl` in the same feature
 * directory so report generation can reconstruct the work flow.
 *
 * The store is intentionally pure persistence — it does not own a timer or emit
 * plugin-bus events. The IPC handlers (Layer 3) call these async methods,
 * translate the returned discriminated envelopes into channel responses, and
 * broadcast the `itemChanged` event to renderer windows after each successful
 * mutation so the board view stays live without polling.
 *
 * `status_resolved` (the `overdue` projection) is computed locally on every
 * read — an item is `overdue` when its stored status is `planned`/`in_progress`
 * AND its `due_at` is strictly in the past — so consumers never re-derive it.
 */
import { readFile, rename } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { createLogger } from "../lib/logger.js";
import {
  openFeatureNamespace,
  writeFileAtomicAtPath,
} from "./storage/feature-namespace.js";
import { createDirStorage, type WorkBoardStorage } from "../work-board/storage.js";
import {
  BOARD_VERSION,
  resolveStatus,
  type BoardFile,
} from "../work-board/board-shared.js";
import { appendActivity } from "../work-board/activity-log.js";

const log = createLogger("lvis");

// Re-export the shared type boundary so callers that import from work-board-store
// continue to work unchanged, while the renderer imports from shared/ (no Node
// built-ins).
export {
  MAX_ITEMS,
  type WorkItemStatusStored,
  type WorkItemStatusResolved,
  type WorkItemPriority,
  type WorkItemRunStatus,
  type WorkItem,
  type WorkItemResolved,
  type WorkItemCreateInput,
  type WorkItemUpdateInput,
  type WorkItemListFilter,
  type WorkItemListResult,
  type WorkItemCreateResult,
  type WorkItemGetResult,
  type WorkItemUpdateResult,
  type WorkItemTransitionResult,
  type WorkItemCompleteResult,
  type WorkItemReopenResult,
  type WorkItemDeleteResult,
  type WorkItemChangedEventPayload,
} from "../shared/work-board-types.js";

import {
  MAX_ITEMS,
  type WorkItem,
  type WorkItemResolved,
  type WorkItemStatusStored,
  type WorkItemPriority,
  type WorkItemRunStatus,
  type WorkItemCreateInput,
  type WorkItemUpdateInput,
  type WorkItemListFilter,
  type WorkItemListResult,
  type WorkItemCreateResult,
  type WorkItemGetResult,
  type WorkItemUpdateResult,
  type WorkItemTransitionResult,
  type WorkItemCompleteResult,
  type WorkItemReopenResult,
  type WorkItemDeleteResult,
} from "../shared/work-board-types.js";

/** Max title length (defensive bound against runaway records). */
const MAX_TITLE_LENGTH = 512;
/** Max detail length. */
const MAX_DETAIL_LENGTH = 8192;
const MAX_PROJECT_ROOT_LENGTH = 2048;
const MAX_PROJECT_NAME_LENGTH = 120;

// Resolved through the feature-namespace helper so `~/.lvis/work-board/` stays
// the single source of truth for the board file location.
const DEFAULT_PATH = join(openFeatureNamespace("work-board").dir, "board.json");

const fileLocks = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = resolve(filePath);
  const prev = fileLocks.get(key) ?? Promise.resolve();
  const next = prev.then(() => fn());
  fileLocks.set(key, next.then(() => undefined, () => undefined));
  return next;
}

const VALID_STATUSES: readonly WorkItemStatusStored[] = [
  "planned",
  "in_progress",
  "completed",
];
const VALID_PRIORITIES: readonly WorkItemPriority[] = ["high", "medium", "low"];

/** Max run-history entries kept per item (oldest evicted from the index — the
 * on-disk transcripts themselves are never deleted here). */
const RUN_HISTORY_CAP = 20;
/** Run statuses that CLOSE a run, stamping `endedAt` on its history entry. */
const TERMINAL_RUN_STATUSES: ReadonlySet<WorkItemRunStatus> = new Set([
  "completed",
  "denied",
  "error",
]);
/** Cap on the inline output preview stored in a run-history entry. */
const RUN_OUTPUT_PREVIEW_CHARS = 280;
const VALID_RUN_STATUSES: readonly WorkItemRunStatus[] = [
  "idle",
  "planning",
  "awaiting_approval",
  "executing",
  "completed",
  "denied",
  "error",
];

function isStatus(v: unknown): v is WorkItemStatusStored {
  return typeof v === "string" && VALID_STATUSES.includes(v as WorkItemStatusStored);
}
function isPriority(v: unknown): v is WorkItemPriority {
  return typeof v === "string" && VALID_PRIORITIES.includes(v as WorkItemPriority);
}
function isRunStatus(v: unknown): v is WorkItemRunStatus {
  return typeof v === "string" && VALID_RUN_STATUSES.includes(v as WorkItemRunStatus);
}

function normalizeOptionalString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, max) : undefined;
}

/**
 * Validate a record loaded from disk. Rejects tampered / corrupted entries so a
 * single bad record cannot poison a list / report read.
 */
function isValidRecord(r: unknown): r is WorkItem {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  if (typeof x.id !== "number" || !Number.isInteger(x.id) || x.id < 1) return false;
  if (typeof x.title !== "string" || x.title.length === 0) return false;
  if (x.detail !== undefined && typeof x.detail !== "string") return false;
  if (!isStatus(x.status)) return false;
  if (!isPriority(x.priority)) return false;
  if (x.due_at !== undefined && typeof x.due_at !== "string") return false;
  if (x.projectRoot !== undefined && typeof x.projectRoot !== "string") return false;
  if (x.projectName !== undefined && typeof x.projectName !== "string") return false;
  if (typeof x.created_at !== "string") return false;
  if (typeof x.updated_at !== "string") return false;
  if (x.completed_at !== undefined && typeof x.completed_at !== "string") return false;
  // Agent-orchestration run fields — all optional (absent on pre-P2 rows).
  if (x.runStatus !== undefined && !isRunStatus(x.runStatus)) return false;
  if (x.plan !== undefined && typeof x.plan !== "string") return false;
  if (x.output !== undefined && typeof x.output !== "string") return false;
  if (x.runSessionId !== undefined && typeof x.runSessionId !== "string") return false;
  if (x.runUpdatedAt !== undefined && typeof x.runUpdatedAt !== "string") return false;
  return true;
}

function emptyBoard(): BoardFile {
  return { version: BOARD_VERSION, nextId: 1, items: [] };
}

/**
 * Read + parse `board.json`. Missing file → seed empty board. Corrupt JSON →
 * back up the bad file and seed empty (so one bad write can't permanently brick
 * the board). Tampered individual records are filtered so the rest survive.
 * `nextId` is repaired to exceed every surviving id so a corrupted counter
 * cannot collide ids.
 */
async function readFileOrEmpty(filePath: string): Promise<BoardFile> {
  try {
    const raw = await readFile(filePath, "utf-8");
    let parsed: BoardFile;
    try {
      parsed = JSON.parse(raw) as BoardFile;
    } catch {
      log.warn("[work-board-store] corrupt JSON, treating as empty + backup");
      await rename(filePath, `${filePath}.corrupt-${Date.now()}.bak`);
      return emptyBoard();
    }
    if (!Array.isArray(parsed.items)) {
      return emptyBoard();
    }
    const items = parsed.items.filter(isValidRecord);
    const maxId = items.reduce((m, it) => Math.max(m, it.id), 0);
    const nextId =
      typeof parsed.nextId === "number" && Number.isInteger(parsed.nextId) && parsed.nextId > maxId
        ? parsed.nextId
        : maxId + 1;
    return {
      version: BOARD_VERSION,
      nextId,
      items,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyBoard();
    }
    throw err;
  }
}

async function writeFileAtomic(filePath: string, data: BoardFile): Promise<void> {
  // Delegates the 0o700-dir / 0o600-file / tmpfile+rename contract to the
  // feature-namespace SOT helper. The injectable `filePath` (tests pass a temp
  // path) is preserved — the helper enforces the permission boundary on
  // whatever parent directory the path resolves to.
  await writeFileAtomicAtPath(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

/** Deep clone a WorkItem so callers cannot mutate shared cache refs. */
function cloneItem(it: WorkItem): WorkItem {
  return { ...it };
}

function decorate(item: WorkItem, nowMs: number): WorkItemResolved {
  return { ...item, status_resolved: resolveStatus(item, nowMs) };
}

/**
 * Map a run lifecycle phase to its single activity-log verb. Transient
 * pre-terminal phases (planning / awaiting_approval / executing / idle) all log
 * as `run-planned` — the flow log captures that a run is underway; the terminal
 * phase rows (`run-executed` / `run-denied` / `run-failed`) carry the outcome.
 */
function runStatusActivityKind(
  runStatus: WorkItemRunStatus,
): "run-planned" | "run-executed" | "run-denied" | "run-failed" {
  switch (runStatus) {
    case "completed":
      return "run-executed";
    case "denied":
      return "run-denied";
    case "error":
      return "run-failed";
    default:
      return "run-planned";
  }
}

export class WorkBoardStore {
  private cache: BoardFile = emptyBoard();
  private loaded = false;
  private readonly filePath: string;
  /** Activity-log storage rooted in the same directory as `board.json`. */
  private readonly activity: WorkBoardStorage;
  private readonly now: () => number;

  /**
   * @param filePath absolute path to `board.json`. Defaults to the
   *   `~/.lvis/work-board/board.json` namespace path; tests inject a temp path.
   * @param now injectable clock for deterministic overdue/timestamp tests.
   */
  constructor(filePath: string = DEFAULT_PATH, now: () => number = () => Date.now()) {
    this.filePath = filePath;
    this.activity = createDirStorage(dirname(filePath));
    this.now = now;
  }

  async load(): Promise<void> {
    this.cache = await readFileOrEmpty(this.filePath);
    this.loaded = true;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  /** List items, newest-id first, with `status_resolved` computed + filter applied. */
  async list(filter: WorkItemListFilter = {}): Promise<WorkItemListResult> {
    await this.ensureLoaded();
    if (filter.limit !== undefined && (!Number.isFinite(filter.limit) || filter.limit < 0)) {
      return { status: "invalid", reason: "limit must be a non-negative number" };
    }
    const projectRoot = normalizeOptionalString(filter.projectRoot, MAX_PROJECT_ROOT_LENGTH);
    const nowMs = this.now();
    let rows = this.cache.items
      .map((item) => decorate(cloneItem(item), nowMs))
      .sort((a, b) => b.id - a.id);
    if (projectRoot) {
      rows = rows.filter((r) => r.projectRoot === projectRoot || (filter.includeUnscoped === true && !r.projectRoot));
    }
    if (filter.status) {
      rows = rows.filter((r) => r.status_resolved === filter.status);
    }
    if (filter.priority) {
      rows = rows.filter((r) => r.priority === filter.priority);
    }
    if (filter.due_before) {
      const cutoff = Date.parse(filter.due_before);
      if (Number.isNaN(cutoff)) {
        return { status: "invalid", reason: "due_before is not a valid ISO timestamp" };
      }
      rows = rows.filter(
        (r) => r.due_at !== undefined && Date.parse(r.due_at) <= cutoff,
      );
    }
    if (filter.limit !== undefined) {
      rows = rows.slice(0, filter.limit);
    }
    return { status: "ok", items: rows };
  }

  /** Fetch one item by id. */
  async get(id: number): Promise<WorkItemGetResult> {
    await this.ensureLoaded();
    const item = this.cache.items.find((i) => i.id === id);
    if (!item) return { status: "not_found", itemId: id };
    return { status: "found", itemId: id, item: decorate(cloneItem(item), this.now()) };
  }

  /** Create a new item, allocating the next id. */
  async create(input: WorkItemCreateInput): Promise<WorkItemCreateResult> {
    await this.ensureLoaded();
    const title = (input.title ?? "").trim();
    if (!title) {
      return { status: "invalid", reason: "title is required and must be non-empty" };
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return { status: "invalid", reason: `title exceeds ${MAX_TITLE_LENGTH} chars` };
    }
    if (input.detail !== undefined && input.detail.length > MAX_DETAIL_LENGTH) {
      return { status: "invalid", reason: `detail exceeds ${MAX_DETAIL_LENGTH} chars` };
    }
    if (input.status !== undefined && !isStatus(input.status)) {
      return { status: "invalid", reason: `invalid status: ${String(input.status)}` };
    }
    if (input.priority !== undefined && !isPriority(input.priority)) {
      return { status: "invalid", reason: `invalid priority: ${String(input.priority)}` };
    }
    if (input.due_at !== undefined && Number.isNaN(Date.parse(input.due_at))) {
      return { status: "invalid", reason: "due_at is not a valid ISO timestamp" };
    }
    const projectRoot = normalizeOptionalString(input.projectRoot, MAX_PROJECT_ROOT_LENGTH);
    const projectName = normalizeOptionalString(input.projectName, MAX_PROJECT_NAME_LENGTH);

    return withFileLock(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      if (board.items.length >= MAX_ITEMS) {
        return {
          status: "invalid" as const,
          reason: `item cap reached (${MAX_ITEMS}); complete or remove old items first`,
        };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const status: WorkItemStatusStored = input.status ?? "planned";
      const item: WorkItem = {
        id: board.nextId,
        title,
        ...(input.detail !== undefined ? { detail: input.detail } : {}),
        status,
        priority: input.priority ?? "medium",
        ...(input.due_at !== undefined ? { due_at: input.due_at } : {}),
        ...(projectRoot ? { projectRoot } : {}),
        ...(projectName ? { projectName } : {}),
        created_at: iso,
        updated_at: iso,
        ...(status === "completed" ? { completed_at: iso } : {}),
      };
      board.nextId += 1;
      board.items.push(item);
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: "created",
        itemId: item.id,
        title: item.title,
        ts: iso,
      });
      return {
        status: "created" as const,
        itemId: item.id,
        item: decorate(cloneItem(item), nowMs),
      };
    });
  }

  /** Apply a partial update to a single item. */
  async update(id: number, patch: WorkItemUpdateInput): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    const keys = Object.keys(patch ?? {}) as (keyof WorkItemUpdateInput)[];
    if (keys.length === 0) {
      return {
        status: "invalid",
        itemId: id,
        reason: "at least one of title / detail / due_at / priority must be provided",
      };
    }
    if (typeof patch.title === "string" && patch.title.trim().length === 0) {
      return { status: "invalid", itemId: id, reason: "title cannot be empty — omit the field instead" };
    }
    if (typeof patch.title === "string" && patch.title.trim().length > MAX_TITLE_LENGTH) {
      return { status: "invalid", itemId: id, reason: `title exceeds ${MAX_TITLE_LENGTH} chars` };
    }
    if (typeof patch.detail === "string" && patch.detail.length > MAX_DETAIL_LENGTH) {
      return { status: "invalid", itemId: id, reason: `detail exceeds ${MAX_DETAIL_LENGTH} chars` };
    }
    if (patch.priority !== undefined && !isPriority(patch.priority)) {
      return { status: "invalid", itemId: id, reason: `invalid priority: ${String(patch.priority)}` };
    }
    if (typeof patch.due_at === "string" && Number.isNaN(Date.parse(patch.due_at))) {
      return { status: "invalid", itemId: id, reason: "due_at is not a valid ISO timestamp" };
    }

    return withFileLock(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const updated: WorkItem = { ...board.items[idx] };
      if (typeof patch.title === "string") updated.title = patch.title.trim();
      if ("detail" in patch) {
        if (patch.detail === null) delete updated.detail;
        else if (patch.detail !== undefined) updated.detail = patch.detail;
      }
      if ("due_at" in patch) {
        if (patch.due_at === null) delete updated.due_at;
        else if (patch.due_at !== undefined) updated.due_at = patch.due_at;
      }
      if (patch.priority !== undefined) updated.priority = patch.priority;
      const nowMs = this.now();
      updated.updated_at = new Date(nowMs).toISOString();
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: "updated",
        itemId: updated.id,
        title: updated.title,
        ts: updated.updated_at,
      });
      return {
        status: "updated" as const,
        itemId: id,
        item: decorate(cloneItem(updated), nowMs),
      };
    });
  }

  /**
   * Move an item to `to`. Any-to-any across the three stored states.
   *
   * Exactly one activity row is written per call, INSIDE the file lock. The
   * `activityKind` parameter lets the `complete()` / `reopen()` wrappers stamp
   * their domain verb (`completed` / `reopened`) on that single row instead of
   * appending a second event out-of-lock — a logical action is one activity
   * line, and every append happens while the board lock is held.
   */
  async transition(
    id: number,
    to: WorkItemStatusStored,
    activityKind: "transitioned" | "completed" | "reopened" = "transitioned",
  ): Promise<WorkItemTransitionResult> {
    if (!isStatus(to)) {
      return { status: "invalid", itemId: id, reason: `invalid target status: ${String(to)}` };
    }
    await this.ensureLoaded();
    return withFileLock(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const from = board.items[idx].status;
      const updated: WorkItem = { ...board.items[idx], status: to, updated_at: iso };
      if (to === "completed") updated.completed_at = iso;
      else delete updated.completed_at;
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: activityKind,
        itemId: updated.id,
        title: updated.title,
        // `from`/`to` carry the status pair for the lifecycle reconstruction
        // regardless of which verb labelled the row.
        from,
        to,
        ts: iso,
      });
      return {
        status: "transitioned" as const,
        itemId: id,
        to,
        item: decorate(cloneItem(updated), nowMs),
      };
    });
  }

  /** Transition to `completed`, mapping the envelope to a complete result. */
  async complete(id: number): Promise<WorkItemCompleteResult> {
    const result = await this.transition(id, "completed", "completed");
    if (result.status === "transitioned") {
      return { status: "completed", itemId: result.itemId, item: result.item };
    }
    return result;
  }

  /** Transition back to `in_progress`, mapping the envelope to a reopen result. */
  async reopen(id: number): Promise<WorkItemReopenResult> {
    const result = await this.transition(id, "in_progress", "reopened");
    if (result.status === "transitioned") {
      return { status: "reopened", itemId: result.itemId, item: result.item };
    }
    return result;
  }

  /**
   * Set the transient run lifecycle phase for an item (planning /
   * awaiting_approval / executing / …). Engine-written only — not exposed via
   * `WorkItemUpdateInput` so a user/LLM patch cannot forge a run phase. Returns
   * `not_found` when the id is unknown (no fallback creation). Writes one
   * activity row whose verb matches the phase so the flow log reconstructs the
   * run without re-deriving it.
   */
  async setRunStatus(
    id: number,
    runStatus: WorkItemRunStatus,
  ): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    return withFileLock(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const updated: WorkItem = {
        ...board.items[idx],
        runStatus,
        runUpdatedAt: iso,
      };
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: runStatusActivityKind(runStatus),
        itemId: updated.id,
        title: updated.title,
        to: runStatus,
        ts: iso,
      });
      return {
        status: "updated" as const,
        itemId: id,
        item: decorate(cloneItem(updated), nowMs),
      };
    });
  }

  /**
   * Open a NEW run for an item (the engine calls this at run start instead of
   * clearing the prior result). Appends a fresh entry to `runHistory` (newest
   * last, capped) keyed by `runId`, points the item at that `runId`, sets
   * `runStatus="planning"`, and resets the latest plan/output/runSessionId for a
   * clean slate. The prior run's history entry AND its on-disk transcript are
   * left intact — re-running NEVER overwrites prior work (the user's continuity
   * requirement). Returns `not_found` for an unknown id.
   */
  async beginRun(id: number, runId: string, startedAt: string): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    return withFileLock(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const prior = board.items[idx];
      const history = [
        ...(prior.runHistory ?? []),
        { runId, startedAt, status: "planning" as WorkItemRunStatus },
      ];
      const capped =
        history.length > RUN_HISTORY_CAP ? history.slice(history.length - RUN_HISTORY_CAP) : history;
      const updated: WorkItem = {
        ...prior,
        runStatus: "planning",
        runId,
        runUpdatedAt: startedAt,
        runHistory: capped,
      };
      delete updated.plan;
      delete updated.output;
      delete updated.runSessionId;
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: "run-planned",
        itemId: id,
        title: updated.title,
        to: "planning",
        ts: startedAt,
      });
      return {
        status: "updated" as const,
        itemId: id,
        item: decorate(cloneItem(updated), Date.parse(startedAt)),
      };
    });
  }

  /**
   * Reconcile runs interrupted by a process exit. A run lives only in memory, so
   * ANY item persisted in an active run phase (planning / awaiting_approval /
   * executing) at boot belongs to a run that can no longer be in flight — its
   * process is gone. Mark each `error` (and close its open history entry) so the
   * item is re-runnable again (P2's runItem guard rejects active runStatus as
   * `already_running`) and the card stops showing a permanent "running" badge.
   * Called once at boot after load(). Returns the number of items reset.
   */
  async reconcileInterruptedRuns(): Promise<number> {
    await this.ensureLoaded();
    return withFileLock(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const iso = new Date(this.now()).toISOString();
      let count = 0;
      for (let i = 0; i < board.items.length; i++) {
        const it = board.items[i];
        if (
          it.runStatus === "planning" ||
          it.runStatus === "awaiting_approval" ||
          it.runStatus === "executing"
        ) {
          const updated: WorkItem = { ...it, runStatus: "error", runUpdatedAt: iso };
          if (it.runId && Array.isArray(it.runHistory)) {
            updated.runHistory = it.runHistory.map((h) =>
              h.runId === it.runId && h.endedAt === undefined
                ? { ...h, status: "error" as WorkItemRunStatus, endedAt: iso }
                : h,
            );
          }
          board.items[i] = updated;
          count += 1;
        }
      }
      if (count > 0) {
        await writeFileAtomic(this.filePath, board);
      }
      this.cache = board;
      if (count > 0) log.info("[work-board-store] reconciled %d interrupted run(s) → error", count);
      return count;
    });
  }

  /**
   * Persist the terminal result of a run — the captured plan, the captured
   * execution output, the linking run session id, and the final run status.
   * Engine-written only. One activity row (`run-executed` for the completed
   * path) records the outcome. Returns `not_found` for an unknown id.
   *
   * Field semantics mirror {@link update}'s null-clears-field convention:
   *   - `undefined` (or omitted) → leave the existing value untouched
   *   - `null`                   → delete the key (clear it)
   *   - a value                  → set it
   * The clear path is what lets the engine RESET stale plan/output/runSessionId
   * at run START (transition to `planning`): without it the conditional-spread
   * `set`-only path would leave a prior run's success output on a record that
   * is now being denied or erroring, showing a green output on a failed run.
   */
  async setRunResult(
    id: number,
    result: {
      runStatus: WorkItemRunStatus;
      plan?: string | null;
      output?: string | null;
      runSessionId?: string | null;
    },
  ): Promise<WorkItemUpdateResult> {
    await this.ensureLoaded();
    return withFileLock(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const idx = board.items.findIndex((i) => i.id === id);
      if (idx === -1) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      const nowMs = this.now();
      const iso = new Date(nowMs).toISOString();
      const updated: WorkItem = {
        ...board.items[idx],
        runStatus: result.runStatus,
        runUpdatedAt: iso,
      };
      // null → clear the key; a string → set it; undefined → leave as-is.
      if (result.plan === null) delete updated.plan;
      else if (result.plan !== undefined) updated.plan = result.plan;
      if (result.output === null) delete updated.output;
      else if (result.output !== undefined) updated.output = result.output;
      if (result.runSessionId === null) delete updated.runSessionId;
      else if (result.runSessionId !== undefined) updated.runSessionId = result.runSessionId;
      // Keep the CURRENT run's history entry (matched by runId) in sync, so the
      // re-run history index reflects each run's final status/plan/output —
      // without a separate write path. `endedAt` is stamped on terminal status.
      if (updated.runId && Array.isArray(updated.runHistory)) {
        updated.runHistory = updated.runHistory.map((h) =>
          h.runId === updated.runId
            ? {
                ...h,
                status: result.runStatus,
                ...(typeof updated.plan === "string" ? { plan: updated.plan } : {}),
                ...(typeof updated.output === "string"
                  ? { outputPreview: updated.output.slice(0, RUN_OUTPUT_PREVIEW_CHARS) }
                  : {}),
                ...(TERMINAL_RUN_STATUSES.has(result.runStatus) ? { endedAt: iso } : {}),
              }
            : h,
        );
      }
      board.items[idx] = updated;
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: runStatusActivityKind(result.runStatus),
        itemId: updated.id,
        title: updated.title,
        to: result.runStatus,
        ts: iso,
      });
      return {
        status: "updated" as const,
        itemId: id,
        item: decorate(cloneItem(updated), nowMs),
      };
    });
  }

  /** Remove an item. */
  async remove(id: number): Promise<WorkItemDeleteResult> {
    await this.ensureLoaded();
    return withFileLock(this.filePath, async () => {
      const board = await readFileOrEmpty(this.filePath);
      const item = board.items.find((i) => i.id === id);
      if (!item) {
        this.cache = board;
        return { status: "not_found" as const, itemId: id };
      }
      board.items = board.items.filter((i) => i.id !== id);
      await writeFileAtomic(this.filePath, board);
      this.cache = board;
      await appendActivity(this.activity, {
        kind: "deleted",
        itemId: id,
        title: item.title,
        ts: new Date(this.now()).toISOString(),
      });
      return { status: "deleted" as const, itemId: id };
    });
  }
}

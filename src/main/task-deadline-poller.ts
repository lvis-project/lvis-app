/**
 * TaskDeadlinePoller — periodic detector for approaching task deadlines.
 *
 * Polls the host's TaskService for pending tasks whose `dueAt` falls within
 * a configurable window (default 2h). For each task that crosses the
 * threshold, emits `task.deadline.approaching` on the host event bus so
 * brain plugins (work-proactive etc.) can subscribe via `pluginAccess.events`
 * and decide whether to fire `triggerConversation()`.
 *
 * Observer/judge separation:
 *   - This poller is the **observer**: data-source proximity + raw event emit.
 *     No judgment about whether the user should be interrupted lives here.
 *   - The **judge** lives in a brain plugin — sees the event, weighs context
 *     (user idle? in meeting? recently dismissed?), and decides.
 *
 * Mirrors the calendar/email pattern (data-source plugin emits, brain
 * subscribes). Tasks happen to live in the host (split paused — see
 * memory `feedback-tasks-plugin-split-paused`), so the observer lives here
 * instead of inside a plugin. The wire shape (event name + payload) is
 * what brain code actually sees, so this seam is invisible to consumers.
 *
 * Dedupe: a per-task (id + dueAt) cooldown suppresses re-emission within
 * `COOLDOWN_MS`. Brain still has its own cross-pluggin TriggerConversation
 * dedupe upstream; this layer just keeps the bus from spamming when many
 * polling ticks see the same task.
 *
 * Cooldown semantics — re-firing IS desired: if brain decides "now is a bad
 * time" on the first emit, the next cooldown window gives it another chance
 * before the dueAt elapses. Once-only would mean "miss the boat, never
 * reconsider".
 */
import type { TaskService, Task } from "../taskService.js";

export interface TaskDeadlineApproachingPayload {
  taskId: string;
  title: string;
  /** ISO 8601 — task's stored dueAt, copied verbatim. */
  dueAt: string;
  source: string;
  priority: Task["priority"];
  /** Optional task description, copied verbatim if present. */
  description?: string;
  /** Milliseconds remaining until dueAt at fire time. May be negative when past-due. */
  msUntilDeadline: number;
}

export type TaskDeadlineApproachingHandler = (
  event: TaskDeadlineApproachingPayload,
) => void;

/** Default polling cadence — 60s. Tasks aren't latency-sensitive at sub-minute. */
const DEFAULT_POLL_INTERVAL_MS = 60_000;
/** Default warning window — emit when dueAt is within this many ms of `now`. */
const DEFAULT_WINDOW_MS = 2 * 60 * 60_000; // 2h
/** Default cooldown — re-emit at most once per (taskId, dueAt) per this interval. */
const DEFAULT_COOLDOWN_MS = 30 * 60_000; // 30m
/** Cap on dedupe map so a long-running session can't grow unbounded. */
const DEDUPE_MAX_ENTRIES = 256;

interface DedupeKey {
  taskId: string;
  dueAt: string;
}

function dedupeKeyOf(k: DedupeKey): string {
  return `${k.taskId}::${k.dueAt}`;
}

export interface TaskDeadlinePollerOptions {
  /** Polling interval in ms. Default 60s. */
  pollIntervalMs?: number;
  /** Warning window in ms (dueAt - now ≤ window → emit). Default 2h. */
  windowMs?: number;
  /** Re-emission cooldown per (taskId, dueAt) in ms. Default 30m. */
  cooldownMs?: number;
  /** Override `Date.now` for tests. */
  now?: () => number;
}

export class TaskDeadlinePoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly handlers = new Set<TaskDeadlineApproachingHandler>();
  /**
   * LRU dedupe — Map iterates in insertion order, so refreshing an existing
   * key's entry (delete-then-set) keeps it from being evicted as "oldest".
   */
  private readonly recentlyFired = new Map<string, number>();
  private inFlight = false;

  private readonly pollIntervalMs: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(
    private readonly taskService: TaskService,
    options: TaskDeadlinePollerOptions = {},
  ) {
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      try {
        this.checkAndFire();
      } finally {
        this.inFlight = false;
      }
    }, this.pollIntervalMs);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
    // Run once immediately so an approaching task at boot fires without
    // waiting for the first interval tick (mirrors RemindersScheduler).
    if (!this.inFlight) {
      this.inFlight = true;
      try {
        this.checkAndFire();
      } finally {
        this.inFlight = false;
      }
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Subscribe; returns unsubscribe disposer. */
  onApproaching(handler: TaskDeadlineApproachingHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Visible for tests — invoke a single polling pass synchronously.
   * Production code should not call this; use `start()` + the timer.
   */
  checkAndFire(): void {
    const nowMs = this.now();
    const cutoffIso = new Date(nowMs + this.windowMs).toISOString();
    let pending: Task[];
    try {
      pending = this.taskService.query({
        status: "pending",
        dueBefore: cutoffIso,
      });
    } catch (err) {
      console.warn(
        "[task-deadline-poller] query failed:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    for (const task of pending) {
      if (!task.dueAt) continue;
      const dueMs = new Date(task.dueAt).getTime();
      if (!Number.isFinite(dueMs)) continue;
      const key = dedupeKeyOf({ taskId: task.id, dueAt: task.dueAt });
      const lastFired = this.recentlyFired.get(key);
      if (lastFired !== undefined && nowMs - lastFired < this.cooldownMs) {
        continue;
      }
      this.recordFired(key, nowMs);
      const payload: TaskDeadlineApproachingPayload = {
        taskId: task.id,
        title: task.title,
        dueAt: task.dueAt,
        source: task.source,
        priority: task.priority,
        msUntilDeadline: dueMs - nowMs,
        ...(task.description !== undefined ? { description: task.description } : {}),
      };
      for (const h of this.handlers) {
        try {
          h(payload);
        } catch (err) {
          console.warn(
            "[task-deadline-poller] handler threw:",
            err instanceof Error ? err.message : String(err),
          );
        }
      }
    }
  }

  /**
   * True LRU refresh — Map#set on an existing key leaves the original
   * insertion position, which would let a frequently re-fired key evict
   * older keys instead of itself when capping. Delete-then-set fixes that.
   */
  private recordFired(key: string, atMs: number): void {
    if (this.recentlyFired.has(key)) this.recentlyFired.delete(key);
    this.recentlyFired.set(key, atMs);
    if (this.recentlyFired.size > DEDUPE_MAX_ENTRIES) {
      const oldestKey = this.recentlyFired.keys().next().value;
      if (oldestKey !== undefined) this.recentlyFired.delete(oldestKey);
    }
  }
}

/**
 * RoutinesScheduler — polls the {@link RoutinesStore} every 30s and fires
 * execution events when a routine's next-fire time has been reached.
 *
 * Execution mode branch:
 *   - "llm-session"       → calls onLlmSession handler (starts a ConversationLoop turn)
 *   - "notification-only" → calls onNotification handler (fires OS notification)
 *
 * For cron-expression routines, next-fire is evaluated via cron-evaluator.ts
 * using the current wall-clock time at each tick rather than advancing a stored
 * `at` field (cron semantics). A per-routine per-minute dedup key prevents
 * double-firing within the same minute window.
 */
import type { RoutinesStore, RoutineRecord } from "./routines-store.js";
import { matchesCron } from "../routines/cron-evaluator.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export interface RoutineFiredEvent {
  routine: RoutineRecord;
}

export type LlmSessionHandler = (event: RoutineFiredEvent) => void;
export type NotificationHandler = (event: RoutineFiredEvent) => void;

const POLL_INTERVAL_MS = 30_000;

/**
 * Build a UTC ISO minute string used as a persistent dedup key for cron routines.
 * Format: "YYYY-MM-DDTHH:MMZ" (always UTC, no seconds).
 */
function minuteKeyUTC(now: Date): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes()),
  ).toISOString().slice(0, 16) + "Z";
}

export class RoutinesScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly llmHandlers = new Set<LlmSessionHandler>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  /** M1: reentrancy guard — skip tick if previous check is still running. */
  private inFlight = false;

  constructor(private readonly store: RoutinesStore) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = true;
      void this.checkAndFire().finally(() => {
        this.inFlight = false;
      });
    }, POLL_INTERVAL_MS);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
    // Run once immediately so routines past-due at boot fire without delay.
    if (!this.inFlight) {
      this.inFlight = true;
      void this.checkAndFire().finally(() => {
        this.inFlight = false;
      });
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onLlmSession(handler: LlmSessionHandler): () => void {
    this.llmHandlers.add(handler);
    return () => this.llmHandlers.delete(handler);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  /**
   * Visible for tests — invoke a single polling pass to verify firing behaviour
   * without waiting for the 30s interval.
   */
  async checkAndFire(): Promise<void> {
    const now = new Date();
    const active = this.store.listActive();
    for (const routine of active) {
      try {
        const due = this.isDue(routine, now);
        if (!due) continue;
        if (routine.schedule?.repeat?.kind === "cron") {
          // Persist the dedup key before firing so that a crash/restart mid-dispatch
          // does not re-fire in the same minute.
          const currentMinuteUTC = minuteKeyUTC(now);
          await this.store.update(routine.id, { lastFiredMinuteUTC: currentMinuteUTC });
        }
        const updated = await this.store.markFired(routine.id);
        if (!updated) continue;
        this.dispatch(updated);
      } catch (err) {
        // One bad routine must not stall all remaining routines in this tick.
        log.warn("routine tick error (id=%s): %s", routine.id, (err as Error).message);
      }
    }
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private isDue(routine: RoutineRecord, now: Date): boolean {
    const schedule = routine.schedule;
    if (!schedule) return false;

    const repeat = schedule.repeat;

    // Cron expression: match current minute using persistent dedup key.
    if (repeat?.kind === "cron") {
      const currentMinuteUTC = minuteKeyUTC(now);
      // Persistent dedup: skip if this minute was already fired (survives restarts).
      if (routine.lastFiredMinuteUTC === currentMinuteUTC) return false;
      return matchesCron(repeat.expression, now);
    }

    // All other kinds: compare next-fire `at` vs now.
    if (!schedule.at) return false;
    const at = new Date(schedule.at).getTime();
    return Number.isFinite(at) && at <= now.getTime();
  }

  /**
   * Publicly dispatch a single routine through its execution-mode handlers,
   * updating persistence (markFired) so lastFiredAt and dedup keys are written.
   * Used by the IPC `trigger-now` handler so manual triggers go through the
   * same code path as scheduled fires — persistence + fired event included.
   */
  async dispatchNow(routineId: string): Promise<boolean> {
    const active = this.store.listActive();
    const routine = active.find((r) => r.id === routineId);
    if (!routine) return false;
    const updated = await this.store.markFired(routine.id);
    if (!updated) return false;
    this.dispatch(updated);
    return true;
  }

  private dispatch(routine: RoutineRecord): void {
    const event: RoutineFiredEvent = { routine };
    const handlers =
      routine.execution === "llm-session" ? this.llmHandlers : this.notificationHandlers;
    for (const h of handlers) {
      try {
        h(event);
      } catch (err) {
        log.warn("routine handler threw: %s", (err as Error).message);
      }
    }
  }
}

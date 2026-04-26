/**
 * RemindersScheduler — polls the {@link RemindersStore} every 30s and
 * fires `lvis:reminder:fired` IPC events when a reminder's `at` time has
 * been reached. Persistent — loads on construction so reminders set in
 * a previous session survive restart.
 */
import type { RemindersStore, ReminderRecord } from "./reminders-store.js";

export interface ReminderFiredEvent {
  reminder: ReminderRecord;
}

export type ReminderFiredHandler = (event: ReminderFiredEvent) => void;

const POLL_INTERVAL_MS = 30_000;

export class RemindersScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly handlers = new Set<ReminderFiredHandler>();

  constructor(private readonly store: RemindersStore) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.checkAndFire();
    }, POLL_INTERVAL_MS);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
    // Run once immediately so reminders past-due at boot fire without delay.
    void this.checkAndFire();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  onFired(handler: ReminderFiredHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  /**
   * Visible for tests — invoke a single polling pass synchronously to
   * verify firing behaviour without waiting for the 30s interval.
   */
  async checkAndFire(): Promise<void> {
    const now = Date.now();
    const due = this.store.listActive().filter((r) => {
      const at = new Date(r.at).getTime();
      return Number.isFinite(at) && at <= now;
    });
    for (const reminder of due) {
      const updated = await this.store.markFired(reminder.id);
      if (!updated) continue;
      for (const h of this.handlers) {
        try {
          h({ reminder: updated });
        } catch (err) {
          console.warn("[lvis] reminder handler threw:", (err as Error).message);
        }
      }
    }
  }
}

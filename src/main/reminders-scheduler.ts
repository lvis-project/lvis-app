/**
 * RemindersScheduler — polls the {@link RemindersStore} every 30s and
 * fires `lvis:reminder:fired` IPC events when a reminder's `at` time has
 * been reached. Persistent — loads on construction so reminders set in
 * a previous session survive restart.
 */
import type { RemindersStore, ReminderRecord } from "./reminders-store.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

export interface ReminderFiredEvent {
  reminder: ReminderRecord;
}

export type ReminderFiredHandler = (event: ReminderFiredEvent) => void;

const POLL_INTERVAL_MS = 30_000;

export class RemindersScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly handlers = new Set<ReminderFiredHandler>();
  /**
   * M1: reentrancy guard. If a `checkAndFire()` invocation is still
   * running when the next interval tick arrives, we skip the new tick.
   * Without this, slow `markFired` writes (file lock contention, network
   * filesystem latency) could overlap and re-fire the same reminder.
   */
  private inFlight = false;

  constructor(private readonly store: RemindersStore) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return; // M1: skip overlapping ticks
      this.inFlight = true;
      void this.checkAndFire().finally(() => {
        this.inFlight = false;
      });
    }, POLL_INTERVAL_MS);
    if (typeof (this.timer as { unref?: () => void }).unref === "function") {
      (this.timer as { unref: () => void }).unref();
    }
    // Run once immediately so reminders past-due at boot fire without delay.
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
          log.warn("reminder handler threw: %s", (err as Error).message);
        }
      }
    }
  }
}

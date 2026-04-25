/**
 * RoutineIdleSignaler — OS-level idle entry/exit detector for wakeup &
 * shutdown routines.
 *
 * Distinct from src/main/idle-scheduler.ts (which gates background indexing
 * with a short 60s threshold). This signaler models *user presence* with a
 * longer threshold (default 10 min) so brief lock-screen / lunch-break noise
 * does not fire routines.
 *
 * Signals
 *   - "idle-long-entry"  → emitted when sustained user-idle reaches threshold
 *                         (drives shutdown routine: "user just left desk")
 *   - "idle-long-exit"   → emitted when user returns after ≥ threshold idle
 *                         (drives wakeup routine: "user just arrived back")
 *
 * Sources (any of which can flip presence state):
 *   - powerMonitor "lock-screen"   → lock event; hold start time
 *   - powerMonitor "unlock-screen" → unlock event; if (now-lockStart) ≥ threshold,
 *                                   emit idle-long-exit
 *   - powerMonitor "suspend"       → treated as lock (sleep)
 *   - powerMonitor "resume"        → treated as unlock; same threshold check
 *   - tick polling (every pollMs)  → uses powerMonitor.getSystemIdleTime() to
 *                                   detect long idle without a lock event
 *                                   (e.g., user walked away without locking)
 *
 * Each emission is followed by a perEventCooldownMs window so a noisy OS
 * (rapid lock-unlock-lock cycles) cannot flood downstream routines.
 *
 * The signaler is purely a presence detector; it does not run routines or
 * touch settings. boot wires its events to the RoutineEngine.
 *
 * Testability
 *   - powerMonitor is `PowerMonitorLike` — inject FakePowerMonitor in tests
 *   - clock is `now()` — inject vi.useFakeTimers compatible clock
 *   - timers are `setIntervalLike`/`clearIntervalLike` — default Node, override
 *     for test
 */

import type { PowerMonitorLike } from "../main/idle-scheduler.js";

export type IdleSignalEvent = "idle-long-entry" | "idle-long-exit";

export interface IdleSignalListener {
  (event: IdleSignalEvent, reason: string): void;
}

export interface RoutineIdleSignalerDeps {
  /** Electron powerMonitor (or test fake). */
  powerMonitor: PowerMonitorLike;
  /** Long-idle threshold getter. Read at decision time so settings changes apply live. */
  getLongIdleThresholdMs: () => number;
  /** Polling interval in ms for getSystemIdleTime check. Default 30_000. */
  pollIntervalMs?: number;
  /** Per-event cooldown to suppress flapping. Default 60_000 (1 min). */
  perEventCooldownMs?: number;
  /** Test override. */
  now?: () => number;
  /** Test override for setInterval. */
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  /** Test override for clearInterval. */
  clearIntervalImpl?: (handle: unknown) => void;
  /** Logger hook (default console.log). */
  logger?: (msg: string) => void;
  /** Kill switch override. Default reads DISABLE_ROUTINE_IDLE_SIGNALER env var. */
  disabled?: () => boolean;
}

/** Internal presence state. */
type Presence = "active" | "idle-long";

export class RoutineIdleSignaler {
  private listeners: IdleSignalListener[] = [];
  private presence: Presence = "active";
  /** Wall-clock time the current idle window started, or null if none. */
  private idleStartedAt: number | null = null;
  /** Last `lock-screen` timestamp; reset by `unlock-screen`. */
  private lockedAt: number | null = null;
  /** Last `suspend` timestamp; reset by `resume`. */
  private suspendedAt: number | null = null;
  /** Last emit per event (for cooldown). */
  private readonly lastEmittedAt: Record<IdleSignalEvent, number> = {
    "idle-long-entry": 0,
    "idle-long-exit": 0,
  };

  private pollTimer: unknown | null = null;
  private subscribed = false;
  private readonly powerListeners: Array<{ event: string; handler: (...args: unknown[]) => void }> = [];

  private readonly pollIntervalMs: number;
  private readonly perEventCooldownMs: number;
  private readonly now: () => number;
  private readonly setIntervalImpl: (cb: () => void, ms: number) => unknown;
  private readonly clearIntervalImpl: (handle: unknown) => void;
  private readonly logger: (msg: string) => void;
  private readonly disabled: () => boolean;

  constructor(private readonly deps: RoutineIdleSignalerDeps) {
    this.pollIntervalMs = deps.pollIntervalMs ?? 30_000;
    this.perEventCooldownMs = deps.perEventCooldownMs ?? 60_000;
    this.now = deps.now ?? (() => Date.now());
    this.setIntervalImpl =
      deps.setIntervalImpl ?? ((cb, ms) => setInterval(cb, ms));
    this.clearIntervalImpl =
      deps.clearIntervalImpl ?? ((handle) => clearInterval(handle as NodeJS.Timeout));
    this.logger = deps.logger ?? ((m) => console.log(m));
    this.disabled = deps.disabled ?? (() => process.env.DISABLE_ROUTINE_IDLE_SIGNALER === "1");
  }

  start(): void {
    if (this.subscribed) return;
    if (this.disabled()) {
      this.logger("[routine-idle-signaler] disabled via DISABLE_ROUTINE_IDLE_SIGNALER");
      return;
    }
    const pm = this.deps.powerMonitor;
    this.subscribePm(pm, "lock-screen", () => this.onLock());
    this.subscribePm(pm, "unlock-screen", () => this.onUnlock());
    this.subscribePm(pm, "suspend", () => this.onSuspend());
    this.subscribePm(pm, "resume", () => this.onResume());
    this.subscribed = true;

    const handle = this.setIntervalImpl(() => {
      try {
        this.tick();
      } catch (e) {
        this.logger(`[routine-idle-signaler] tick failed: ${(e as Error).message}`);
      }
    }, this.pollIntervalMs);
    // Best-effort: Node Timeout supports unref(); test fakes may not.
    if (handle && typeof (handle as { unref?: () => void }).unref === "function") {
      (handle as { unref: () => void }).unref();
    }
    this.pollTimer = handle;
  }

  stop(): void {
    if (this.pollTimer) {
      this.clearIntervalImpl(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.subscribed) {
      // Detach our listeners only — don't blow away other subscribers on the
      // shared Electron powerMonitor instance.
      const pm = this.deps.powerMonitor;
      for (const { event, handler } of this.powerListeners) {
        const off = (pm as { off?: (e: string, h: (...a: unknown[]) => void) => void }).off;
        if (typeof off === "function") {
          off.call(pm, event, handler);
        }
      }
      this.powerListeners.length = 0;
      this.subscribed = false;
    }
  }

  on(listener: IdleSignalListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Public for tests — drives a single tick. */
  _testTick(): void {
    this.tick();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private subscribePm(pm: PowerMonitorLike, event: string, handler: () => void): void {
    try {
      pm.on(event, handler);
      this.powerListeners.push({ event, handler });
    } catch (e) {
      // Linux Electron may not support all events. Non-fatal — tick polling
      // still gives us coverage via getSystemIdleTime().
      this.logger(`[routine-idle-signaler] pm.on('${event}') unavailable: ${(e as Error).message}`);
    }
  }

  private onLock(): void {
    this.lockedAt = this.now();
    // A lock event is itself a strong "user left" signal; promote to idle-long
    // immediately if we are not already there. Threshold filtering is applied
    // on the *exit* path so a brief lock-unlock cycle does not fire wakeup,
    // but the entry event is meaningful as "shutdown trigger" only when the
    // user stays away — so we still gate entry by threshold via tick logic.
    // The tick will pick this up using getSystemIdleTime.
  }

  private onUnlock(): void {
    const lockedAt = this.lockedAt;
    this.lockedAt = null;
    if (lockedAt == null) return;
    const idleMs = this.now() - lockedAt;
    if (idleMs >= this.deps.getLongIdleThresholdMs()) {
      this.transition("active", `unlock-after-${Math.round(idleMs / 1000)}s`);
    }
  }

  private onSuspend(): void {
    this.suspendedAt = this.now();
    // Treat as lock — tick will eventually elevate to idle-long.
  }

  private onResume(): void {
    const suspendedAt = this.suspendedAt;
    this.suspendedAt = null;
    if (suspendedAt == null) return;
    const idleMs = this.now() - suspendedAt;
    if (idleMs >= this.deps.getLongIdleThresholdMs()) {
      this.transition("active", `resume-after-${Math.round(idleMs / 1000)}s`);
    }
  }

  private tick(): void {
    const idleSec = this.deps.powerMonitor.getSystemIdleTime();
    const idleMs = idleSec * 1000;
    const threshold = this.deps.getLongIdleThresholdMs();
    if (idleMs >= threshold) {
      this.transition("idle-long", `tick-idle-${Math.round(idleSec)}s`);
    } else {
      this.transition("active", `tick-active-idle-${Math.round(idleSec)}s`);
    }
  }

  private transition(target: Presence, reason: string): void {
    if (target === this.presence) return;
    const prev = this.presence;
    this.presence = target;
    if (target === "idle-long") {
      this.idleStartedAt = this.now();
      this.emit("idle-long-entry", reason);
    } else {
      // active
      this.idleStartedAt = null;
      // Only emit exit if we came from idle-long. Initial state already starts
      // as "active", so the first tick won't emit a spurious exit.
      if (prev === "idle-long") {
        this.emit("idle-long-exit", reason);
      }
    }
  }

  private emit(event: IdleSignalEvent, reason: string): void {
    const now = this.now();
    if (now - this.lastEmittedAt[event] < this.perEventCooldownMs) {
      this.logger(`[routine-idle-signaler] suppressed ${event} (cooldown, reason=${reason})`);
      return;
    }
    this.lastEmittedAt[event] = now;
    this.logger(`[routine-idle-signaler] emit ${event} (reason=${reason})`);
    for (const listener of this.listeners) {
      try {
        listener(event, reason);
      } catch (e) {
        this.logger(`[routine-idle-signaler] listener threw: ${(e as Error).message}`);
      }
    }
  }
}

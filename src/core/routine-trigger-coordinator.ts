/**
 * Sprint 3-A-2 — RoutineTriggerCoordinator (§7 condition-based heartbeat).
 *
 * Evaluates multiple signals (idle, schedule, calendar meeting, task deadline)
 * on a 60s tick + explicit event pokes, and fires `generateDailyBriefing` when
 * any signal returns {fire:true}. Subject to a 30min debounce (in addition to
 * the engine's own once-per-day / recently-dismissed gates).
 *
 * Plugin-id hardcoding is forbidden — calendar lookup uses
 * `findMethodByCapability("calendar-source", ...)`. Kill-switch:
 * `DISABLE_ROUTINE_COORDINATOR=1` (legacy `DISABLE_PROACTIVE_COORDINATOR=1` also supported).
 */

import type { RoutineEngine } from "./routine-engine.js";

export interface SignalResult {
  fire: boolean;
  reason: string;
}

export type SignalEvaluator = (now: Date) => SignalResult | null | Promise<SignalResult | null>;

export interface CoordinatorDeps {
  routineEngine?: RoutineEngine;
  /** @deprecated compatibility alias for older callers. */
  proactiveEngine?: RoutineEngine;
  evaluators: Array<{ name: string; evaluate: SignalEvaluator }>;
  /** default 60_000 */
  tickIntervalMs?: number;
  /** default 30 * 60_000 */
  debounceMs?: number;
  /** test override */
  now?: () => Date;
  logger?: (msg: string) => void;
  /** test override (default: process.env.DISABLE_ROUTINE_COORDINATOR === "1" || process.env.DISABLE_PROACTIVE_COORDINATOR === "1") */
  disabled?: () => boolean;
}

export class RoutineTriggerCoordinator {
  private timer: NodeJS.Timeout | null = null;
  /** Shared across ALL signals — prevents double-briefing race (Issue 3). */
  private lastFiredAt = 0;
  private running = false;
  private readonly tickIntervalMs: number;
  private readonly debounceMs: number;
  private readonly now: () => Date;
  private readonly logger: (msg: string) => void;
  private readonly disabled: () => boolean;

  constructor(private readonly deps: CoordinatorDeps) {
    this.tickIntervalMs = deps.tickIntervalMs ?? 60_000;
    this.debounceMs = deps.debounceMs ?? 30 * 60_000;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? ((m) => console.log(m));
    this.disabled = deps.disabled ?? (() => process.env.DISABLE_ROUTINE_COORDINATOR === "1" || process.env.DISABLE_PROACTIVE_COORDINATOR === "1");
  }

  start(): void {
    if (this.timer) return;
    if (this.disabled()) {
      this.logger("[routine-coordinator] disabled via DISABLE_ROUTINE_COORDINATOR / DISABLE_PROACTIVE_COORDINATOR");
      return;
    }
    this.timer = setInterval(() => {
      void this.evaluateAll("tick").catch((e: Error) =>
        this.logger(`[routine-coordinator] tick failed: ${e.message}`),
      );
    }, this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** External event poke — idle state change, new task, new meeting, etc. */
  notify(event: string): void {
    if (this.disabled()) return;
    void this.evaluateAll(`event:${event}`).catch((e: Error) =>
      this.logger(`[routine-coordinator] notify(${event}) failed: ${e.message}`),
    );
  }

  /**
   * Issue 3 fix: shared global cooldown check for external callers (e.g. the
   * IDLE_SCAN composite listener in boot.ts). Returns true when a briefing has
   * fired within `windowMs` milliseconds. Default matches coordinator debounce.
   */
  isWithinGlobalCooldown(windowMs = this.debounceMs): boolean {
    return Date.now() - this.lastFiredAt < windowMs;
  }

  /** Test hook. */
  async _testEvaluate(source = "test"): Promise<SignalResult | null> {
    return this.evaluateAll(source);
  }

  private async evaluateAll(source: string): Promise<SignalResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const nowDate = this.now();
      // debounce
      if (nowDate.getTime() - this.lastFiredAt < this.debounceMs) {
        return null;
      }

      for (const { name, evaluate } of this.deps.evaluators) {
        let result: SignalResult | null;
        try {
          result = await evaluate(nowDate);
        } catch (e) {
          this.logger(`[routine-coordinator] ${name} threw: ${(e as Error).message}`);
          continue;
        }
        if (result && result.fire) {
          this.lastFiredAt = nowDate.getTime();
          this.logger(`[routine-coordinator] fire via ${name} (${result.reason}, src=${source})`);
          const idleState = name === "idleSignal" ? "long_idle" : "triggered";
          try {
            const engine = this.deps.routineEngine ?? this.deps.proactiveEngine;
            if (!engine) {
              this.logger("[routine-coordinator] skipped: no routine engine configured");
              return null;
            }
            const r = await engine.generateDailyBriefing({
              idleState,
              triggerReason: `${name}:${result.reason}`,
              now: nowDate,
            });
            this.logger(
              r.status === "generated"
                ? `[routine-coordinator] briefing generated (${name})`
                : `[routine-coordinator] briefing skipped (${r.reason})`,
            );
          } catch (e) {
            this.logger(`[routine-coordinator] generate failed: ${(e as Error).message}`);
          }
          return result;
        }
      }
      return null;
    } finally {
      this.running = false;
    }
  }
}

// ─── Default evaluator factories ────────────────────────────────────────────

/**
 * idleSignal — fires when caller reports IdleScheduler is in IDLE_SCAN.
 * Back-compat path: the existing boot wiring invokes RoutineEngine directly
 * from IdleScheduler.setStateChangeListener. This evaluator mirrors that path
 * so coordinator-only deployments still get idle briefings.
 */
export function createIdleSignal(
  isLongIdle: () => boolean,
): { name: string; evaluate: SignalEvaluator } {
  return {
    name: "idleSignal",
    evaluate: () => (isLongIdle() ? { fire: true, reason: "long_idle" } : null),
  };
}

/**
 * scheduleSignal — fires at configured KST time (default "08:30") once per
 * day. `lastFiredDayKey` persists the last-fired KST YYYY-MM-DD to avoid
 * repeat fires within the same local day.
 */
export function createScheduleSignal(opts: {
  hhmmKst?: string;
  isEnabled: () => boolean;
  getLastFiredDayKey: () => string | undefined;
  setLastFiredDayKey: (key: string) => void;
}): { name: string; evaluate: SignalEvaluator } {
  const hhmm = opts.hhmmKst ?? "08:30";
  const [targetH, targetM] = hhmm.split(":").map((x) => Number.parseInt(x, 10));
  // PR#44 Copilot: validate parseInt — reject NaN and out-of-range values so a
  // malformed config string doesn't silently turn into fires at t=NaN (which
  // would compare false-ish and hide the misconfiguration).
  const isValidHm = (h: number, m: number): boolean =>
    Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;
  if (!isValidHm(targetH, targetM)) {
    console.warn(`[routine-coordinator] invalid hhmmKst "${hhmm}" — scheduleSignal disabled`);
    return {
      name: "scheduleSignal",
      evaluate: () => null,
    };
  }
  return {
    name: "scheduleSignal",
    evaluate: (now) => {
      if (!opts.isEnabled()) return null;
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now);
      const [curH, curM] = fmt.split(":").map((x) => Number.parseInt(x, 10));
      if (!isValidHm(curH, curM)) {
        console.warn(`[routine-coordinator] Intl DateTimeFormat produced invalid hh:mm "${fmt}"`);
        return null;
      }
      const curMinutes = curH * 60 + curM;
      const tgtMinutes = targetH * 60 + targetM;
      // fire inside [target, target+5min) window (60s tick + grace)
      if (curMinutes < tgtMinutes || curMinutes >= tgtMinutes + 5) return null;
      const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
      if (opts.getLastFiredDayKey() === dayKey) return null;
      opts.setLastFiredDayKey(dayKey);
      return { fire: true, reason: `schedule:${hhmm}` };
    },
  };
}

export interface UpcomingEvent {
  subject: string;
  start: string;
  end: string;
  isAllDay?: boolean;
}

/**
 * meetingSignal — fires 10min before any upcoming calendar event. Events are
 * resolved via `getEvents()` — the boot wiring supplies a closure over the
 * calendar capability lookup (no plugin-id hardcoding).
 */
export function createMeetingSignal(opts: {
  getEvents: () => UpcomingEvent[];
  leadMinutes?: number;
  getShownSet: () => Set<string>;
}): { name: string; evaluate: SignalEvaluator } {
  const lead = opts.leadMinutes ?? 10;
  return {
    name: "meetingSignal",
    evaluate: (now) => {
      const shown = opts.getShownSet();
      const events = opts.getEvents();
      for (const ev of events) {
        if (ev.isAllDay) continue;
        const startMs = new Date(ev.start).getTime();
        if (!Number.isFinite(startMs)) continue;
        const deltaMin = (startMs - now.getTime()) / 60_000;
        if (deltaMin <= lead && deltaMin > 0) {
          const key = `${ev.subject}@${ev.start}`;
          if (shown.has(key)) continue;
          shown.add(key);
          return { fire: true, reason: `meeting-in-${Math.round(deltaMin)}m:${ev.subject}` };
        }
      }
      return null;
    },
  };
}

export interface DeadlineTask {
  id?: string;
  title: string;
  status: string;
  dueAt?: string;
}

/**
 * taskDeadlineSignal — fires when any pending task is due within
 * `windowMinutes` (default 120). `shown` dedup set prevents re-fire for the
 * same task id/title within the process lifetime.
 */
/**
 * postTurnSignal — fires after a conversation turn when enabled and cooldown
 * has elapsed (default 10 min). Designed to be notified via `coordinator.notify("post-turn")`.
 * Persists lastFiredAt in-memory only (no storage).
 */
export function createPostTurnSignal(opts: {
  getCooldownMs?: () => number;
  getLastFiredAt: () => number;
  setLastFiredAt: (ts: number) => void;
  isEnabled: () => boolean;
}): { name: string; evaluate: SignalEvaluator } {
  const DEFAULT_COOLDOWN_MS = 10 * 60_000;
  return {
    name: "postTurnSignal",
    evaluate: (now) => {
      if (!opts.isEnabled()) return null;
      const cooldown = opts.getCooldownMs?.() ?? DEFAULT_COOLDOWN_MS;
      if (now.getTime() - opts.getLastFiredAt() < cooldown) return null;
      opts.setLastFiredAt(now.getTime());
      return { fire: true, reason: "post-turn" };
    },
  };
}

export function createTaskDeadlineSignal(opts: {
  getTasks: () => DeadlineTask[];
  windowMinutes?: number;
  getShownSet: () => Set<string>;
}): { name: string; evaluate: SignalEvaluator } {
  const windowMin = opts.windowMinutes ?? 120;
  return {
    name: "taskDeadlineSignal",
    evaluate: (now) => {
      const shown = opts.getShownSet();
      const tasks = opts.getTasks();
      for (const t of tasks) {
        if (t.status !== "pending" || !t.dueAt) continue;
        const dueMs = new Date(t.dueAt).getTime();
        if (!Number.isFinite(dueMs)) continue;
        const deltaMin = (dueMs - now.getTime()) / 60_000;
        if (deltaMin <= windowMin && deltaMin > 0) {
          const key = t.id ?? t.title;
          if (shown.has(key)) continue;
          shown.add(key);
          return { fire: true, reason: `task-due-${Math.round(deltaMin)}m:${t.title}` };
        }
      }
      return null;
    },
  };
}

export { RoutineTriggerCoordinator as ProactiveTriggerCoordinator };

/**
 * Sprint 3-A-2 — Routine Trigger Coordinator.
 *
 * Evaluates signals (idle, schedule, post-turn) on a 60s tick and fires
 * `runRoutine` for the wakeup routine when any signal returns {fire:true}.
 * Subject to a 30min debounce.
 *
 * Kill-switch: DISABLE_ROUTINE_COORDINATOR=1
 */

import type { Routine, RoutineResult, RoutineEngine } from "./routine-engine.js";

export type RoutineCompletedCallback = (result: RoutineResult) => void | Promise<void>;

export interface SignalResult {
  fire: boolean;
  reason: string;
}

export type SignalEvaluator = (
  now: Date,
  source?: string,
) => SignalResult | null | Promise<SignalResult | null>;

export interface CoordinatorDeps {
  routineEngine: RoutineEngine;
  evaluators: Array<{ name: string; evaluate: SignalEvaluator }>;
  /** default 60_000 */
  tickIntervalMs?: number;
  /** default 30 * 60_000 */
  debounceMs?: number;
  /** test override */
  now?: () => Date;
  logger?: (msg: string) => void;
  onRoutineCompleted?: RoutineCompletedCallback;
  /** test override */
  disabled?: () => boolean;
}

export class RoutineTriggerCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private lastFiredAt = 0;
  private running = false;
  private readonly tickIntervalMs: number;
  private readonly debounceMs: number;
  private readonly now: () => Date;
  private readonly logger: (msg: string) => void;
  private readonly onRoutineCompleted?: RoutineCompletedCallback;
  private readonly disabled: () => boolean;

  constructor(private readonly deps: CoordinatorDeps) {
    this.tickIntervalMs = deps.tickIntervalMs ?? 60_000;
    this.debounceMs = deps.debounceMs ?? 30 * 60_000;
    this.now = deps.now ?? (() => new Date());
    this.logger = deps.logger ?? ((m) => console.log(m));
    this.onRoutineCompleted = deps.onRoutineCompleted;
    this.disabled = deps.disabled ?? (() =>
      process.env.DISABLE_ROUTINE_COORDINATOR === "1" || process.env.DISABLE_PROACTIVE_COORDINATOR === "1");
  }

  start(): void {
    if (this.timer) return;
    if (this.disabled()) {
      this.logger("[routine-coordinator] disabled via DISABLE_ROUTINE_COORDINATOR");
      return;
    }
    this.timer = setInterval(() => {
      void this.evaluateAll("tick").catch((e: Error) =>
        this.logger(`[routine-coordinator] tick failed: ${e.message}`),
      );
    }, this.tickIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  notify(event: string): void {
    if (this.disabled()) return;
    void this.evaluateAll(`event:${event}`).catch((e: Error) =>
      this.logger(`[routine-coordinator] notify(${event}) failed: ${e.message}`),
    );
  }

  isWithinGlobalCooldown(windowMs = this.debounceMs): boolean {
    return Date.now() - this.lastFiredAt < windowMs;
  }

  async _testEvaluate(source = "test"): Promise<SignalResult | null> {
    return this.evaluateAll(source);
  }

  private async evaluateAll(source: string): Promise<SignalResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const nowDate = this.now();
      if (nowDate.getTime() - this.lastFiredAt < this.debounceMs) return null;

      for (const { name, evaluate } of this.deps.evaluators) {
        let result: SignalResult | null;
        try {
          result = await evaluate(nowDate, source);
        } catch (e) {
          this.logger(`[routine-coordinator] ${name} threw: ${(e as Error).message}`);
          continue;
        }
        if (result?.fire) {
          this.lastFiredAt = nowDate.getTime();
          this.logger(`[routine-coordinator] fire via ${name} (${result.reason}, src=${source})`);
          const wakeupRoutine: Routine = {
            id: "wakeup",
            trigger: "wakeup",
            prePrompt: "오늘 업무 맥락을 정리해줘.",
          };
          try {
            const routineResult = await this.deps.routineEngine.runRoutine(wakeupRoutine);
            this.logger(`[routine-coordinator] routine complete (${name})`);
            try {
              await this.onRoutineCompleted?.(routineResult);
            } catch (e) {
              this.logger(`[routine-coordinator] onRoutineCompleted failed: ${(e as Error).message}`);
            }
          } catch (e) {
            this.logger(`[routine-coordinator] runRoutine failed: ${(e as Error).message}`);
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

// ─── Default evaluator factories ─────────────────────────────────────────────

export function createIdleSignal(
  isLongIdle: () => boolean,
): { name: string; evaluate: SignalEvaluator } {
  return {
    name: "idleSignal",
    evaluate: () => (isLongIdle() ? { fire: true, reason: "long_idle" } : null),
  };
}

export function createScheduleSignal(opts: {
  getHhmmKst?: () => string | undefined;
  isEnabled: () => boolean;
  getLastFiredDayKey: () => string | undefined;
  setLastFiredDayKey: (key: string) => void;
}): { name: string; evaluate: SignalEvaluator } {
  const isValidHm = (h: number, m: number): boolean =>
    Number.isFinite(h) && Number.isFinite(m) && h >= 0 && h <= 23 && m >= 0 && m <= 59;
  return {
    name: "scheduleSignal",
    evaluate: (now) => {
      if (!opts.isEnabled()) return null;
      const hhmm = opts.getHhmmKst?.() ?? "08:30";
      const [targetH, targetM] = hhmm.split(":").map((x) => Number.parseInt(x, 10));
      if (!isValidHm(targetH, targetM)) {
        console.warn(`[routine-coordinator] invalid hhmmKst "${hhmm}" — scheduleSignal disabled`);
        return null;
      }
      const fmt = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Seoul",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      }).format(now);
      const [curH, curM] = fmt.split(":").map((x) => Number.parseInt(x, 10));
      if (!isValidHm(curH, curM)) return null;
      const curMinutes = curH * 60 + curM;
      const tgtMinutes = targetH * 60 + targetM;
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

export function createPostTurnSignal(opts: {
  getCooldownMs?: () => number;
  getLastFiredAt: () => number;
  setLastFiredAt: (ts: number) => void;
  isEnabled: () => boolean;
}): { name: string; evaluate: SignalEvaluator } {
  const DEFAULT_COOLDOWN_MS = 10 * 60_000;
  return {
    name: "postTurnSignal",
    evaluate: (now, source) => {
      if (!opts.isEnabled()) return null;
      if (source !== "event:post-turn") return null;
      const cooldown = opts.getCooldownMs?.() ?? DEFAULT_COOLDOWN_MS;
      if (now.getTime() - opts.getLastFiredAt() < cooldown) return null;
      opts.setLastFiredAt(now.getTime());
      return { fire: true, reason: "post-turn" };
    },
  };
}

// ─── Removed: createMeetingSignal, createTaskDeadlineSignal ──────────────────
// These signals triggered the old generateDailyBriefing (pluginRuntime.call).
// They are removed in the wakeup-routine refactor. If needed in future, add
// them back as separate coordinator instances rather than mixing with routine triggers.

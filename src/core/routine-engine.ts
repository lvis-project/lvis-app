import type { PluginRuntime } from "../plugins/runtime.js";
import type { HeartbeatEntry } from "../routines/schedule.js";

export interface BriefingItem {
  category: "task" | "note" | "session" | "meeting" | "email" | "calendar" | "system";
  priority: "high" | "medium" | "low";
  title: string;
  detail?: string;
}

export interface Briefing {
  generatedAt: string;
  items: BriefingItem[];
  summary?: string;
}

export type DailyBriefingResult =
  | { status: "generated"; briefing: Briefing }
  | {
      status: "skipped";
      reason:
        | "disabled"
        | "not_idle"
        | "already_today"
        | "recently_dismissed"
        | "no_signals"
        | "provider_unavailable"
        | "in_flight";
    };

export interface DailyBriefingOptions {
  idleState?: string;
  now?: Date;
  triggerReason?: string;
}

export interface ShutdownSummary {
  generatedAt: string;
  summary: string;
}

export interface MemoryManagerLike {
  listMemoryEntries(): Array<{ title: string; filename: string; content?: string }>;
}

export interface RoutineEngineDeps {
  pluginRuntime: PluginRuntime;
  memoryManager?: MemoryManagerLike;
  taskService?: { getPendingByPriority?: () => unknown[] };
  isDailyBriefingEnabled?: () => boolean;
  getLastBriefingDate?: () => string | undefined;
  setLastBriefingDate?: (dateKst: string) => void;
  getLastDismissedAt?: () => string | undefined;
  getDailyBriefingPrompt?: () => string | undefined;
  getShutdownPrompt?: () => string | undefined;
  dailyBriefingTool?: string;
  shutdownSummaryTool?: string;
  heartbeatTool?: string;
}

function isBriefingItem(value: unknown): value is BriefingItem {
  const record = value as Record<string, unknown> | null;
  return !!record &&
    typeof record.title === "string" &&
    typeof record.category === "string" &&
    typeof record.priority === "string" &&
    (record.detail === undefined || typeof record.detail === "string");
}

function isBriefing(value: unknown): value is Briefing {
  const record = value as Record<string, unknown> | null;
  return !!record &&
    typeof record.generatedAt === "string" &&
    Array.isArray(record.items) &&
    record.items.every(isBriefingItem) &&
    (record.summary === undefined || typeof record.summary === "string");
}

function isShutdownSummary(value: unknown): value is ShutdownSummary {
  const record = value as Record<string, unknown> | null;
  return !!record &&
    typeof record.generatedAt === "string" &&
    typeof record.summary === "string";
}

export class RoutineEngine {
  private briefingInFlight = false;

  constructor(private readonly deps: RoutineEngineDeps) {}

  private kstDateKey(now: Date): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
  }

  private get dailyBriefingTool(): string | undefined {
    return this.deps.dailyBriefingTool;
  }

  private get shutdownSummaryTool(): string | undefined {
    return this.deps.shutdownSummaryTool;
  }

  private get heartbeatTool(): string | undefined {
    return this.deps.heartbeatTool;
  }

  async generateDailyBriefing(options: DailyBriefingOptions = {}): Promise<DailyBriefingResult> {
    if (this.briefingInFlight) {
      return { status: "skipped", reason: "in_flight" };
    }
    this.briefingInFlight = true;
    try {
      const now = options.now ?? new Date();
      const enabled = this.deps.isDailyBriefingEnabled?.() ?? false;
      if (!enabled) return { status: "skipped", reason: "disabled" };
      if (options.idleState !== "long_idle" && options.idleState !== "triggered") {
        return { status: "skipped", reason: "not_idle" };
      }

      const todayKst = this.kstDateKey(now);
      if (this.deps.getLastBriefingDate?.() === todayKst) {
        return { status: "skipped", reason: "already_today" };
      }

      const dismissedAt = this.deps.getLastDismissedAt?.();
      if (dismissedAt) {
        const dismissedMs = new Date(dismissedAt).getTime();
        if (Number.isFinite(dismissedMs) && now.getTime() - dismissedMs < 24 * 60 * 60 * 1000) {
          return { status: "skipped", reason: "recently_dismissed" };
        }
      }

      if (!this.dailyBriefingTool) {
        return { status: "skipped", reason: "provider_unavailable" };
      }

      let raw: unknown;
      try {
        raw = await this.deps.pluginRuntime.call(this.dailyBriefingTool, {
          trigger: options.triggerReason ?? "routine",
          nowIso: now.toISOString(),
          routinePrompt: this.deps.getDailyBriefingPrompt?.(),
        });
      } catch {
        return { status: "skipped", reason: "provider_unavailable" };
      }

      if (!isBriefing(raw)) {
        return { status: "skipped", reason: "provider_unavailable" };
      }
      if (raw.items.length === 0 && !(raw.summary && raw.summary.trim())) {
        return { status: "skipped", reason: "no_signals" };
      }
      this.deps.setLastBriefingDate?.(todayKst);
      return { status: "generated", briefing: raw };
    } finally {
      this.briefingInFlight = false;
    }
  }

  async generateTextBriefing(): Promise<Briefing> {
    const now = new Date();
    if (!this.dailyBriefingTool) {
      return {
        generatedAt: now.toISOString(),
        items: [],
        summary: "브리핑 공급자를 사용할 수 없습니다.",
      };
    }
    try {
      const raw = await this.deps.pluginRuntime.call(this.dailyBriefingTool, {
        trigger: "manual",
        nowIso: now.toISOString(),
      });
      if (isBriefing(raw)) return raw;
    } catch {
      // fall through to compatibility fallback below
    }
    return {
      generatedAt: now.toISOString(),
      items: [],
      summary: "브리핑 공급자를 사용할 수 없습니다.",
    };
  }

  /** Collects briefing items from memory entries and other sources. */
  collectBriefingItems(_now?: Date): BriefingItem[] {
    const items: BriefingItem[] = [];
    const entries = this.deps.memoryManager?.listMemoryEntries() ?? [];
    for (const entry of entries) {
      items.push({
        category: "note",
        priority: "medium",
        title: entry.title,
        detail: entry.content,
      });
    }
    return items;
  }

  /** Renders briefing items into a prompt string. */
  getBriefingPromptData(items?: BriefingItem[], _now?: Date): string {
    if (!items || items.length === 0) return "";
    return items
      .map((item) => `[${item.priority}] ${item.category}: ${item.title}${item.detail ? ` (${item.detail})` : ""}`)
      .join("\n");
  }

  async runShutdownRoutine(now: Date = new Date()): Promise<ShutdownSummary | null> {
    if (!this.shutdownSummaryTool) return null;
    try {
      const raw = await this.deps.pluginRuntime.call(this.shutdownSummaryTool, {
        trigger: "shutdown",
        nowIso: now.toISOString(),
        routinePrompt: this.deps.getShutdownPrompt?.(),
      });
      return isShutdownSummary(raw) ? raw : null;
    } catch {
      return null;
    }
  }

  async runHeartbeatRoutine(now: Date = new Date(), heartbeat?: HeartbeatEntry): Promise<void> {
    if (!this.heartbeatTool) return;
    try {
      await this.deps.pluginRuntime.call(this.heartbeatTool, {
        trigger: "heartbeat",
        nowIso: now.toISOString(),
        heartbeatId: heartbeat?.id,
        heartbeatAgentId: heartbeat?.agentId,
        heartbeatSchedule: heartbeat?.schedule,
        heartbeatPrompt: heartbeat?.prompt,
      });
    } catch {
      // Heartbeat failures are intentionally non-fatal.
    }
  }
}

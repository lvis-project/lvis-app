/**
 * Boot §4.2 Step 6 — Proactive Engine + calendar 초기 로드.
 */
import type { PluginRuntime } from "../plugins/runtime.js";
import type { TaskService } from "../taskService.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import { ProactiveEngine } from "../core/proactive-engine.js";
import {
  buildManifestEventHints,
  findMethodByCapability,
  registerManifestEventSubscriptions,
} from "./plugins.js";

export function createProactiveEngine(opts: {
  taskService: TaskService;
  memoryManager: MemoryManager;
  pluginRuntime: PluginRuntime;
  // Sprint 2-D: Daily Briefing gating deps — feature flag, LLM caller,
  // date persistence, dismissal state. All optional so the split helper
  // remains usable in contexts where briefing is disabled.
  isDailyBriefingEnabled?: () => boolean;
  callLlm?: (prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>;
  getLastBriefingDate?: () => string | undefined;
  setLastBriefingDate?: (dateKst: string) => void;
  getLastDismissedAt?: () => string | undefined;
}): ProactiveEngine {
  const {
    taskService, memoryManager, pluginRuntime,
    isDailyBriefingEnabled, callLlm,
    getLastBriefingDate, setLastBriefingDate, getLastDismissedAt,
  } = opts;
  const proactiveEngine = new ProactiveEngine({
    getTaskSummary: () => taskService.getPendingByPriority().map((t) => ({
      title: t.title, priority: t.priority, status: t.status,
      dueAt: t.dueAt ?? undefined, source: t.source,
    })),
    getRecentNotes: () => memoryManager.listNotes().slice(0, 5),
    getRecentSessions: () => memoryManager.listSessions().slice(0, 5),
    // Sprint 3-A: user voice tone hint — note titles only (deterministic).
    getRecentMemoryExcerpts: () => memoryManager.listNotes().slice(0, 3).map((n) => n.title),
    isDailyBriefingEnabled,
    callLlm,
    getLastBriefingDate,
    setLastBriefingDate,
    getLastDismissedAt,
  });
  proactiveEngine.setEventHints(buildManifestEventHints(pluginRuntime));

  // 이벤트 버스 → Proactive Engine 연동 (manifest.eventSubscriptions 선언 기반)
  registerManifestEventSubscriptions(pluginRuntime, proactiveEngine);

  return proactiveEngine;
}

/** 오늘 일정 초기 로드 (calendar-source capability 플러그인에서 *_today 메서드 자동 탐색) */
export function loadCalendarToday(
  pluginRuntime: PluginRuntime,
  proactiveEngine: ProactiveEngine,
): void {
  const calendarTodayMethod = findMethodByCapability(
    pluginRuntime,
    "calendar-source",
    (method) => method.endsWith("_today"),
  );
  if (calendarTodayMethod) {
    pluginRuntime.call(calendarTodayMethod, {})
      .then((events: unknown) => {
        if (Array.isArray(events)) {
          proactiveEngine.updateCalendarEvents(events as import("../core/proactive-engine.js").CachedCalendarEvent[]);
          console.log(`[lvis] boot: calendar today loaded (${events.length}건)`);
        }
      })
      .catch((e: Error) => console.log("[lvis] boot: calendar today load failed (non-fatal):", e.message));
  }
}

/** Feature 4: 월요일 주간 일정 캐시 로드 (KST 기준) */
export function loadWeeklyCalendarIfMonday(
  pluginRuntime: PluginRuntime,
  proactiveEngine: ProactiveEngine,
): void {
  const isMonday = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Seoul", weekday: "short" }).format(new Date()) === "Mon";
  const calendarListMethod = findMethodByCapability(
    pluginRuntime, "calendar-source", (m) => m.endsWith("_list"),
  );
  if (isMonday && calendarListMethod) {
    pluginRuntime.call(calendarListMethod, { days: 7 })
      .then((events: unknown) => {
        if (Array.isArray(events)) {
          proactiveEngine.updateCalendarEvents(events as import("../core/proactive-engine.js").CachedCalendarEvent[]);
          console.log(`[lvis] boot: weekly calendar loaded (${events.length}건, 월요일 모드)`);
        }
      })
      .catch((e: Error) => console.log("[lvis] boot: weekly calendar load failed (non-fatal):", e.message));
  }
}

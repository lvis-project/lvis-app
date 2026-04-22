/**
 * Sprint 2-C — Daily Briefing (§7) gating tests.
 *
 * Verifies:
 *   - feature flag off → no briefing, no LLM call
 *   - once-per-day dedupe via persisted KST date
 *   - missing callLlm → skipped:no_llm
 *   - idle-state gate (only "long_idle" proceeds)
 *   - generated path persists date + returns summary
 */
import { describe, it, expect, vi } from "vitest";
import { RoutineEngine, type RoutineEngineDeps } from "../routine-engine.js";

function baseDeps(overrides: Partial<RoutineEngineDeps> = {}): RoutineEngineDeps {
  return {
    getTaskSummary: () => [
      { title: "문서 검토", priority: "high", status: "pending", source: "test" },
    ],
    getRecentNotes: () => [],
    getRecentSessions: () => [],
    ...overrides,
  };
}

describe("RoutineEngine.generateDailyBriefing — feature flag gating", () => {
  it("returns skipped:disabled when flag is off (and never invokes callLlm)", async () => {
    const callLlm = vi.fn().mockResolvedValue("stub");
    const engine = new RoutineEngine(baseDeps({
      isDailyBriefingEnabled: () => false,
      callLlm,
    }));
    const r = await engine.generateDailyBriefing({ idleState: "long_idle" });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("disabled");
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("defaults to disabled when isDailyBriefingEnabled is not wired", async () => {
    const engine = new RoutineEngine(baseDeps());
    const r = await engine.generateDailyBriefing({ idleState: "long_idle" });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("disabled");
  });
});

describe("RoutineEngine.generateDailyBriefing — callLlm absence", () => {
  it("returns skipped:no_llm when callLlm is not provided", async () => {
    const engine = new RoutineEngine(baseDeps({
      isDailyBriefingEnabled: () => true,
      // callLlm omitted
    }));
    const r = await engine.generateDailyBriefing({ idleState: "long_idle" });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("no_llm");
  });
});

describe("RoutineEngine.generateDailyBriefing — idle gate", () => {
  it("returns skipped:not_idle unless idleState=long_idle", async () => {
    const callLlm = vi.fn().mockResolvedValue("stub");
    const engine = new RoutineEngine(baseDeps({
      isDailyBriefingEnabled: () => true,
      callLlm,
    }));
    const r = await engine.generateDailyBriefing({ idleState: "short_idle" });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("not_idle");
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("accepts idleState=\"triggered\" (Sprint 3-A-2 coordinator path)", async () => {
    const callLlm = vi.fn().mockResolvedValue("stub briefing");
    const engine = new RoutineEngine(baseDeps({
      isDailyBriefingEnabled: () => true,
      callLlm,
    }));
    const r = await engine.generateDailyBriefing({
      idleState: "triggered",
      triggerReason: "scheduleSignal:08:30",
    });
    expect(r.status).toBe("generated");
    expect(callLlm).toHaveBeenCalledTimes(1);
  });
});

describe("RoutineEngine.generateDailyBriefing — once-per-day dedupe", () => {
  it("skips when lastBriefingDate equals today (KST)", async () => {
    const now = new Date("2026-04-18T02:00:00Z"); // 2026-04-18 KST 11:00
    const todayKst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
    const callLlm = vi.fn().mockResolvedValue("stub");
    const engine = new RoutineEngine(baseDeps({
      isDailyBriefingEnabled: () => true,
      callLlm,
      getLastBriefingDate: () => todayKst,
    }));
    const r = await engine.generateDailyBriefing({ idleState: "long_idle", now });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("already_today");
    expect(callLlm).not.toHaveBeenCalled();
  });

  it("proceeds when last briefing was a different day, and persists today's date", async () => {
    const now = new Date("2026-04-18T02:00:00Z");
    const todayKst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
    const callLlm = vi.fn().mockResolvedValue("오늘의 브리핑 요약");
    const setLastBriefingDate = vi.fn();
    const engine = new RoutineEngine(baseDeps({
      isDailyBriefingEnabled: () => true,
      callLlm,
      getLastBriefingDate: () => "2026-04-17",
      setLastBriefingDate,
    }));
    const r = await engine.generateDailyBriefing({ idleState: "long_idle", now });
    expect(r.status).toBe("generated");
    if (r.status === "generated") {
      expect(r.briefing.summary).toBe("오늘의 브리핑 요약");
      expect(r.briefing.items.length).toBeGreaterThan(0);
    }
    expect(callLlm).toHaveBeenCalledTimes(1);
    expect(setLastBriefingDate).toHaveBeenCalledWith(todayKst);
  });
});

describe("RoutineEngine.generateDailyBriefing — dismissal suppression", () => {
  it("skips when user dismissed within the last 24h", async () => {
    const now = new Date("2026-04-18T02:00:00Z");
    const dismissed = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString(); // 3h ago
    const callLlm = vi.fn().mockResolvedValue("stub");
    const engine = new RoutineEngine(baseDeps({
      isDailyBriefingEnabled: () => true,
      callLlm,
      getLastDismissedAt: () => dismissed,
    }));
    const r = await engine.generateDailyBriefing({ idleState: "long_idle", now });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("recently_dismissed");
    expect(callLlm).not.toHaveBeenCalled();
  });
});

describe("RoutineEngine.generateDailyBriefing — no_signals", () => {
  it("skips when no tasks/notes/sessions/events/calendar signals exist", async () => {
    const callLlm = vi.fn().mockResolvedValue("stub");
    const engine = new RoutineEngine({
      getTaskSummary: () => [],
      getRecentNotes: () => [],
      getRecentSessions: () => [],
      isDailyBriefingEnabled: () => true,
      callLlm,
    });
    const r = await engine.generateDailyBriefing({ idleState: "long_idle" });
    expect(r.status).toBe("skipped");
    if (r.status === "skipped") expect(r.reason).toBe("no_signals");
    expect(callLlm).not.toHaveBeenCalled();
  });
});

describe("RoutineEngine.generateDailyBriefing — concurrent invocation race guard", () => {
  it("second parallel call returns in_flight while first is running", async () => {
    let resolveLlm!: (v: string) => void;
    const llmPromise = new Promise<string>((res) => { resolveLlm = res; });
    const callLlm = vi.fn().mockReturnValue(llmPromise);
    const setLastBriefingDate = vi.fn();
    const engine = new RoutineEngine(baseDeps({
      isDailyBriefingEnabled: () => true,
      callLlm,
      getLastBriefingDate: () => undefined,
      setLastBriefingDate,
    }));

    // Start first call — it will block on callLlm
    const first = engine.generateDailyBriefing({ idleState: "long_idle" });
    // Second call fires before first resolves — must be rejected with in_flight
    const second = engine.generateDailyBriefing({ idleState: "long_idle" });

    // Unblock the first LLM call
    resolveLlm("첫 번째 브리핑");

    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.status).toBe("generated");
    expect(r2.status).toBe("skipped");
    if (r2.status === "skipped") expect(r2.reason).toBe("in_flight");
    // LLM was only called once
    expect(callLlm).toHaveBeenCalledTimes(1);
  });
});

describe("RoutineEngine.collectBriefingItems — UTC/KST date boundary", () => {
  it("task due 'tomorrow UTC' appears as 'today' in briefing when clock is 23:30 UTC (08:30 KST next day)", () => {
    // 23:30 UTC on 2026-04-17 = 08:30 KST on 2026-04-18
    // KST date key is "2026-04-18"
    // A task due "2026-04-18" should be treated as due today (urgent)
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-17T23:30:00Z"));

    const engine = new RoutineEngine({
      getTaskSummary: () => [
        // dueAt is "tomorrow" in UTC terms but "today" in KST
        { title: "KST-today task", priority: "medium", status: "pending", dueAt: "2026-04-18", source: "test" },
      ],
      getRecentNotes: () => [],
      getRecentSessions: () => [],
    });

    const items = engine.collectBriefingItems();
    const taskItem = items.find((i) => i.title === "KST-today task");
    expect(taskItem).toBeDefined();
    // dueAt "2026-04-18" <= kstDateKey "2026-04-18" → urgent → priority high
    expect(taskItem?.priority).toBe("high");

    vi.useRealTimers();
  });
});

describe("RoutineEngine routine.* event ingestion", () => {
  it("collects normalized routine items without manifest event hints", () => {
    const engine = new RoutineEngine({
      getTaskSummary: () => [],
      getRecentNotes: () => [],
      getRecentSessions: () => [],
    });

    engine.collectEvent("routine.item.created", {
      item: {
        category: "meeting",
        priority: "high",
        title: "회의 10분 전",
        detail: "Design sync",
      },
    });

    const items = engine.collectBriefingItems();
    expect(items).toContainEqual({
      category: "meeting",
      priority: "high",
      title: "회의 10분 전",
      detail: "Design sync",
    });
  });

  it("uses routine calendar and mail snapshots as normalized inputs", () => {
    const engine = new RoutineEngine({
      getTaskSummary: () => [],
      getRecentNotes: () => [],
      getRecentSessions: () => [],
    });
    const now = new Date("2026-04-18T00:10:00+09:00");

    engine.collectEvent("routine.snapshot.calendar", {
      events: [
        {
          subject: "Morning sync",
          start: "2026-04-18T09:00:00+09:00",
          end: "2026-04-18T10:00:00+09:00",
          isOnlineMeeting: true,
        },
      ],
    });
    engine.collectEvent("routine.snapshot.mail", {
      items: [
        {
          subject: "승인 필요",
          sender: "manager@lge.com",
          deadline: "today",
          intent: "결재 요청",
          priority: "high",
        },
      ],
    });

    const items = engine.collectBriefingItems(now);
    expect(items.some((item) => item.category === "calendar" && item.title === "Morning sync")).toBe(true);

    const prompt = engine.getBriefingPromptData(items, now);
    expect(prompt).toContain("승인 필요");
    expect(prompt).toContain("manager@lge.com");
  });

  it("clears normalized calendar cache on explicit invalidation", () => {
    const engine = new RoutineEngine({
      getTaskSummary: () => [],
      getRecentNotes: () => [],
      getRecentSessions: () => [],
    });
    const now = new Date("2026-04-18T00:10:00+09:00");

    engine.collectEvent("routine.snapshot.calendar", {
      events: [
        {
          subject: "Morning sync",
          start: "2026-04-18T09:00:00+09:00",
          end: "2026-04-18T10:00:00+09:00",
        },
      ],
    });
    engine.collectEvent("routine.snapshot.calendar.invalidated", {
      reason: "auth lost",
    });

    expect(engine.collectBriefingItems(now).some((item) => item.category === "calendar")).toBe(false);
  });

  it("clears normalized mail cache on explicit invalidation", () => {
    const engine = new RoutineEngine({
      getTaskSummary: () => [],
      getRecentNotes: () => [],
      getRecentSessions: () => [],
    });
    const now = new Date("2026-04-18T00:10:00+09:00");

    engine.collectEvent("routine.snapshot.mail", {
      items: [
        {
          subject: "승인 필요",
          sender: "manager@lge.com",
          deadline: "today",
          intent: "결재 요청",
          priority: "high",
        },
      ],
    });
    engine.collectEvent("routine.snapshot.mail.invalidated", {
      reason: "plugin stopped",
    });

    expect(engine.getBriefingPromptData([], now)).toBe("");
  });

  it("ignores raw non-routine events after the bundled translation boundary", () => {
    const engine = new RoutineEngine({
      getTaskSummary: () => [],
      getRecentNotes: () => [],
      getRecentSessions: () => [],
    });

    engine.collectEvent("email.action.needed", {
      subject: "raw event should not leak into core",
      sender: "legacy@lge.com",
      priority: "high",
    });

    expect(engine.collectBriefingItems()).toEqual([]);
    expect(engine.getBriefingPromptData()).toBe("");
  });
});

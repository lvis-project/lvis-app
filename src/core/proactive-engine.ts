/**
 * Proactive Engine — §7 Daily Briefing
 *
 * 플러그인 이벤트 + 내부 상태를 수집하여 능동적 브리핑 생성.
 * 현재 수집 가능 소스:
 * - TaskService: 미완료 태스크, 기한 임박
 * - MemoryManager: 최근 메모, 최근 세션
 * - Plugin Events: meeting.summary.created, email.action.needed 등
 *
 * 향후 추가 소스: Calendar, Agent Hub, Marketplace
 */

import type { IdleState } from "../main/idle-scheduler.js";

export interface BriefingItem {
  category: "task" | "note" | "session" | "meeting" | "email" | "calendar" | "system";
  priority: "high" | "medium" | "low";
  title: string;
  detail?: string;
}

export interface CachedCalendarEvent {
  subject: string;
  start: string;
  end: string;
  isAllDay?: boolean;
  location?: string;
  isOnlineMeeting?: boolean;
}

export interface Briefing {
  generatedAt: string;
  items: BriefingItem[];
  summary?: string; // LLM이 생성한 자연어 브리핑
}

export interface ProactiveEngineDeps {
  getTaskSummary: () => Array<{ title: string; priority: string; status: string; dueAt?: string; source: string }>;
  getRecentNotes: () => Array<{ title: string; filename: string }>;
  getRecentSessions: () => Array<{ id: string; modifiedAt: Date }>;
  /**
   * Sprint 3-A: optional, returns short note excerpts used to infer the
   * user's voice/tone for the briefing. Kept deterministic — only titles are
   * surfaced so repeated calls produce identical prompt text for tests.
   */
  getRecentMemoryExcerpts?: () => string[];
  /**
   * §14.4 feature-flag pattern. Called at briefing time so a settings change
   * takes effect without service restart. Default OFF when undefined.
   */
  isDailyBriefingEnabled?: () => boolean;
  /**
   * §7 LLM synthesis entrypoint. Wired to HostApi.callLlm() in boot.ts.
   * Absence disables LLM summarization (test/noop contexts).
   */
  callLlm?: (prompt: string, options?: { maxTokens?: number; systemPrompt?: string }) => Promise<string>;
  /** Returns KST YYYY-MM-DD of last briefing, or undefined if never. */
  getLastBriefingDate?: () => string | undefined;
  /** Persists KST YYYY-MM-DD of the briefing just generated. */
  setLastBriefingDate?: (dateKst: string) => void;
  /** Returns ISO timestamp of last user dismissal. */
  getLastDismissedAt?: () => string | undefined;
  /**
   * Sprint E §2 — 최근 사용자 브리핑 피드백 (dismiss 사유 기록).
   * LLM 프롬프트에 "User feedback memory:" 섹션으로 주입되어 점진적 튜닝을 유도.
   * Absence = no feedback context (backwards compatible).
   */
  getRecentBriefingFeedback?: () => Array<{ date: string; reason: string; details: string }>;
}

/** Result of a daily briefing attempt. */
export type DailyBriefingResult =
  | { status: "generated"; briefing: Briefing }
  | { status: "skipped"; reason: "disabled" | "no_llm" | "not_idle" | "already_today" | "recently_dismissed" | "no_signals" | "in_flight" };

export interface DailyBriefingOptions {
  /**
   * IdleScheduler state at call time. Accepts:
   *   - "long_idle": classic idle-scan path
   *   - "triggered": bypass idle gate (Sprint 3-A-2 coordinator non-idle signals)
   * Any other value → skipped:not_idle.
   */
  idleState?: IdleState | string;
  /** Override "now" for tests. */
  now?: Date;
  /**
   * Sprint 3-A-2: free-form human-readable reason from the
   * ProactiveTriggerCoordinator (e.g. "schedule:08:30", "meeting-in-10m",
   * "task-deadline-2h"). Logged alongside result for observability.
   */
  triggerReason?: string;
}

export interface ProactiveEventHint {
  category: BriefingItem["category"];
  priority?: BriefingItem["priority"];
  title?: string;
}

export class ProactiveEngine {
  private readonly deps: ProactiveEngineDeps;
  private readonly eventLog: Array<{ type: string; data: unknown; timestamp: string }> = [];
  private readonly eventHints = new Map<string, ProactiveEventHint>();
  private calendarEventsCache: CachedCalendarEvent[] = [];
  /** Race-guard: true while an async generateDailyBriefing() call is in progress. */
  private briefingInFlight = false;

  constructor(deps: ProactiveEngineDeps) {
    this.deps = deps;
  }

  /** 캘린더 이벤트 캐시 업데이트 (boot.ts에서 호출) */
  updateCalendarEvents(events: CachedCalendarEvent[]): void {
    this.calendarEventsCache = events;
  }

  /**
   * KST 기준 당일 범위 [00:00, 24:00)을 UTC ms 경계로 반환.
   * 캐시에 주간 일정이 섞여 있을 수 있으므로 "오늘" 필터링에 사용한다.
   */
  private kstTodayBoundsMs(now: Date): { start: number; end: number } {
    const todayKstDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
    const start = new Date(`${todayKstDate}T00:00:00+09:00`).getTime();
    return { start, end: start + 24 * 60 * 60 * 1000 };
  }

  /** 이벤트가 KST 당일 범위와 겹치면 true — 멀티데이/자정 걸친 일정도 포함. */
  private overlapsKstToday(ev: CachedCalendarEvent, bounds: { start: number; end: number }): boolean {
    const startMs = new Date(ev.start).getTime();
    const endMs = new Date(ev.end).getTime();
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
    return startMs < bounds.end && endMs > bounds.start;
  }

  /** 플러그인 이벤트 수집 (이벤트 버스에서 호출) */
  collectEvent(type: string, data?: unknown): void {
    this.eventLog.push({
      type,
      data,
      timestamp: new Date().toISOString(),
    });
    // 최근 100개만 유지
    if (this.eventLog.length > 100) {
      this.eventLog.splice(0, this.eventLog.length - 100);
    }
  }

  setEventHints(hints: Record<string, ProactiveEventHint>): void {
    this.eventHints.clear();
    for (const [eventType, hint] of Object.entries(hints)) {
      this.eventHints.set(eventType, hint);
    }
  }

  /** 브리핑 데이터 수집 — LLM 요약 전 단계 */
  collectBriefingItems(now: Date = new Date()): BriefingItem[] {
    const items: BriefingItem[] = [];

    // 1. 태스크 (미완료, 기한 임박)
    const tasks = this.deps.getTaskSummary();
    const pendingTasks = tasks.filter((t) => t.status === "pending");
    const today = this.kstDateKey(now);

    for (const task of pendingTasks.slice(0, 10)) {
      const isUrgent = task.priority === "high" || (task.dueAt && task.dueAt <= today);
      items.push({
        category: "task",
        priority: isUrgent ? "high" : "medium",
        title: task.title,
        detail: task.dueAt ? `마감: ${task.dueAt}` : `출처: ${task.source}`,
      });
    }

    // 2. 최근 메모 (24시간 내)
    const notes = this.deps.getRecentNotes();
    if (notes.length > 0) {
      items.push({
        category: "note",
        priority: "low",
        title: `최근 메모 ${notes.length}건`,
        detail: notes.slice(0, 3).map((n) => n.title).join(", "),
      });
    }

    // 3. 최근 세션 (미완료 대화)
    const sessions = this.deps.getRecentSessions();
    const recentSessions = sessions.filter((s) => {
      const age = now.getTime() - s.modifiedAt.getTime();
      return age < 24 * 60 * 60 * 1000; // 24시간 내
    });
    if (recentSessions.length > 0) {
      items.push({
        category: "session",
        priority: "low",
        title: `최근 대화 ${recentSessions.length}건`,
        detail: `마지막: ${recentSessions[0].modifiedAt.toLocaleString("ko-KR")}`,
      });
    }

    // 4. 수집된 플러그인 이벤트 (최근 24시간)
    const recentCutoff = now.getTime() - 24 * 60 * 60 * 1000;
    const recentEvents = this.eventLog.filter(
      (e) => new Date(e.timestamp).getTime() > recentCutoff,
    );

    this.collectHintedEventItems(recentEvents, items);

    // 5. 오늘 캘린더 일정 — KST 기준 당일로 범위 제한 (주간 캐시가 로드돼도 오늘 것만)
    if (this.calendarEventsCache.length > 0) {
      const bounds = this.kstTodayBoundsMs(now);
      const todayCache = this.calendarEventsCache.filter((e) => this.overlapsKstToday(e, bounds));
      const upcomingEvents = todayCache
        .filter((e) => !e.isAllDay && new Date(e.start) > now)
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      const allDayEvents = todayCache.filter((e) => e.isAllDay);
      const ongoingEvents = todayCache.filter(
        (e) => !e.isAllDay && new Date(e.start) <= now && new Date(e.end) > now,
      );

      // 진행 중 일정 — 높은 우선순위
      for (const ev of ongoingEvents) {
        const endTime = new Date(ev.end).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" });
        items.push({
          category: "calendar",
          priority: "high",
          title: `[진행 중] ${ev.subject}`,
          detail: `${endTime}까지${ev.location ? ` — ${ev.location}` : ""}${ev.isOnlineMeeting ? " (온라인)" : ""}`,
        });
      }

      // 예정 일정 (최대 3개)
      for (const ev of upcomingEvents.slice(0, 3)) {
        const startTime = new Date(ev.start).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" });
        const minutesUntil = Math.round((new Date(ev.start).getTime() - now.getTime()) / 60000);
        const soon = minutesUntil <= 30;
        items.push({
          category: "calendar",
          priority: soon ? "high" : "medium",
          title: ev.subject,
          detail: `${startTime}${minutesUntil < 60 ? ` (${minutesUntil}분 후)` : ""}${ev.location ? ` — ${ev.location}` : ""}${ev.isOnlineMeeting ? " (온라인)" : ""}`,
        });
      }

      // 종일 일정
      if (allDayEvents.length > 0) {
        items.push({
          category: "calendar",
          priority: "low",
          title: `종일 일정 ${allDayEvents.length}건`,
          detail: allDayEvents.map((e) => e.subject).join(", "),
        });
      }
    }

    return items.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });
  }

  private collectHintedEventItems(
    recentEvents: Array<{ type: string; data: unknown; timestamp: string }>,
    items: BriefingItem[],
  ): void {
    const grouped = new Map<string, Array<{ type: string; data: unknown; timestamp: string }>>();
    for (const event of recentEvents) {
      const bucket = grouped.get(event.type) ?? [];
      bucket.push(event);
      grouped.set(event.type, bucket);
    }

    for (const [eventType, events] of grouped.entries()) {
      const hinted = this.eventHints.get(eventType) ?? inferHintFromEventType(eventType);
      if (!hinted) continue;
      if (hinted.category === "calendar") continue;

      const latestData = events[events.length - 1]?.data as {
        subject?: string; sender?: string; deadline?: string; priority?: string;
      } | undefined;
      const hasHighPriorityEmail = hinted.category === "email" &&
        events.some((e) => (e.data as { priority?: string } | undefined)?.priority === "high");

      const priority = hasHighPriorityEmail ? "high" : (hinted.priority ?? "medium");
      const title = hinted.title ?? `${eventType} ${events.length}건`;

      items.push({
        category: hinted.category,
        priority,
        title,
        detail: hinted.category === "email" && latestData?.subject
          ? `${latestData.sender ? `${latestData.sender} — ` : ""}${latestData.subject}${latestData.deadline ? ` (마감: ${latestData.deadline})` : ""}`
          : undefined,
      });
    }
  }

  /** 텍스트 브리핑 생성 (LLM 없이, 구조화된 텍스트) */
  generateTextBriefing(): Briefing {
    const items = this.collectBriefingItems();
    const now = new Date().toISOString();

    if (items.length === 0) {
      return {
        generatedAt: now,
        items: [],
        summary: "오늘 특별한 알림이 없습니다. 좋은 하루 되세요!",
      };
    }

    const lines: string[] = [];
    const highItems = items.filter((i) => i.priority === "high");
    const medItems = items.filter((i) => i.priority === "medium");
    const lowItems = items.filter((i) => i.priority === "low");

    if (highItems.length > 0) {
      lines.push(`🔴 긴급 (${highItems.length}건):`);
      for (const item of highItems) {
        lines.push(`  • ${item.title}${item.detail ? ` — ${item.detail}` : ""}`);
      }
    }
    if (medItems.length > 0) {
      lines.push(`🟡 주요 (${medItems.length}건):`);
      for (const item of medItems) {
        lines.push(`  • ${item.title}${item.detail ? ` — ${item.detail}` : ""}`);
      }
    }
    if (lowItems.length > 0) {
      lines.push(`🔵 참고 (${lowItems.length}건):`);
      for (const item of lowItems) {
        lines.push(`  • ${item.title}${item.detail ? ` — ${item.detail}` : ""}`);
      }
    }

    return {
      generatedAt: now,
      items,
      summary: lines.join("\n"),
    };
  }

  /** KST 기준 YYYY-MM-DD 반환 (once-per-day dedupe 키) */
  private kstDateKey(now: Date): string {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(now);
  }

  /**
   * §7 Daily Briefing — gated LLM 요약 생성.
   *
   * 게이팅 순서 (최소-비용 → 최대-비용):
   *   1. feature flag off       → skipped:disabled
   *   2. callLlm 미주입           → skipped:no_llm
   *   3. idle state ≠ long_idle → skipped:not_idle
   *   4. 오늘 이미 생성           → skipped:already_today
   *   5. 24h 내 사용자 dismiss    → skipped:recently_dismissed
   *   6. 수집된 signal이 전무     → skipped:no_signals
   *
   * §14.4: flag가 기본 off이므로 production default는 no-op.
   */
  async generateDailyBriefing(options: DailyBriefingOptions = {}): Promise<DailyBriefingResult> {
    // 0) concurrent-invocation race guard — set synchronously before first await
    if (this.briefingInFlight) {
      return { status: "skipped", reason: "in_flight" };
    }
    this.briefingInFlight = true;

    try {
    return await this._generateDailyBriefingInner(options);
    } finally {
      this.briefingInFlight = false;
    }
  }

  private async _generateDailyBriefingInner(options: DailyBriefingOptions): Promise<DailyBriefingResult> {
    const now = options.now ?? new Date();

    // 1) feature flag
    const enabled = this.deps.isDailyBriefingEnabled?.() ?? false;
    if (!enabled) return { status: "skipped", reason: "disabled" };

    // 2) callLlm
    if (!this.deps.callLlm) return { status: "skipped", reason: "no_llm" };

    // 3) idle state — accepted values: "long_idle" (classic idle path) or
    //    "triggered" (Sprint 3-A-2 ProactiveTriggerCoordinator non-idle signal).
    if (options.idleState !== "long_idle" && options.idleState !== "triggered") {
      return { status: "skipped", reason: "not_idle" };
    }

    // 4) once-per-day dedupe — KST 일자 기준
    const todayKst = this.kstDateKey(now);
    const lastDate = this.deps.getLastBriefingDate?.();
    if (lastDate === todayKst) {
      return { status: "skipped", reason: "already_today" };
    }

    // 5) dismissal suppression (24h)
    const dismissedAt = this.deps.getLastDismissedAt?.();
    if (dismissedAt) {
      const dismissedMs = new Date(dismissedAt).getTime();
      if (Number.isFinite(dismissedMs) && now.getTime() - dismissedMs < 24 * 60 * 60 * 1000) {
        return { status: "skipped", reason: "recently_dismissed" };
      }
    }

    // 6) signal 수집 — items once, passed into prompt builder for consistency
    const items = this.collectBriefingItems(now);
    const promptData = this.getBriefingPromptData(items, now);
    if (items.length === 0 && promptData.trim().length === 0) {
      return { status: "skipped", reason: "no_signals" };
    }

    // LLM 요약 — 실패 시 텍스트 브리핑으로 폴백
    const systemPrompt =
      "당신은 LVIS의 능동적 일일 브리핑 어시스턴트입니다. 주어진 signal을 바탕으로 " +
      "사용자에게 하루를 시작하는 간결한 한국어 브리핑을 3~5문장으로 요약하세요. " +
      "우선순위가 높은 항목을 먼저 언급하고, 불필요한 수식어는 피하세요.";
    const userPrompt = promptData.length > 0
      ? promptData
      : items.map((i) => `[${i.priority}] ${i.category}: ${i.title}${i.detail ? ` (${i.detail})` : ""}`).join("\n");

    let summary: string;
    try {
      summary = await this.deps.callLlm(userPrompt, { maxTokens: 600, systemPrompt });
    } catch (err) {
      console.warn("[proactive] LLM briefing failed, falling back to text:", (err as Error).message);
      // Intentional: we still persist lastBriefingDate even on LLM failure.
      // The text-fallback briefing is a valid once-per-day briefing — without
      // persisting, a transient LLM outage would cause infinite retry loops.
      summary = this.generateTextBriefing().summary ?? "";
    }

    // dedupe 마커 persist
    this.deps.setLastBriefingDate?.(todayKst);

    return {
      status: "generated",
      briefing: {
        generatedAt: now.toISOString(),
        items,
        summary,
      },
    };
  }

  /**
   * LLM 브리핑용 프롬프트 데이터 생성 (ConversationLoop에서 호출).
   * items/now는 선택적이며, 생략 시 내부에서 collectBriefingItems(now)로 생성한다.
   * 동일 호출에서 한 번 수집한 items를 재사용하고 싶을 때는 명시 전달한다.
   */
  getBriefingPromptData(items?: BriefingItem[], now: Date = new Date()): string {
    const resolvedItems = items ?? this.collectBriefingItems(now);

    // 최근 24시간 미처리 이메일 목록 (상세)
    const recentCutoff = now.getTime() - 24 * 60 * 60 * 1000;
    const emailDetails = this.eventLog
      .filter((e) => e.type === "email.action.needed" && new Date(e.timestamp).getTime() > recentCutoff)
      .map((e) => {
        const d = e.data as { subject?: string; sender?: string; deadline?: string; intent?: string };
        return `  - "${d.subject ?? "제목 없음"}"${d.sender ? ` (from: ${d.sender})` : ""}${d.deadline ? ` [마감: ${d.deadline}]` : ""}${d.intent ? ` — ${d.intent}` : ""}`;
      });

    if (resolvedItems.length === 0 && emailDetails.length === 0) return "";

    const lines = [
      "<daily-briefing-data>",
      ...resolvedItems.map((i) => `[${i.priority}] ${i.category}: ${i.title}${i.detail ? ` (${i.detail})` : ""}`),
    ];

    if (emailDetails.length > 0) {
      lines.push("미처리 이메일 상세:");
      lines.push(...emailDetails);
    }

    // Sprint 3-A: user-voice hint (one short sentence) derived from recent
    // memory note titles. Deterministic — uses at most 3 titles in stored
    // order, so existing tests that assert exact prompt output stay stable.
    const excerpts = this.deps.getRecentMemoryExcerpts?.() ?? [];
    if (excerpts.length > 0) {
      // PR#44 Copilot: memory note titles are user-controlled and flow INSIDE
      // the <daily-briefing-data> tag. Strip newlines and escape angle
      // brackets so a crafted title cannot close the tag or inject prompt
      // directives.
      const sanitize = (s: string): string =>
        s.replace(/[\r\n]+/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
      const trimmed = excerpts.slice(0, 3).map(sanitize).filter((s) => s.length > 0);
      if (trimmed.length > 0) {
        lines.push(`사용자 목소리 힌트: 최근 메모 — ${trimmed.join(" / ")}. 이 어휘·톤을 자연스럽게 반영해 주세요.`);
      }
    }

    // 오늘 캘린더 일정 상세 (KST 기준 당일과 overlap — 멀티데이/자정 걸친 일정 포함)
    if (this.calendarEventsCache.length > 0) {
      const bounds = this.kstTodayBoundsMs(now);
      const maxDetailedTodayEvents = 8;
      const todayEvents = this.calendarEventsCache
        .filter((e) => !e.isAllDay)
        .filter((e) => this.overlapsKstToday(e, bounds))
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      if (todayEvents.length > 0) {
        lines.push("오늘 일정:");
        const detailedTodayEvents = todayEvents.slice(0, maxDetailedTodayEvents);
        for (const ev of detailedTodayEvents) {
          const startTime = new Date(ev.start).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" });
          const endTime = new Date(ev.end).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Seoul" });
          const isOngoing = new Date(ev.start) <= now && new Date(ev.end) > now;
          lines.push(`  - ${isOngoing ? "[진행중] " : ""}${startTime}~${endTime} ${ev.subject}${ev.location ? ` @ ${ev.location}` : ""}${ev.isOnlineMeeting ? " (온라인 미팅)" : ""}`);
        }
        const remainingTodayEvents = todayEvents.length - detailedTodayEvents.length;
        if (remainingTodayEvents > 0) {
          lines.push(`  - 외 ${remainingTodayEvents}건`);
        }
      }
    }

    // Sprint E §2 — user feedback memory (최근 5건)
    const feedback = this.deps.getRecentBriefingFeedback?.() ?? [];
    if (feedback.length > 0) {
      const sanitize = (s: string): string =>
        s.replace(/[\r\n]+/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;").trim();
      lines.push("User feedback memory (최근 브리핑 dismiss 사유 — 다음 브리핑 톤 조정에 참고):");
      for (const f of feedback.slice(-5)) {
        const details = f.details ? ` — ${sanitize(f.details)}` : "";
        lines.push(`  - [${sanitize(f.date)}] ${sanitize(f.reason)}${details}`);
      }
    }

    lines.push("</daily-briefing-data>");
    return lines.join("\n");
  }
}

function inferHintFromEventType(eventType: string): ProactiveEventHint | undefined {
  const [prefix] = eventType.split(".");
  if (prefix === "meeting") {
    return { category: "meeting", priority: "medium", title: "회의 이벤트" };
  }
  if (prefix === "email") {
    return { category: "email", priority: "medium", title: "이메일 이벤트" };
  }
  if (prefix === "calendar") {
    return { category: "calendar", priority: "low", title: "일정 이벤트" };
  }
  return { category: "system", priority: "low", title: eventType };
}

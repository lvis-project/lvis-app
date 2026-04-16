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
}

export class ProactiveEngine {
  private readonly deps: ProactiveEngineDeps;
  private readonly eventLog: Array<{ type: string; data: unknown; timestamp: string }> = [];
  private calendarEventsCache: CachedCalendarEvent[] = [];

  constructor(deps: ProactiveEngineDeps) {
    this.deps = deps;
  }

  /** 캘린더 이벤트 캐시 업데이트 (boot.ts에서 호출) */
  updateCalendarEvents(events: CachedCalendarEvent[]): void {
    this.calendarEventsCache = events;
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

  /** 브리핑 데이터 수집 — LLM 요약 전 단계 */
  collectBriefingItems(): BriefingItem[] {
    const items: BriefingItem[] = [];

    // 1. 태스크 (미완료, 기한 임박)
    const tasks = this.deps.getTaskSummary();
    const pendingTasks = tasks.filter((t) => t.status === "pending");
    const today = new Date().toISOString().slice(0, 10);

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
      const age = Date.now() - s.modifiedAt.getTime();
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
    const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const recentEvents = this.eventLog.filter(
      (e) => new Date(e.timestamp).getTime() > recentCutoff,
    );

    const meetingEvents = recentEvents.filter((e) => e.type === "meeting.summary.created");
    if (meetingEvents.length > 0) {
      items.push({
        category: "meeting",
        priority: "medium",
        title: `회의 요약 ${meetingEvents.length}건`,
      });
    }

    // 5. 오늘 캘린더 일정
    if (this.calendarEventsCache.length > 0) {
      const now = new Date();
      const upcomingEvents = this.calendarEventsCache
        .filter((e) => !e.isAllDay && new Date(e.start) > now)
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      const allDayEvents = this.calendarEventsCache.filter((e) => e.isAllDay);
      const ongoingEvents = this.calendarEventsCache.filter(
        (e) => !e.isAllDay && new Date(e.start) <= now && new Date(e.end) > now,
      );

      // 진행 중 일정 — 높은 우선순위
      for (const ev of ongoingEvents) {
        const endTime = new Date(ev.end).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
        items.push({
          category: "calendar",
          priority: "high",
          title: `[진행 중] ${ev.subject}`,
          detail: `${endTime}까지${ev.location ? ` — ${ev.location}` : ""}${ev.isOnlineMeeting ? " (온라인)" : ""}`,
        });
      }

      // 예정 일정 (최대 3개)
      for (const ev of upcomingEvents.slice(0, 3)) {
        const startTime = new Date(ev.start).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
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

    const emailEvents = recentEvents.filter((e) => e.type === "email.action.needed");
    if (emailEvents.length > 0) {
      // 우선순위별 분류
      const highEmails = emailEvents.filter((e) => (e.data as { priority?: string })?.priority === "high");
      const topEmail = emailEvents[emailEvents.length - 1]?.data as {
        subject?: string; sender?: string; deadline?: string; intent?: string; priority?: string;
      } | undefined;

      items.push({
        category: "email",
        priority: highEmails.length > 0 ? "high" : "medium",
        title: `액션 필요 이메일 ${emailEvents.length}건`,
        detail: topEmail?.subject
          ? `${topEmail.sender ? `${topEmail.sender} — ` : ""}${topEmail.subject}${topEmail.deadline ? ` (마감: ${topEmail.deadline})` : ""}`
          : undefined,
      });
    }

    return items.sort((a, b) => {
      const order = { high: 0, medium: 1, low: 2 };
      return order[a.priority] - order[b.priority];
    });
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

  /** LLM 브리핑용 프롬프트 데이터 생성 (ConversationLoop에서 호출) */
  getBriefingPromptData(): string {
    const items = this.collectBriefingItems();

    // 최근 24시간 미처리 이메일 목록 (상세)
    const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
    const emailDetails = this.eventLog
      .filter((e) => e.type === "email.action.needed" && new Date(e.timestamp).getTime() > recentCutoff)
      .map((e) => {
        const d = e.data as { subject?: string; sender?: string; deadline?: string; intent?: string };
        return `  - "${d.subject ?? "제목 없음"}"${d.sender ? ` (from: ${d.sender})` : ""}${d.deadline ? ` [마감: ${d.deadline}]` : ""}${d.intent ? ` — ${d.intent}` : ""}`;
      });

    if (items.length === 0 && emailDetails.length === 0) return "";

    const lines = [
      "<daily-briefing-data>",
      ...items.map((i) => `[${i.priority}] ${i.category}: ${i.title}${i.detail ? ` (${i.detail})` : ""}`),
    ];

    if (emailDetails.length > 0) {
      lines.push("미처리 이메일 상세:");
      lines.push(...emailDetails);
    }

    // 오늘 캘린더 일정 상세
    if (this.calendarEventsCache.length > 0) {
      const now = new Date();
      const todayEvents = this.calendarEventsCache
        .filter((e) => !e.isAllDay)
        .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
      if (todayEvents.length > 0) {
        lines.push("오늘 일정:");
        for (const ev of todayEvents) {
          const startTime = new Date(ev.start).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
          const endTime = new Date(ev.end).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
          const isOngoing = new Date(ev.start) <= now && new Date(ev.end) > now;
          lines.push(`  - ${isOngoing ? "[진행중] " : ""}${startTime}~${endTime} ${ev.subject}${ev.location ? ` @ ${ev.location}` : ""}${ev.isOnlineMeeting ? " (온라인 미팅)" : ""}`);
        }
      }
    }

    lines.push("</daily-briefing-data>");
    return lines.join("\n");
  }
}

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
  category: "task" | "note" | "session" | "meeting" | "email" | "system";
  priority: "high" | "medium" | "low";
  title: string;
  detail?: string;
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

  constructor(deps: ProactiveEngineDeps) {
    this.deps = deps;
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

    const emailEvents = recentEvents.filter((e) => e.type === "email.action.needed");
    if (emailEvents.length > 0) {
      items.push({
        category: "email",
        priority: "high",
        title: `액션 필요 이메일 ${emailEvents.length}건`,
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
    if (items.length === 0) return "";

    return [
      "<daily-briefing-data>",
      ...items.map((i) => `[${i.priority}] ${i.category}: ${i.title}${i.detail ? ` (${i.detail})` : ""}`),
      "</daily-briefing-data>",
    ].join("\n");
  }
}

/**
 * Work Board reports (Hermes "reporting" surface) — host-native daily + weekly.
 *
 * The board is a first-class host domain (architecture.md §10.0.3), so the HOST
 * generates the personal work reports the agent-hub plugin used to: it gathers
 * the board state + the period's activity-log events + the learned work-flow
 * memory, builds a Korean prompt, calls the host one-shot LLM
 * (`ConversationLoop.generateText` via `createCallLlm`), persists the markdown
 * under `~/.lvis/work-board/reports/{daily,weekly}/`, and appends a bounded
 * one-line summary to `MEMORY.md` (the self-improvement loop).
 *
 * No-Fallback: an LLM failure surfaces (the report IS the deliverable, so a
 * canned-text stub would silently hide a provider outage). An empty board /
 * empty period short-circuits to an `empty` envelope with NO LLM call.
 *
 * "Today" / "this week" are KST calendar boundaries (see ./schedule.ts). All
 * time inputs flow through an injectable `now()` so report windows are
 * deterministically testable.
 */
import {
  appendMemory,
  renderWorkContext,
  type MemoryStorage,
} from "./work-memory.js";
import { readActivity, type ActivityStorage } from "./activity-log.js";
import { isoWeekFor, kstDay, kstDayBounds, sundayWeekBoundsKst } from "./schedule.js";
import type { WorkBoardStorage } from "./storage.js";
import type {
  WorkItemListResult,
  WorkItemResolved,
  WorkBoardReportKind,
} from "../shared/work-board-types.js";

/** Host one-shot LLM caller — shape of `createCallLlm(conversationLoop)`. */
export interface CallLlm {
  (prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }): Promise<string>;
}

/** Narrow board reader the reports need (satisfied by WorkBoardStore). */
export interface ReportBoardReader {
  list(): Promise<WorkItemListResult>;
}

/** Storage slice for writing report markdown (write auto-creates parents). */
export type ReportStorage = Pick<WorkBoardStorage, "write" | "mkdir">;

/** Report kind — re-aliased from the renderer-safe wire SOT (single source). */
export type ReportKind = WorkBoardReportKind;

/**
 * Reporter return — `ok` carries the markdown + period; `empty` skips the LLM.
 * The `error` variant is added at the IPC boundary, not here (the reporter
 * surfaces LLM failures by throwing — No-Fallback).
 */
export type ReportResult =
  | { status: "ok"; kind: ReportKind; period: string; markdown: string }
  | { status: "empty"; kind: ReportKind; period: string; reason: string };

export interface DailyReportInput {
  /** Override the target day (`YYYY-MM-DD`, KST). Default: today KST. */
  date?: string;
}

export interface WeeklyReportInput {
  /** Override the target ISO week (`YYYY-Www`). Default: current week KST. */
  weekIso?: string;
  /** Sunday-week offset relative to now (0 = this week, -1 = last week). */
  weekOffset?: number;
}

/** Host event emitted after a report is generated (slim notification pointer). */
export const REPORT_GENERATED_EVENT = "work_board.report.generated";

const DAILY_DIR = "reports/daily";
const WEEKLY_DIR = "reports/weekly";
const DAILY_SYSTEM_PROMPT =
  "당신은 개인 업무 보드 비서입니다. 오늘 하루의 업무 진행 상황을 간결한 한국어 마크다운으로 정리합니다.";
const WEEKLY_SYSTEM_PROMPT =
  "당신은 개인 업무 보드 비서입니다. 한 주의 업무를 5섹션(성과 / 이슈 / 다음 주 / 지원 요청 / 지표) 한국어 마크다운 주간보고로 정리합니다.";
const WEEKLY_PROMPT_SUFFIX =
  "위 데이터를 바탕으로 다음 5섹션 한국어 마크다운 주간보고를 작성하세요: " +
  "## 성과 / ## 이슈 / ## 다음 주 / ## 지원 요청 / ## 지표. " +
  "지표 섹션에는 완료/신규/지연 건수를 요약하세요.";

/** Dependencies for the reporter. One storage handle backs memory/activity/report. */
export interface WorkBoardReporterDeps {
  store: ReportBoardReader;
  storage: WorkBoardStorage;
  callLlm: CallLlm;
  emit?: (type: string, data?: unknown) => void;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface WorkBoardReporter {
  generateDaily(input?: DailyReportInput): Promise<ReportResult>;
  generateWeekly(input?: WeeklyReportInput): Promise<ReportResult>;
  generate(kind: ReportKind, input?: DailyReportInput & WeeklyReportInput): Promise<ReportResult>;
}

function lineFor(item: WorkItemResolved): string {
  const due = item.due_at ? ` (마감 ${item.due_at.slice(0, 10)})` : "";
  return `- [${item.priority}] #${item.id} ${item.title}${due}`;
}

function isWithin(iso: string | undefined, startMs: number, endMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= startMs && t < endMs;
}

function bucket(label: string, items: WorkItemResolved[]): string {
  return `## ${label} (${items.length})\n${items.length ? items.map(lineFor).join("\n") : "- 없음"}`;
}

/**
 * Construct the reporter. The storage handle is sliced internally into the
 * memory / activity / report seams so callers pass exactly one
 * work-board-namespaced storage.
 */
export function createWorkBoardReporter(deps: WorkBoardReporterDeps): WorkBoardReporter {
  const { store, storage, callLlm } = deps;
  const memory: MemoryStorage = storage;
  const activity: ActivityStorage = storage;
  const report: ReportStorage = storage;
  const nowMs = (): number => (deps.now ? deps.now() : Date.now());

  async function items(): Promise<WorkItemResolved[]> {
    const listed = await store.list();
    // Discriminated envelope: a non-ok list means the board is unreadable — the
    // report cannot be built, so the callers below treat [] as "empty".
    return listed.status === "ok" ? listed.items : [];
  }

  async function generateDaily(input?: DailyReportInput): Promise<ReportResult> {
    const period = input?.date ?? kstDay(nowMs());
    const bounds = kstDayBounds(period);
    if (!bounds) {
      return { status: "empty", kind: "daily", period, reason: "invalid date — expected YYYY-MM-DD" };
    }

    const all = await items();
    if (all.length === 0) {
      return { status: "empty", kind: "daily", period, reason: "보드에 작업 항목이 없습니다." };
    }

    const planned = all.filter((i) => i.status_resolved === "planned");
    const inProgress = all.filter((i) => i.status_resolved === "in_progress");
    const overdue = all.filter((i) => i.status_resolved === "overdue");
    const createdToday = all.filter((i) => isWithin(i.created_at, bounds.startMs, bounds.endMs));
    const completedToday = all.filter((i) => isWithin(i.completed_at, bounds.startMs, bounds.endMs));

    const recentActivity = await readActivity(activity, new Date(bounds.startMs).toISOString());
    const workContext = await renderWorkContext(memory);

    const prompt =
      [
        `# ${period} 데일리 리포트 입력`,
        workContext,
        bucket("오늘 완료", completedToday),
        bucket("오늘 추가", createdToday),
        bucket("진행 중", inProgress),
        bucket("예정", planned),
        bucket("지연", overdue),
        `## 오늘 활동 로그 (${recentActivity.length})\n${
          recentActivity.length
            ? recentActivity.map((e) => `- ${e.ts} ${e.kind} #${e.itemId ?? ""} ${e.title ?? ""}`).join("\n")
            : "- 없음"
        }`,
      ].join("\n\n") +
      "\n\n위 데이터를 바탕으로 오늘 하루 업무를 다음 구성으로 정리하세요: " +
      "1) 오늘의 성과, 2) 진행 중인 일, 3) 주의가 필요한 지연 항목, 4) 내일 우선순위. " +
      "간결한 한국어 마크다운으로 작성하세요.";

    const markdown = await callLlm(prompt, { maxTokens: 800, systemPrompt: DAILY_SYSTEM_PROMPT });

    await report.mkdir(DAILY_DIR);
    await report.write(`${DAILY_DIR}/${period}.md`, markdown);
    await appendMemory(memory, [
      `${period}: 완료 ${completedToday.length}건 · 신규 ${createdToday.length}건 · 진행 ${inProgress.length}건 · 지연 ${overdue.length}건`,
    ]);
    deps.emit?.(REPORT_GENERATED_EVENT, { kind: "daily", period });

    return { status: "ok", kind: "daily", period, markdown };
  }

  async function generateWeekly(input?: WeeklyReportInput): Promise<ReportResult> {
    const ref = new Date(nowMs());
    const { start, end } = sundayWeekBoundsKst(ref, input?.weekOffset ?? 0);
    const period = input?.weekIso ?? isoWeekFor(start);
    const startMs = start.getTime();
    const endMs = end.getTime();

    const all = await items();
    const completedThisWeek = all.filter((i) => isWithin(i.completed_at, startMs, endMs));
    const createdThisWeek = all.filter((i) => isWithin(i.created_at, startMs, endMs));
    const inProgress = all.filter((i) => i.status_resolved === "in_progress");
    const planned = all.filter((i) => i.status_resolved === "planned");
    const overdue = all.filter((i) => i.status_resolved === "overdue");

    const weekActivity = await readActivity(activity, start.toISOString());

    if (completedThisWeek.length === 0 && createdThisWeek.length === 0 && weekActivity.length === 0) {
      return { status: "empty", kind: "weekly", period, reason: "이번 주 보드 활동이 없습니다." };
    }

    const workContext = await renderWorkContext(memory);
    const prompt =
      [
        `# ${period} 주간보고 입력 (${start.toISOString().slice(0, 10)} ~ ${end.toISOString().slice(0, 10)})`,
        workContext,
        bucket("이번 주 완료", completedThisWeek),
        bucket("이번 주 신규", createdThisWeek),
        bucket("진행 중", inProgress),
        bucket("예정", planned),
        bucket("지연", overdue),
        `## 활동 로그 (${weekActivity.length})\n${
          weekActivity.length
            ? weekActivity.map((e) => `- ${e.ts} ${e.kind} #${e.itemId ?? ""} ${e.title ?? ""}`).join("\n")
            : "- 없음"
        }`,
      ].join("\n\n") +
      `\n\n${WEEKLY_PROMPT_SUFFIX}`;

    const markdown = await callLlm(prompt, { maxTokens: 1000, systemPrompt: WEEKLY_SYSTEM_PROMPT });

    await report.mkdir(WEEKLY_DIR);
    await report.write(`${WEEKLY_DIR}/${period}.md`, markdown);
    await appendMemory(memory, [
      `${period}: 주간 완료 ${completedThisWeek.length}건 · 신규 ${createdThisWeek.length}건 · 지연 ${overdue.length}건`,
    ]);
    deps.emit?.(REPORT_GENERATED_EVENT, { kind: "weekly", period });

    return { status: "ok", kind: "weekly", period, markdown };
  }

  return {
    generateDaily,
    generateWeekly,
    generate: (kind, input) =>
      kind === "weekly" ? generateWeekly(input) : generateDaily(input),
  };
}

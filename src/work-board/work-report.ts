/**
 * Work Board reports (Hermes "reporting" surface) — host-native daily + weekly.
 *
 * The board is a first-class host domain (architecture.md §10.0.3), so the HOST
 * generates the personal work reports the legacy board plugin used to: it gathers
 * the board state + the period's activity-log events + the learned work-flow
 * memory, builds an English-first prompt, calls the host one-shot LLM
 * (`ConversationLoop.generateText` via `createCallLlm`), persists the markdown
 * under the work-board report namespace (project reports live under
 * `reports/projects/<project-key>/{daily,weekly}/`), and appends a bounded
 * one-line summary to work memory (the self-improvement loop).
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
import { workBoardProjectStorageKey } from "./project-storage.js";
import { isoWeekFor, kstDay, kstDayBounds, sundayWeekBoundsKst } from "./schedule.js";
import type { WorkBoardStorage } from "./storage.js";
import type {
  WorkItemListResult,
  WorkItemResolved,
  WorkBoardReportKind,
  WorkItemListFilter,
} from "../shared/work-board-types.js";

/** Host one-shot LLM caller — shape of `createCallLlm(conversationLoop)`. */
export interface CallLlm {
  (prompt: string, opts?: { maxTokens?: number; systemPrompt?: string }): Promise<string>;
}

/** Narrow board reader the reports need (satisfied by WorkBoardStore). */
export interface ReportBoardReader {
  list(filter?: WorkItemListFilter): Promise<WorkItemListResult>;
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
  projectRoot?: string;
  includeUnscoped?: boolean;
}

export interface WeeklyReportInput {
  /** Override the target ISO week (`YYYY-Www`). Default: current week KST. */
  weekIso?: string;
  /** Sunday-week offset relative to now (0 = this week, -1 = last week). */
  weekOffset?: number;
  projectRoot?: string;
  includeUnscoped?: boolean;
}

type ReportProjectOptions = Pick<DailyReportInput, "projectRoot" | "includeUnscoped">;

/** Host event emitted after a report is generated (slim notification pointer). */
export const REPORT_GENERATED_EVENT = "work_board.report.generated";

const DAILY_DIR = "reports/daily";
const WEEKLY_DIR = "reports/weekly";
const PROJECT_REPORTS_DIR = "reports/projects";
const DAILY_SYSTEM_PROMPT =
  "You are a personal Work Board assistant. Summarize today's work progress in concise English Markdown.";
const WEEKLY_SYSTEM_PROMPT =
  "You are a personal Work Board assistant. Summarize the week as a five-section English Markdown weekly report: Wins / Issues / Next Week / Support Needed / Metrics.";
const WEEKLY_PROMPT_SUFFIX =
  "Based on the data above, write a five-section English Markdown weekly report: " +
  "## Wins / ## Issues / ## Next Week / ## Support Needed / ## Metrics. " +
  "In the Metrics section, summarize completed, newly created, and overdue counts.";

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
  const due = item.due_at ? ` (due ${item.due_at.slice(0, 10)})` : "";
  return `- [${item.priority}] #${item.id} ${item.title}${due}`;
}

function isWithin(iso: string | undefined, startMs: number, endMs: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  return !Number.isNaN(t) && t >= startMs && t < endMs;
}

function bucket(label: string, items: WorkItemResolved[]): string {
  return `## ${label} (${items.length})\n${items.length ? items.map(lineFor).join("\n") : "- None"}`;
}

function reportDir(kind: ReportKind, projectRoot: string | undefined): string {
  const key = workBoardProjectStorageKey(projectRoot);
  if (!key) return kind === "daily" ? DAILY_DIR : WEEKLY_DIR;
  return `${PROJECT_REPORTS_DIR}/${key}/${kind}`;
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

  async function items(input?: { projectRoot?: string; includeUnscoped?: boolean }): Promise<WorkItemResolved[]> {
    const listed = await store.list(input?.projectRoot
      ? { projectRoot: input.projectRoot, includeUnscoped: input.includeUnscoped === true }
      : undefined);
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

    const all = await items(input);
    if (all.length === 0) {
      return { status: "empty", kind: "daily", period, reason: "No work items on the board." };
    }

    const planned = all.filter((i) => i.status_resolved === "planned");
    const inProgress = all.filter((i) => i.status_resolved === "in_progress");
    const overdue = all.filter((i) => i.status_resolved === "overdue");
    const createdToday = all.filter((i) => isWithin(i.created_at, bounds.startMs, bounds.endMs));
    const completedToday = all.filter((i) => isWithin(i.completed_at, bounds.startMs, bounds.endMs));

    const visibleItemIds = new Set(all.map((item) => item.id));
    const recentActivity = (await readActivity(activity, new Date(bounds.startMs).toISOString()))
      .filter((event) => event.itemId === undefined || visibleItemIds.has(event.itemId));
    const projectOptions: ReportProjectOptions = {
      ...(input?.projectRoot ? { projectRoot: input.projectRoot } : {}),
      ...(input?.includeUnscoped === true ? { includeUnscoped: true } : {}),
    };
    const workContext = await renderWorkContext(memory, 40, projectOptions);

    const prompt =
      [
        `# ${period} Daily Report Input`,
        workContext,
        bucket("Completed Today", completedToday),
        bucket("Created Today", createdToday),
        bucket("In Progress", inProgress),
        bucket("Planned", planned),
        bucket("Overdue", overdue),
        `## Today's Activity Log (${recentActivity.length})\n${
          recentActivity.length
            ? recentActivity.map((e) => `- ${e.ts} ${e.kind} #${e.itemId ?? ""} ${e.title ?? ""}`).join("\n")
            : "- None"
        }`,
      ].join("\n\n") +
      "\n\nBased on the data above, summarize today's work with this structure: " +
      "1) Today's Wins, 2) Work in Progress, 3) Overdue Items That Need Attention, 4) Tomorrow's Priorities. " +
      "Write concise English Markdown.";

    const markdown = await callLlm(prompt, { maxTokens: 800, systemPrompt: DAILY_SYSTEM_PROMPT });

    const dir = reportDir("daily", input?.projectRoot);
    await report.mkdir(dir);
    await report.write(`${dir}/${period}.md`, markdown);
    await appendMemory(
      memory,
      [
        `${period}: completed ${completedToday.length} · created ${createdToday.length} · in progress ${inProgress.length} · overdue ${overdue.length}`,
      ],
      projectOptions,
    );
    deps.emit?.(REPORT_GENERATED_EVENT, { kind: "daily", period });

    return { status: "ok", kind: "daily", period, markdown };
  }

  async function generateWeekly(input?: WeeklyReportInput): Promise<ReportResult> {
    // Validate a caller-supplied week label BEFORE it is interpolated into the
    // report file path — a `../`-bearing weekIso would otherwise escape the
    // work-board namespace on write. (Daily's date is regex-validated by
    // kstDayBounds; weekly needs the same guard.)
    if (input?.weekIso !== undefined && !/^\d{4}-W\d{2}$/.test(input.weekIso)) {
      return {
        status: "empty",
        kind: "weekly",
        period: input.weekIso,
        reason: "invalid week — expected YYYY-Www",
      };
    }
    const ref = new Date(nowMs());
    const { start, end } = sundayWeekBoundsKst(ref, input?.weekOffset ?? 0);
    const period = input?.weekIso ?? isoWeekFor(start);
    const startMs = start.getTime();
    const endMs = end.getTime();

    const all = await items(input);
    const completedThisWeek = all.filter((i) => isWithin(i.completed_at, startMs, endMs));
    const createdThisWeek = all.filter((i) => isWithin(i.created_at, startMs, endMs));
    const inProgress = all.filter((i) => i.status_resolved === "in_progress");
    const planned = all.filter((i) => i.status_resolved === "planned");
    const overdue = all.filter((i) => i.status_resolved === "overdue");

    const visibleItemIds = new Set(all.map((item) => item.id));
    const weekActivity = (await readActivity(activity, start.toISOString()))
      .filter((event) => event.itemId === undefined || visibleItemIds.has(event.itemId));

    if (completedThisWeek.length === 0 && createdThisWeek.length === 0 && weekActivity.length === 0) {
      return { status: "empty", kind: "weekly", period, reason: "No board activity this week." };
    }

    const projectOptions: ReportProjectOptions = {
      ...(input?.projectRoot ? { projectRoot: input.projectRoot } : {}),
      ...(input?.includeUnscoped === true ? { includeUnscoped: true } : {}),
    };
    const workContext = await renderWorkContext(memory, 40, projectOptions);
    const prompt =
      [
        `# ${period} Weekly Report Input (${start.toISOString().slice(0, 10)} ~ ${end.toISOString().slice(0, 10)})`,
        workContext,
        bucket("Completed This Week", completedThisWeek),
        bucket("Created This Week", createdThisWeek),
        bucket("In Progress", inProgress),
        bucket("Planned", planned),
        bucket("Overdue", overdue),
        `## Activity Log (${weekActivity.length})\n${
          weekActivity.length
            ? weekActivity.map((e) => `- ${e.ts} ${e.kind} #${e.itemId ?? ""} ${e.title ?? ""}`).join("\n")
            : "- None"
        }`,
      ].join("\n\n") +
      `\n\n${WEEKLY_PROMPT_SUFFIX}`;

    const markdown = await callLlm(prompt, { maxTokens: 1000, systemPrompt: WEEKLY_SYSTEM_PROMPT });

    const dir = reportDir("weekly", input?.projectRoot);
    await report.mkdir(dir);
    await report.write(`${dir}/${period}.md`, markdown);
    await appendMemory(
      memory,
      [`${period}: weekly completed ${completedThisWeek.length} · created ${createdThisWeek.length} · overdue ${overdue.length}`],
      projectOptions,
    );
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

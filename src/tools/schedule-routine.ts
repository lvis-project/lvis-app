/**
 * `schedule_routine` LLM tool — creates a persistent routine that fires at a
 * scheduled time (one-off or repeating). The routine survives app restart
 * (persisted to `~/.lvis/routines.json`) and fires via the RoutinesScheduler.
 *
 * Execution modes (Q2):
 *   - "llm-session"       → starts a ConversationLoop with prePrompt
 *   - "notification-only" → fires an OS notification
 *
 * 3 input styles (Q4):
 *   1. Form:           at + repeat.kind + repeat fields
 *   2. Cron:           repeat.kind="cron" + repeat.expression
 *   3. Natural language: LLM fills the structured fields after parsing user intent
 *
 * Examples
 *   매일 오전 9시 데일리 리포트:
 *     { execution:"llm-session", schedule:{ at:"2026-05-09T09:00:00+09:00",
 *       repeat:{kind:"daily"} }, prePrompt:"오늘의 데일리 리포트 작성", title:"데일리 리포트" }
 *
 *   매주 월요일 9시 업무 정리:
 *     { execution:"llm-session", schedule:{ at:"...", repeat:{kind:"weekly"} }, ... }
 *
 *   크론 표현식 직접:
 *     { execution:"notification-only", schedule:{ repeat:{kind:"cron",
 *       expression:"0 9 * * 1"} }, notificationTitle:"월요일 알림" }
 */
import { createDynamicTool, type Tool } from "./base.js";
import type { RoutinesStore } from "../main/routines-store.js";
import type { RoutineExecution, RoutineRepeat, RoutineSchedule } from "../main/routines-store.js";
import { isValidCronExpression } from "../routines/cron-evaluator.js";

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KST_OFFSET = "+09:00";

function asIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (DATE_ONLY_RE.test(trimmed)) {
    const parsed = new Date(`${trimmed}T09:00:00${KST_OFFSET}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function parseRepeat(raw: unknown): RoutineRepeat | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = r.kind;
  if (kind === "none") return { kind: "none" };
  if (kind === "daily") return { kind: "daily" };
  if (kind === "weekly") return { kind: "weekly" };
  if (kind === "monthly") return { kind: "monthly" };
  if (kind === "interval") {
    const ms = typeof r.intervalMs === "number" && Number.isFinite(r.intervalMs) && r.intervalMs > 0
      ? r.intervalMs
      : null;
    if (!ms) return null;
    return { kind: "interval", intervalMs: ms };
  }
  if (kind === "cron") {
    const expr = typeof r.expression === "string" ? r.expression.trim() : "";
    if (!expr || !isValidCronExpression(expr)) return null;
    return { kind: "cron", expression: expr };
  }
  return null;
}

function parseSchedule(raw: unknown): RoutineSchedule | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;

  const repeat = s.repeat !== undefined ? parseRepeat(s.repeat) : undefined;
  // cron routines do not need an `at` field — next-fire is computed by the scheduler.
  const isCron = repeat?.kind === "cron";

  const at = s.at !== undefined ? asIso(s.at) : undefined;

  // Non-cron schedules require at least an `at` timestamp.
  if (!isCron && !at) return null;

  return {
    ...(at ? { at } : {}),
    ...(repeat ? { repeat } : {}),
  };
}

export function createScheduleRoutineTool(store: RoutinesStore): Tool {
  return createDynamicTool({
    name: "schedule_routine",
    description:
      "특정 시각 또는 반복 일정에 실행될 루틴을 등록합니다. " +
      "execution='llm-session'이면 지정 시각에 LLM 대화를 시작하고, " +
      "'notification-only'이면 OS 알림만 발송합니다. " +
      "반복 방식: none/daily/weekly/monthly/interval/cron. " +
      "예: 매일 오전 9시 데일리 리포트 → execution:'llm-session', " +
      "schedule:{at:'2026-05-09T09:00:00+09:00', repeat:{kind:'daily'}}, " +
      "prePrompt:'오늘의 데일리 리포트 작성'",
    source: "builtin",
    category: "write",
    jsonSchema: {
      type: "object",
      required: ["execution", "schedule"],
      properties: {
        execution: {
          type: "string",
          enum: ["llm-session", "notification-only"],
          description: "실행 모드. llm-session=LLM 대화 시작, notification-only=알림만",
        },
        schedule: {
          type: "object",
          description:
            "스케줄 설정. at: ISO 8601 or YYYY-MM-DD. " +
            "repeat.kind: none|daily|weekly|monthly|interval|cron. " +
            "cron 타입은 repeat.expression(5필드)만 필요.",
          properties: {
            at: {
              type: "string",
              description: "ISO 8601 datetime (예: '2026-05-09T09:00:00+09:00') 또는 YYYY-MM-DD",
            },
            repeat: {
              type: "object",
              properties: {
                kind: { type: "string", enum: ["none", "daily", "weekly", "monthly", "interval", "cron"] },
                intervalMs: { type: "number", description: "interval 타입 전용: ms 단위 간격" },
                expression: { type: "string", description: "cron 타입 전용: 5필드 cron 표현식" },
              },
              required: ["kind"],
            },
          },
        },
        prePrompt: {
          type: "string",
          description: "execution=llm-session 시 LLM에 전달할 초기 프롬프트",
        },
        title: { type: "string", description: "루틴 제목 (선택)" },
        notificationTitle: {
          type: "string",
          description: "execution=notification-only 시 알림 제목",
        },
        notificationBody: {
          type: "string",
          description: "execution=notification-only 시 알림 본문",
        },
      },
    },
    execute: async (rawInput) => {
      const a = (rawInput ?? {}) as Record<string, unknown>;

      const execution = a.execution;
      if (execution !== "llm-session" && execution !== "notification-only") {
        return {
          output: JSON.stringify({ error: "execution must be 'llm-session' or 'notification-only'" }),
          isError: true,
        };
      }

      const schedule = parseSchedule(a.schedule);
      if (!schedule) {
        return {
          output: JSON.stringify({
            error:
              "invalid schedule: provide at least { at } (ISO 8601) for non-cron schedules, " +
              "or { repeat: { kind: 'cron', expression: '...' } } for cron schedules",
          }),
          isError: true,
        };
      }

      if (execution === "llm-session" && typeof a.prePrompt !== "string") {
        return {
          output: JSON.stringify({ error: "prePrompt is required for execution='llm-session'" }),
          isError: true,
        };
      }

      const prePrompt = execution === "llm-session"
        ? (typeof a.prePrompt === "string" ? a.prePrompt.trim() : undefined)
        : undefined;

      const notificationTitle = execution === "notification-only"
        ? (typeof a.notificationTitle === "string" ? a.notificationTitle.trim() : undefined)
        : undefined;
      const notificationBody = execution === "notification-only"
        ? (typeof a.notificationBody === "string" ? a.notificationBody.trim() : undefined)
        : undefined;

      const title = typeof a.title === "string" ? a.title.trim() : undefined;

      try {
        const record = await store.add({
          trigger: "schedule",
          schedule,
          execution: execution as RoutineExecution,
          prePrompt,
          title,
          notificationTitle,
          notificationBody,
        });
        return {
          output: JSON.stringify({ routineId: record.id, schedule: record.schedule }),
          isError: false,
        };
      } catch (err) {
        return {
          output: JSON.stringify({
            error: (err as Error).message ?? "schedule_routine failed",
          }),
          isError: true,
        };
      }
    },
  });
}

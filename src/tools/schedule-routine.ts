/**
 * `schedule_routine` LLM tool — creates a persistent routine that fires at a
 * scheduled time (one-off or repeating). The routine survives app restart
 * (persisted to `~/.lvis/routine/routines.json`) and fires via the RoutinesScheduler.
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

/** Maximum allowed cron expression length (prevents regex DoS on oversized inputs). */
const MAX_CRON_EXPR_LENGTH = 256;

/** Minimum interval: 1 minute (prevents sub-minute polling spam). */
const MIN_INTERVAL_MS = 60_000;

/** Maximum interval: 5 years (matches MAX_FUTURE_OFFSET_MS in routines-store). */
const MAX_INTERVAL_MS = 5 * 365.25 * 24 * 60 * 60 * 1000;

/**
 * Normalize a date/datetime string to a UTC ISO string.
 *
 * Accepts:
 * - ISO 8601 datetime strings (with or without timezone offset)
 * - `YYYY-MM-DD` date-only strings — defaults to **09:00 KST (+09:00)**
 *   when no time component is provided.
 *
 * @returns UTC ISO string, or null if the input cannot be parsed.
 */
function asIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (DATE_ONLY_RE.test(trimmed)) {
    // Default time 09:00 KST when only date provided (YYYY-MM-DD).
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
    const ms = typeof r.intervalMs === "number"
      && Number.isFinite(r.intervalMs)
      && r.intervalMs >= MIN_INTERVAL_MS
      && r.intervalMs <= MAX_INTERVAL_MS
      ? r.intervalMs
      : null;
    if (!ms) return null;
    return { kind: "interval", intervalMs: ms };
  }
  if (kind === "cron") {
    const raw = typeof r.expression === "string" ? r.expression : "";
    const expr = raw.trim();
    if (!expr || expr.length > MAX_CRON_EXPR_LENGTH || !isValidCronExpression(expr)) return null;
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

function parseAllowedPlugins(raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const ids = raw.map((v) => (typeof v === "string" ? v.trim() : ""));
  if (ids.some((v) => !v || !/^[a-z0-9][a-z0-9_.-]*$/i.test(v))) return null;
  return [...new Set(ids)];
}

export function scheduleRoutineApprovalCacheKey(rawInput: unknown): string {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const allowedPlugins = parseAllowedPlugins(input.allowedPlugins);
  if (!allowedPlugins) return "scope:invalid";
  if (allowedPlugins.length === 0) return "scope:deny-all";
  return `scope:allow:${[...allowedPlugins].sort().join(",")}`;
}

export function createScheduleRoutineTool(store: RoutinesStore): Tool {
  return createDynamicTool({
    name: "schedule_routine",
    description:
      "특정 시각 또는 반복 일정에 실행될 루틴을 등록합니다. " +
      "execution='llm-session'이면 지정 시각에 LLM 대화를 시작하고, " +
      "'notification-only'이면 OS 알림만 발송합니다. " +
      "반복 방식: none/daily/weekly/monthly/interval/cron. " +
      "schedule.at 에 날짜만 제공(YYYY-MM-DD)하면 기본 시각 09:00 KST 로 처리됩니다. " +
      "예: 매일 오전 9시 데일리 리포트 → execution:'llm-session', " +
      "schedule:{at:'2026-05-09T09:00:00+09:00', repeat:{kind:'daily'}}, " +
      "prePrompt:'오늘의 데일리 리포트 작성'",
    source: "builtin",
    category: "write",
    approvalCacheKey: scheduleRoutineApprovalCacheKey,
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
        allowedPlugins: {
          type: "array",
          description:
            "execution=llm-session 루틴에서 노출할 플러그인 id 목록. 미지정 또는 []이면 플러그인 도구를 사용하지 않습니다.",
          items: { type: "string" },
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

      if (execution === "llm-session") {
        if (typeof a.prePrompt !== "string" || (a.prePrompt as string).trim().length === 0) {
          return {
            output: JSON.stringify({ error: "prePrompt is required and must be non-empty for execution='llm-session'" }),
            isError: true,
          };
        }
      }

      if (execution === "notification-only") {
        if (typeof a.notificationTitle !== "string" || (a.notificationTitle as string).trim().length === 0) {
          return {
            output: JSON.stringify({ error: "notificationTitle is required and must be non-empty for execution='notification-only'" }),
            isError: true,
          };
        }
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
      const allowedPlugins = parseAllowedPlugins(a.allowedPlugins);
      if (!allowedPlugins) {
        return {
          output: JSON.stringify({ error: "allowedPlugins must be an array of valid plugin id strings" }),
          isError: true,
        };
      }

      // Permission policy Layer 4 — translate the LLM-facing `allowedPlugins` field
      // into the canonical `scope` discriminated union. Missing or []
      // both mean explicit deny-all; non-empty means explicit allow-list.
      const pluginIds = allowedPlugins.length === 0
        ? ({ mode: "deny-all" } as const)
        : ({ mode: "allow", ids: allowedPlugins } as const);

      try {
        const record = await store.add({
          trigger: "schedule",
          schedule,
          execution: execution as RoutineExecution,
          prePrompt,
          title,
          notificationTitle,
          notificationBody,
          scope: {
            pluginIds,
            forcedPluginIds: [],
            directories: [],
          },
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

/**
 * `remind_at` LLM tool — schedules a persistent reminder. The reminder
 * survives app restart (persisted to `~/.lvis/reminders.json`) and fires
 * `lvis:reminder:fired` when the time arrives. The renderer's
 * RemindersList sidebar surface lets the user dismiss / cancel.
 */
import { createDynamicTool, type Tool } from "./base.js";
import type { RemindersStore, ReminderRepeat } from "../main/reminders-store.js";

const REPEAT_VALUES: ReminderRepeat[] = ["daily", "weekly", "none"];
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KST_OFFSET = "+09:00";

function asReminderIso(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (DATE_ONLY_RE.test(trimmed)) {
    // Bare date → 09:00 KST (sensible morning default).
    const parsed = new Date(`${trimmed}T09:00:00${KST_OFFSET}`);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function createRemindAtTool(store: RemindersStore): Tool {
  return createDynamicTool({
    name: "remind_at",
    description:
      "특정 시각에 사용자에게 다시 알릴 리마인더를 등록합니다. 반복(repeat)도 가능. " +
      "예: '내일 오전 9시에 회의 준비 알려줘'. 등록 시 reminderId 반환. " +
      "리마인더 시각 도달 시 사이드바에 알림이 뜬다.",
    source: "builtin",
    category: "write",
    jsonSchema: {
      type: "object",
      required: ["at", "title"],
      properties: {
        at: {
          type: "string",
          description:
            "ISO 8601 datetime (예: '2026-04-30T09:00:00+09:00') 또는 YYYY-MM-DD (KST 09:00 기본).",
        },
        title: { type: "string", description: "리마인더 제목 (한 줄)" },
        body: { type: "string", description: "부가 본문 (선택)" },
        repeat: {
          type: "string",
          enum: REPEAT_VALUES,
          description: "반복 주기. 기본 'none'.",
        },
      },
    },
    execute: async (rawInput) => {
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const at = asReminderIso(a.at);
      if (!at) {
        return {
          output: JSON.stringify({
            error: "invalid `at`: expected ISO 8601 or YYYY-MM-DD",
          }),
          isError: true,
        };
      }
      const title = typeof a.title === "string" ? a.title.trim() : "";
      if (!title) {
        return {
          output: JSON.stringify({ error: "title is required" }),
          isError: true,
        };
      }
      const repeat: ReminderRepeat =
        typeof a.repeat === "string" &&
        (REPEAT_VALUES as string[]).includes(a.repeat)
          ? (a.repeat as ReminderRepeat)
          : "none";
      const body = typeof a.body === "string" ? a.body : undefined;
      const record = await store.add({ at, title, body, repeat });
      return {
        output: JSON.stringify({ reminderId: record.id, at: record.at }),
        isError: false,
      };
    },
  });
}

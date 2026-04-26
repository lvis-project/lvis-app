/**
 * `todo_session_write` LLM tool — assistant's per-session checklist.
 * Distinct from user `task_*` (persistent): in-memory only, scoped to the
 * active ChatSession via `ctx.metadata.sessionId`. The renderer's
 * SessionTodoPanel surfaces the live list inside the chat view.
 */
import { createDynamicTool, type Tool } from "./base.js";
import type {
  SessionTodoStore,
  SessionTodoStatus,
  SessionTodoUpdate,
} from "../main/session-todo-store.js";

const STATUS_VALUES: SessionTodoStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "deleted",
];

export function createTodoSessionWriteTool(store: SessionTodoStore): Tool {
  return createDynamicTool({
    name: "todo_session_write",
    description:
      "현재 턴 동안 어시스턴트가 따라갈 체크리스트를 작성/갱신합니다. " +
      "사용자 task_* 와 다름 (세션 단위 휘발성). id 를 같이 보내면 merge, " +
      "생략하면 새 항목 생성. status: pending | in_progress | completed | deleted.",
    source: "builtin",
    category: "write",
    jsonSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["content", "status"],
            properties: {
              id: { type: "string", description: "기존 항목 갱신 시 id 전달." },
              content: { type: "string" },
              status: { type: "string", enum: STATUS_VALUES },
            },
          },
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const sessionId =
        typeof ctx.metadata?.sessionId === "string"
          ? (ctx.metadata.sessionId as string)
          : "unknown";
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const itemsRaw = Array.isArray(a.items) ? (a.items as unknown[]) : [];
      const updates: SessionTodoUpdate[] = [];
      for (const it of itemsRaw) {
        if (!it || typeof it !== "object") continue;
        const obj = it as Record<string, unknown>;
        const content = typeof obj.content === "string" ? obj.content : "";
        const status = obj.status as SessionTodoStatus;
        if (!content.trim() || !STATUS_VALUES.includes(status)) continue;
        updates.push({
          id: typeof obj.id === "string" ? obj.id : undefined,
          content,
          status,
        });
      }
      if (updates.length === 0) {
        return {
          output: JSON.stringify({ error: "no valid items provided" }),
          isError: true,
        };
      }
      const merged = store.write(sessionId, updates);
      return {
        output: JSON.stringify({ items: merged }),
        isError: false,
      };
    },
  });
}

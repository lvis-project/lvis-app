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
      "생략하면 새 항목 생성. beforeId/afterId 로 중간 삽입 또는 이동 가능. " +
      "status: pending | in_progress | completed | deleted. " +
      "사용자가 본인의 업무·할 일·태스크를 등록·기록·추가해달라는 요청에는 " +
      "이 도구를 사용하지 마세요 — 영구 업무 항목 등록을 지원하는 플러그인 " +
      "도구가 노출되어 있으면 그쪽을 우선 호출하세요. 본 도구는 어시스턴트가 " +
      "다단계 응답을 풀어가는 *내부 단계 추적* 용도로만 사용합니다.",
    source: "builtin",
    // H1: category="read" — the assistant's own per-session checklist lives
    // entirely in an in-memory store this conversation owns; there is no
    // external mutation, no on-disk persistence, no cross-session impact.
    // Treating each tick as a write would pop an approval modal for every
    // status change, which is a UX regression with zero security gain.
    // The tool does not declare isReadOnly() because the §S4 short-circuit
    // is only consulted when category=read AND ApprovalGate is engaged;
    // category=read alone is sufficient to keep PermissionManager from
    // raising an "ask" decision for the default policy.
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            required: ["status"],
            properties: {
              id: { type: "string", description: "기존 항목 id — 생략 시 신규 생성. id 전달 시 content 생략 가능(기존 내용 유지)." },
              content: { type: "string", description: "항목 내용. 신규 생성 시 필수." },
              status: { type: "string", enum: STATUS_VALUES },
              beforeId: { type: "string", description: "이 항목 앞에 삽입/이동할 기준 id. afterId 보다 우선." },
              afterId: { type: "string", description: "이 항목 뒤에 삽입/이동할 기준 id. 기준이 없으면 뒤에 추가." },
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
        const content = typeof obj.content === "string" ? obj.content : undefined;
        const id = typeof obj.id === "string" ? obj.id : undefined;
        const beforeId = typeof obj.beforeId === "string" ? obj.beforeId : undefined;
        const afterId = typeof obj.afterId === "string" ? obj.afterId : undefined;
        const status = obj.status as SessionTodoStatus;
        // new items require content; updates by id allow content omission
        if (!id && !content?.trim()) continue;
        if (!STATUS_VALUES.includes(status)) continue;
        updates.push({ id, content, status, beforeId, afterId });
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

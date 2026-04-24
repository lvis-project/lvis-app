/**
 * Task LLM tools — expose TaskService operations so the assistant can
 * add/update/list/delete tasks through chat. All writes go through the
 * §6.3 permission stack (category="write" → approval gate), reads are
 * short-circuited (category="read").
 *
 * Output shape: every tool returns a JSON string — callers (LLM, test)
 * parse it back into the structured Task/Task[] they expect.
 */
import { createDynamicTool, type Tool } from "./base.js";
import type {
  Task,
  TaskFilter,
  TaskPriority,
  TaskService,
  TaskStatus,
} from "../taskService.js";

const PRIORITY_VALUES: TaskPriority[] = ["high", "medium", "low"];
const STATUS_VALUES: TaskStatus[] = ["pending", "done", "snoozed"];

/**
 * `YYYY-MM-DD` 입력은 사용자 시각 (KST) 의 **당일 23:59:59** 로 해석한다.
 * `new Date("2026-04-30")` 는 UTC 자정 = KST 09:00 으로 파싱되어 "오늘 마감"
 * 경계가 밀린다. 데드라인 시맨틱상 "4/30 까지" = "4/30 하루가 끝날 때까지"
 * 가 가장 자연스러우므로 KST 의 end-of-day 로 고정. full ISO 입력은 이미
 * timezone 정보가 있으므로 그대로 사용.
 */
const KST_OFFSET = "+09:00";
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function asIsoOrUndef(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (DATE_ONLY_RE.test(trimmed)) {
    const parsed = new Date(`${trimmed}T23:59:59${KST_OFFSET}`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

/**
 * `task_update` 의 `dueAt` 필드가 JSON 으로 받을 수 있는 clear 신호.
 * - omitted (key 없음) → 변경 없음
 * - `null` 또는 `""` → dueAt 지우기
 * - valid date/ISO → set
 */
type DueAtIntent =
  | { kind: "unchanged" }
  | { kind: "clear" }
  | { kind: "set"; iso: string };

function parseDueAtIntent(raw: unknown, hasKey: boolean): DueAtIntent {
  if (!hasKey) return { kind: "unchanged" };
  if (raw === null) return { kind: "clear" };
  if (typeof raw === "string" && raw.trim() === "") return { kind: "clear" };
  const iso = asIsoOrUndef(raw);
  return iso ? { kind: "set", iso } : { kind: "unchanged" };
}

function asPriority(value: unknown): TaskPriority | undefined {
  return PRIORITY_VALUES.includes(value as TaskPriority)
    ? (value as TaskPriority)
    : undefined;
}

function asStatus(value: unknown): TaskStatus | undefined {
  return STATUS_VALUES.includes(value as TaskStatus)
    ? (value as TaskStatus)
    : undefined;
}

function ok(output: unknown): { output: string; isError: false } {
  return { output: JSON.stringify(output), isError: false };
}

function err(message: string): { output: string; isError: true } {
  return { output: JSON.stringify({ error: message }), isError: true };
}

/**
 * Build the task-management tool bundle. Called once from `boot/tools.ts`;
 * the returned array is registered into the shared ToolRegistry.
 */
export function createTaskTools(taskService: TaskService): Tool[] {
  return [
    createDynamicTool({
      name: "task_add",
      description:
        "할 일(Task)을 새로 추가합니다. 사용자가 '~ 할 일 추가해줘' / '~ 까지 해야 함' / " +
        "'리마인더로 저장해줘' 같이 요청할 때 사용. priority 기본 medium, source 기본 'chat'. " +
        "성공 시 생성된 Task 전체를 JSON 으로 반환.",
      source: "builtin",
      category: "write",
      jsonSchema: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string", description: "할 일 제목 (한 줄)" },
          description: { type: "string", description: "부가 설명 (선택)" },
          priority: {
            type: "string",
            enum: PRIORITY_VALUES,
            description: "우선순위. 기본 medium.",
          },
          dueAt: {
            type: "string",
            description:
              "마감일. ISO 8601 (예: '2026-04-30T18:00:00Z') 또는 YYYY-MM-DD (KST 기준 당일 end-of-day 23:59:59+09:00 로 해석).",
          },
          source: {
            type: "string",
            description:
              "출처 라벨 (예: 'chat', 'email:<messageId>', 'meeting:<sessionId>'). 기본 'chat'.",
          },
          sourceRef: {
            type: "string",
            description: "출처 원본 참조 (메일 id, 회의 id 등). 선택.",
          },
        },
      },
      execute: async (rawInput) => {
        const a = (rawInput ?? {}) as Record<string, unknown>;
        const title = typeof a.title === "string" ? a.title.trim() : "";
        if (!title) return err("title is required");
        const task = taskService.add({
          title,
          description: typeof a.description === "string" ? a.description : undefined,
          priority: asPriority(a.priority) ?? "medium",
          status: "pending",
          source: typeof a.source === "string" && a.source.length > 0
            ? a.source
            : "chat",
          sourceRef: typeof a.sourceRef === "string" ? a.sourceRef : undefined,
          dueAt: asIsoOrUndef(a.dueAt),
        });
        return ok(task);
      },
    }),

    createDynamicTool({
      name: "task_update",
      description:
        "기존 Task 를 수정합니다. 완료 처리 (status='done'), 우선순위 변경, 마감일 변경, " +
        "제목/설명 수정 등에 사용. id 는 task_list / task_today / task_overdue 결과에서 " +
        "얻은 값 그대로 전달. 성공 시 갱신된 Task 반환.",
      source: "builtin",
      category: "write",
      jsonSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "Task UUID" },
          title: { type: "string" },
          description: { type: "string" },
          status: {
            type: "string",
            enum: STATUS_VALUES,
            description: "pending | done | snoozed",
          },
          priority: { type: "string", enum: PRIORITY_VALUES },
          dueAt: {
            description:
              "마감일 설정/변경: ISO 8601 또는 YYYY-MM-DD (KST 기준 당일 end-of-day). " +
              "마감일 제거: null 또는 빈 문자열 전달. 필드 생략 시 기존 값 유지.",
            oneOf: [
              { type: "string" },
              { type: "null" },
            ],
          },
        },
      },
      execute: async (rawInput) => {
        const a = (rawInput ?? {}) as Record<string, unknown>;
        const id = typeof a.id === "string" ? a.id.trim() : "";
        if (!id) return err("id is required");
        const existing = taskService.get(id);
        if (!existing) return err(`task not found: ${id}`);

        const patch: Partial<Omit<Task, "id" | "createdAt">> = {};
        if (typeof a.title === "string" && a.title.trim().length > 0) {
          patch.title = a.title.trim();
        }
        if (typeof a.description === "string") {
          patch.description = a.description;
        }
        const status = asStatus(a.status);
        if (status) patch.status = status;
        const priority = asPriority(a.priority);
        if (priority) patch.priority = priority;

        const dueIntent = parseDueAtIntent(
          a.dueAt,
          Object.prototype.hasOwnProperty.call(a, "dueAt"),
        );
        if (dueIntent.kind === "clear") patch.dueAt = undefined;
        else if (dueIntent.kind === "set") patch.dueAt = dueIntent.iso;

        if (Object.keys(patch).length === 0) {
          return err("no updatable fields provided");
        }
        const updated = taskService.update(id, patch);
        return ok(updated);
      },
    }),

    createDynamicTool({
      name: "task_delete",
      description:
        "Task 를 영구 삭제합니다. 완료 처리(`task_update status=done`)와 다름 — 완전 제거. " +
        "사용자가 '취소' / '지워줘' / '삭제' 라고 명시할 때만 사용. 성공 시 { deleted: true, id } 반환.",
      source: "builtin",
      category: "write",
      jsonSchema: {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string", description: "Task UUID" },
        },
      },
      execute: async (rawInput) => {
        const a = (rawInput ?? {}) as Record<string, unknown>;
        const id = typeof a.id === "string" ? a.id.trim() : "";
        if (!id) return err("id is required");
        const existing = taskService.get(id);
        if (!existing) return err(`task not found: ${id}`);
        taskService.delete(id);
        return ok({ deleted: true, id });
      },
    }),

    createDynamicTool({
      name: "task_list",
      description:
        "Task 목록을 필터로 조회합니다. 필터 없으면 전체. status/priority/source 로 좁히거나 " +
        "dueBefore/dueAfter (ISO) 로 기간 필터 가능. " +
        "'오늘 할 일' 은 task_today, '밀린 것' 은 task_overdue 를 우선 사용.",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: {
        type: "object",
        properties: {
          status: {
            oneOf: [
              { type: "string", enum: STATUS_VALUES },
              { type: "array", items: { type: "string", enum: STATUS_VALUES } },
            ],
            description: "단일 status 또는 배열. 예: 'pending' 또는 ['pending','snoozed'].",
          },
          priority: { type: "string", enum: PRIORITY_VALUES },
          source: { type: "string", description: "source 라벨로 필터 (예: 'chat', 'email')." },
          dueBefore: { type: "string", description: "ISO. 이 시각 이전 dueAt 만." },
          dueAfter: { type: "string", description: "ISO. 이 시각 이후 dueAt 만." },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "최대 개수. 기본 100.",
          },
        },
      },
      execute: async (rawInput) => {
        const a = (rawInput ?? {}) as Record<string, unknown>;
        const filter: TaskFilter = {};
        // status: accept string or array
        if (typeof a.status === "string") {
          const s = asStatus(a.status);
          if (s) filter.status = s;
        } else if (Array.isArray(a.status)) {
          const arr = (a.status as unknown[])
            .map((v) => asStatus(v))
            .filter((v): v is TaskStatus => Boolean(v));
          if (arr.length > 0) filter.status = arr;
        }
        const priority = asPriority(a.priority);
        if (priority) filter.priority = priority;
        if (typeof a.source === "string" && a.source.length > 0) {
          filter.source = a.source;
        }
        const dueBefore = asIsoOrUndef(a.dueBefore);
        if (dueBefore) filter.dueBefore = dueBefore;
        const dueAfter = asIsoOrUndef(a.dueAfter);
        if (dueAfter) filter.dueAfter = dueAfter;

        // Schema 선언은 integer — 런타임도 엄격하게 number 만 수용 + floor +
        // clamp. string/float 은 schema 위반으로 간주해 default 로 떨어뜨림.
        const limit =
          typeof a.limit === "number" && Number.isFinite(a.limit)
            ? Math.max(1, Math.min(500, Math.floor(a.limit)))
            : 100;
        const items = taskService.query(filter).slice(0, limit);
        return ok({ count: items.length, items });
      },
    }),

    createDynamicTool({
      name: "task_today",
      description:
        "오늘(KST 기준) 마감인 미완료 Task 목록을 돌려줍니다. 아침 브리핑·'오늘 할 일' 질문에 사용.",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        const items = taskService.getDueToday();
        return ok({ count: items.length, items });
      },
    }),

    createDynamicTool({
      name: "task_overdue",
      description:
        "dueAt 가 현재 시각보다 이전인 pending Task 목록. '밀린 것 뭐 있지?' 류 질문에 사용.",
      source: "builtin",
      category: "read",
      isReadOnly: () => true,
      jsonSchema: { type: "object", properties: {} },
      execute: async () => {
        const items = taskService.getOverdue();
        return ok({ count: items.length, items });
      },
    }),
  ];
}

/**
 * `todo_session_write` LLM tool — assistant's current-turn checklist.
 * Distinct from user `task_*` (persistent): in-memory only, scoped to the
 * active ChatSession id, and cleared at the next explicit user/user-queued
 * turn boundary only after every item is completed.
 */
import { createDynamicTool, type Tool } from "./base.js";
import {
  SessionTodoEmptyPlanError,
  type SessionTodoStore,
} from "../main/session-todo-store.js";
import {
  isSessionTodoUpdateStatus,
  SESSION_TODO_UPDATE_STATUSES,
  type SessionTodoItem,
  type SessionTodoUpdate,
} from "../shared/session-todo.js";
import { t } from "../i18n/index.js";

/**
 * An update changes the plan when it adds/moves an item, deletes one, or
 * shifts an existing item's status or content. A call whose every update
 * leaves the current state untouched by re-marking an existing item (e.g.
 * already-in_progress -> in_progress) is invalid: it burns a full-context
 * round without moving the checklist. We reject that case so the model treats
 * the call as a failed update instead of a successful tool result worth
 * repeating. A delete of an already-absent item remains an idempotent no-op.
 */
function updateChangesPlan(
  u: SessionTodoUpdate,
  current: Map<string, SessionTodoItem>,
): boolean {
  // Reorder intent — we do not compute the resulting order here, so never
  // suppress it.
  if (u.beforeId || u.afterId) return true;
  const cur = u.id ? current.get(u.id) : undefined;
  if (!cur) {
    // No existing item under this id: a delete targets nothing (no-op),
    // anything else creates/adds an item (a real change).
    return u.status !== "deleted";
  }
  if (u.status !== cur.status) return true;
  if (u.content !== undefined && u.content !== cur.content) return true;
  return false;
}

function isMissingDeleteNoOp(
  u: SessionTodoUpdate,
  current: Map<string, SessionTodoItem>,
): boolean {
  return !!u.id && u.status === "deleted" && !current.has(u.id) && !u.beforeId && !u.afterId;
}

export function createTodoSessionWriteTool(store: SessionTodoStore): Tool {
  return createDynamicTool({
    name: "todo_session_write",
    description: t("be_todoSessionWrite.toolDescription"),
    source: "builtin",
    // category="read" — the assistant's own current-turn checklist lives
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
              id: { type: "string", description: t("be_todoSessionWrite.schemaIdDesc") },
              content: { type: "string", description: t("be_todoSessionWrite.schemaContentDesc") },
              status: { type: "string", enum: SESSION_TODO_UPDATE_STATUSES },
              beforeId: { type: "string", description: t("be_todoSessionWrite.schemaBeforeIdDesc") },
              afterId: { type: "string", description: t("be_todoSessionWrite.schemaAfterIdDesc") },
            },
          },
        },
      },
    },
    execute: async (rawInput, ctx) => {
      if (typeof ctx.metadata?.sessionId !== "string" || ctx.metadata.sessionId.length === 0) {
        return {
          output: JSON.stringify({ error: "missing sessionId metadata" }),
          isError: true,
        };
      }
      const sessionId = ctx.metadata.sessionId;
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
        const status = obj.status;
        // new items require content; updates by id allow content omission
        if (!id && !content?.trim()) continue;
        if (!isSessionTodoUpdateStatus(status)) continue;
        updates.push({ id, content, status, beforeId, afterId });
      }
      if (updates.length === 0) {
        return {
          output: JSON.stringify({ error: "no valid items provided" }),
          isError: true,
        };
      }
      // No-op guard — if no update would change the current plan (the
      // already-in_progress re-mark loop), reject it as an invalid update.
      // Returning success with changed:false was not enough in live sessions:
      // the model kept repeating the same no-op and hit TPM. A failed result
      // makes the contract violation explicit and engages the generic
      // "do not retry the same failed tool input" prompt rule.
      const current = new Map(store.list(sessionId).map((i) => [i.id, i]));
      if (!updates.some((u) => updateChangesPlan(u, current))) {
        if (updates.every((u) => isMissingDeleteNoOp(u, current))) {
          return {
            output: JSON.stringify({
              items: store.list(sessionId),
              changed: false,
            }),
            isError: false,
          };
        }
        return {
          output: JSON.stringify({
            items: store.list(sessionId),
            changed: false,
            error: "No item changed state. Do not retry todo_session_write with the same status; continue with work tools and only update the TO-DO when an item actually advances.",
          }),
          isError: true,
        };
      }
      let merged;
      try {
        merged = store.write(sessionId, updates);
      } catch (err) {
        if (!(err instanceof SessionTodoEmptyPlanError)) {
          throw err;
        }
        return {
          output: JSON.stringify({
            error: "todo_session_write cannot delete every item; mark remaining items completed instead",
          }),
          isError: true,
        };
      }
      return {
        output: JSON.stringify({ items: merged }),
        isError: false,
      };
    },
  });
}

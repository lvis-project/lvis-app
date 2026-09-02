/**
 * `session_tasks` LLM tool — the assistant's checklist for the current
 * session. Distinct from user `task_*`: scoped to the active ChatSession id,
 * persisted in that session's metadata sidecar, and addressed by 1-based
 * task number so the model and the user talk about the same "task 1".
 *
 * Every action answers with the full numbered list, so the model never has
 * to remember positions across calls.
 */
import { createDynamicTool, type Tool } from "./base.js";
import {
  SessionTaskIndexError,
  type SessionTasksStore,
} from "../main/session-tasks-store.js";
import type { SessionTaskItem } from "../shared/session-tasks.js";
import { t } from "../i18n/index.js";

const ACTIONS = ["create", "add", "edit", "delete", "complete"] as const;
type SessionTasksAction = (typeof ACTIONS)[number];

const EDIT_STATUSES = ["pending", "in_progress"] as const;

function isAction(value: unknown): value is SessionTasksAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

/**
 * `steps` is a comma-separated string by contract; a JSON array of strings is
 * accepted too because some providers serialize list-shaped arguments that
 * way. Blank entries are dropped, so a trailing comma is harmless.
 */
function parseSteps(raw: unknown): string[] {
  const parts = Array.isArray(raw)
    ? raw.filter((s): s is string => typeof s === "string")
    : typeof raw === "string"
      ? raw.split(",")
      : [];
  return parts.map((s) => s.trim()).filter((s) => s.length > 0);
}

function optionalInteger(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof n === "number" && Number.isInteger(n) ? n : Number.NaN;
}

function numbered(items: SessionTaskItem[]): Array<{ index: number; text: string; status: string }> {
  return items.map((item, i) => ({ index: i + 1, text: item.content, status: item.status }));
}

function failure(error: string) {
  return { output: JSON.stringify({ error }), isError: true };
}

/**
 * A call that leaves the list as it is burns a full-context round for
 * nothing. Returning success was not enough in live sessions — the model kept
 * repeating the same call and hit TPM — so it is a failed update, which
 * engages the generic "do not retry the same failed tool input" prompt rule.
 */
function noChange(detail: string) {
  return failure(`${detail}: nothing changed. Do not retry session_tasks with the same input; continue with work tools and update a task only when it actually advances.`);
}

export function createSessionTasksTool(store: SessionTasksStore): Tool {
  return createDynamicTool({
    name: "session_tasks",
    description: t("be_sessionTasks.toolDescription"),
    source: "builtin",
    // category="read" — the list is this conversation's own bookkeeping,
    // written into its own session sidecar; there is no external mutation
    // and no cross-session impact. Treating each tick as a write would open
    // the approval dock for every status change, which is a UX regression
    // with zero security gain. The tool does not declare isReadOnly() for
    // the §S4 short-circuit alone: category=read is what keeps
    // PermissionManager from raising an "ask" decision under the default policy.
    category: "read",
    isReadOnly: () => true,
    jsonSchema: {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: t("be_sessionTasks.actionDesc"),
        },
        steps: { type: "string", description: t("be_sessionTasks.stepsDesc") },
        after: { type: "integer", minimum: 0, description: t("be_sessionTasks.afterDesc") },
        index: { type: "integer", minimum: 1, description: t("be_sessionTasks.indexDesc") },
        text: { type: "string", description: t("be_sessionTasks.textDesc") },
        status: {
          type: "string",
          enum: EDIT_STATUSES,
          description: t("be_sessionTasks.statusDesc"),
        },
      },
    },
    execute: async (rawInput, ctx) => {
      if (typeof ctx.metadata?.sessionId !== "string" || ctx.metadata.sessionId.length === 0) {
        return failure("missing sessionId metadata");
      }
      const sessionId = ctx.metadata.sessionId;
      const a = (rawInput ?? {}) as Record<string, unknown>;
      if (!isAction(a.action)) {
        return failure(`action must be one of ${ACTIONS.join(", ")}`);
      }
      const index = optionalInteger(a.index);
      const after = optionalInteger(a.after);
      if (Number.isNaN(index)) return failure("index must be an integer task number (1-based)");
      if (Number.isNaN(after)) return failure("after must be an integer task number (0 = front)");
      try {
        let items: SessionTaskItem[];
        switch (a.action) {
          case "create": {
            const steps = parseSteps(a.steps);
            if (steps.length === 0) return failure("create needs steps: a comma-separated list of tasks");
            items = await store.create(sessionId, steps);
            break;
          }
          case "add": {
            const steps = parseSteps(a.steps);
            if (steps.length === 0) return failure("add needs steps: a comma-separated list of tasks");
            items = await store.add(sessionId, steps, after);
            break;
          }
          case "edit": {
            if (index === undefined) return failure("edit needs index: the task number to change");
            const text = typeof a.text === "string" && a.text.trim() ? a.text.trim() : undefined;
            const status = (EDIT_STATUSES as readonly string[]).includes(a.status as string)
              ? (a.status as (typeof EDIT_STATUSES)[number])
              : undefined;
            if (a.status !== undefined && status === undefined) {
              return failure(`status must be one of ${EDIT_STATUSES.join(", ")}; use action=complete to finish a task`);
            }
            if (text === undefined && status === undefined) {
              return failure("edit needs text and/or status");
            }
            const current = store.list(sessionId)[index - 1];
            if (
              current &&
              (text === undefined || text === current.content) &&
              (status === undefined || status === current.status)
            ) {
              return noChange(`task ${index} is already "${current.content}" (${current.status})`);
            }
            items = await store.edit(sessionId, index, { text, status });
            break;
          }
          case "delete": {
            if (index === undefined) return failure("delete needs index: the task number to remove");
            items = await store.delete(sessionId, index);
            break;
          }
          case "complete": {
            if (index === undefined) return failure("complete needs index: the task number that is done");
            if (store.list(sessionId)[index - 1]?.status === "completed") {
              return noChange(`task ${index} is already completed`);
            }
            items = await store.complete(sessionId, index);
            break;
          }
        }
        return { output: JSON.stringify({ tasks: numbered(items) }), isError: false };
      } catch (err) {
        if (err instanceof SessionTaskIndexError) {
          return {
            output: JSON.stringify({ error: err.message, tasks: numbered(store.list(sessionId)) }),
            isError: true,
          };
        }
        throw err;
      }
    },
  });
}

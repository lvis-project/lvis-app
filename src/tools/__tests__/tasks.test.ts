import { describe, expect, it, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createTaskTools } from "../tasks.js";
import type { Task, TaskFilter, TaskService } from "../../taskService.js";
import type { Tool, ToolExecutionContext } from "../base.js";

/**
 * Plain in-memory TaskService mock — mirrors the public interface exactly
 * so we verify the tool wiring (arg parsing, error mapping, field filtering)
 * without hitting SQLite/native bindings.
 */
function makeService(): TaskService {
  const store = new Map<string, Task>();
  const now = () => new Date().toISOString();

  const svc = {
    add(task: Omit<Task, "id" | "createdAt" | "updatedAt">): Task {
      const t: Task = {
        id: randomUUID(),
        createdAt: now(),
        updatedAt: now(),
        ...task,
      };
      store.set(t.id, t);
      return t;
    },
    get(id: string): Task | undefined {
      return store.get(id);
    },
    update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task {
      const existing = store.get(id);
      if (!existing) throw new Error(`not found: ${id}`);
      const updated: Task = { ...existing, ...patch, id, updatedAt: now() };
      store.set(id, updated);
      return updated;
    },
    delete(id: string): void {
      store.delete(id);
    },
    query(filter: TaskFilter): Task[] {
      let items = [...store.values()];
      if (filter.status) {
        const set = Array.isArray(filter.status)
          ? new Set(filter.status)
          : new Set([filter.status]);
        items = items.filter((t) => set.has(t.status));
      }
      if (filter.priority) items = items.filter((t) => t.priority === filter.priority);
      if (filter.source) items = items.filter((t) => t.source === filter.source);
      if (filter.dueBefore) items = items.filter((t) => t.dueAt && t.dueAt < filter.dueBefore!);
      if (filter.dueAfter) items = items.filter((t) => t.dueAt && t.dueAt > filter.dueAfter!);
      return items;
    },
    getPendingByPriority(): Task[] {
      return [...store.values()].filter((t) => t.status === "pending");
    },
    getOverdue(): Task[] {
      const nowIso = now();
      return [...store.values()].filter(
        (t) => t.status === "pending" && t.dueAt && t.dueAt < nowIso,
      );
    },
    getDueToday(): Task[] {
      const today = new Date().toISOString().slice(0, 10);
      return [...store.values()].filter(
        (t) => t.status === "pending" && t.dueAt?.startsWith(today),
      );
    },
  };
  return svc as unknown as TaskService;
}

function makeCtx(): ToolExecutionContext {
  return { sessionId: "test", turnId: "turn-1" } as unknown as ToolExecutionContext;
}

async function call(
  tool: Tool,
  input: Record<string, unknown>,
): Promise<{ json: unknown; isError: boolean }> {
  const result = await tool.execute(input, makeCtx());
  return { json: JSON.parse(result.output), isError: result.isError };
}

function toolByName(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe("task tools", () => {
  let service: TaskService;
  let tools: Tool[];

  beforeEach(() => {
    service = makeService();
    tools = createTaskTools(service);
  });

  it("exposes 6 tools with correct names + categories", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "task_add",
      "task_delete",
      "task_list",
      "task_overdue",
      "task_today",
      "task_update",
    ]);
    expect(toolByName(tools, "task_add").category).toBe("write");
    expect(toolByName(tools, "task_update").category).toBe("write");
    expect(toolByName(tools, "task_delete").category).toBe("write");
    expect(toolByName(tools, "task_list").category).toBe("read");
    expect(toolByName(tools, "task_today").category).toBe("read");
    expect(toolByName(tools, "task_overdue").category).toBe("read");
  });

  it("task_add: creates task with defaults", async () => {
    const { json, isError } = await call(toolByName(tools, "task_add"), {
      title: "제안서 초안",
    });
    expect(isError).toBe(false);
    const t = json as Record<string, unknown>;
    expect(t.title).toBe("제안서 초안");
    expect(t.priority).toBe("medium");
    expect(t.status).toBe("pending");
    expect(t.source).toBe("chat");
    expect(typeof t.id).toBe("string");
  });

  it("task_add: rejects empty title", async () => {
    const { json, isError } = await call(toolByName(tools, "task_add"), {
      title: "   ",
    });
    expect(isError).toBe(true);
    expect((json as { error: string }).error).toMatch(/title is required/);
  });

  it("task_add: respects custom priority + dueAt (YYYY-MM-DD normalized)", async () => {
    const { json } = await call(toolByName(tools, "task_add"), {
      title: "고객 응답",
      priority: "high",
      dueAt: "2026-04-30",
      source: "email:abc",
    });
    const t = json as Record<string, string>;
    expect(t.priority).toBe("high");
    expect(t.source).toBe("email:abc");
    expect(t.dueAt).toMatch(/^2026-04-30T/);
  });

  it("task_update: changes status to done, rejects unknown id", async () => {
    const created = await call(toolByName(tools, "task_add"), { title: "리뷰" });
    const id = (created.json as { id: string }).id;

    const { json, isError } = await call(toolByName(tools, "task_update"), {
      id,
      status: "done",
    });
    expect(isError).toBe(false);
    expect((json as { status: string }).status).toBe("done");

    const notFound = await call(toolByName(tools, "task_update"), {
      id: "00000000-0000-0000-0000-000000000000",
      status: "done",
    });
    expect(notFound.isError).toBe(true);
  });

  it("task_update: requires at least one updatable field", async () => {
    const created = await call(toolByName(tools, "task_add"), { title: "X" });
    const id = (created.json as { id: string }).id;
    const { isError, json } = await call(toolByName(tools, "task_update"), {
      id,
    });
    expect(isError).toBe(true);
    expect((json as { error: string }).error).toMatch(/no updatable fields/);
  });

  it("task_list: filters by status + priority + limit", async () => {
    await call(toolByName(tools, "task_add"), { title: "A", priority: "high" });
    await call(toolByName(tools, "task_add"), { title: "B", priority: "low" });
    const c = await call(toolByName(tools, "task_add"), {
      title: "C",
      priority: "medium",
    });
    const cId = (c.json as { id: string }).id;
    await call(toolByName(tools, "task_update"), { id: cId, status: "done" });

    const pending = await call(toolByName(tools, "task_list"), {
      status: "pending",
    });
    expect(
      (pending.json as { items: Array<{ title: string }> }).items
        .map((i) => i.title)
        .sort(),
    ).toEqual(["A", "B"]);

    const highOnly = await call(toolByName(tools, "task_list"), {
      priority: "high",
    });
    expect((highOnly.json as { items: unknown[] }).items).toHaveLength(1);

    const capped = await call(toolByName(tools, "task_list"), { limit: 1 });
    expect((capped.json as { items: unknown[] }).items).toHaveLength(1);
  });

  it("task_today: returns only pending tasks due today", async () => {
    const todayIso = new Date().toISOString().slice(0, 10);
    await call(toolByName(tools, "task_add"), {
      title: "오늘",
      dueAt: `${todayIso}T12:00:00Z`,
    });
    await call(toolByName(tools, "task_add"), {
      title: "내일",
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const { json } = await call(toolByName(tools, "task_today"), {});
    const titles = (json as { items: Array<{ title: string }> }).items.map(
      (i) => i.title,
    );
    expect(titles).toContain("오늘");
    expect(titles).not.toContain("내일");
  });

  it("task_overdue: returns only past-due pending tasks", async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await call(toolByName(tools, "task_add"), { title: "과거", dueAt: past });
    await call(toolByName(tools, "task_add"), { title: "미래", dueAt: future });
    await call(toolByName(tools, "task_add"), { title: "기한없음" });

    const { json } = await call(toolByName(tools, "task_overdue"), {});
    const titles = (json as { items: Array<{ title: string }> }).items.map(
      (i) => i.title,
    );
    expect(titles).toEqual(["과거"]);
  });

  it("task_delete: removes task, subsequent update returns not-found", async () => {
    const created = await call(toolByName(tools, "task_add"), { title: "제거" });
    const id = (created.json as { id: string }).id;

    const { json, isError } = await call(toolByName(tools, "task_delete"), {
      id,
    });
    expect(isError).toBe(false);
    expect((json as { deleted: boolean }).deleted).toBe(true);

    const update = await call(toolByName(tools, "task_update"), {
      id,
      title: "resurrect",
    });
    expect(update.isError).toBe(true);
  });
});

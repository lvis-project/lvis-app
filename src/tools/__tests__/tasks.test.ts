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
      // Real TaskService uses inclusive `<=` / `>=` (see taskService.ts:137,141) —
      // mirror that so tool behavior at day boundaries matches production.
      let items = [...store.values()];
      if (filter.status) {
        const set = Array.isArray(filter.status)
          ? new Set(filter.status)
          : new Set([filter.status]);
        items = items.filter((t) => set.has(t.status));
      }
      if (filter.priority) items = items.filter((t) => t.priority === filter.priority);
      if (filter.source) items = items.filter((t) => t.source === filter.source);
      if (filter.dueBefore) items = items.filter((t) => !!t.dueAt && t.dueAt <= filter.dueBefore!);
      if (filter.dueAfter) items = items.filter((t) => !!t.dueAt && t.dueAt >= filter.dueAfter!);
      return items;
    },
    getPendingByPriority(): Task[] {
      return [...store.values()].filter((t) => t.status === "pending");
    },
    getOverdue(): Task[] {
      const nowIso = now();
      return [...store.values()].filter(
        (t) => t.status === "pending" && !!t.dueAt && t.dueAt < nowIso,
      );
    },
    getDueToday(): Task[] {
      // Mirror real TaskService.getDueToday (taskService.ts:180-195):
      // host-local setHours(0,0,0,0) .. setHours(23,59,59,999), inclusive.
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 999);
      const startIso = start.toISOString();
      const endIso = end.toISOString();
      return [...store.values()].filter(
        (t) =>
          t.status === "pending" &&
          !!t.dueAt &&
          t.dueAt >= startIso &&
          t.dueAt <= endIso,
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
    // Use local-time noon so the task always falls inside getDueToday()'s
    // host-local 00:00..23:59 window, regardless of the runner's timezone.
    // (Earlier `slice(0,10)` of a UTC ISO string raced KST midnight: between
    // 00:00–09:00 KST the UTC date is still "yesterday" and the task fell
    // outside the local window.)
    const localNoonToday = new Date();
    localNoonToday.setHours(12, 0, 0, 0);
    const localNoonTomorrow = new Date(localNoonToday.getTime() + 86_400_000);
    await call(toolByName(tools, "task_add"), {
      title: "오늘",
      dueAt: localNoonToday.toISOString(),
    });
    await call(toolByName(tools, "task_add"), {
      title: "내일",
      dueAt: localNoonTomorrow.toISOString(),
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

  it("task_add: YYYY-MM-DD interpreted as KST end-of-day (no timezone off-by-one)", async () => {
    const { json } = await call(toolByName(tools, "task_add"), {
      title: "KST end-of-day",
      dueAt: "2026-04-30",
    });
    const iso = (json as { dueAt: string }).dueAt;
    // 2026-04-30T23:59:59+09:00 == 2026-04-30T14:59:59Z
    expect(iso).toBe("2026-04-30T14:59:59.000Z");
  });

  it("task_add: full ISO input kept as-is (no KST re-interpretation)", async () => {
    const { json } = await call(toolByName(tools, "task_add"), {
      title: "ISO 원본",
      dueAt: "2026-04-30T18:00:00Z",
    });
    expect((json as { dueAt: string }).dueAt).toBe("2026-04-30T18:00:00.000Z");
  });

  it("task_update: dueAt=null clears existing due date", async () => {
    const created = await call(toolByName(tools, "task_add"), {
      title: "마감 제거 테스트",
      dueAt: "2026-05-01",
    });
    const id = (created.json as { id: string }).id;
    expect((created.json as { dueAt?: string }).dueAt).toBeTruthy();

    const updated = await call(toolByName(tools, "task_update"), {
      id,
      dueAt: null,
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { dueAt?: string }).dueAt).toBeUndefined();
  });

  it("task_update: dueAt='' also clears", async () => {
    const created = await call(toolByName(tools, "task_add"), {
      title: "빈 문자열 clear",
      dueAt: "2026-05-01",
    });
    const id = (created.json as { id: string }).id;
    const updated = await call(toolByName(tools, "task_update"), {
      id,
      dueAt: "",
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { dueAt?: string }).dueAt).toBeUndefined();
  });

  it("task_update: omitted dueAt keeps previous value (not cleared)", async () => {
    const created = await call(toolByName(tools, "task_add"), {
      title: "유지 확인",
      dueAt: "2026-05-01",
    });
    const id = (created.json as { id: string }).id;
    const originalDue = (created.json as { dueAt: string }).dueAt;

    const updated = await call(toolByName(tools, "task_update"), {
      id,
      title: "제목만 수정",
    });
    expect(updated.isError).toBe(false);
    expect((updated.json as { dueAt: string }).dueAt).toBe(originalDue);
  });

  it("task_list: rejects non-numeric limit (falls back to default 100)", async () => {
    // Seed 3 tasks
    await call(toolByName(tools, "task_add"), { title: "A" });
    await call(toolByName(tools, "task_add"), { title: "B" });
    await call(toolByName(tools, "task_add"), { title: "C" });

    // String "2" must NOT be coerced → default 100 → returns all 3
    const r1 = await call(toolByName(tools, "task_list"), { limit: "2" });
    expect((r1.json as { items: unknown[] }).items).toHaveLength(3);

    // Float 1.8 → floor → 1
    const r2 = await call(toolByName(tools, "task_list"), { limit: 1.8 });
    expect((r2.json as { items: unknown[] }).items).toHaveLength(1);
  });

  it("task_update: invalid dueAt string returns explicit error (not silent ignore)", async () => {
    const created = await call(toolByName(tools, "task_add"), {
      title: "원본",
      dueAt: "2026-05-01",
    });
    const id = (created.json as { id: string }).id;
    const originalDue = (created.json as { dueAt: string }).dueAt;

    const updated = await call(toolByName(tools, "task_update"), {
      id,
      dueAt: "not-a-date",
    });
    expect(updated.isError).toBe(true);
    expect((updated.json as { error: string }).error).toMatch(/invalid dueAt/);

    // 기존 dueAt 은 건드리지 않음
    const list = await call(toolByName(tools, "task_list"), {});
    const item = (list.json as { items: Array<{ id: string; dueAt: string }> })
      .items.find((i) => i.id === id)!;
    expect(item.dueAt).toBe(originalDue);
  });

  it("task_list: source filter trims whitespace", async () => {
    await call(toolByName(tools, "task_add"), { title: "A", source: "chat" });
    await call(toolByName(tools, "task_add"), { title: "B", source: "email" });

    const r = await call(toolByName(tools, "task_list"), { source: "  chat  " });
    const titles = (r.json as { items: Array<{ title: string }> }).items.map(
      (i) => i.title,
    );
    expect(titles).toEqual(["A"]);
  });

  it("task_list: source='' (whitespace only) ignores filter entirely", async () => {
    await call(toolByName(tools, "task_add"), { title: "A", source: "chat" });
    await call(toolByName(tools, "task_add"), { title: "B", source: "email" });

    const r = await call(toolByName(tools, "task_list"), { source: "   " });
    expect(
      (r.json as { items: unknown[] }).items,
    ).toHaveLength(2);
  });

  it("task_today: uses explicit KST day range (not host local)", async () => {
    // Today's KST date
    const nowKst = new Date(Date.now() + 9 * 60 * 60_000);
    const y = nowKst.getUTCFullYear();
    const m = String(nowKst.getUTCMonth() + 1).padStart(2, "0");
    const d = String(nowKst.getUTCDate()).padStart(2, "0");
    const todayKstDate = `${y}-${m}-${d}`;

    // Task due at KST 18:00 today — must appear
    await call(toolByName(tools, "task_add"), {
      title: "오늘 오후",
      dueAt: new Date(`${todayKstDate}T18:00:00+09:00`).toISOString(),
    });
    // Task due yesterday KST 23:59 — must NOT appear (no matter host local time)
    const yesterdayKst = new Date(
      new Date(`${todayKstDate}T00:00:00+09:00`).getTime() - 60_000,
    ).toISOString();
    await call(toolByName(tools, "task_add"), { title: "어제", dueAt: yesterdayKst });

    const { json } = await call(toolByName(tools, "task_today"), {});
    const titles = (json as { items: Array<{ title: string }> }).items.map(
      (i) => i.title,
    );
    expect(titles).toContain("오늘 오후");
    expect(titles).not.toContain("어제");
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

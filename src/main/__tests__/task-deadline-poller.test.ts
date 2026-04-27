/**
 * TaskDeadlinePoller unit tests.
 *
 * Uses an in-memory TaskService mock (mirrors `tools/__tests__/tasks.test.ts`)
 * so vitest doesn't need the better-sqlite3 native binding rebuilt against
 * the test runner's Node ABI. The poller only consumes
 * `taskService.query({ status, dueBefore })`, so we model that shape verbatim.
 *
 * Covers:
 *   - Window detection: fires when dueAt within window, skips when outside.
 *   - Status filter: pending only — done / snoozed never fire.
 *   - Cooldown: same (taskId, dueAt) does NOT re-fire within cooldown.
 *   - Cooldown: re-fires after cooldown elapses (judgment-retry path).
 *   - dueAt change: a task whose dueAt is rescheduled fires again under
 *     the new key (cooldown is per-(taskId, dueAt)).
 *   - Past-due: tasks already overdue still fire (negative msUntilDeadline).
 *   - Missing dueAt: skipped.
 *   - Handler errors don't break the loop.
 *   - start/stop is idempotent.
 *   - query() failure is non-fatal (logs warn, continues).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Task, TaskFilter, TaskService } from "../../taskService.js";
import {
  TaskDeadlinePoller,
  type TaskDeadlineApproachingPayload,
} from "../task-deadline-poller.js";

function makeService(): TaskService {
  const store = new Map<string, Task>();
  const nowIso = () => new Date().toISOString();
  const svc = {
    add(input: Omit<Task, "id" | "createdAt" | "updatedAt">): Task {
      const t: Task = {
        id: randomUUID(),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        ...input,
      };
      store.set(t.id, t);
      return t;
    },
    update(id: string, patch: Partial<Omit<Task, "id" | "createdAt">>): Task {
      const existing = store.get(id);
      if (!existing) throw new Error(`not found: ${id}`);
      const updated: Task = { ...existing, ...patch, id, updatedAt: nowIso() };
      store.set(id, updated);
      return updated;
    },
    query(filter: TaskFilter): Task[] {
      let items = [...store.values()];
      if (filter.status) {
        const set = Array.isArray(filter.status)
          ? new Set(filter.status)
          : new Set([filter.status]);
        items = items.filter((t) => set.has(t.status));
      }
      if (filter.dueBefore) {
        items = items.filter((t) => !!t.dueAt && t.dueAt <= filter.dueBefore!);
      }
      return items;
    },
  };
  return svc as unknown as TaskService;
}

function addTask(
  service: TaskService,
  input: Partial<Task> & { dueAt?: string },
): Task {
  return service.add({
    title: input.title ?? "Test task",
    description: input.description,
    source: input.source ?? "chat",
    priority: input.priority ?? "medium",
    status: input.status ?? "pending",
    dueAt: input.dueAt,
  });
}

describe("TaskDeadlinePoller", () => {
  let service: TaskService;
  let collected: TaskDeadlineApproachingPayload[];

  beforeEach(() => {
    service = makeService();
    collected = [];
  });

  function makePoller(opts: {
    nowMs: number;
    windowMs?: number;
    cooldownMs?: number;
  }): { poller: TaskDeadlinePoller; advance: (deltaMs: number) => void } {
    let now = opts.nowMs;
    const poller = new TaskDeadlinePoller(service, {
      windowMs: opts.windowMs ?? 2 * 60 * 60_000,
      cooldownMs: opts.cooldownMs ?? 7 * 60_000,
      now: () => now,
    });
    poller.onApproaching((p) => collected.push(p));
    return {
      poller,
      advance(deltaMs: number) {
        now += deltaMs;
      },
    };
  }

  it("fires for a pending task whose dueAt is within the window", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now + 60 * 60_000).toISOString();
    const t = addTask(service, { title: "Q2 report", dueAt, priority: "high" });
    const { poller } = makePoller({ nowMs: now });
    poller.checkAndFire();
    expect(collected).toHaveLength(1);
    expect(collected[0]).toMatchObject({
      taskId: t.id,
      title: "Q2 report",
      dueAt,
      priority: "high",
      source: "chat",
    });
    expect(collected[0].msUntilDeadline).toBe(60 * 60_000);
  });

  it("does not fire when dueAt is outside the window", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now + 5 * 60 * 60_000).toISOString();
    addTask(service, { dueAt });
    const { poller } = makePoller({ nowMs: now });
    poller.checkAndFire();
    expect(collected).toHaveLength(0);
  });

  it("does not fire for done or snoozed tasks", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now + 60 * 60_000).toISOString();
    addTask(service, { title: "done task", dueAt, status: "done" });
    addTask(service, { title: "snoozed task", dueAt, status: "snoozed" });
    const { poller } = makePoller({ nowMs: now });
    poller.checkAndFire();
    expect(collected).toHaveLength(0);
  });

  it("does not fire for tasks without dueAt", () => {
    addTask(service, { title: "no deadline" });
    const { poller } = makePoller({ nowMs: Date.now() });
    poller.checkAndFire();
    expect(collected).toHaveLength(0);
  });

  it("dedupes within cooldown — same (taskId, dueAt) fires only once", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now + 60 * 60_000).toISOString();
    addTask(service, { title: "X", dueAt });
    const { poller } = makePoller({ nowMs: now, cooldownMs: 7 * 60_000 });
    poller.checkAndFire();
    poller.checkAndFire();
    poller.checkAndFire();
    expect(collected).toHaveLength(1);
  });

  it("re-fires after cooldown elapses", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now + 60 * 60_000).toISOString();
    addTask(service, { title: "X", dueAt });
    const { poller, advance } = makePoller({
      nowMs: now,
      cooldownMs: 7 * 60_000,
    });
    poller.checkAndFire();
    expect(collected).toHaveLength(1);
    advance(8 * 60_000);
    poller.checkAndFire();
    expect(collected).toHaveLength(2);
    expect(collected[0].taskId).toBe(collected[1].taskId);
  });

  it("a throwing handler still consumes the cooldown slot (no emit storm on error)", () => {
    // recordFired runs BEFORE dispatch — a buggy subscriber that throws
    // every time must not cause the poller to re-emit on every tick. The
    // per-handler try/catch (already covered above) isolates the failure;
    // this test pins down the cooldown-precedence half of the contract.
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now + 60 * 60_000).toISOString();
    addTask(service, { title: "X", dueAt });
    const { poller } = makePoller({ nowMs: now, cooldownMs: 7 * 60_000 });
    poller.onApproaching(() => {
      throw new Error("intentional handler failure");
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      poller.checkAndFire();
      poller.checkAndFire();
      poller.checkAndFire();
    } finally {
      warnSpy.mockRestore();
    }
    // Successful collector handler still saw exactly one emit despite
    // the throwing handler firing on every dispatch.
    expect(collected).toHaveLength(1);
  });

  it("re-fires when dueAt changes (rescheduled task)", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const firstDue = new Date(now + 60 * 60_000).toISOString();
    const t = addTask(service, { title: "reschedulable", dueAt: firstDue });
    const { poller } = makePoller({ nowMs: now });
    poller.checkAndFire();
    expect(collected).toHaveLength(1);
    expect(collected[0].dueAt).toBe(firstDue);

    // Reschedule — different dueAt → new dedupe key → fires again even
    // though we're well within the original cooldown.
    const secondDue = new Date(now + 30 * 60_000).toISOString();
    service.update(t.id, { dueAt: secondDue });
    poller.checkAndFire();
    expect(collected).toHaveLength(2);
    expect(collected[1].dueAt).toBe(secondDue);
  });

  it("fires for past-due tasks (negative msUntilDeadline)", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now - 30 * 60_000).toISOString();
    addTask(service, { title: "overdue", dueAt });
    const { poller } = makePoller({ nowMs: now });
    poller.checkAndFire();
    expect(collected).toHaveLength(1);
    expect(collected[0].msUntilDeadline).toBe(-30 * 60_000);
  });

  it("includes description in payload when present", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now + 60 * 60_000).toISOString();
    addTask(service, { title: "X", description: "details here", dueAt });
    const { poller } = makePoller({ nowMs: now });
    poller.checkAndFire();
    expect(collected[0].description).toBe("details here");
  });

  it("omits description from payload when absent", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now + 60 * 60_000).toISOString();
    addTask(service, { title: "X", dueAt });
    const { poller } = makePoller({ nowMs: now });
    poller.checkAndFire();
    expect(collected[0]).not.toHaveProperty("description");
  });

  it("one handler throwing does not break other handlers", () => {
    const now = new Date("2026-04-27T10:00:00Z").getTime();
    const dueAt = new Date(now + 60 * 60_000).toISOString();
    addTask(service, { title: "X", dueAt });
    const { poller } = makePoller({ nowMs: now });
    const goodCalls: TaskDeadlineApproachingPayload[] = [];
    poller.onApproaching(() => {
      throw new Error("intentional");
    });
    poller.onApproaching((p) => goodCalls.push(p));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      poller.checkAndFire();
    } finally {
      warnSpy.mockRestore();
    }
    expect(collected).toHaveLength(1); // first handler set up in makePoller still gets called
    expect(goodCalls).toHaveLength(1);
  });

  it("start() is idempotent", () => {
    const { poller } = makePoller({ nowMs: Date.now() });
    poller.start();
    poller.start();
    poller.stop();
    // No throw, no leaked timer (vitest catches dangling intervals).
  });

  it("stop() before start() is a no-op", () => {
    const { poller } = makePoller({ nowMs: Date.now() });
    expect(() => poller.stop()).not.toThrow();
  });

  it("survives a query() failure without throwing", () => {
    // Direct console.warn override (not vi.spyOn): vitest 2.x's spy on
    // global console doesn't reliably capture calls made through the
    // production module's reference to `console.warn`. Capturing via a
    // fresh array sidesteps the indirection. See sibling tests for the
    // vi.spyOn pattern when only call count matters.
    const now = Date.now();
    const poller = new TaskDeadlinePoller(
      {
        query: () => {
          throw new Error("db down");
        },
      } as unknown as TaskService,
      { now: () => now },
    );
    poller.onApproaching((p) => collected.push(p));
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      expect(() => poller.checkAndFire()).not.toThrow();
    } finally {
      console.warn = origWarn;
    }
    expect(collected).toHaveLength(0);
    expect(warnings.some((w) => w.includes("task-deadline-poller"))).toBe(true);
  });
});

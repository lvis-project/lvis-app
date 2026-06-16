/**
 * Due-soon scanner — emits one slim pointer event per not-yet-completed item
 * whose `due_at` falls inside the next 24h, deduped by `${id}:${due_at}`.
 *
 * The scanner depends only on a minimal `BoardReader` (`list()` → resolved
 * items) and a `DueSoonStorage` slice (`readJson` / `writeJson`). Both are
 * supplied here as in-memory fakes so no `~/.lvis/` path is touched and the
 * window / dedupe / skip logic is exercised against a fixed clock.
 */
import { describe, it, expect } from "vitest";
import {
  scanAndEmitDueSoon,
  DUE_SOON_EVENT,
  DUE_SOON_NOTIFIED_FILE,
  DUE_SOON_WINDOW_MS,
  type BoardReader,
  type DueSoonNotified,
  type DueSoonStorage,
} from "../due-soon.js";
import type {
  WorkItem,
  WorkItemResolved,
  WorkItemStatusStored,
} from "../../shared/work-board-types.js";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");

/** Build a resolved item; `status_resolved` mirrors `status` (scanner ignores it). */
function item(
  id: number,
  dueOffsetMs: number | undefined,
  status: WorkItemStatusStored = "planned",
  title = `item-${id}`,
): WorkItemResolved {
  const base: WorkItem = {
    id,
    title,
    status,
    priority: "medium",
    created_at: new Date(NOW).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    ...(dueOffsetMs !== undefined ? { due_at: new Date(NOW + dueOffsetMs).toISOString() } : {}),
    ...(status === "completed" ? { completed_at: new Date(NOW).toISOString() } : {}),
  };
  return { ...base, status_resolved: status };
}

function fakeReader(items: WorkItemResolved[]): BoardReader {
  return { list: async () => items };
}

/** In-memory DueSoonStorage backed by a single-key map; records writes. */
function fakeStorage(seed: DueSoonNotified | null = null) {
  let state: DueSoonNotified | null = seed;
  let writes = 0;
  const storage: DueSoonStorage = {
    async readJson<T = unknown>(rel: string): Promise<T | null> {
      expect(rel).toBe(DUE_SOON_NOTIFIED_FILE);
      return (state as unknown as T) ?? null;
    },
    async writeJson<T>(rel: string, value: T): Promise<void> {
      expect(rel).toBe(DUE_SOON_NOTIFIED_FILE);
      state = value as unknown as DueSoonNotified;
      writes += 1;
    },
  };
  return {
    storage,
    get state() {
      return state;
    },
    get writes() {
      return writes;
    },
  };
}

function collector() {
  const events: { type: string; data: unknown }[] = [];
  return { emit: (type: string, data?: unknown) => events.push({ type, data }), events };
}

describe("scanAndEmitDueSoon — emission + payload", () => {
  it("emits { itemId, title, notifiedAt } for an item inside the 24h window", async () => {
    const reader = fakeReader([item(1, 60 * 60_000, "planned", "deadline soon")]);
    const store = fakeStorage();
    const { emit, events } = collector();

    const emitted = await scanAndEmitDueSoon(reader, store.storage, emit, NOW);

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      itemId: 1,
      title: "deadline soon",
      notifiedAt: new Date(NOW).toISOString(),
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe(DUE_SOON_EVENT);
    expect(events[0].data).toEqual(emitted[0]);
    // A fresh fire persists the dedupe key.
    expect(store.writes).toBe(1);
    expect(store.state).toEqual({
      [`1:${new Date(NOW + 60 * 60_000).toISOString()}`]: new Date(NOW).toISOString(),
    });
  });

  it("emits for the boundary item exactly at now (half-open window includes now)", async () => {
    const reader = fakeReader([item(1, 0)]);
    const { emit, events } = collector();
    const emitted = await scanAndEmitDueSoon(reader, fakeStorage().storage, emit, NOW);
    expect(emitted).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});

describe("scanAndEmitDueSoon — skip rules", () => {
  it("skips completed, far-future, and past-due (overdue) items", async () => {
    const reader = fakeReader([
      item(1, 60 * 60_000, "completed"), // completed → never nudge
      item(2, DUE_SOON_WINDOW_MS + 60_000), // beyond 24h → far future
      item(3, -60_000), // already past → overdue, not due-soon
      item(4, undefined), // no due_at → cannot be due-soon
    ]);
    const { emit, events } = collector();
    const emitted = await scanAndEmitDueSoon(reader, fakeStorage().storage, emit, NOW);
    expect(emitted).toHaveLength(0);
    expect(events).toHaveLength(0);
  });

  it("skips an item exactly at the far window edge (now + 24h is exclusive)", async () => {
    const reader = fakeReader([item(1, DUE_SOON_WINDOW_MS)]);
    const { emit, events } = collector();
    const emitted = await scanAndEmitDueSoon(reader, fakeStorage().storage, emit, NOW);
    expect(emitted).toHaveLength(0);
    expect(events).toHaveLength(0);
  });
});

describe("scanAndEmitDueSoon — dedupe by (id, due_at)", () => {
  it("does not re-emit for the same deadline already in the notified map", async () => {
    const due = new Date(NOW + 60 * 60_000).toISOString();
    const reader = fakeReader([item(1, 60 * 60_000)]);
    const store = fakeStorage({ [`1:${due}`]: new Date(NOW - 1000).toISOString() });
    const { emit, events } = collector();

    const emitted = await scanAndEmitDueSoon(reader, store.storage, emit, NOW);

    expect(emitted).toHaveLength(0);
    expect(events).toHaveLength(0);
    // Unchanged map (key carried forward, none pruned) → no write.
    expect(store.writes).toBe(0);
  });

  it("re-fires when due_at moves, and prunes the stale key", async () => {
    const oldDue = new Date(NOW + 60 * 60_000).toISOString();
    const newDue = new Date(NOW + 2 * 60 * 60_000).toISOString();
    const reader = fakeReader([item(1, 2 * 60 * 60_000)]); // rescheduled → newDue
    const store = fakeStorage({ [`1:${oldDue}`]: new Date(NOW - 1000).toISOString() });
    const { emit, events } = collector();

    const emitted = await scanAndEmitDueSoon(reader, store.storage, emit, NOW);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].itemId).toBe(1);
    expect(events).toHaveLength(1);
    // Stale (old-due) key dropped, new key written.
    expect(store.writes).toBe(1);
    expect(store.state).toEqual({ [`1:${newDue}`]: new Date(NOW).toISOString() });
    expect(store.state).not.toHaveProperty(`1:${oldDue}`);
  });

  it("persists a pruned map even when nothing fires (stale key aged out)", async () => {
    const goneDue = new Date(NOW + 60 * 60_000).toISOString();
    // Board is now empty — the previously-notified item was completed/deleted.
    const reader = fakeReader([]);
    const store = fakeStorage({ [`1:${goneDue}`]: new Date(NOW - 1000).toISOString() });
    const { emit, events } = collector();

    const emitted = await scanAndEmitDueSoon(reader, store.storage, emit, NOW);

    expect(emitted).toHaveLength(0);
    expect(events).toHaveLength(0);
    // The map shrank (stale key pruned) → a write happens to persist the prune.
    expect(store.writes).toBe(1);
    expect(store.state).toEqual({});
  });
});

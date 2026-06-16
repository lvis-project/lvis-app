/**
 * Host due-soon scanner contract.
 *
 * Verifies the half-open `[now, now+24h)` window, the `(id, due_at)` dedupe
 * (fire once per deadline), pruning of keys whose items left the window, and
 * re-fire when an item's `due_at` actually changes. The board reader + storage
 * are in-memory fakes so no real `~/.lvis` is touched; `emit` is captured.
 */
import { describe, it, expect } from "vitest";
import {
  scanAndEmitDueSoon,
  DUE_SOON_EVENT,
  DUE_SOON_NOTIFIED_FILE,
  DUE_SOON_WINDOW_MS,
  type DueSoonBoardReader,
} from "../due-soon.js";
import type { WorkBoardStorage } from "../storage.js";
import type {
  WorkItem,
  WorkItemResolved,
} from "../../shared/work-board-types.js";
import { okListReader } from "./board-test-fixtures.js";

const NOW = Date.parse("2026-06-16T00:00:00.000Z");

/** Build a resolved work item with sensible defaults for the field under test. */
function item(partial: Partial<WorkItem> & { id: number }): WorkItemResolved {
  const base: WorkItem = {
    title: `item ${partial.id}`,
    status: "planned",
    priority: "medium",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...partial,
  };
  return { ...base, status_resolved: base.status };
}

/** In-memory storage capturing the dedupe map across scans. */
function memStorage(seed?: Record<string, unknown>): WorkBoardStorage {
  const files: Record<string, unknown> = { ...seed };
  return {
    readJson: async <T>(rel: string): Promise<T | null> =>
      (files[rel] as T) ?? null,
    writeJson: async (rel: string, data: unknown): Promise<void> => {
      files[rel] = data;
    },
  } as unknown as WorkBoardStorage;
}

/** Capture emitted (type, payload) pairs. */
function recorder() {
  const calls: Array<{ type: string; data: unknown }> = [];
  return { emit: (type: string, data?: unknown) => calls.push({ type, data }), calls };
}

describe("scanAndEmitDueSoon", () => {
  it("emits for an item due inside the next 24h", async () => {
    const dueIn1h = new Date(NOW + 60 * 60_000).toISOString();
    const store = okListReader([item({ id: 1, due_at: dueIn1h })]);
    const { emit, calls } = recorder();

    const emitted = await scanAndEmitDueSoon(store, memStorage(), emit, NOW);

    expect(emitted).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      type: DUE_SOON_EVENT,
      data: { itemId: 1, title: "item 1", notifiedAt: new Date(NOW).toISOString() },
    });
  });

  it("does NOT emit for items outside the window or completed/undated", async () => {
    const store = okListReader([
      item({ id: 1 }), // no due_at
      item({ id: 2, due_at: new Date(NOW - 60_000).toISOString() }), // past due (overdue, not soon)
      item({ id: 3, due_at: new Date(NOW + DUE_SOON_WINDOW_MS).toISOString() }), // exactly +24h (half-open → excluded)
      item({ id: 4, due_at: new Date(NOW + 60_000).toISOString(), status: "completed" }), // completed
    ]);
    const { emit, calls } = recorder();

    const emitted = await scanAndEmitDueSoon(store, memStorage(), emit, NOW);

    expect(emitted).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("dedupes: a second scan for the same deadline does not re-emit", async () => {
    const dueIn1h = new Date(NOW + 60 * 60_000).toISOString();
    const store = okListReader([item({ id: 1, due_at: dueIn1h })]);
    const storage = memStorage();
    const { emit, calls } = recorder();

    await scanAndEmitDueSoon(store, storage, emit, NOW);
    await scanAndEmitDueSoon(store, storage, emit, NOW + 5 * 60_000);

    expect(calls).toHaveLength(1); // only the first scan fired
    // The dedupe map persisted exactly one key, retaining its first-notified instant.
    const persisted = (await storage.readJson<Record<string, string>>(DUE_SOON_NOTIFIED_FILE)) ?? {};
    expect(Object.keys(persisted)).toEqual([`1:${dueIn1h}`]);
    expect(persisted[`1:${dueIn1h}`]).toBe(new Date(NOW).toISOString());
  });

  it("re-fires when the deadline changes (new (id, due_at) key)", async () => {
    const due1 = new Date(NOW + 60 * 60_000).toISOString();
    const due2 = new Date(NOW + 2 * 60 * 60_000).toISOString();
    const storage = memStorage();
    const { emit, calls } = recorder();

    await scanAndEmitDueSoon(okListReader([item({ id: 1, due_at: due1 })]), storage, emit, NOW);
    await scanAndEmitDueSoon(okListReader([item({ id: 1, due_at: due2 })]), storage, emit, NOW);

    expect(calls).toHaveLength(2);
    // The stale key is pruned; only the current deadline survives.
    const persisted = (await storage.readJson<Record<string, string>>(DUE_SOON_NOTIFIED_FILE)) ?? {};
    expect(Object.keys(persisted)).toEqual([`1:${due2}`]);
  });

  it("prunes the dedupe map when an item leaves the window", async () => {
    const dueIn1h = new Date(NOW + 60 * 60_000).toISOString();
    const storage = memStorage();
    const { emit } = recorder();

    // First scan fires + records the key.
    await scanAndEmitDueSoon(okListReader([item({ id: 1, due_at: dueIn1h })]), storage, emit, NOW);
    // Item later completed → no longer due-soon → key pruned.
    await scanAndEmitDueSoon(
      okListReader([item({ id: 1, due_at: dueIn1h, status: "completed" })]),
      storage,
      emit,
      NOW + 5 * 60_000,
    );

    const persisted = (await storage.readJson<Record<string, string>>(DUE_SOON_NOTIFIED_FILE)) ?? {};
    expect(persisted).toEqual({});
  });

  it("returns [] when the board list is not ok", async () => {
    const store: DueSoonBoardReader = {
      list: async () => ({ status: "invalid", reason: "boom" }),
    };
    const { emit, calls } = recorder();

    const emitted = await scanAndEmitDueSoon(store, memStorage(), emit, NOW);

    expect(emitted).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});

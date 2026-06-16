/**
 * First-run sample seed contract: seed once on a genuinely fresh board, skip
 * (but still mark) when migrated or already-populated, and never re-seed after
 * the marker is written — even if the user later empties the board.
 */
import { describe, it, expect } from "vitest";
import {
  seedSampleWorkBoard,
  SAMPLE_SEEDED_FILE,
  type SampleSeedStore,
} from "../sample-data.js";
import type { WorkBoardStorage } from "../storage.js";
import type {
  WorkItem,
  WorkItemResolved,
  WorkItemCreateInput,
} from "../../shared/work-board-types.js";

const NOW = Date.parse("2026-06-16T00:00:00.000Z");

/** Mutable in-memory store implementing the narrow SampleSeedStore surface. */
function makeStore(initial: WorkItemResolved[] = []) {
  const items = [...initial];
  let nextId = items.reduce((m, i) => Math.max(m, i.id), 0) + 1;
  const store: SampleSeedStore & { items: WorkItemResolved[] } = {
    items,
    list: async () => ({ status: "ok", items }),
    create: async (input: WorkItemCreateInput) => {
      const id = nextId++;
      const base: WorkItem = {
        id,
        title: input.title,
        detail: input.detail,
        status: input.status ?? "planned",
        priority: input.priority ?? "medium",
        due_at: input.due_at,
        created_at: new Date(NOW).toISOString(),
        updated_at: new Date(NOW).toISOString(),
      };
      const item: WorkItemResolved = { ...base, status_resolved: base.status };
      items.push(item);
      return { status: "created", itemId: id, item };
    },
    setRunResult: async (id, patch) => {
      const it = items.find((i) => i.id === id);
      if (it) Object.assign(it, patch);
      return {};
    },
  };
  return store;
}

/** In-memory marker storage (readJson/writeJson). */
function makeMarker(): Pick<WorkBoardStorage, "readJson" | "writeJson"> & {
  files: Record<string, unknown>;
} {
  const files: Record<string, unknown> = {};
  return {
    files,
    readJson: async <T>(rel: string) => (rel in files ? (files[rel] as T) : null),
    writeJson: async (rel: string, value: unknown) => {
      files[rel] = value;
    },
  };
}

describe("seedSampleWorkBoard", () => {
  it("seeds a fresh board once, with a completed sample carrying plan + output", async () => {
    const store = makeStore();
    const marker = makeMarker();

    const r = await seedSampleWorkBoard({ store, marker, alreadyMigrated: false, now: () => NOW });

    expect(r.seeded).toBe(true);
    expect(r.count).toBe(3);
    expect(store.items).toHaveLength(3);
    // One completed sample demonstrates the agentic output end-state.
    const completed = store.items.find((i) => i.status === "completed");
    expect(completed?.output).toBeTruthy();
    expect(completed?.runStatus).toBe("completed");
    // The high-priority planned sample is due inside the 24h due-soon window.
    const planned = store.items.find((i) => i.priority === "high");
    expect(planned?.due_at).toBeTruthy();
    expect(Date.parse(planned!.due_at!) - NOW).toBeLessThan(24 * 60 * 60_000);
    // Marker records the decision.
    expect(marker.files[SAMPLE_SEEDED_FILE]).toMatchObject({ seeded: true, count: 3 });
  });

  it("is idempotent — a second run does nothing even after the board is emptied", async () => {
    const store = makeStore();
    const marker = makeMarker();
    await seedSampleWorkBoard({ store, marker, alreadyMigrated: false, now: () => NOW });

    // Simulate the user deleting every demo item.
    store.items.length = 0;
    const second = await seedSampleWorkBoard({ store, marker, alreadyMigrated: false, now: () => NOW });

    expect(second.seeded).toBe(false);
    expect(second.reason).toBe("already-decided");
    expect(store.items).toHaveLength(0); // not re-seeded
  });

  it("skips (but marks) a migrated board — never seeds over real data", async () => {
    const store = makeStore();
    const marker = makeMarker();

    const r = await seedSampleWorkBoard({ store, marker, alreadyMigrated: true, now: () => NOW });

    expect(r.seeded).toBe(false);
    expect(r.reason).toBe("migrated");
    expect(store.items).toHaveLength(0);
    expect(marker.files[SAMPLE_SEEDED_FILE]).toMatchObject({ seeded: false });
  });

  it("skips (but marks) a board that already has items", async () => {
    const existing: WorkItemResolved = {
      id: 1,
      title: "real task",
      status: "planned",
      priority: "medium",
      created_at: "x",
      updated_at: "x",
      status_resolved: "planned",
    };
    const store = makeStore([existing]);
    const marker = makeMarker();

    const r = await seedSampleWorkBoard({ store, marker, alreadyMigrated: false, now: () => NOW });

    expect(r.seeded).toBe(false);
    expect(r.reason).toBe("non-empty");
    expect(store.items).toHaveLength(1); // unchanged
    expect(marker.files[SAMPLE_SEEDED_FILE]).toMatchObject({ seeded: false });
  });
});

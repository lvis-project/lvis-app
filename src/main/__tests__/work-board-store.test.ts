/**
 * WorkBoardStore — the single board CRUD implementation.
 *
 * Mirrors the RoutinesStore test style: every case injects a temp `board.json`
 * path through the constructor (and an injectable clock for deterministic
 * overdue / timestamp assertions) so the real `~/.lvis/work-board/` namespace
 * is never touched.
 *
 * Coverage:
 *   - Full CRUD round-trip: create → list → get → update → transition →
 *     complete (stamps completed_at) → reopen (clears it) → remove, plus a
 *     persistence reload through a second store instance.
 *   - `overdue` projection: resolved only for planned|in_progress with a past
 *     `due_at`; never written to disk.
 *   - MAX_ITEMS cap enforcement.
 *   - Corrupt `board.json` recovery (backup-and-reset path).
 */
import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkBoardStore, MAX_ITEMS } from "../work-board-store.js";

function tempBoard(now?: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "lvis-wb-"));
  const path = join(dir, "board.json");
  const store = new WorkBoardStore(path, now);
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { store, dir, path, cleanup };
}

/** A clock pinned to a fixed instant so timestamps + overdue are deterministic. */
const FIXED_NOW = Date.parse("2026-06-15T12:00:00.000Z");
const fixedClock = () => FIXED_NOW;

describe("WorkBoardStore — CRUD round-trip", () => {
  it("creates, lists, gets, updates, transitions, completes, reopens, and removes", async () => {
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      // create
      const created = await store.create({ title: "write report", priority: "high" });
      expect(created.status).toBe("created");
      if (created.status !== "created") throw new Error("unreachable");
      const id = created.itemId;
      expect(created.item.title).toBe("write report");
      expect(created.item.status).toBe("planned");
      expect(created.item.status_resolved).toBe("planned");
      expect(created.item.priority).toBe("high");

      // list
      const listed = await store.list();
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") throw new Error("unreachable");
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0].id).toBe(id);

      // get
      const got = await store.get(id);
      expect(got.status).toBe("found");
      if (got.status !== "found") throw new Error("unreachable");
      expect(got.item.id).toBe(id);

      // update
      const updated = await store.update(id, { detail: "Q2 summary", priority: "low" });
      expect(updated.status).toBe("updated");
      if (updated.status !== "updated") throw new Error("unreachable");
      expect(updated.item.detail).toBe("Q2 summary");
      expect(updated.item.priority).toBe("low");

      // transition (any-to-any): planned → in_progress
      const moved = await store.transition(id, "in_progress");
      expect(moved.status).toBe("transitioned");
      if (moved.status !== "transitioned") throw new Error("unreachable");
      expect(moved.to).toBe("in_progress");
      expect(moved.item.status).toBe("in_progress");
      expect(moved.item.completed_at).toBeUndefined();

      // complete: stamps completed_at
      const done = await store.complete(id);
      expect(done.status).toBe("completed");
      if (done.status !== "completed") throw new Error("unreachable");
      expect(done.item.status).toBe("completed");
      expect(done.item.completed_at).toBe(new Date(FIXED_NOW).toISOString());

      // reopen: clears completed_at
      const reopened = await store.reopen(id);
      expect(reopened.status).toBe("reopened");
      if (reopened.status !== "reopened") throw new Error("unreachable");
      expect(reopened.item.status).toBe("in_progress");
      expect(reopened.item.completed_at).toBeUndefined();

      // remove
      const removed = await store.remove(id);
      expect(removed.status).toBe("deleted");
      const afterRemove = await store.list();
      if (afterRemove.status !== "ok") throw new Error("unreachable");
      expect(afterRemove.items).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("get / update / transition / remove return not_found for an unknown id", async () => {
    const { store, cleanup } = tempBoard();
    try {
      expect((await store.get(999)).status).toBe("not_found");
      expect((await store.update(999, { title: "x" })).status).toBe("not_found");
      expect((await store.transition(999, "completed")).status).toBe("not_found");
      expect((await store.remove(999)).status).toBe("not_found");
    } finally {
      cleanup();
    }
  });

  it("persists across a reload through a fresh store instance on the same path", async () => {
    const { path, cleanup } = tempBoard(fixedClock);
    try {
      const first = new WorkBoardStore(path, fixedClock);
      const a = await first.create({ title: "alpha" });
      const b = await first.create({ title: "beta", priority: "high" });
      if (a.status !== "created" || b.status !== "created") throw new Error("setup failed");
      await first.transition(b.itemId, "in_progress");

      // A brand-new instance reads only from disk.
      const second = new WorkBoardStore(path, fixedClock);
      const reloaded = await second.list();
      expect(reloaded.status).toBe("ok");
      if (reloaded.status !== "ok") throw new Error("unreachable");
      expect(reloaded.items).toHaveLength(2);
      const beta = reloaded.items.find((i) => i.id === b.itemId);
      expect(beta?.status).toBe("in_progress");
      expect(beta?.title).toBe("beta");
      // next id continues monotonically after a reload (no id reuse).
      const c = await second.create({ title: "gamma" });
      if (c.status !== "created") throw new Error("unreachable");
      expect(c.itemId).toBeGreaterThan(b.itemId);
    } finally {
      cleanup();
    }
  });
});

describe("WorkBoardStore — overdue projection", () => {
  it("resolves overdue only for planned|in_progress with a past due_at", async () => {
    const past = new Date(FIXED_NOW - 60_000).toISOString();
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      // planned + past due → overdue
      const planned = await store.create({ title: "p", due_at: past, status: "planned" });
      // in_progress + past due → overdue
      const inProg = await store.create({ title: "i", due_at: past, status: "in_progress" });
      // completed + past due → stays completed (never overdue)
      const doneItem = await store.create({ title: "c", due_at: past, status: "completed" });
      if (
        planned.status !== "created" ||
        inProg.status !== "created" ||
        doneItem.status !== "created"
      ) {
        throw new Error("setup failed");
      }

      expect(planned.item.status_resolved).toBe("overdue");
      expect(inProg.item.status_resolved).toBe("overdue");
      expect(doneItem.item.status_resolved).toBe("completed");

      const listed = await store.list();
      if (listed.status !== "ok") throw new Error("unreachable");
      const byId = new Map(listed.items.map((i) => [i.id, i]));
      expect(byId.get(planned.itemId)?.status_resolved).toBe("overdue");
      expect(byId.get(inProg.itemId)?.status_resolved).toBe("overdue");
      expect(byId.get(doneItem.itemId)?.status_resolved).toBe("completed");
    } finally {
      cleanup();
    }
  });

  it("does not resolve overdue for a future due_at", async () => {
    const future = new Date(FIXED_NOW + 60_000).toISOString();
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      const r = await store.create({ title: "future", due_at: future });
      if (r.status !== "created") throw new Error("setup failed");
      expect(r.item.status_resolved).toBe("planned");
    } finally {
      cleanup();
    }
  });

  it("never persists the overdue projection to disk (status_resolved is read-only)", async () => {
    const past = new Date(FIXED_NOW - 60_000).toISOString();
    const { store, path, cleanup } = tempBoard(fixedClock);
    try {
      const r = await store.create({ title: "ghost", due_at: past });
      if (r.status !== "created") throw new Error("setup failed");
      expect(r.item.status_resolved).toBe("overdue");

      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as { items: Record<string, unknown>[] };
      expect(parsed.items).toHaveLength(1);
      expect(parsed.items[0].status).toBe("planned");
      expect(parsed.items[0]).not.toHaveProperty("status_resolved");
      // The literal string must not appear anywhere in the serialized file.
      expect(raw).not.toContain("status_resolved");
      expect(raw).not.toContain("overdue");
    } finally {
      cleanup();
    }
  });
});

describe("WorkBoardStore — project scope", () => {
  it("persists project identity and filters list results by projectRoot", async () => {
    const { store, cleanup } = tempBoard(fixedClock);
    try {
      const legacy = await store.create({ title: "legacy" });
      const alpha = await store.create({
        title: "alpha",
        projectRoot: "C:\\workspace\\alpha",
        projectName: "alpha",
      });
      const beta = await store.create({
        title: "beta",
        projectRoot: "C:\\workspace\\beta",
        projectName: "beta",
      });
      if (legacy.status !== "created" || alpha.status !== "created" || beta.status !== "created") {
        throw new Error("setup failed");
      }

      const alphaOnly = await store.list({ projectRoot: "c:/workspace/alpha/" });
      expect(alphaOnly.status).toBe("ok");
      if (alphaOnly.status !== "ok") throw new Error("unreachable");
      expect(alphaOnly.items.map((item) => item.title)).toEqual(["alpha"]);
      expect(alphaOnly.items[0].projectName).toBe("alpha");

      const defaultWithLegacy = await store.list({
        projectRoot: "C:\\workspace\\default",
        includeUnscoped: true,
      });
      expect(defaultWithLegacy.status).toBe("ok");
      if (defaultWithLegacy.status !== "ok") throw new Error("unreachable");
      expect(defaultWithLegacy.items.map((item) => item.title)).toEqual(["legacy"]);
    } finally {
      cleanup();
    }
  });
});

describe("WorkBoardStore — MAX_ITEMS cap", () => {
  it("rejects create once the board holds MAX_ITEMS items", async () => {
    const { store, path, cleanup } = tempBoard();
    try {
      const timestamp = new Date(FIXED_NOW).toISOString();
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          nextId: MAX_ITEMS + 1,
          items: Array.from({ length: MAX_ITEMS }, (_, index) => ({
            id: index + 1,
            title: `item-${index}`,
            status: "planned",
            priority: "medium",
            created_at: timestamp,
            updated_at: timestamp,
          })),
        }),
        "utf-8",
      );

      const overflow = await store.create({ title: "one too many" });
      expect(overflow.status).toBe("invalid");
      if (overflow.status !== "invalid") throw new Error("unreachable");
      expect(overflow.reason).toMatch(/cap reached/);
    } finally {
      cleanup();
    }
  });
});

describe("WorkBoardStore — corrupt board.json recovery", () => {
  it("backs up corrupt JSON and seeds an empty board on read", async () => {
    const { store, dir, path, cleanup } = tempBoard();
    try {
      writeFileSync(path, "{ this is not json", "utf-8");

      // First read triggers the backup-and-reset path.
      const listed = await store.list();
      expect(listed.status).toBe("ok");
      if (listed.status !== "ok") throw new Error("unreachable");
      expect(listed.items).toHaveLength(0);

      // The corrupt original is preserved under a .corrupt-*.bak sibling.
      const backups = readdirSync(dir).filter((f) => /\.corrupt-\d+\.bak$/.test(f));
      expect(backups).toHaveLength(1);

      // The store now functions normally — a create succeeds with id 1.
      const created = await store.create({ title: "recovered" });
      expect(created.status).toBe("created");
      if (created.status !== "created") throw new Error("unreachable");
      expect(created.itemId).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("drops tampered records but keeps the valid rest and repairs nextId", async () => {
    const { store, path, cleanup } = tempBoard();
    try {
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          nextId: 1, // deliberately stale / colliding counter
          items: [
            { id: 5, title: "valid", status: "planned", priority: "medium", created_at: "x", updated_at: "x" },
            { id: 6, title: "", status: "planned", priority: "medium", created_at: "x", updated_at: "x" }, // empty title → dropped
            { id: 7, title: "bad-status", status: "weird", priority: "medium", created_at: "x", updated_at: "x" }, // invalid status → dropped
          ],
        }),
        "utf-8",
      );

      const listed = await store.list();
      if (listed.status !== "ok") throw new Error("unreachable");
      expect(listed.items).toHaveLength(1);
      expect(listed.items[0].id).toBe(5);

      // nextId must be repaired to exceed the surviving max id (5) → new id 6.
      const created = await store.create({ title: "next" });
      if (created.status !== "created") throw new Error("unreachable");
      expect(created.itemId).toBe(6);
    } finally {
      cleanup();
    }
  });
});

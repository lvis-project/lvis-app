/**
 * Unit tests for SessionTodoStore + SkillStore.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  SessionTodoEmptyPlanError,
  SessionTodoStore,
} from "../main/session-todo-store.js";
import { SkillStore, parseFrontmatter } from "../main/skill-store.js";

const REPO_ROOT = resolvePath(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);
const BUILTIN_SKILLS_DIR = resolvePath(REPO_ROOT, "resources/skills");

describe("SessionTodoStore", () => {
  it("auto-generates ids and merges by id", () => {
    const store = new SessionTodoStore();
    const r1 = store.write("s", [
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
    ]);
    expect(r1).toHaveLength(2);
    const idA = r1[0].id;
    const r2 = store.write("s", [
      { id: idA, content: "a", status: "completed" },
      { content: "c", status: "pending" },
    ]);
    expect(r2).toHaveLength(3);
    expect(r2[0].status).toBe("completed");
    expect(r2[2].content).toBe("c");
  });

  it("inserts, moves, deletes, then marks and clears a fully completed plan", () => {
    const store = new SessionTodoStore();
    const events: Array<{ sid: string; len: number }> = [];
    store.onChange((sid, items) => events.push({ sid, len: items.length }));
    const initial = store.write("s", [
      { content: "a", status: "pending" },
      { content: "c", status: "pending" },
    ]);
    const [a, c] = initial;

    const inserted = store.write("s", [
      { content: "b", status: "pending", beforeId: c.id },
    ]);
    expect(inserted.map((i) => i.content)).toEqual(["a", "b", "c"]);

    const b = inserted[1];
    const moved = store.write("s", [
      { id: b.id, status: "pending", afterId: c.id },
    ]);
    expect(moved.map((i) => i.content)).toEqual(["a", "c", "b"]);

    const deleted = store.write("s", [
      { id: c.id, status: "deleted" },
    ]);
    expect(deleted.map((i) => i.content)).toEqual(["a", "b"]);

    // Nothing pending yet → execute is a no-op for any session.
    expect(store.clearIfPending("missing-session")).toBe(false);
    expect(store.clearIfPending("s")).toBe(false);

    store.write("s", [
      { id: a.id, status: "completed" },
      { id: b.id, status: "completed" },
    ]);
    const eventCountBeforeMark = events.length;

    // Phase 1: mark must NOT emit — the panel stays visible this turn.
    expect(store.markForClearIfCompleted("s")).toBe(true);
    expect(events.length).toBe(eventCountBeforeMark);
    expect(store.list("s").map((i) => i.content)).toEqual(["a", "b"]);

    // Phase 2: execute drops the session + emits empty exactly once.
    expect(store.clearIfPending("s")).toBe(true);
    expect(store.list("s")).toEqual([]);
    expect(events.at(-1)).toEqual({ sid: "s", len: 0 });
    // Mark is consumed: a second execute is a no-op.
    expect(store.clearIfPending("s")).toBe(false);
  });

  it("does not mark unfinished plans for clear", () => {
    const store = new SessionTodoStore();
    const events: Array<{ sid: string; len: number }> = [];
    store.onChange((sid, items) => events.push({ sid, len: items.length }));

    store.write("s", [
      { content: "still running", status: "in_progress" },
      { content: "not started", status: "pending" },
    ]);

    expect(store.markForClearIfCompleted("s")).toBe(false);
    expect(store.clearIfPending("s")).toBe(false);
    expect(store.list("s").map((item) => item.content)).toEqual([
      "still running",
      "not started",
    ]);
    expect(events).toEqual([{ sid: "s", len: 2 }]);
  });

  it("markForClearIfCompleted defensively unmarks when re-run on a no-longer-completed plan", () => {
    const store = new SessionTodoStore();
    const [a] = store.write("s", [{ content: "a", status: "completed" }]);
    expect(store.markForClearIfCompleted("s")).toBe(true);

    // The plan regresses to in_progress. write() already resets the mark, but
    // re-running the mark step on a non-completed plan must also clear it via
    // the defensive `else` branch (it returns false and leaves nothing pending).
    store.write("s", [{ id: a.id, status: "in_progress" }]);
    expect(store.markForClearIfCompleted("s")).toBe(false);
    expect(store.clearIfPending("s")).toBe(false);

    // markForClearIfCompleted on a session with no plan also returns false.
    expect(store.markForClearIfCompleted("never-seen")).toBe(false);
  });

  it("write() resets a stale pending-clear mark so a changed plan is re-evaluated", () => {
    const store = new SessionTodoStore();
    const events: Array<{ sid: string; len: number }> = [];
    store.onChange((sid, items) => events.push({ sid, len: items.length }));
    const [a] = store.write("s", [{ content: "a", status: "completed" }]);
    expect(store.markForClearIfCompleted("s")).toBe(true);

    // The plan changes after being marked → the mark is invalidated.
    store.write("s", [
      { id: a.id, status: "completed" },
      { content: "b", status: "in_progress" },
    ]);
    expect(store.clearIfPending("s")).toBe(false);
    expect(store.list("s").map((i) => i.content)).toEqual(["a", "b"]);
    // No spurious empty-list emit happened.
    expect(events.every((e) => e.len > 0)).toBe(true);
  });

  it("manual clear() drops a pending-clear mark", () => {
    const store = new SessionTodoStore();
    store.write("s", [{ content: "a", status: "completed" }]);
    expect(store.markForClearIfCompleted("s")).toBe(true);

    // Manual dismiss clears immediately and consumes the mark, so a later
    // execute cannot re-fire against a repopulated session.
    store.clear("s");
    store.write("s", [{ content: "new topic", status: "pending" }]);
    expect(store.clearIfPending("s")).toBe(false);
    expect(store.list("s").map((i) => i.content)).toEqual(["new topic"]);
  });

  it("rejects a delete-only update that would empty the plan", () => {
    const store = new SessionTodoStore();
    const events: Array<{ sid: string; len: number }> = [];
    store.onChange((sid, items) => events.push({ sid, len: items.length }));
    const [a, b] = store.write("s", [
      { content: "a", status: "pending" },
      { content: "b", status: "pending" },
    ]);

    expect(() =>
      store.write("s", [
        { id: a.id, status: "deleted" },
        { id: b.id, status: "deleted" },
      ]),
    ).toThrow(SessionTodoEmptyPlanError);

    expect(store.list("s").map((item) => item.content)).toEqual(["a", "b"]);
    expect(events).toEqual([{ sid: "s", len: 2 }]);
  });

  it("emits change events with the merged list", () => {
    const store = new SessionTodoStore();
    const events: number[] = [];
    store.onChange((_sid, items) => events.push(items.length));
    store.write("s2", [{ content: "x", status: "pending" }]);
    store.write("s2", [{ content: "y", status: "pending" }]);
    expect(events).toEqual([1, 2]);
  });

  it("clear() emits an empty list and drops the session regardless of status", () => {
    const store = new SessionTodoStore();
    const events: Array<{ sid: string; len: number }> = [];
    store.onChange((sid, items) => events.push({ sid, len: items.length }));
    store.write("s3", [
      { content: "a", status: "in_progress" },
      { content: "b", status: "pending" },
    ]);

    // Manual dismiss path: unlike the mark step, clear() does not gate on
    // every item being completed.
    store.clear("s3");
    expect(store.list("s3")).toEqual([]);
    expect(events.at(-1)).toEqual({ sid: "s3", len: 0 });
  });
});

describe("parseFrontmatter", () => {
  it("returns name + body when frontmatter is present", () => {
    const { fm, body } = parseFrontmatter(
      "---\nname: foo\ndescription: bar\n---\nbody text",
    );
    expect(fm.name).toBe("foo");
    expect(fm.description).toBe("bar");
    expect(body).toBe("body text");
  });

  it("returns body only when frontmatter is missing", () => {
    const { fm, body } = parseFrontmatter("plain content");
    expect(fm.name).toBe("");
    expect(body).toBe("plain content");
  });
});

describe("SkillStore", () => {
  it("loads packaged report-writing skill from the seed source directory", async () => {
    // Post-first-boot, `~/.lvis/skills/` holds the seeded copies of every
    // file shipped under `resources/skills/`. Pointing userDir at the
    // resources dir simulates that on-disk state without depending on
    // a real user home directory in tests.
    const store = new SkillStore({ userDir: BUILTIN_SKILLS_DIR });
    const list = await store.list();
    const names = list.map((s) => s.name);
    expect(names).toContain("report-writing");
    const loaded = await store.load("report-writing");
    expect(loaded).not.toBeNull();
    expect(loaded?.body).toContain("SARR");
  });

  it("user-authored skills override built-ins by name", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lvis-skills-"));
    try {
      writeFileSync(
        join(dir, "report-writing.md"),
        "---\nname: report-writing\ndescription: USER OVERRIDE\n---\nuser body",
        "utf-8",
      );
      const store = new SkillStore({ userDir: dir });
      const loaded = await store.load("report-writing");
      expect(loaded?.description).toBe("USER OVERRIDE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

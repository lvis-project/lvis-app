/**
 * Unit tests for SessionTodoStore + SkillStore.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { SessionTodoStore } from "../main/session-todo-store.js";
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

  it("inserts, moves, deletes, and clears a fully completed plan", () => {
    const store = new SessionTodoStore();
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

    expect(store.clearIfAllCompleted("s")).toBe(false);
    store.write("s", [
      { id: a.id, status: "completed" },
      { id: b.id, status: "completed" },
    ]);
    expect(store.clearIfAllCompleted("s")).toBe(true);
    expect(store.list("s")).toEqual([]);
  });

  it("emits change events with the merged list", () => {
    const store = new SessionTodoStore();
    const events: number[] = [];
    store.onChange((_sid, items) => events.push(items.length));
    store.write("s2", [{ content: "x", status: "pending" }]);
    store.write("s2", [{ content: "y", status: "pending" }]);
    expect(events).toEqual([1, 2]);
  });
});

describe("parseFrontmatter", () => {
  it("returns name + body when frontmatter is present", () => {
    const { fm, body } = parseFrontmatter(
      "---\nname: foo\ndescription: bar\ntriggers: [a, b]\n---\nbody text",
    );
    expect(fm.name).toBe("foo");
    expect(fm.description).toBe("bar");
    expect(fm.triggers).toEqual(["a", "b"]);
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
      expect(loaded?.source).toBe("user");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

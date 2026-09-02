/**
 * Unit tests for SessionTasksStore + SkillStore.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  SessionTaskIndexError,
  SessionTasksStore,
} from "../main/session-tasks-store.js";
import type { SessionTaskItem } from "../shared/session-tasks.js";
import { SkillStore, parseFrontmatter } from "../main/skill-store.js";
import { cleanupTmpDir } from "../__tests__/support/tmp-dir-teardown.js";

const REPO_ROOT = resolvePath(
  fileURLToPath(new URL(".", import.meta.url)),
  "../..",
);
const BUILTIN_SKILLS_DIR = resolvePath(REPO_ROOT, "resources/skills");

describe("SessionTasksStore", () => {
  function memoryPersistence(seed: Record<string, SessionTaskItem[]> = {}) {
    const disk = new Map(Object.entries(seed));
    const saves: Array<{ sid: string; items: SessionTaskItem[] }> = [];
    return {
      disk,
      saves,
      persistence: {
        load: (sid: string) => disk.get(sid) ?? [],
        save: async (sid: string, items: SessionTaskItem[]) => {
          saves.push({ sid, items });
          disk.set(sid, items);
        },
      },
    };
  }

  it("create replaces the list with pending steps and persists it", async () => {
    const { persistence, disk } = memoryPersistence();
    const store = new SessionTasksStore(persistence);
    const first = await store.create("s", ["a", "b"]);
    expect(first.map((i) => [i.content, i.status])).toEqual([["a", "pending"], ["b", "pending"]]);
    const second = await store.create("s", ["only"]);
    expect(second.map((i) => i.content)).toEqual(["only"]);
    expect(disk.get("s")?.map((i) => i.content)).toEqual(["only"]);
  });

  it("add inserts at the front (0), after N, and appends when after is omitted", async () => {
    const store = new SessionTasksStore(memoryPersistence().persistence);
    await store.create("s", ["b", "d"]);
    expect((await store.add("s", ["a"], 0)).map((i) => i.content)).toEqual(["a", "b", "d"]);
    expect((await store.add("s", ["c"], 2)).map((i) => i.content)).toEqual(["a", "b", "c", "d"]);
    expect((await store.add("s", ["e", "f"])).map((i) => i.content)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(() => store.add("s", ["x"], 7)).toThrow(SessionTaskIndexError);
    expect(() => store.add("s", ["x"], -1)).toThrow(SessionTaskIndexError);
  });

  it("edit changes text and status by 1-based number", async () => {
    const store = new SessionTasksStore(memoryPersistence().persistence);
    await store.create("s", ["a", "b"]);
    const edited = await store.edit("s", 2, { text: "B", status: "in_progress" });
    expect(edited[1]).toMatchObject({ content: "B", status: "in_progress" });
    expect(edited[0]).toMatchObject({ content: "a", status: "pending" });
    const textOnly = await store.edit("s", 1, { text: "A" });
    expect(textOnly[0]).toMatchObject({ content: "A", status: "pending" });
  });

  it("complete keeps the item in the list; delete removes it", async () => {
    const { persistence, disk } = memoryPersistence();
    const store = new SessionTasksStore(persistence);
    await store.create("s", ["a", "b", "c"]);
    const done = await store.complete("s", 1);
    expect(done.map((i) => i.status)).toEqual(["completed", "pending", "pending"]);
    expect(disk.get("s")?.[0].status).toBe("completed");
    const removed = await store.delete("s", 2);
    expect(removed.map((i) => i.content)).toEqual(["a", "c"]);
  });

  it("rejects an out-of-range number without touching the list", async () => {
    const { persistence, saves } = memoryPersistence();
    const store = new SessionTasksStore(persistence);
    await store.create("s", ["a"]);
    for (const bad of [0, 2, -1, 1.5]) {
      expect(() => store.edit("s", bad, { text: "x" })).toThrow(SessionTaskIndexError);
      expect(() => store.delete("s", bad)).toThrow(SessionTaskIndexError);
      expect(() => store.complete("s", bad)).toThrow(SessionTaskIndexError);
    }
    expect(() => store.complete("empty", 1)).toThrow("the list is empty");
    expect(store.list("s").map((i) => i.content)).toEqual(["a"]);
    expect(saves).toHaveLength(1);
  });

  it("reads a session's list back from persistence the first time it is asked", async () => {
    const seeded: SessionTaskItem[] = [
      { id: "x1", content: "done", status: "completed" },
      { id: "x2", content: "next", status: "pending" },
    ];
    const store = new SessionTasksStore(memoryPersistence({ resumed: seeded }).persistence);
    expect(store.list("resumed")).toEqual(seeded);
    // Mutations continue from the loaded list, not from an empty one.
    expect((await store.complete("resumed", 2)).map((i) => i.status)).toEqual(["completed", "completed"]);
  });

  it("emits the full list after every mutation and an empty list on clear", async () => {
    const { persistence, disk } = memoryPersistence();
    const store = new SessionTasksStore(persistence);
    const events: Array<{ sid: string; len: number }> = [];
    store.onChange((sid, items) => events.push({ sid, len: items.length }));
    await store.create("s3", ["a", "b"]);
    await store.edit("s3", 1, { status: "in_progress" });
    await store.clear("s3");
    expect(events).toEqual([
      { sid: "s3", len: 2 },
      { sid: "s3", len: 2 },
      { sid: "s3", len: 0 },
    ]);
    expect(store.list("s3")).toEqual([]);
    expect(disk.get("s3")).toEqual([]);
  });

  it("leaves the held list untouched when persistence fails", async () => {
    const store = new SessionTasksStore({
      load: () => [],
      save: async (_sid, items) => {
        if (items.length > 1) throw new Error("disk full");
      },
    });
    await store.create("s", ["a"]);
    await expect(store.add("s", ["b"])).rejects.toThrow("disk full");
    expect(store.list("s").map((i) => i.content)).toEqual(["a"]);
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
      await cleanupTmpDir(dir);
    }
  });
});

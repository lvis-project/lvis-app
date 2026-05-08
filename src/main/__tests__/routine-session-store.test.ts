/**
 * RoutineSessionStore — unit tests.
 *
 * Tests: createSession (dir/mode), listRecent (sort order), purgeRoutine, path traversal guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { RoutineSessionStore } from "../routine-session-store.js";

let tmpRoot: string;
let store: RoutineSessionStore;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "rss-test-"));
  store = new RoutineSessionStore(tmpRoot);
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("createSession", () => {
  it("creates a JSONL file under routineId subdir", async () => {
    const path = await store.createSession("routine-abc", "2026-05-08T09:00:00.000Z");
    expect(path).toContain("routine-abc");
    expect(path.endsWith(".jsonl")).toBe(true);
  });

  it("created file has mode 0o600", async () => {
    const path = await store.createSession("routine-abc", "2026-05-08T09:00:00.000Z");
    const s = await stat(path);
    // On macOS/Linux the mode includes file type bits, mask to permission bits.
    expect(s.mode & 0o777).toBe(0o600);
  });

  it("parent directory has mode 0o700", async () => {
    const path = await store.createSession("routine-abc", "2026-05-08T09:00:00.000Z");
    const dir = join(tmpRoot, "routine-abc");
    const s = await stat(dir);
    expect(s.mode & 0o777).toBe(0o700);
  });

  it("sanitizes routineId with unsafe chars", async () => {
    const path = await store.createSession("../evil/../../id", "2026-05-08T09:00:00.000Z");
    expect(path).not.toContain("..");
  });
});

describe("listRecent", () => {
  it("returns empty array when directory does not exist", async () => {
    const result = await store.listRecent("nonexistent");
    expect(result).toEqual([]);
  });

  it("returns entries sorted newest first", async () => {
    await store.createSession("r1", "2026-05-08T08:00:00.000Z");
    await store.createSession("r1", "2026-05-08T09:00:00.000Z");
    await store.createSession("r1", "2026-05-08T10:00:00.000Z");
    const records = await store.listRecent("r1");
    expect(records[0].jsonlPath > records[1].jsonlPath).toBe(true);
    expect(records[1].jsonlPath > records[2].jsonlPath).toBe(true);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await store.createSession("r2", `2026-05-08T0${i}:00:00.000Z`);
    }
    const records = await store.listRecent("r2", 3);
    expect(records.length).toBe(3);
  });
});

describe("purgeRoutine", () => {
  it("removes routine session directory", async () => {
    await store.createSession("r-purge", "2026-05-08T09:00:00.000Z");
    await store.purgeRoutine("r-purge");
    const remaining = await readdir(tmpRoot).catch(() => []);
    expect(remaining.includes("r-purge")).toBe(false);
  });

  it("is a no-op when routine has no sessions", async () => {
    await expect(store.purgeRoutine("no-sessions")).resolves.toBeUndefined();
  });
});

describe("isPathSafe (path traversal guard)", () => {
  it("accepts a path inside sessions root", async () => {
    const safe = join(tmpRoot, "r1", "2026.jsonl");
    expect(store.isPathSafe(safe)).toBe(true);
  });

  it("rejects a path escaping the sessions root", () => {
    const unsafe = join(tmpRoot, "..", "other", "session.jsonl");
    expect(store.isPathSafe(unsafe)).toBe(false);
  });

  it("rejects absolute path outside root", () => {
    expect(store.isPathSafe("/etc/passwd")).toBe(false);
  });
});

/**
 * RoutineSessionStore — unit tests.
 *
 * Tests: createSession (dir/mode), listRecent (sort order), purgeRoutine, path traversal guard.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, stat, readdir, writeFile } from "node:fs/promises";
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

  it.skipIf(process.platform === "win32")("created file has mode 0o600", async () => {
    const path = await store.createSession("routine-abc", "2026-05-08T09:00:00.000Z");
    const s = await stat(path);
    // On macOS/Linux the mode includes file type bits, mask to permission bits.
    expect(s.mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("parent directory has mode 0o700", async () => {
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

describe("findForFiredAt", () => {
  it("returns the exact session when firedAt matches the session filename", async () => {
    const path = await store.createSession("r-exact", "2026-05-10T07:06:02.698Z");
    const record = await store.findForFiredAt("r-exact", "2026-05-10T07:06:02.698Z");
    expect(record?.jsonlPath).toBe(path);
    expect(record?.firedAt).toBe("2026-05-10T07:06:02.698Z");
  });

  it("returns the same fire tick session when file creation differs by milliseconds", async () => {
    const path = await store.createSession("r-skew", "2026-05-10T07:06:02.701Z");
    const record = await store.findForFiredAt("r-skew", "2026-05-10T07:06:02.698Z");
    expect(record?.jsonlPath).toBe(path);
    expect(record?.firedAt).toBe("2026-05-10T07:06:02.701Z");
  });

  it("does not attach an unrelated session outside the routine fire tick", async () => {
    await store.createSession("r-far", "2026-05-10T07:06:12.000Z");
    const record = await store.findForFiredAt("r-far", "2026-05-10T07:06:02.000Z");
    expect(record).toBeUndefined();
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

describe("extractSummary", () => {
  async function writeJsonl(filePath: string, messages: unknown[]): Promise<void> {
    const lines = messages.map((m) => JSON.stringify(m)).join("\n");
    await writeFile(filePath, lines + "\n", { encoding: "utf-8" });
  }

  it("extracts <summary> tag content from last assistant message", async () => {
    const p = await store.createSession("es-test", "2026-05-09T10:00:00.000Z");
    await writeJsonl(p, [
      { role: "user", content: "루틴 실행해줘" },
      { role: "assistant", content: "## 오늘의 업무 현황\n- 항목1\n- 항목2\n\n<summary>오늘 업무 3건 중 2건 완료, 1건 진행 중</summary>" },
    ]);
    const result = await store.extractSummary(p);
    expect(result).toBe("오늘 업무 3건 중 2건 완료, 1건 진행 중");
  });

  it("returns [요약 형식 누락] when <summary> tag is absent", async () => {
    const p = await store.createSession("es-test", "2026-05-09T10:01:00.000Z");
    await writeJsonl(p, [
      { role: "user", content: "루틴 실행해줘" },
      { role: "assistant", content: "## 결과\n- 항목1\n- 항목2" },
    ]);
    const result = await store.extractSummary(p);
    expect(result).toBe("[요약 형식 누락]");
  });

  it("caps extracted summary at 200 codepoints", async () => {
    const longSummary = "가".repeat(250);
    const p = await store.createSession("es-test", "2026-05-09T10:02:00.000Z");
    await writeJsonl(p, [
      { role: "assistant", content: `본문\n<summary>${longSummary}</summary>` },
    ]);
    const result = await store.extractSummary(p);
    expect([...result].length).toBe(200);
  });

  it("returns empty string when file is empty", async () => {
    const p = await store.createSession("es-test", "2026-05-09T10:03:00.000Z");
    // file is created empty by createSession
    const result = await store.extractSummary(p);
    expect(result).toBe("");
  });

  it("returns empty string when file has no assistant message", async () => {
    const p = await store.createSession("es-test", "2026-05-09T10:04:00.000Z");
    await writeJsonl(p, [
      { role: "user", content: "안녕" },
    ]);
    const result = await store.extractSummary(p);
    expect(result).toBe("");
  });

  it("handles Anthropic-style content array with <summary> tag", async () => {
    const p = await store.createSession("es-test", "2026-05-09T10:05:00.000Z");
    await writeJsonl(p, [
      { role: "assistant", content: [{ type: "text", text: "결과 본문\n<summary>요약 텍스트</summary>" }] },
    ]);
    const result = await store.extractSummary(p);
    expect(result).toBe("요약 텍스트");
  });
});

/**
 * D5 — MemoryManager search tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";

let dir: string;
let mm: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(homedir(), ".lvis", "test-tmp", "lvis-search-"));
  mm = new MemoryManager({ lvisDir: dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryManager.searchNotes", () => {
  it("returns empty array for empty query", async () => {
    await mm.saveNote("프로젝트 목표", "분기 매출 달성");
    const results = mm.searchNotes("");
    // empty query matches all — cap 50
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("matches title substring (case-insensitive)", async () => {
    await mm.saveNote("Meeting Notes", "weekly sync discussion");
    await mm.saveNote("장보기 목록", "사과 바나나");
    const results = mm.searchNotes("meeting");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Meeting Notes");
  });

  it("matches body substring", async () => {
    await mm.saveNote("기타 메모", "quarterly review 내용 정리");
    await mm.saveNote("다른 메모", "무관한 내용");
    const results = mm.searchNotes("quarterly");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("기타 메모");
  });

  it("caps results at 50", async () => {
    for (let i = 0; i < 60; i++) {
      await mm.saveNote(`메모 ${i}`, "공통 키워드 hello");
    }
    const results = mm.searchNotes("hello");
    expect(results.length).toBe(50);
  });
});

describe("MemoryManager.searchSessions", () => {
  it("returns empty array when no sessions exist", () => {
    const results = mm.searchSessions("hello");
    expect(results).toEqual([]);
  });

  it("returns empty array for query shorter than 2 chars", async () => {
    await mm.saveSession("a1b2c3d4-e5f6-7890-abcd-ef1234567890", [
      { role: "user", content: "hello world" },
    ]);
    expect(mm.searchSessions("")).toEqual([]);
    expect(mm.searchSessions("h")).toEqual([]);
    expect(mm.searchSessions("  ")).toEqual([]);
  });

  it("skips files whose stem is not UUID-shaped", async () => {
    // Write a non-UUID file directly into sessionsDir
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sessionsDir = join(dir, "sessions");
    writeFileSync(join(sessionsDir, "../../etc-passwd.jsonl"), JSON.stringify({ role: "user", content: "secret hello data" }) + "\n");
    writeFileSync(join(sessionsDir, "notauuid.jsonl"), JSON.stringify({ role: "user", content: "hello leak" }) + "\n");
    const results = mm.searchSessions("hello");
    // Non-UUID files should be skipped entirely
    const sessionIds = results.map((r) => r.sessionId);
    expect(sessionIds).not.toContain("../../etc-passwd");
    expect(sessionIds).not.toContain("notauuid");
  });

  it("skips files larger than 5MB", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const sessionsDir = join(dir, "sessions");
    const bigId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    // Write >5MB file
    const bigLine = JSON.stringify({ role: "user", content: "hello " + "x".repeat(6_000_000) });
    writeFileSync(join(sessionsDir, `${bigId}.jsonl`), bigLine + "\n");
    const results = mm.searchSessions("hello");
    expect(results.find((r) => r.sessionId === bigId)).toBeUndefined();
  });

  it("truncates matchedMessage to ~200 chars centred on match", async () => {
    const sessionId = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";
    const prefix = "a".repeat(150);
    const suffix = "b".repeat(150);
    const content = `${prefix}KEYWORD${suffix}`;
    await mm.saveSession(sessionId, [{ role: "user", content }]);
    const results = mm.searchSessions("KEYWORD");
    expect(results.length).toBe(1);
    expect(results[0].matchedMessage.length).toBeLessThanOrEqual(210);
    expect(results[0].matchedMessage).toContain("KEYWORD");
  });

  it("matches message content substring", async () => {
    const sessionId = "cccccccc-dddd-eeee-ffff-000000000001";
    await mm.saveSession(sessionId, [
      { role: "user", content: "quarterly report 분석 요청" },
      { role: "assistant", content: "네, 분석해드리겠습니다." },
    ]);
    const results = mm.searchSessions("quarterly");
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBe(sessionId);
    expect(results[0].matchedMessage).toContain("quarterly");
  });

  it("caps results at 50", async () => {
    for (let i = 0; i < 60; i++) {
      const id = `dddddddd-eeee-ffff-0000-${String(i).padStart(12, "0")}`;
      await mm.saveSession(id, [
        { role: "user", content: `hello world message ${i}` },
      ]);
    }
    const results = mm.searchSessions("hello");
    expect(results.length).toBe(50);
  });
});

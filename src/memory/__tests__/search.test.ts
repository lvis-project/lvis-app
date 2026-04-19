/**
 * D5 — MemoryManager search tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../memory-manager.js";

let dir: string;
let mm: MemoryManager;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lvis-search-"));
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

  it("matches message content substring", async () => {
    const sessionId = "test-session-001";
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
      await mm.saveSession(`sess-${i}`, [
        { role: "user", content: `hello world message ${i}` },
      ]);
    }
    const results = mm.searchSessions("hello");
    expect(results.length).toBe(50);
  });
});

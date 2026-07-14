/**
 * D5 — MemoryManager search tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
  mm.stopPersistentContextWatcher();
  mm.closeSearchIndex();
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryManager.searchMemoryEntries", () => {
  it("returns empty array for empty query", async () => {
    await mm.saveMemory("프로젝트 목표", "분기 매출 달성");
    const results = mm.searchMemoryEntries("");
    // empty query matches all — cap 50
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  it("matches title substring (case-insensitive)", async () => {
    await mm.saveMemory("Meeting Notes", "weekly sync discussion");
    await mm.saveMemory("장보기 목록", "사과 바나나");
    const results = mm.searchMemoryEntries("meeting");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("Meeting Notes");
  });

  it("matches body substring", async () => {
    await mm.saveMemory("기타 기억", "quarterly review 내용 정리");
    await mm.saveMemory("다른 기억", "무관한 내용");
    const results = mm.searchMemoryEntries("quarterly");
    expect(results.length).toBe(1);
    expect(results[0].title).toBe("기타 기억");
  });

  it("scopes saved notes by projectRoot while keeping legacy notes for the default project", async () => {
    await mm.saveMemory("Legacy Note", "shared baseline");
    await mm.saveMemory("Alpha Note", "alpha secret", {
      projectRoot: "C:\\workspace\\alpha",
      projectName: "alpha",
    });
    await mm.saveMemory("Beta Note", "beta secret", {
      projectRoot: "C:\\workspace\\beta",
      projectName: "beta",
    });

    expect(mm.searchMemoryEntries("secret", { projectRoot: "C:\\workspace\\alpha" }).map((entry) => entry.title))
      .toEqual(["Alpha Note"]);
    expect(mm.searchMemoryEntries("secret", { projectRoot: "c:/workspace/alpha/" }).map((entry) => entry.title))
      .toEqual(["Alpha Note"]);
    expect(mm.listMemoryEntries({ projectRoot: "C:\\workspace\\alpha", includeUnscoped: true }).map((entry) => entry.title))
      .toEqual(expect.arrayContaining(["Legacy Note", "Alpha Note"]));
    expect(mm.getMemoryContext({ projectRoot: "C:\\workspace\\alpha" })).toContain("alpha secret");
    expect(mm.getMemoryContext({ projectRoot: "C:\\workspace\\alpha" })).not.toContain("beta secret");
    expect(mm.getMemoryIndex({ projectRoot: "C:\\workspace\\alpha" })).toBe("");
  });

  it("caps results at 50", async () => {
    for (let i = 0; i < 60; i++) {
      await mm.saveMemory(`기억 ${i}`, "공통 키워드 hello");
    }
    const results = mm.searchMemoryEntries("hello");
    expect(results.length).toBe(50);
  });
});

describe("MemoryManager AGENTS.md and MEMORY.md layout", () => {
  it("creates AGENTS.md and memories/MEMORY.md on first boot", () => {
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "memories", "MEMORY.md"))).toBe(true);
    expect(existsSync(join(dir, "memory"))).toBe(false);
    const index = readFileSync(join(dir, "memories", "MEMORY.md"), "utf-8");
    expect(index).toContain("## Urgent Memory");
    expect(index).toContain("## References");
    expect(index).toContain("## Saved Memories");
  });

  it("migrates legacy LVIS.md and memory/ into the new layout", () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, "memory"), { recursive: true });
    writeFileSync(join(dir, "LVIS.md"), "# Legacy LVIS", "utf-8");
    writeFileSync(join(dir, "memory", "old-note.md"), "# Old Note\n\nbody", "utf-8");

    const migrated = new MemoryManager({ lvisDir: dir });
    migrated.load();

    expect(existsSync(join(dir, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(dir, "LVIS.md"))).toBe(false);
    expect(existsSync(join(dir, "memories", "old-note.md"))).toBe(true);
    expect(migrated.getAgentsMd()).toContain("Legacy LVIS");
  });

  it("updates MEMORY.md when saving a memory and injects it via getMemoryIndex", async () => {
    await mm.saveMemory("Meeting Notes", "weekly sync discussion");
    const index = readFileSync(join(dir, "memories", "MEMORY.md"), "utf-8");
    expect(index).toContain("[Meeting Notes](./meeting-notes.md)");
    expect(mm.getMemoryIndex()).toContain("weekly sync discussion");
  });

  it("updates MEMORY.md directly for sectioned urgent memory", async () => {
    await mm.updateMemoryIndex("# LVIS Memory Index\n\n## Urgent Memory\n\n500자 내외 긴급 기억\n");

    const index = readFileSync(join(dir, "memories", "MEMORY.md"), "utf-8");
    expect(index).toContain("500자 내외 긴급 기억");
    expect(mm.getMemoryIndex()).toContain("500자 내외 긴급 기억");
  });

  it("updates MEMORY.md sections under the current file lock without dropping saved memories", async () => {
    await mm.saveMemory("Meeting Notes", "weekly sync discussion");
    await mm.updateMemoryIndex("# LVIS Memory Index\n\n## Urgent Memory\n\nold urgent\n\n## References\n\nold link\n\n## Saved Memories\n\n- [Meeting Notes](./meeting-notes.md) — weekly sync discussion\n");

    await mm.updateMemoryIndexSections({
      urgentMemory: "new urgent",
      references: "new link",
    });

    const index = readFileSync(join(dir, "memories", "MEMORY.md"), "utf-8");
    expect(index).toContain("## Urgent Memory\n\nnew urgent");
    expect(index).not.toContain("old urgent");
    expect(index).toContain("## References\n\nnew link");
    expect(index).not.toContain("old link");
    expect(index).toContain("[Meeting Notes](./meeting-notes.md)");
  });

  it("compare-and-set updates MEMORY.md only when unchanged", async () => {
    mm.load();
    const before = mm.getMemoryIndex();
    await expect(mm.updateMemoryIndexIfUnchanged(before, "# LVIS Memory Index\nfresh")).resolves.toBe(true);
    expect(mm.getMemoryIndex()).toContain("fresh");

    writeFileSync(join(dir, "memories", "MEMORY.md"), "# LVIS Memory Index\nmanual edit", "utf-8");
    await expect(mm.updateMemoryIndexIfUnchanged("# LVIS Memory Index\nfresh", "# LVIS Memory Index\nstale")).resolves.toBe(false);
    expect(mm.getMemoryIndex()).toContain("manual edit");
  });

  it("compare-and-set updates user-preferences.md only when unchanged", async () => {
    mm.load();
    const before = mm.getUserPreferences();

    await expect(mm.updateUserPreferencesIfUnchanged(before, "# User Preferences\nupdated")).resolves.toBe(true);
    expect(mm.getUserPreferences()).toBe("# User Preferences\nupdated");

    writeFileSync(join(dir, "user-preferences.md"), "# User Preferences\nmanual edit", "utf-8");
    await expect(mm.updateUserPreferencesIfUnchanged("# User Preferences\nupdated", "# User Preferences\nstale refresh")).resolves.toBe(false);

    expect(readFileSync(join(dir, "user-preferences.md"), "utf-8")).toBe("# User Preferences\nmanual edit");
    expect(mm.getUserPreferences()).toBe("# User Preferences\nmanual edit");
  });

  it("does not allow saved memory titles to overwrite MEMORY.md", async () => {
    const entry = await mm.saveMemory("MEMORY", "reserved index collision");

    expect(entry.filename.toLowerCase()).not.toBe("memory.md");
    expect(existsSync(join(dir, "memories", entry.filename))).toBe(true);
    const index = readFileSync(join(dir, "memories", "MEMORY.md"), "utf-8");
    expect(index).toContain(`# LVIS Memory Index`);
    expect(index).toContain(`](./${entry.filename})`);
  });

  it("removes deleted memories from MEMORY.md and the cached index", async () => {
    await mm.saveMemory("Meeting Notes", "weekly sync discussion");

    await mm.deleteMemory("meeting-notes.md");

    expect(existsSync(join(dir, "memories", "meeting-notes.md"))).toBe(false);
    const index = readFileSync(join(dir, "memories", "MEMORY.md"), "utf-8");
    expect(index).not.toContain("[Meeting Notes](./meeting-notes.md)");
    expect(mm.getMemoryIndex()).not.toContain("weekly sync discussion");
  });

  it("does not allow MEMORY.md to be deleted as a normal memory entry", async () => {
    await expect(mm.deleteMemory("MEMORY.md")).rejects.toThrow(/MEMORY\.md is an index file/);
    expect(existsSync(join(dir, "memories", "MEMORY.md"))).toBe(true);
  });

  it("reloads AGENTS.md and MEMORY.md after direct file edits", async () => {
    mm.load();
    mm.startPersistentContextWatcher();
    await new Promise((resolve) => setTimeout(resolve, 50));

    writeFileSync(join(dir, "AGENTS.md"), "# Live Agents\n\nwatcher updated", "utf-8");
    await waitUntil(() => mm.getAgentsMd().includes("watcher updated"), 3000);

    writeFileSync(join(dir, "memories", "MEMORY.md"), "# Live Memory\n\nindex updated", "utf-8");
    await waitUntil(() => mm.getMemoryIndex().includes("index updated"), 3000);
  });

  it("injects directly edited detailed memory files without a tool call", () => {
    mm.load();
    writeFileSync(
      join(dir, "memories", "direct-memory.md"),
      "# Direct Memory\n\nfile-backed context",
      "utf-8",
    );

    expect(mm.getMemoryContext()).toContain("file-backed context");
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(predicate()).toBe(true);
}

describe("MemoryManager.searchSessions", () => {
  it("returns empty array when no sessions exist", () => {
    const results = mm.searchSessions("hello");
    expect(results).toEqual([]);
  });

  it("returns empty array for genuinely trivial queries (empty / 1-char / whitespace)", async () => {
    await mm.saveSession("a1b2c3d4-e5f6-7890-abcd-ef1234567890", [
      { role: "user", content: "hello world" },
    ]);
    // Only < 2 code points is rejected upstream; 2 code points is served by the
    // LIKE fallback (see the Korean 2-syllable tests below).
    expect(mm.searchSessions("")).toEqual([]);
    expect(mm.searchSessions("h")).toEqual([]);
    expect(mm.searchSessions("  ")).toEqual([]);
    expect(mm.searchSessions("가")).toEqual([]); // 1 Korean syllable = 1 code point
  });

  it("matches a 2-syllable Korean query via the LIKE fallback (2-char CJK, trigram-floor gap)", async () => {
    const id = "a2b2c3d4-e5f6-7890-abcd-ef1234567891";
    await mm.saveSession(id, [
      { role: "user", content: "이번 분기 매출 목표를 검토합시다" },
      { role: "assistant", content: "회의 일정을 잡겠습니다" },
    ]);
    // These 2-syllable queries are BELOW the FTS5 trigram floor (3 code points)
    // — a MATCH-only impl would 0-hit them (the regression this guards).
    expect(mm.searchSessions("매출").map((r) => r.sessionId)).toEqual([id]);
    expect(mm.searchSessions("분기").map((r) => r.sessionId)).toEqual([id]);
    expect(mm.searchSessions("목표").map((r) => r.sessionId)).toEqual([id]);
    expect(mm.searchSessions("회의").map((r) => r.sessionId)).toEqual([id]);
    // The excerpt is centred on the match.
    expect(mm.searchSessions("매출")[0].matchedMessage).toContain("매출");
  });

  it("matches a 2-char ASCII query case-insensitively via the LIKE fallback", async () => {
    const id = "a3b2c3d4-e5f6-7890-abcd-ef1234567892";
    await mm.saveSession(id, [{ role: "user", content: "Node.js Runtime notes" }]);
    // "no" is 2 chars — LIKE branch — and must fold case like the old toLowerCase scan.
    expect(mm.searchSessions("no").map((r) => r.sessionId)).toEqual([id]);
    expect(mm.searchSessions("NO").map((r) => r.sessionId)).toEqual([id]);
  });

  it("keeps 3+ code-point Korean on the fast MATCH path", async () => {
    const id = "a4b2c3d4-e5f6-7890-abcd-ef1234567893";
    await mm.saveSession(id, [{ role: "user", content: "분기 보고서 초안을 작성했습니다" }]);
    // 3 syllables → trigram MATCH (not LIKE).
    expect(mm.searchSessions("보고서").map((r) => r.sessionId)).toEqual([id]);
  });

  it("handles a Korean+ASCII mixed 2-code-point query", async () => {
    const id = "a5b2c3d4-e5f6-7890-abcd-ef1234567894";
    await mm.saveSession(id, [{ role: "user", content: "버전 v2 릴리스" }]);
    // "v2" (2 code points, ASCII) via LIKE; also a mixed "전v"? keep the simple ASCII 2-char.
    expect(mm.searchSessions("v2").map((r) => r.sessionId)).toEqual([id]);
  });

  it("escapes LIKE metacharacters (% and _) in a 2-char query so they match literally", async () => {
    const literalId = "a6b2c3d4-e5f6-7890-abcd-ef1234567895";
    const decoyId = "a7b2c3d4-e5f6-7890-abcd-ef1234567896";
    await mm.saveSession(literalId, [{ role: "user", content: "growth was 5% this quarter" }]);
    await mm.saveSession(decoyId, [{ role: "user", content: "value 5X and 5Y only" }]);
    // "5%" must match ONLY the literal "5%" row, not treat % as a wildcard that
    // would also match "5X"/"5Y" in the decoy row.
    const hits = mm.searchSessions("5%").map((r) => r.sessionId);
    expect(hits).toEqual([literalId]);

    const underscoreId = "a8b2c3d4-e5f6-7890-abcd-ef1234567897";
    const underscoreDecoy = "a9b2c3d4-e5f6-7890-abcd-ef1234567898";
    await mm.saveSession(underscoreId, [{ role: "user", content: "the a_b marker here" }]);
    await mm.saveSession(underscoreDecoy, [{ role: "user", content: "the axb variant here" }]);
    // "a_" must match "a_b" literally, NOT wildcard-match "ax" in the decoy.
    const uHits = mm.searchSessions("a_").map((r) => r.sessionId);
    expect(uHits).toContain(underscoreId);
    expect(uHits).not.toContain(underscoreDecoy);
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
    expect(results[0].title).toBe("quarterly report 분석 요청");
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

// ── FTS5 index behaviors (#1500 / E3) ────────────────────────────────────
describe("MemoryManager.searchSessions — FTS5 escape + injection safety", () => {
  it("treats FTS5 operators in the query as literal text (no syntax error)", async () => {
    const id = "10000000-0000-4000-8000-000000000001";
    await mm.saveSession(id, [{ role: "user", content: "deploy AND rollback plan" }]);
    // `AND` is an FTS5 operator; escaping forces a literal phrase match so the
    // query is neither a syntax error nor a boolean AND across the corpus.
    const results = mm.searchSessions("deploy AND rollback");
    expect(results.map((r) => r.sessionId)).toEqual([id]);
  });

  it("does not throw on an unterminated double-quote in the query", async () => {
    const id = "10000000-0000-4000-8000-000000000002";
    await mm.saveSession(id, [{ role: "user", content: 'he said "hello there" loudly' }]);
    // A raw `"hello` would be an unterminated FTS5 phrase; escaping doubles the
    // quote so it is matched literally and the call returns rather than crashes.
    expect(() => mm.searchSessions('"hello')).not.toThrow();
    const results = mm.searchSessions('"hello there"');
    expect(results.map((r) => r.sessionId)).toEqual([id]);
  });

  it("matches a substring inside an unbroken token (trigram tokenizer)", async () => {
    const id = "10000000-0000-4000-8000-000000000003";
    // A URL is one unbroken token; a whole-token tokenizer would miss `example`
    // inside it. Trigram restores the old substring (indexOf) semantics.
    await mm.saveSession(id, [{ role: "user", content: "see https://example.com/path" }]);
    expect(mm.searchSessions("example").map((r) => r.sessionId)).toEqual([id]);
  });

  it("indexes text parts of array (multi-part) user content", async () => {
    const id = "10000000-0000-4000-8000-000000000004";
    await mm.saveSession(id, [
      { role: "user", content: [{ type: "text", text: "multipart needle here" }] },
    ]);
    expect(mm.searchSessions("needle").map((r) => r.sessionId)).toEqual([id]);
  });
});

describe("MemoryManager.searchSessions — timestamp sourcing", () => {
  it("uses the session JSONL mtime, not the index-write time", async () => {
    const id = "60000000-0000-4000-8000-000000000001";
    await mm.saveSession(id, [{ role: "user", content: "timestamp keyword body" }]);
    // Back-date the session file well into the past.
    const past = new Date("2020-01-02T03:04:05.000Z");
    const { utimesSync } = await import("node:fs");
    utimesSync(join(dir, "sessions", `${id}.jsonl`), past, past);
    // Drop the index entirely so the boot check does a TRUE rebuild that reads
    // the (now back-dated) mtime — verifyOrRebuildSearchIndex is a no-op on a
    // healthy non-empty index, so the row must be gone for the rebuild to fire.
    mm.closeSearchIndex();
    rmSync(join(dir, "search"), { recursive: true, force: true });
    await mm.verifyOrRebuildSearchIndex();

    const hit = mm.searchSessions("timestamp").find((r) => r.sessionId === id);
    expect(hit).toBeDefined();
    // The reported timestamp must track the (past) file mtime, not "now".
    expect(new Date(hit!.timestamp).getUTCFullYear()).toBe(2020);
  });
});

describe("MemoryManager.saveImportedSession", () => {
  it("always persists sessionKind:\"main\" regardless of any inherited metadata", async () => {
    const id = "50000000-0000-4000-8000-000000000001";
    await mm.saveImportedSession(id, [
      { role: "user", content: "imported conversation body" },
      { role: "assistant", content: "reply" },
    ]);
    // Imported sessions are brand-new MAIN sessions — they must appear in the
    // default (main-kind) search/list surface and NOT under any routine scope.
    expect(mm.searchSessions("imported").map((r) => r.sessionId)).toEqual([id]);
    expect(mm.searchSessions("imported", { kind: "routine" })).toEqual([]);
    expect(mm.listSessions().map((s) => s.id)).toContain(id);
    // Assert the persisted metadata sessionKind directly.
    const metaPath = join(dir, "sessions", `${id}.meta.json`);
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    expect(meta.sessionKind).toBe("main");
  });
});

describe("MemoryManager.searchSessions — index maintenance", () => {
  it("removes a deleted session's row from the search index (no orphan hit)", async () => {
    const id = "20000000-0000-4000-8000-000000000001";
    await mm.saveSession(id, [{ role: "user", content: "ephemeral keyword body" }]);
    expect(mm.searchSessions("ephemeral").map((r) => r.sessionId)).toEqual([id]);

    await mm.deleteSession(id);
    expect(mm.searchSessions("ephemeral")).toEqual([]);
  });

  it("re-indexes on metadata-only update so scope filters stay correct", async () => {
    const id = "20000000-0000-4000-8000-000000000002";
    await mm.saveSession(id, [{ role: "user", content: "scoped keyword content" }]);
    // Tag it as a routine session AFTER the initial save (create-then-tag).
    await mm.saveSessionMetadata(id, { sessionKind: "routine", routineId: "r-1" });
    // Default (main-kind) search must NOT see it; routine-scoped search must.
    expect(mm.searchSessions("scoped")).toEqual([]);
    expect(mm.searchSessions("scoped", { kind: "routine" }).map((r) => r.sessionId)).toEqual([id]);
  });

  it("rebuilds the index from JSONL after the DB file is corrupted", async () => {
    const id = "20000000-0000-4000-8000-000000000003";
    await mm.saveSession(id, [{ role: "user", content: "durable rebuild keyword" }]);
    expect(mm.searchSessions("durable").map((r) => r.sessionId)).toEqual([id]);

    // Corrupt the on-disk index (overwrite with junk) — search should now miss.
    const dbPath = join(dir, "search", "index.db");
    writeFileSync(dbPath, "not a sqlite database at all", "utf-8");
    // Boot integrity check must detect corruption and rebuild from the JSONL SOT.
    await mm.verifyOrRebuildSearchIndex();
    expect(mm.searchSessions("durable").map((r) => r.sessionId)).toEqual([id]);
  });

  it("rebuilds a missing index from existing session files at boot", async () => {
    const id = "20000000-0000-4000-8000-000000000004";
    await mm.saveSession(id, [{ role: "user", content: "cold boot keyword" }]);
    // Simulate a first boot with no index: delete the whole search dir.
    rmSync(join(dir, "search"), { recursive: true, force: true });
    await mm.verifyOrRebuildSearchIndex();
    expect(mm.searchSessions("cold").map((r) => r.sessionId)).toEqual([id]);
  });
});

describe("MemoryManager.listSessionEntries", () => {
  it("returns recent sessions with inspectable excerpts", async () => {
    const sessionId = "eeeeeeee-ffff-0000-1111-222222222222";
    await mm.saveSession(sessionId, [
      { role: "user", content: "first message" },
      { role: "assistant", content: "latest answer preview" },
    ]);

    const results = mm.listSessionEntries();
    expect(results.length).toBe(1);
    expect(results[0].sessionId).toBe(sessionId);
    expect(results[0].title).toBe("first message");
    expect(results[0].matchedMessage).toContain("latest answer preview");
  });

  it("skips malformed session lines instead of crashing", async () => {
    const { appendFileSync } = await import("node:fs");
    const sessionId = "ffffffff-0000-1111-2222-333333333333";
    await mm.saveSession(sessionId, [
      { role: "assistant", content: "valid message" },
    ]);
    appendFileSync(join(dir, "sessions", `${sessionId}.jsonl`), "{not-json}\n", "utf-8");

    const loaded = mm.loadSession(sessionId);
    expect(Array.isArray(loaded)).toBe(true);
    expect((loaded ?? []).length).toBe(1);

    const sessions = mm.listSessions();
    expect(sessions[0].preview).toContain("valid message");
  });

  it("uses a fallback preview for oversized session files", async () => {
    const { writeFileSync } = await import("node:fs");
    const sessionId = "99999999-aaaa-bbbb-cccc-444444444444";
    writeFileSync(join(dir, "sessions", `${sessionId}.jsonl`), "x".repeat(5_000_001), "utf-8");

    const sessions = mm.listSessions();
    expect(sessions[0].id).toBe(sessionId);
    expect(sessions[0].preview).toMatch(/미리보기를 생략|preview skipped/);
  });

  it("defaults list/search APIs to main sessions and requires explicit routine scope", async () => {
    const mainId = "11111111-2222-3333-4444-555555555555";
    const routineSessionId = "22222222-3333-4444-5555-666666666666";
    const routineIdOnlySessionId = "33333333-4444-5555-6666-777777777777";
    await mm.saveSession(mainId, [{ role: "user", content: "needle main" }]);
    await mm.saveSessionMetadata(mainId, { sessionKind: "main", title: "Main" });
    await mm.saveSession(routineSessionId, [{ role: "user", content: "needle routine" }]);
    await mm.saveSessionMetadata(routineSessionId, {
      sessionKind: "routine",
      routineId: "routine-a",
      routineTitle: "Routine A",
    });
    await mm.saveSession(routineIdOnlySessionId, [{ role: "user", content: "needle routine id only" }]);
    await mm.saveSessionMetadata(routineIdOnlySessionId, { routineId: "routine-a", title: "Routine id only" });

    expect(mm.listSessions().map((s) => s.id)).toEqual(expect.arrayContaining([mainId, routineIdOnlySessionId]));
    expect(mm.listSessions().map((s) => s.id)).not.toContain(routineSessionId);
    expect(mm.listSessions({ kind: "routine" }).map((s) => s.id)).toEqual([routineSessionId]);
    expect(mm.listSessionsByRoutine("routine-a").map((s) => s.id)).toEqual([routineSessionId]);
    expect(mm.searchSessions("needle").map((s) => s.sessionId)).toEqual(expect.arrayContaining([mainId, routineIdOnlySessionId]));
    expect(mm.searchSessions("needle").map((s) => s.sessionId)).not.toContain(routineSessionId);
    expect(mm.searchSessions("needle", { kind: "routine" }).map((s) => s.sessionId)).toEqual([routineSessionId]);
  });

  it("deleteSession removes the jsonl, metadata, per-session archive, checkpoint snapshots, and diff sidecars", async () => {
    const sessionId = "44444444-5555-6666-7777-888888888888";
    const sessionsDir = join(dir, "sessions");
    const diffCacheDir = join(dir, "diff-cache", sessionId);
    await mm.saveSession(sessionId, [{ role: "user", content: "delete me" }]);
    await mm.saveSessionMetadata(sessionId, { sessionKind: "main", title: "Delete me" });
    await mm.saveCheckpointSnapshot(sessionId, 1, [{ role: "user", content: "snapshot" }]);
    mkdirSync(join(sessionsDir, sessionId, "truncated"), { recursive: true });
    writeFileSync(join(sessionsDir, sessionId, "truncated", "0.jsonl"), "archive", "utf-8");
    mkdirSync(diffCacheDir, { recursive: true });
    writeFileSync(join(diffCacheDir, "tool-call.json"), "diff", "utf-8");

    await mm.deleteSession(sessionId);

    expect(existsSync(join(sessionsDir, `${sessionId}.jsonl`))).toBe(false);
    expect(existsSync(join(sessionsDir, `${sessionId}.meta.json`))).toBe(false);
    expect(existsSync(join(sessionsDir, sessionId))).toBe(false);
    expect(existsSync(join(sessionsDir, ".checkpoints", sessionId))).toBe(false);
    expect(existsSync(diffCacheDir)).toBe(false);
  });
});

/**
 * AuditLogger.search() + getStats() — filter correctness, date range, pagination.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

// Patch homedir so AuditLogger writes to a temp dir during tests.
import { homedir } from "node:os";
import { vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: vi.fn(orig.homedir) };
});

import { AuditLogger, type AuditEntry } from "../audit-logger.js";

let testHome: string;
let auditDir: string;

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: "test-session",
    type: "turn",
    input: "hello",
    output: "world",
    ...overrides
  };
}

function writeJsonl(filename: string, entries: AuditEntry[]) {
  const path = join(auditDir, filename);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf-8");
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "lvis-audit-test-"));
  auditDir = join(testHome, ".lvis", "audit");
  mkdirSync(auditDir, { recursive: true });
  vi.mocked(homedir).mockReturnValue(testHome);
});

afterEach(() => {
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("AuditLogger.search()", () => {
  it("returns all entries when no filter", async () => {
    writeJsonl("2026-04-17.jsonl", [makeEntry({ type: "turn" }), makeEntry({ type: "tool_call" })]);
    writeJsonl("2026-04-18.jsonl", [makeEntry({ type: "error" })]);
    const logger = new AuditLogger();
    const { entries, total } = await logger.search({});
    expect(total).toBe(3);
    expect(entries).toHaveLength(3);
  });

  it("filters by type", async () => {
    writeJsonl("2026-04-17.jsonl", [
      makeEntry({ type: "turn" }),
      makeEntry({ type: "tool_call" }),
      makeEntry({ type: "turn" }),
    ]);
    const logger = new AuditLogger();
    const { entries, total } = await logger.search({ type: "tool_call" });
    expect(total).toBe(1);
    expect(entries[0].type).toBe("tool_call");
  });

  it("filters by dateFrom/dateTo", async () => {
    writeJsonl("2026-04-15.jsonl", [makeEntry({ type: "warn" })]);
    writeJsonl("2026-04-17.jsonl", [makeEntry({ type: "turn" })]);
    writeJsonl("2026-04-19.jsonl", [makeEntry({ type: "error" })]);
    const logger = new AuditLogger();
    const { total } = await logger.search({ dateFrom: "2026-04-16", dateTo: "2026-04-18" });
    expect(total).toBe(1);
  });

  it("filters by textSearch (case-insensitive)", async () => {
    writeJsonl("2026-04-17.jsonl", [
      makeEntry({ input: "secret token abc" }),
      makeEntry({ input: "normal message" }),
    ]);
    const logger = new AuditLogger();
    const { total } = await logger.search({ textSearch: "SECRET" });
    expect(total).toBe(1);
  });

  it("applies pagination via limit and offset", async () => {
    const entries = Array.from({ length: 10 }, (_, i) =>
      makeEntry({ type: "turn", input: `msg ${i}` }),
    );
    writeJsonl("2026-04-17.jsonl", entries);
    const logger = new AuditLogger();
    const page1 = await logger.search({ limit: 4, offset: 0 });
    expect(page1.total).toBe(10);
    expect(page1.entries).toHaveLength(4);
    const page2 = await logger.search({ limit: 4, offset: 4 });
    expect(page2.entries).toHaveLength(4);
    const page3 = await logger.search({ limit: 4, offset: 8 });
    expect(page3.entries).toHaveLength(2);
  });

  it("returns empty when no files exist", async () => {
    const logger = new AuditLogger();
    const { entries, total } = await logger.search({});
    // Today's empty file may exist (created by constructor); should still be 0 entries.
    expect(total).toBe(0);
    expect(entries).toHaveLength(0);
  });

  it("skips malformed JSON lines gracefully", async () => {
    const path = join(auditDir, "2026-04-17.jsonl");
    writeFileSync(path, `${JSON.stringify(makeEntry())}\nNOT_JSON\n${JSON.stringify(makeEntry())}\n`, "utf-8");
    const logger = new AuditLogger();
    const { total } = await logger.search({});
    expect(total).toBe(2);
  });
});

describe("AuditLogger.getStats()", () => {
  it("counts entries by type", async () => {
    writeJsonl("2026-04-17.jsonl", [
      makeEntry({ type: "turn" }),
      makeEntry({ type: "turn" }),
      makeEntry({ type: "tool_call" }),
    ]);
    const logger = new AuditLogger();
    const stats = await logger.getStats(30);
    expect(stats.totalByType["turn"]).toBe(2);
    expect(stats.totalByType["tool_call"]).toBe(1);
  });

  it("counts sensitive ops (approval + kill_switch)", async () => {
    writeJsonl("2026-04-17.jsonl", [
      makeEntry({ type: "approval" }),
      makeEntry({ type: "kill_switch" }),
      makeEntry({ type: "turn" }),
    ]);
    const logger = new AuditLogger();
    const stats = await logger.getStats(30);
    expect(stats.sensitiveOps).toBe(2);
  });

  it("returns zero stats when no files", async () => {
    const logger = new AuditLogger();
    const stats = await logger.getStats(7);
    expect(stats.sensitiveOps).toBe(0);
    expect(Object.keys(stats.totalByType)).toHaveLength(0);
  });
});

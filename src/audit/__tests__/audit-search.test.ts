/**
 * AuditLogger.search() + getStats() — filter correctness, date range, pagination.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { homedir } from "node:os";
import { finished } from "node:stream/promises";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

// Patch homedir so AuditLogger writes to a temp dir during tests.
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
  testHome = mkdtempSync(join(process.cwd(), ".lvis-audit-test-"));
  auditDir = join(testHome, ".lvis", "audit");
  mkdirSync(auditDir, { recursive: true });
  vi.mocked(homedir).mockReturnValue(testHome);
});

afterEach(async () => {
  // The retry here is MITIGATION for a flake whose mechanism was never pinned down in this
  // file, and saying so matters, because the obvious fix does not apply.
  //
  // Every logger in this file is constructed synchronously in a test body and only ever has
  // `search()` called on it, and `search()` enqueues nothing — it only reads. So
  // `AuditLogger.flush()`, which does exist, would have nothing to drain, and the only
  // writers are the constructor's `mkdirSync` and this file's synchronous `writeJsonl`. Do
  // not "improve" this into a flush call; it would be a no-op dressed as a fix.
  //
  // An earlier version of this comment contrasted the above with the executor teardown,
  // describing that one as a real un-awaited `recordApproval` whose write outlived the test.
  // That contrast was built on a false premise and is gone: `mutatePersistentApprovals`
  // RETURNS the promise covering `readApprovalsFile → mutator → atomicWrite`, and
  // `recordApproval` awaits it, so an awaited call has already landed. The writer that
  // actually raced there was an unflushed `AuditLogger` the executor constructs implicitly —
  // which makes it the same KIND of writer as this file's, just one that is actually written
  // to. See that file's `beforeEach`.
  //
  // So this file's occasional ENOTEMPTY has no demonstrated cause, and retries are the honest
  // response to that. One concrete aggravator IS evidenced though, and naming it is better
  // than the earlier "below that, at the filesystem", which pointed nowhere: `beforeEach` uses
  // `mkdtempSync(join(process.cwd(), ...))`, so these trees are created in the REPO ROOT rather
  // than the OS temp dir, under a multi-worker vitest pool. That is a shared directory with
  // concurrent creators and deleters. It is an aggravator rather than the mechanism — the
  // failure is on `testHome` itself, not its parent — which is why this stays `maxRetries`
  // instead of a claim.
  //
  // Restoring the mock AFTER removal, not before: an earlier version did the reverse and
  // claimed it aimed a late construction at the real home rather than the tree being
  // deleted. Both halves were wrong — the constructor captures `this.auditDir`, so a bound
  // write cannot be redirected, and pointing a hypothetical late writer at the user's real
  // `~/.lvis` is the failure mode to avoid, not the fix.
  //
  // The ladder moved off `rmSync`'s own `maxRetries` (#1983): measured against a real lock
  // that budget is never applied at all, failing in 0ms, so it was mitigation in name only.
  // `cleanupTmpDir` retries the same codes on a bounded ladder that does run.
  if (existsSync(testHome)) {
    await cleanupTmpDir(testHome);
  }
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

  it("streams a large log while retaining only the requested page", async () => {
    const filePath = join(auditDir, "2026-04-17.jsonl");
    const output = createWriteStream(filePath, { encoding: "utf-8" });
    const totalRows = 50_000;
    for (let index = 0; index < totalRows; index += 1) {
      const line = `${JSON.stringify(makeEntry({ input: `${index}:${"x".repeat(1_000)}` }))}\n`;
      if (!output.write(line)) await once(output, "drain");
    }
    output.end();
    await finished(output);

    let eventLoopTicks = 0;
    let scanning = true;
    const tick = () => {
      eventLoopTicks += 1;
      if (scanning) setImmediate(tick);
    };
    setImmediate(tick);

    const logger = new AuditLogger();
    const result = await logger.search({ offset: 49_990, limit: 5 });
    scanning = false;

    expect(result.total).toBe(totalRows);
    expect(result.entries).toHaveLength(5);
    expect(result.entries.map((entry) => entry.input?.split(":", 1)[0])).toEqual([
      "49990",
      "49991",
      "49992",
      "49993",
      "49994",
    ]);
    expect(eventLoopTicks).toBeGreaterThan(0);
  }, 30_000);
});

describe("AuditLogger.getStats()", () => {
  // getStats(N) filters by file-name date; pin fixtures to today so the
  // window doesn't rot as the calendar advances past a hard-coded date.
  const todayJsonl = () => `${new Date().toISOString().slice(0, 10)}.jsonl`;

  it("counts entries by type", async () => {
    writeJsonl(todayJsonl(), [
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
    writeJsonl(todayJsonl(), [
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

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
    // Entries carry the instant their partition was named for, as the store
    // writes them; the range is decided by that instant, not the file name.
    // Noon UTC keeps each entry on its own civil day in every host zone.
    writeJsonl("2026-04-14.jsonl", [makeEntry({ type: "warn", timestamp: "2026-04-14T12:00:00.000Z" })]);
    writeJsonl("2026-04-17.jsonl", [makeEntry({ type: "turn", timestamp: "2026-04-17T12:00:00.000Z" })]);
    writeJsonl("2026-04-20.jsonl", [makeEntry({ type: "error", timestamp: "2026-04-20T12:00:00.000Z" })]);
    const logger = new AuditLogger();
    const { entries, total } = await logger.search({ dateFrom: "2026-04-16", dateTo: "2026-04-18" });
    expect(total).toBe(1);
    expect(entries[0].type).toBe("turn");
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
  // getStats(N) keeps entries by timestamp instant and only opens the UTC
  // partitions that can hold the window; pin fixtures to today's partition so
  // the window doesn't rot as the calendar advances past a hard-coded date.
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

/**
 * The picker hands `search()` HOST-LOCAL civil days while the store stays
 * partitioned by UTC day, so an entry can live in a file named for a day the
 * person never picked. Every case pins `TZ`; CI runs UTC, where the local and
 * UTC days coincide and none of these boundaries exist.
 *
 * Seoul is UTC+9 with no DST: local day D runs [D-1 15:00Z, D 15:00Z).
 * New York is UTC-4 in June (EDT): local day D runs [D 04:00Z, D+1 04:00Z).
 */
describe("AuditLogger.search() — host-local day range over UTC partitions", () => {
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  it("a Seoul host at 01:00 local sees today's entries, which live in yesterday's UTC file", async () => {
    process.env.TZ = "Asia/Seoul";
    writeJsonl("2026-06-15.jsonl", [
      // 01:00 on the 16th in Seoul — picked day, previous UTC partition.
      makeEntry({ timestamp: "2026-06-15T16:00:00.000Z", input: "after-local-midnight" }),
      // 23:30 on the 15th in Seoul — same partition, day before the picked one.
      makeEntry({ timestamp: "2026-06-15T14:30:00.000Z", input: "before-local-midnight" }),
    ]);
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T10:00:00.000Z", input: "local-evening" }),
    ]);
    const logger = new AuditLogger();
    const { entries, total } = await logger.search({ dateFrom: "2026-06-16", dateTo: "2026-06-16" });
    expect(total).toBe(2);
    expect(entries.map((e) => e.input).sort()).toEqual(["after-local-midnight", "local-evening"]);
  });

  it("a New York host at 21:00 local sees entries written after 00:00Z that belong to its local today", async () => {
    process.env.TZ = "America/New_York";
    writeJsonl("2026-06-16.jsonl", [
      // 21:00 on the 15th in New York — picked day, next UTC partition.
      makeEntry({ timestamp: "2026-06-16T01:00:00.000Z", input: "local-evening" }),
      // 00:00 on the 16th in New York — first instant of the next local day.
      makeEntry({ timestamp: "2026-06-16T04:00:00.000Z", input: "next-local-day" }),
    ]);
    writeJsonl("2026-06-15.jsonl", [
      // 23:59:59 on the 14th in New York.
      makeEntry({ timestamp: "2026-06-15T03:59:59.000Z", input: "previous-local-day" }),
      makeEntry({ timestamp: "2026-06-15T12:00:00.000Z", input: "local-morning" }),
    ]);
    const logger = new AuditLogger();
    const { entries, total } = await logger.search({ dateFrom: "2026-06-15", dateTo: "2026-06-15" });
    expect(total).toBe(2);
    expect(entries.map((e) => e.input).sort()).toEqual(["local-evening", "local-morning"]);
  });

  it("includes both boundary local days: the first instant of dateFrom and the last of dateTo", async () => {
    process.env.TZ = "Asia/Seoul";
    writeJsonl("2026-06-14.jsonl", [
      makeEntry({ timestamp: "2026-06-14T14:59:59.999Z", input: "before-from" }),
      makeEntry({ timestamp: "2026-06-14T15:00:00.000Z", input: "from-first-instant" }),
    ]);
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T14:59:59.999Z", input: "to-last-instant" }),
      makeEntry({ timestamp: "2026-06-16T15:00:00.000Z", input: "after-to" }),
    ]);
    const logger = new AuditLogger();
    const { entries, total } = await logger.search({ dateFrom: "2026-06-15", dateTo: "2026-06-16" });
    expect(total).toBe(2);
    expect(entries.map((e) => e.input).sort()).toEqual(["from-first-instant", "to-last-instant"]);
  });

  it("control: under UTC the same files answer by UTC day, so the boundary set differs", async () => {
    process.env.TZ = "UTC";
    writeJsonl("2026-06-14.jsonl", [
      makeEntry({ timestamp: "2026-06-14T14:59:59.999Z", input: "before-from" }),
      makeEntry({ timestamp: "2026-06-14T15:00:00.000Z", input: "from-first-instant" }),
    ]);
    writeJsonl("2026-06-16.jsonl", [
      makeEntry({ timestamp: "2026-06-16T14:59:59.999Z", input: "to-last-instant" }),
      makeEntry({ timestamp: "2026-06-16T15:00:00.000Z", input: "after-to" }),
    ]);
    const logger = new AuditLogger();
    const { entries, total } = await logger.search({ dateFrom: "2026-06-15", dateTo: "2026-06-16" });
    expect(total).toBe(2);
    expect(entries.map((e) => e.input).sort()).toEqual(["after-to", "to-last-instant"]);
  });

  it("keeps HMAC-chained permission rows, which stamp `ts` rather than `timestamp`", async () => {
    process.env.TZ = "Asia/Seoul";
    const permissionRow = {
      ts: "2026-06-15T16:00:00.000Z",
      sessionId: "test-session",
      decision: "allow",
      tool: "read_file",
    } as unknown as AuditEntry;
    writeJsonl("2026-06-15.permission-audit.jsonl", [permissionRow]);
    const logger = new AuditLogger();
    const { total } = await logger.search({ dateFrom: "2026-06-16", dateTo: "2026-06-16" });
    expect(total).toBe(1);
  });

  it("rejects a malformed day key instead of silently widening the range", async () => {
    const logger = new AuditLogger();
    await expect(logger.search({ dateFrom: "2026-6-1" })).rejects.toThrow(TypeError);
  });
});

describe("AuditLogger.getStats() — host-local window and day buckets", () => {
  let previousTz: string | undefined;

  beforeEach(() => {
    previousTz = process.env.TZ;
  });

  afterEach(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });

  // 01:30 on the 16th in Seoul; still the 15th in UTC.
  const NOW = new Date("2026-06-15T16:30:00.000Z");

  it("buckets totalByDay by the host's civil day, not the partition's UTC day", async () => {
    process.env.TZ = "Asia/Seoul";
    writeJsonl("2026-06-15.jsonl", [
      makeEntry({ timestamp: "2026-06-15T16:00:00.000Z" }), // 01:00 local, the 16th
      makeEntry({ timestamp: "2026-06-15T14:00:00.000Z" }), // 23:00 local, the 15th
    ]);
    const logger = new AuditLogger(undefined, { now: () => NOW });
    const stats = await logger.getStats(1);
    expect(stats.totalByDay).toEqual({ "2026-06-16": 1, "2026-06-15": 1 });
  });

  it("control: under UTC both entries fall on the partition's day", async () => {
    process.env.TZ = "UTC";
    writeJsonl("2026-06-15.jsonl", [
      makeEntry({ timestamp: "2026-06-15T16:00:00.000Z" }),
      makeEntry({ timestamp: "2026-06-15T14:00:00.000Z" }),
    ]);
    const logger = new AuditLogger(undefined, { now: () => NOW });
    const stats = await logger.getStats(1);
    expect(stats.totalByDay).toEqual({ "2026-06-15": 2 });
  });

  it("starts the window at local midnight N days back, reaching into the earlier UTC partition", async () => {
    process.env.TZ = "Asia/Seoul";
    // getStats(1) from the 16th local covers the 15th local onward: [2026-06-14T15:00Z, ...).
    writeJsonl("2026-06-14.jsonl", [
      makeEntry({ timestamp: "2026-06-14T15:00:00.000Z", type: "approval" }), // 00:00 local, the 15th
      makeEntry({ timestamp: "2026-06-14T14:59:59.000Z", type: "kill_switch" }), // 23:59:59 local, the 14th
    ]);
    const logger = new AuditLogger(undefined, { now: () => NOW });
    const stats = await logger.getStats(1);
    expect(stats.sensitiveOps).toBe(1);
    expect(stats.totalByType).toEqual({ approval: 1 });
  });
});

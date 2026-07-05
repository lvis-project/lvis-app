/**
 * log-file-sink — production pino file sink: retention pruning, size-based
 * sequence rolling, namespace mode (0o700 dir / 0o600 file), and the filename
 * date parser. Uses an explicit temp `dir` (the sink is dependency-injectable),
 * so no homedir/lvisHome mocking is required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createLogFileSink,
  parseLogFileDate,
  pruneOldLogs,
  LOG_RETENTION_DAYS,
  LOG_MAX_BYTES,
} from "../log-file-sink.js";

let logDir: string;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "lvis-logsink-"));
});

afterEach(async () => {
  if (!existsSync(logDir)) return;
  // Every test in this suite waits for its sink's file(s) to actually land on
  // disk (waitForFile) before calling destroy(), so no fs.open should still be
  // in flight here. This one extra macrotask tick is defense-in-depth only —
  // destroy()'s boom.end() itself does not return a promise the caller can
  // await, so give any trailing internal callback (e.g. the stream 'close'
  // event) a chance to settle before rmSync runs.
  await new Promise((r) => setTimeout(r, 0));
  // SonicBoom's end() closes the fd asynchronously (on the stream 'close'
  // event), so on Windows a just-destroyed sink can still hold a handle when
  // rmSync runs → ENOTEMPTY/EBUSY. Retry a few times with a short yield.
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      rmSync(logDir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
});

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** date N days ago as YYYY-MM-DD */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function listFiles(): string[] {
  return readdirSync(logDir).sort();
}

/**
 * Wait until `path` exists on disk. SonicBoom opens with `sync:false`, so the
 * fd (and therefore the file) appears on a later tick than the sink's
 * construction. Polling until existsSync is true makes mode/size assertions
 * DETERMINISTIC instead of racing the async open (the old chmodSync-after-open
 * approach raced it silently). Throws if the file never appears.
 */
async function waitForFile(path: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("parseLogFileDate", () => {
  it("parses base and sequenced log filenames", () => {
    expect(parseLogFileDate("lvis-2026-07-05.log")).toBe("2026-07-05");
    expect(parseLogFileDate("lvis-2026-07-05.3.log")).toBe("2026-07-05");
  });

  it("rejects non-log / foreign filenames", () => {
    expect(parseLogFileDate("audit-2026-07-05.jsonl")).toBeNull();
    expect(parseLogFileDate("lvis.log")).toBeNull();
    expect(parseLogFileDate("lvis-2026-7-5.log")).toBeNull();
    expect(parseLogFileDate("readme.txt")).toBeNull();
  });
});

describe("pruneOldLogs — retention", () => {
  it("deletes files older than the retention window, keeps recent ones", () => {
    writeFileSync(join(logDir, `lvis-${daysAgo(10)}.log`), "old\n");
    writeFileSync(join(logDir, `lvis-${daysAgo(10)}.1.log`), "old-seq\n");
    writeFileSync(join(logDir, `lvis-${daysAgo(2)}.log`), "recent\n");
    writeFileSync(join(logDir, `lvis-${todayDateStr()}.log`), "today\n");

    const deleted = pruneOldLogs(logDir, 7);

    expect(deleted.sort()).toEqual(
      [`lvis-${daysAgo(10)}.1.log`, `lvis-${daysAgo(10)}.log`].sort(),
    );
    const remaining = listFiles();
    expect(remaining).toContain(`lvis-${daysAgo(2)}.log`);
    expect(remaining).toContain(`lvis-${todayDateStr()}.log`);
    expect(remaining).not.toContain(`lvis-${daysAgo(10)}.log`);
  });

  it("never touches foreign files in the directory", () => {
    writeFileSync(join(logDir, "audit-2000-01-01.jsonl"), "x\n");
    writeFileSync(join(logDir, "keep.txt"), "x\n");
    const deleted = pruneOldLogs(logDir, 1);
    expect(deleted).toEqual([]);
    expect(listFiles()).toContain("audit-2000-01-01.jsonl");
    expect(listFiles()).toContain("keep.txt");
  });

  it("returns [] for a missing directory (non-fatal)", () => {
    expect(pruneOldLogs(join(logDir, "does-not-exist"), 7)).toEqual([]);
  });

  it("respects the retention boundary exactly", () => {
    // A file dated exactly retentionDays ago is at the >= cutoff → deleted.
    writeFileSync(join(logDir, `lvis-${daysAgo(7)}.log`), "boundary\n");
    const deleted = pruneOldLogs(logDir, 7);
    expect(deleted).toContain(`lvis-${daysAgo(7)}.log`);
  });
});

describe("createLogFileSink — file creation + mode", () => {
  it("creates today's base log file and prunes old files on attach", async () => {
    writeFileSync(join(logDir, `lvis-${daysAgo(30)}.log`), "ancient\n");
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7 });
    try {
      sink.write("hello\n");
      // SonicBoom opens with sync:false, so the fd (and the file itself) lands
      // on a LATER tick than write() returns — assert currentFile's path
      // in-process first (race-free), then wait for the on-disk file before
      // any existsSync/statSync assertion.
      expect(sink.currentFile).toBe(join(logDir, `lvis-${todayDateStr()}.log`));
      await waitForFile(sink.currentFile);
      expect(existsSync(sink.currentFile)).toBe(true);
      // Old file pruned at attach.
      expect(existsSync(join(logDir, `lvis-${daysAgo(30)}.log`))).toBe(false);
    } finally {
      sink.destroy();
    }
  });

  it.runIf(process.platform !== "win32")(
    "enforces 0o600 on the log file (at open) and 0o700 on the directory",
    async () => {
      const sink = createLogFileSink({ dir: logDir, retentionDays: 7 });
      try {
        sink.write("x\n");
        // Wait for the async (`sync:false`) SonicBoom open to land the file
        // before asserting its mode — otherwise statSync races the open. The
        // mode is applied AT OPEN via the constructor's `mode` option, so once
        // the file exists it already carries 0o600 (no post-open chmod window).
        await waitForFile(sink.currentFile);
        const fileMode = statSync(sink.currentFile).mode & 0o777;
        const dirMode = statSync(logDir).mode & 0o777;
        expect(fileMode).toBe(0o600);
        expect(dirMode).toBe(0o700);
      } finally {
        sink.destroy();
      }
    },
  );
});

describe("createLogFileSink — size-based sequence rolling", () => {
  it("rolls to a .seq file once the active file crosses maxBytes", async () => {
    // Small ceiling so a handful of writes trips the size guard.
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7, maxBytes: 64 });
    try {
      const base = join(logDir, `lvis-${todayDateStr()}.log`);
      // Rolling is byte-count based (in-process, not statSync). 200 writes ×
      // 21 bytes = 4200 bytes >> the 64-byte ceiling → several rolls.
      const line = "x".repeat(20) + "\n";
      for (let i = 0; i < 200; i++) sink.write(line);
      // currentFile (in-process, race-free) already reflects the final roll.
      const finalFile = sink.currentFile;
      expect(finalFile).not.toBe(base);
      // Wait for BOTH the base and the final rolled file to actually land on
      // disk before destroy()/cleanup — each roll opens its new destination
      // with sync:false, so the fd (and the file) appears on a later tick
      // than write() returns. Destroying (or letting afterEach rmSync the
      // temp dir) while an open is still in flight produces an ENOENT that
      // surfaces asynchronously, uncaught, well after this test has finished
      // (and gets misattributed to whatever test runs next).
      await waitForFile(base);
      await waitForFile(finalFile);
      sink.destroy();
      const files = listFiles().filter((f) => parseLogFileDate(f) === todayDateStr());
      // Base file plus at least one sequenced roll.
      expect(files).toContain(`lvis-${todayDateStr()}.log`);
      expect(files.some((f) => /\.\d+\.log$/.test(f))).toBe(true);
      expect(existsSync(base)).toBe(true);
    } finally {
      // already destroyed; guard against double-destroy being fatal
    }
  });

  it("resumes into a fresh sequence when today's base file is already oversized", async () => {
    // Pre-seed an oversized base file for today.
    const base = join(logDir, `lvis-${todayDateStr()}.log`);
    writeFileSync(base, "y".repeat(200));
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7, maxBytes: 64 });
    try {
      sink.write("z\n");
      // The active file must NOT be the oversized base — it should be a .1 seq.
      expect(sink.currentFile).not.toBe(base);
      expect(/\.\d+\.log$/.test(sink.currentFile)).toBe(true);
      // Wait for the .1 file's async (sync:false) open to land before this
      // test returns, so no in-flight fs.open survives into afterEach's
      // rmSync of logDir (a late ENOENT there surfaces as an uncaught
      // exception misattributed to a later test).
      await waitForFile(sink.currentFile);
    } finally {
      sink.destroy();
    }
  });

  it("resumes an UNDER-cap same-day file and seeds the byte counter from its size", async () => {
    // A partially-filled today file that is still UNDER the cap must be
    // APPENDED to (not rolled), and the in-process byte counter must be seeded
    // from the on-disk size so the roll trips accounting for the pre-existing
    // bytes — not from zero. maxBytes=100, pre-seed 60 bytes: the base is
    // reused (60 < 100), then writes past the remaining 40-byte headroom must
    // cross the ceiling and roll, proving the counter started at 60, not 0.
    const base = join(logDir, `lvis-${todayDateStr()}.log`);
    writeFileSync(base, "a".repeat(60));
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7, maxBytes: 100 });
    try {
      // The active file resumes the under-cap base (seq 0), not a new sequence.
      expect(sink.currentFile).toBe(base);
      // The roll fires synchronously inside write() the moment the seeded
      // counter (60) + accumulated chunk bytes crosses maxBytes (100). Assert
      // on currentFile (in-process, race-free) rather than on-disk file
      // presence — the rolled .seq file is opened with sync:false so its
      // fd/inode lands on a later tick. 6 × 10 bytes = 60, so 60 + 60 = 120
      // ≥ 100 → the active file must advance to a .seq. If the counter had
      // been seeded to 0, 60 < 100 and currentFile would stay the base.
      for (let i = 0; i < 6; i++) sink.write("b".repeat(9) + "\n"); // 10 bytes each
      expect(sink.currentFile).not.toBe(base);
      expect(/\.\d+\.log$/.test(sink.currentFile)).toBe(true);
      // Wait for the rolled .seq file's async open to land BEFORE destroy()
      // — destroying (or the afterEach rmSync) while the open is still in
      // flight is exactly the ENOENT-after-teardown race this suite must
      // avoid (see the two tests above for the same pattern).
      const rolledPath = sink.currentFile;
      await waitForFile(rolledPath);
      expect(existsSync(rolledPath)).toBe(true);
      // The original base bytes are preserved (append mode, not truncated).
      expect(statSync(base).size).toBeGreaterThanOrEqual(60);
    } finally {
      sink.destroy();
    }
  });
});

describe("SOT constants", () => {
  it("exports the documented defaults", () => {
    expect(LOG_RETENTION_DAYS).toBe(7);
    expect(LOG_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});

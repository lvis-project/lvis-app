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
  it("creates today's base log file and prunes old files on attach", () => {
    writeFileSync(join(logDir, `lvis-${daysAgo(30)}.log`), "ancient\n");
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7 });
    try {
      sink.write("hello\n");
      expect(existsSync(sink.currentFile)).toBe(true);
      expect(sink.currentFile).toBe(join(logDir, `lvis-${todayDateStr()}.log`));
      // Old file pruned at attach.
      expect(existsSync(join(logDir, `lvis-${daysAgo(30)}.log`))).toBe(false);
    } finally {
      sink.destroy();
    }
  });

  it.runIf(process.platform !== "win32")(
    "enforces 0o600 on the log file and 0o700 on the directory",
    () => {
      const sink = createLogFileSink({ dir: logDir, retentionDays: 7 });
      try {
        sink.write("x\n");
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
  it("rolls to a .seq file once the active file crosses maxBytes", () => {
    // Small ceiling so a handful of writes trips the size guard.
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7, maxBytes: 64 });
    try {
      const base = join(logDir, `lvis-${todayDateStr()}.log`);
      // Rolling is byte-count based (in-process, not statSync). 200 writes ×
      // 21 bytes = 4200 bytes >> the 64-byte ceiling → several rolls.
      const line = "x".repeat(20) + "\n";
      for (let i = 0; i < 200; i++) sink.write(line);
      // Force the async SonicBoom buffer to disk before asserting.
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

  it("resumes into a fresh sequence when today's base file is already oversized", () => {
    // Pre-seed an oversized base file for today.
    const base = join(logDir, `lvis-${todayDateStr()}.log`);
    writeFileSync(base, "y".repeat(200));
    const sink = createLogFileSink({ dir: logDir, retentionDays: 7, maxBytes: 64 });
    try {
      sink.write("z\n");
      // The active file must NOT be the oversized base — it should be a .1 seq.
      expect(sink.currentFile).not.toBe(base);
      expect(/\.\d+\.log$/.test(sink.currentFile)).toBe(true);
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

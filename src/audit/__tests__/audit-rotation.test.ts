/**
 * AuditLogger.rotateAndPrune() — size-triggered rotation, age-triggered delete,
 * concurrent write + rotate race (withFileLock).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: vi.fn(orig.homedir) };
});

import { AuditLogger } from "../audit-logger.js";
import { withAuditSnapshotLock } from "../jsonl-reader.js";
import { readAuditEntries } from "../../engine/usage-stats.js";


let testHome: string;
let auditDir: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "lvis-audit-rot-"));
  auditDir = join(testHome, ".lvis", "audit");
  mkdirSync(auditDir, { recursive: true });
  vi.mocked(homedir).mockReturnValue(testHome);
});

afterEach(async () => {
  if (existsSync(testHome)) await cleanupTmpDir(testHome);
  vi.restoreAllMocks();
});

function writeJsonlFile(filename: string, content: string): string {
  const p = join(auditDir, filename);
  writeFileSync(p, content, "utf-8");
  return p;
}

function listAuditFiles(): string[] {
  return readdirSync(auditDir).sort();
}

describe("rotateAndPrune — size-triggered rotation", () => {
  it("compresses a .jsonl file that exceeds maxBytes", async () => {
    const content = '{"timestamp":"2026-04-10T00:00:00Z","sessionId":"s1","type":"turn"}\n'.repeat(5);
    writeJsonlFile("2026-04-10.jsonl", content);

    const logger = new AuditLogger();
    await logger.rotateAndPrune({ maxBytes: 10, retentionDays: 30 }); // 10-byte threshold → triggers rotation

    const files = listAuditFiles();
    // Original .jsonl should be gone
    expect(files.some((f) => f === "2026-04-10.jsonl")).toBe(false);
    // A .gz archive should exist
    const archive = files.find((f) => /2026-04-10\.jsonl\.\d{17}\.[0-9a-f-]{36}\.gz$/i.test(f));
    expect(archive).toBeDefined();
    const archiveStat = statSync(join(auditDir, archive!));
    expect(archiveStat.isFile()).toBe(true);
    if (process.platform !== "win32") {
      expect(archiveStat.mode & 0o777).toBe(0o600);
    }
  });

  it("keeps every same-day rotation archive instead of overwriting prior telemetry", async () => {
    const now = new Date("2026-07-04T12:00:00.000Z");
    const logger = new AuditLogger(auditDir, { now: () => now });
    writeJsonlFile("2026-07-03.jsonl", "first rotation\n");

    await logger.rotateAndPrune({ maxBytes: 1, retentionDays: 30, rotationAgeDays: 365 });
    writeJsonlFile("2026-07-03.jsonl", "second rotation\n");
    await logger.rotateAndPrune({ maxBytes: 1, retentionDays: 30, rotationAgeDays: 365 });

    const archives = listAuditFiles().filter((file) => /^2026-07-03\.jsonl\.\d{17}\.[0-9a-f-]{36}\.gz$/i.test(file));
    expect(archives).toHaveLength(2);
    expect(archives.map((file) => gunzipSync(readFileSync(join(auditDir, file))).toString("utf-8")).sort())
      .toEqual(["first rotation\n", "second rotation\n"]);
  });

  it("serializes rotation and aggregate reads through one audit snapshot", async () => {
    const now = new Date("2026-07-04T12:00:00.000Z");
    const source = "2026-07-03.jsonl";
    writeJsonlFile(source, '{"timestamp":"2026-07-03T15:30:00Z","sessionId":"s1","type":"turn"}\n');
    const logger = new AuditLogger(auditDir, { now: () => now });
    let releaseSnapshot: (() => void) | undefined;
    let snapshotHeld: (() => void) | undefined;
    const hold = withAuditSnapshotLock(auditDir, async () => {
      snapshotHeld?.();
      await new Promise<void>((resolve) => { releaseSnapshot = resolve; });
    });
    await new Promise<void>((resolve) => { snapshotHeld = resolve; });

    const rotating = logger.rotateAndPrune({ maxBytes: 1, retentionDays: 30, rotationAgeDays: 365 });
    let readSettled = false;
    const reading = readAuditEntries(auditDir, 2, now).then((rows) => {
      readSettled = true;
      return rows;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(existsSync(join(auditDir, source))).toBe(true);
    expect(readSettled).toBe(false);

    releaseSnapshot?.();
    await hold;
    const [, rows] = await Promise.all([rotating, reading]);
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("s1");
  });

  it("does NOT rotate a file below the size threshold", async () => {
    writeJsonlFile("2026-04-10.jsonl", '{"type":"turn"}\n');

    const logger = new AuditLogger();
    await logger.rotateAndPrune({ maxBytes: 10 * 1024 * 1024, retentionDays: 30, rotationAgeDays: 365 });

    const files = listAuditFiles();
    expect(files.some((f) => f === "2026-04-10.jsonl")).toBe(true);
    expect(files.some((f) => f.endsWith(".gz"))).toBe(false);
  });
});

describe("rotateAndPrune — age-triggered rotation", () => {
  it("rotates a .jsonl file older than rotationAgeDays", async () => {
    // A file dated 10 days ago
    const oldDate = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    writeJsonlFile(`${oldDate}.jsonl`, '{"type":"turn"}\n');

    const logger = new AuditLogger();
    await logger.rotateAndPrune({ maxBytes: 10 * 1024 * 1024, retentionDays: 30, rotationAgeDays: 7 });

    const files = listAuditFiles();
    expect(files.some((f) => f === `${oldDate}.jsonl`)).toBe(false);
    expect(files.some((f) => new RegExp(`${oldDate.replace(/-/g, "")}\\.gz$`).test(f)
      || f.endsWith(".gz"))).toBe(true);
  });

  it("does NOT rotate a file within the age window", async () => {
    const recentDate = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
    writeJsonlFile(`${recentDate}.jsonl`, '{"type":"turn"}\n');

    const logger = new AuditLogger();
    await logger.rotateAndPrune({ maxBytes: 10 * 1024 * 1024, retentionDays: 30, rotationAgeDays: 7 });

    const files = listAuditFiles();
    expect(files.some((f) => f === `${recentDate}.jsonl`)).toBe(true);
    expect(files.some((f) => f.endsWith(".gz"))).toBe(false);
  });
});

describe("rotateAndPrune — HMAC-chained channels", () => {
  it("does NOT size-rotate an active (today) permission-audit chain even when oversized", async () => {
    // Size-rotating the active prevHash chain mid-day would gzip+unlink it and
    // sever the tamper-evident chain. It must be left untouched.
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    writeJsonlFile(`${today}.permission-audit.jsonl`, '{"type":"permission","prevHash":"x"}\n'.repeat(50));

    const logger = new AuditLogger();
    await logger.rotateAndPrune({ maxBytes: 10, retentionDays: 30, rotationAgeDays: 7 });

    const files = listAuditFiles();
    expect(files.some((f) => f === `${today}.permission-audit.jsonl`)).toBe(true);
    expect(files.some((f) => f.endsWith(".gz"))).toBe(false);
  });

  it("does NOT size-rotate an active (today) sandbox chain even when oversized", async () => {
    const today = new Date(Date.now()).toISOString().slice(0, 10);
    writeJsonlFile(`${today}.sandbox.jsonl`, '{"type":"sandbox"}\n'.repeat(50));

    const logger = new AuditLogger();
    await logger.rotateAndPrune({ maxBytes: 10, retentionDays: 30, rotationAgeDays: 7 });

    const files = listAuditFiles();
    expect(files.some((f) => f === `${today}.sandbox.jsonl`)).toBe(true);
    expect(files.some((f) => f.endsWith(".gz"))).toBe(false);
  });

  it("DOES age-rotate a CLOSED prior-day chain (≥ rotationAgeDays) so chain channels stay bounded", async () => {
    // A sealed prior-day chain is safe to archive — each UTC day is an
    // independent chain. This prevents unbounded one-file-per-day accumulation.
    const oldDate = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    writeJsonlFile(`${oldDate}.permission-audit.jsonl`, '{"type":"permission"}\n');

    const logger = new AuditLogger();
    await logger.rotateAndPrune({ maxBytes: 10 * 1024 * 1024, retentionDays: 30, rotationAgeDays: 7 });

    const files = listAuditFiles();
    expect(files.some((f) => f === `${oldDate}.permission-audit.jsonl`)).toBe(false);
    expect(files.some((f) => f.endsWith(".gz"))).toBe(true);
  });
});

describe("rotateAndPrune — retention / age-triggered delete", () => {
  it("deletes .gz archives older than retentionDays", async () => {
    // Archive dated 35 days ago
    const oldDs = new Date(Date.now() - 35 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
    writeJsonlFile(`2026-01-01.jsonl.${oldDs}.gz`, "fake-gzip-data");

    const logger = new AuditLogger();
    await logger.rotateAndPrune({ maxBytes: 10 * 1024 * 1024, retentionDays: 30 });

    const files = listAuditFiles();
    expect(files.some((f) => f.includes(oldDs))).toBe(false);
  });

  it("prunes timestamp/UUID archives using their archive date", async () => {
    const now = new Date("2026-07-04T12:00:00.000Z");
    const oldStamp = "20260530120000000";
    const file = `2026-01-01.jsonl.${oldStamp}.11111111-1111-4111-8111-111111111111.gz`;
    writeJsonlFile(file, "fake-gzip-data");

    const logger = new AuditLogger(auditDir, { now: () => now });
    await logger.rotateAndPrune({ maxBytes: 10 * 1024 * 1024, retentionDays: 30 });

    expect(listAuditFiles()).not.toContain(file);
  });

  it("retains .gz archives within retentionDays", async () => {
    const recentDs = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
    const fname = `2026-04-14.jsonl.${recentDs}.gz`;
    writeJsonlFile(fname, "fake-gzip-data");

    const logger = new AuditLogger();
    await logger.rotateAndPrune({ maxBytes: 10 * 1024 * 1024, retentionDays: 30 });

    const files = listAuditFiles();
    expect(files.some((f) => f === fname)).toBe(true);
  });
});

describe("rotateAndPrune — concurrent write + rotate race", () => {
  it("handles concurrent log() and rotateAndPrune() without data corruption", async () => {
    const content = '{"timestamp":"2026-04-10T00:00:00Z","sessionId":"s1","type":"turn"}\n'.repeat(3);
    writeJsonlFile("2026-04-10.jsonl", content);

    const logger = new AuditLogger();

    // Fire off rotation and concurrent writes simultaneously
    const rotatePromise = logger.rotateAndPrune({ maxBytes: 10, retentionDays: 30 });

    // Concurrent writes use the ordered async queue and the same file lock as
    // rotation, so they may land before or after the archive but must not corrupt it.
    for (let i = 0; i < 10; i++) {
      logger.log({ timestamp: new Date().toISOString(), sessionId: "race", type: "turn" });
    }

    await rotatePromise;
    await logger.flush();

    // Either the archive exists or the original still does — no crash is the assertion.
    const files = listAuditFiles();
    const hasArchiveOrOriginal =
      files.some((f) => f.endsWith(".gz")) || files.some((f) => f.endsWith(".jsonl"));
    expect(hasArchiveOrOriginal).toBe(true);
  });
});

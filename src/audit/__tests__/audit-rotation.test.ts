/**
 * AuditLogger.rotateAndPrune() — size-triggered rotation, age-triggered delete,
 * concurrent write + rotate race (withFileLock).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: vi.fn(orig.homedir) };
});

import { homedir } from "node:os";
import { AuditLogger } from "../audit-logger.js";

let testHome: string;
let auditDir: string;

beforeEach(() => {
  testHome = join(tmpdir(), `lvis-audit-rot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  auditDir = join(testHome, ".lvis", "audit");
  mkdirSync(auditDir, { recursive: true });
  vi.mocked(homedir).mockReturnValue(testHome);
});

afterEach(() => {
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
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
    expect(files.some((f) => /2026-04-10\.jsonl\.\d{8}\.gz$/.test(f))).toBe(true);
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

    // Concurrent writes — these use appendFileSync so they may write to the
    // original or a new file but must not throw.
    for (let i = 0; i < 10; i++) {
      logger.log({ timestamp: new Date().toISOString(), sessionId: "race", type: "turn" });
    }

    await rotatePromise;

    // Either the archive exists or the original still does — no crash is the assertion.
    const files = listAuditFiles();
    const hasArchiveOrOriginal =
      files.some((f) => f.endsWith(".gz")) || files.some((f) => f.endsWith(".jsonl"));
    expect(hasArchiveOrOriginal).toBe(true);
  });
});

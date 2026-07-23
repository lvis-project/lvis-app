import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { AuditLogger, type AuditEntry } from "../audit-logger.js";

let auditDir: string;

function entry(index: number): AuditEntry {
  return {
    timestamp: new Date().toISOString(),
    sessionId: `session-${index}`,
    type: "info",
    input: String(index),
  };
}

function telemetryLines(): AuditEntry[] {
  const path = join(auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}

function shadowLines(): AuditEntry[] {
  const path = join(auditDir, `${new Date().toISOString().slice(0, 10)}.permission-shadow.jsonl`);
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AuditEntry);
}

beforeEach(() => {
  auditDir = mkdtempSync(join(process.cwd(), ".lvis-audit-writer-"));
});

afterEach(() => {
  rmSync(auditDir, { recursive: true, force: true });
});

describe("AuditLogger ordered async writer", () => {
  it("preserves burst order without blocking the caller", async () => {
    const logger = new AuditLogger(auditDir);
    let eventLoopAdvanced = false;
    setImmediate(() => { eventLoopAdvanced = true; });

    for (let index = 0; index < 100; index += 1) logger.log(entry(index));
    expect(logger.getWriterStats().pendingWrites).toBe(100);

    await logger.flush();
    expect(eventLoopAdvanced).toBe(true);
    expect(telemetryLines().map((row) => row.input)).toEqual(
      Array.from({ length: 100 }, (_, index) => String(index)),
    );
    expect(logger.getWriterStats()).toMatchObject({
      pendingWrites: 0,
      pendingBytes: 0,
      droppedWrites: 0,
    });
  });

  it("bounds saturation deterministically and keeps accepted order", async () => {
    const logger = new AuditLogger(auditDir, {
      maxPendingWrites: 2,
      maxPendingBytes: 1024 * 1024,
    });
    for (let index = 0; index < 10; index += 1) logger.log(entry(index));

    expect(logger.getWriterStats()).toMatchObject({ pendingWrites: 2, droppedWrites: 8 });
    await logger.flush();
    expect(telemetryLines().map((row) => row.input)).toEqual(["0", "1"]);
  });

  it("isolates channel budgets so shadow bursts cannot evict canonical telemetry", async () => {
    const logger = new AuditLogger(auditDir, {
      maxPendingWrites: 1,
      maxPendingBytes: 1024 * 1024,
    });
    logger.logShadow(entry(1));
    logger.logShadow(entry(2));
    logger.log(entry(3));

    expect(logger.getWriterStats()).toMatchObject({ pendingWrites: 2, droppedWrites: 1 });
    await logger.flush();
    expect(shadowLines().map((row) => row.input)).toEqual(["1"]);
    expect(telemetryLines().map((row) => row.input)).toEqual(["3"]);
  });

  it("enforces the byte budget using UTF-8 bytes and releases accounting", async () => {
    const sample = { ...entry(1), input: "한글" };
    const lineBytes = Buffer.byteLength(`${JSON.stringify(sample)}\n`, "utf-8");
    const logger = new AuditLogger(auditDir, {
      maxPendingWrites: 10,
      maxPendingBytes: lineBytes,
    });
    logger.log(sample);
    logger.log(sample);

    expect(logger.getWriterStats()).toMatchObject({
      pendingWrites: 1,
      pendingBytes: lineBytes,
      droppedWrites: 1,
    });
    await logger.flush();
    expect(logger.getWriterStats()).toMatchObject({ pendingWrites: 0, pendingBytes: 0 });
    expect(telemetryLines()).toHaveLength(1);
  });

  it("recovers after a write failure without poisoning later ordered writes", async () => {
    const logger = new AuditLogger(auditDir);
    rmSync(auditDir, { recursive: true, force: true });
    writeFileSync(auditDir, "not-a-directory", "utf-8");

    logger.log(entry(1));
    await logger.flush();
    expect(logger.getWriterStats()).toMatchObject({
      pendingWrites: 0,
      pendingBytes: 0,
      droppedWrites: 1,
    });

    rmSync(auditDir, { force: true });
    mkdirSync(auditDir, { recursive: true });
    logger.log(entry(2));
    logger.log(entry(3));
    await logger.flush();
    expect(telemetryLines().map((row) => row.input)).toEqual(["2", "3"]);
  });

  it("close drains accepted records and drops later telemetry", async () => {
    const logger = new AuditLogger(auditDir);
    logger.log(entry(1));
    await logger.close();
    logger.log(entry(2));
    await logger.flush();

    expect(telemetryLines().map((row) => row.input)).toEqual(["1"]);
    expect(logger.getWriterStats()).toMatchObject({
      acceptingWrites: false,
      droppedWrites: 1,
    });
  });

  it("creates the telemetry file with user-only permissions", async () => {
    const logger = new AuditLogger(auditDir);
    logger.log(entry(1));
    logger.log(entry(2));
    await logger.flush();

    const path = join(auditDir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

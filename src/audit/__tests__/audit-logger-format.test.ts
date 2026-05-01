/**
 * AuditLogger.log() + logTurn() — format invariants, timestamp validity,
 * sessionId, redaction marker, retention semantics.
 *
 * UQ-QUALITY SEV-2 #2
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: vi.fn(orig.homedir) };
});

import { AuditLogger, type AuditEntry } from "../audit-logger.js";

let testHome: string;
let auditDir: string;

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "lvis-audit-fmt-"));
  auditDir = join(testHome, ".lvis", "audit");
  mkdirSync(auditDir, { recursive: true });
  vi.mocked(homedir).mockReturnValue(testHome);
});

afterEach(() => {
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readLogLines(): AuditEntry[] {
  const files = existsSync(auditDir)
    ? require("node:fs").readdirSync(auditDir).filter((f: string) => f.endsWith(".jsonl"))
    : [];
  const lines: AuditEntry[] = [];
  for (const f of files) {
    const raw = readFileSync(join(auditDir, f), "utf-8");
    for (const line of raw.split("\n").filter(Boolean)) {
      try { lines.push(JSON.parse(line)); } catch {}
    }
  }
  return lines;
}

describe("AuditLogger.log() — format invariants", () => {
  it("writes a valid ISO-8601 timestamp", () => {
    const logger = new AuditLogger();
    logger.log({ timestamp: "2026-04-20T12:00:00.000Z", sessionId: "s1", type: "turn" });
    const entries = readLogLines();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries.find((e) => e.sessionId === "s1" && e.type === "turn");
    expect(entry).toBeDefined();
    expect(new Date(entry!.timestamp).toISOString()).toBe("2026-04-20T12:00:00.000Z");
  });

  it("preserves sessionId verbatim", () => {
    const logger = new AuditLogger();
    logger.log({ timestamp: new Date().toISOString(), sessionId: "sess-abc-123", type: "tool_call" });
    const entries = readLogLines();
    const entry = entries.find((e) => e.type === "tool_call");
    expect(entry?.sessionId).toBe("sess-abc-123");
  });

  it("stores the exact type field", () => {
    const logger = new AuditLogger();
    const types: AuditEntry["type"][] = ["turn", "tool_call", "approval", "warn", "error", "mcp_connect", "kill_switch", "dlp", "info"];
    for (const t of types) {
      logger.log({ timestamp: new Date().toISOString(), sessionId: "s", type: t });
    }
    const entries = readLogLines();
    for (const t of types) {
      expect(entries.some((e) => e.type === t)).toBe(true);
    }
  });

  it("stores dlp payload when type is dlp", () => {
    const logger = new AuditLogger();
    logger.log({
      timestamp: new Date().toISOString(),
      sessionId: "s",
      type: "dlp",
      dlp: { byKind: { EMAIL: 2 }, totalRedactions: 2, turnId: "t1" },
    });
    const entries = readLogLines();
    const dlpEntry = entries.find((e) => e.type === "dlp");
    expect(dlpEntry?.dlp?.byKind?.EMAIL).toBe(2);
    expect(dlpEntry?.dlp?.totalRedactions).toBe(2);
    expect(dlpEntry?.dlp?.turnId).toBe("t1");
  });

  it("writes each entry on its own newline-terminated line (JSONL format)", () => {
    const logger = new AuditLogger();
    logger.log({ timestamp: "2026-04-20T00:00:00Z", sessionId: "a", type: "turn" });
    logger.log({ timestamp: "2026-04-20T00:01:00Z", sessionId: "b", type: "warn" });
    const files = require("node:fs").readdirSync(auditDir).filter((f: string) => f.endsWith(".jsonl"));
    const raw = readFileSync(join(auditDir, files[0]), "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    // Each line must be individually parseable
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    expect(lines.length).toBeGreaterThanOrEqual(2);
  });

  it("does not throw when the audit dir is temporarily missing (swallow error)", () => {
    const logger = new AuditLogger();
    rmSync(auditDir, { recursive: true, force: true });
    // Must not throw — audit failure must not propagate
    expect(() => logger.log({ timestamp: new Date().toISOString(), sessionId: "s", type: "turn" })).not.toThrow();
  });

  it("stores toolCalls array when present", () => {
    const logger = new AuditLogger();
    logger.log({
      timestamp: new Date().toISOString(),
      sessionId: "s",
      type: "tool_call",
      toolCalls: [{ name: "bash", isError: false }],
    });
    const entries = readLogLines();
    const entry = entries.find((e) => e.type === "tool_call");
    expect(entry?.toolCalls?.[0]?.name).toBe("bash");
    expect(entry?.toolCalls?.[0]?.isError).toBe(false);
  });

  it("stores tokenUsage when present", () => {
    const logger = new AuditLogger();
    logger.log({
      timestamp: new Date().toISOString(),
      sessionId: "s",
      type: "turn",
      tokenUsage: { inputTokens: 100, outputTokens: 200 },
    });
    const entries = readLogLines();
    const entry = entries.find((e) => e.tokenUsage !== undefined);
    expect(entry?.tokenUsage?.inputTokens).toBe(100);
    expect(entry?.tokenUsage?.outputTokens).toBe(200);
  });
});

describe("AuditLogger.logTurn() — helper correctness", () => {
  it("writes a turn entry with truncated input/output (500 chars max)", () => {
    const logger = new AuditLogger();
    const longStr = "A".repeat(1000);
    logger.logTurn({
      sessionId: "s",
      input: longStr,
      output: longStr,
      toolCalls: [],
      route: "chat",
    });
    const entries = readLogLines();
    const entry = entries.find((e) => e.type === "turn");
    expect(entry?.input?.length).toBeLessThanOrEqual(500);
    expect(entry?.output?.length).toBeLessThanOrEqual(500);
  });

  it("writes the route field", () => {
    const logger = new AuditLogger();
    logger.logTurn({ sessionId: "s", input: "hi", output: "hello", toolCalls: [], route: "meeting" });
    const entries = readLogLines();
    const entry = entries.find((e) => e.type === "turn");
    expect(entry?.route).toBe("meeting");
  });

  it("writes toolCalls array verbatim", () => {
    const logger = new AuditLogger();
    const toolCalls = [{ name: "bash", isError: true }, { name: "read_file", isError: false }];
    logger.logTurn({ sessionId: "s", input: "x", output: "y", toolCalls, route: "r" });
    const entries = readLogLines();
    const entry = entries.find((e) => e.type === "turn");
    expect(entry?.toolCalls).toHaveLength(2);
    expect(entry?.toolCalls?.[0]?.name).toBe("bash");
    expect(entry?.toolCalls?.[0]?.isError).toBe(true);
  });

  it("generates a timestamp that parses as a valid date", () => {
    const before = Date.now();
    const logger = new AuditLogger();
    logger.logTurn({ sessionId: "s", input: "x", output: "y", toolCalls: [], route: "r" });
    const after = Date.now();
    const entries = readLogLines();
    const entry = entries.find((e) => e.type === "turn");
    const ts = new Date(entry!.timestamp).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });
});

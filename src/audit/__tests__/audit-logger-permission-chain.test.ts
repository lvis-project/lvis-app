/**
 * AuditLogger permission audit chain integration tests.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 7.
 *
 * Coverage:
 *   1. setupPermissionAuditChain bootstraps cleanly on a fresh file (genesis).
 *   2. setupPermissionAuditChain re-attaches to an existing file's tail.
 *   3. appendPermissionAuditEntry computes prevHash and writes JSONL.
 *   4. The full file passes verifyChain after sequential appends.
 *   5. appendPermissionAuditEntry throws when chain not initialized.
 *   6. Tampering one line in the file is detected by verifyChain.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("node:os", async (importOriginal) => {
  const orig = await importOriginal<typeof import("node:os")>();
  return { ...orig, homedir: vi.fn(orig.homedir) };
});

import { AuditLogger } from "../audit-logger.js";
import {
  buildChainedEntries,
  computeLineHmac,
  GENESIS_MARKER,
  verifyChain,
} from "../hmac-chain.js";

let testHome: string;
let auditDir: string;
const SECRET = "ff".repeat(32);

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "lvis-permission-chain-"));
  auditDir = join(testHome, ".lvis", "audit");
  mkdirSync(auditDir, { recursive: true });
  vi.mocked(homedir).mockReturnValue(testHome);
});

afterEach(() => {
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readPermissionAuditLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").split("\n").filter((l) => l.length > 0);
}

describe("AuditLogger permission audit chain", () => {
  it("isPermissionAuditChainReady is false before setupPermissionAuditChain", () => {
    const logger = new AuditLogger();
    expect(logger.isPermissionAuditChainReady()).toBe(false);
  });

  it("isPermissionAuditChainReady is true after setupPermissionAuditChain", () => {
    const logger = new AuditLogger();
    logger.setupPermissionAuditChain(SECRET);
    expect(logger.isPermissionAuditChainReady()).toBe(true);
  });

  it("appendPermissionAuditEntry throws before setupPermissionAuditChain", async () => {
    const logger = new AuditLogger();
    await expect(
      logger.appendPermissionAuditEntry({
        decision: "allow",
        auditId: "id-1",
        ts: "2026-05-09T00:00:00.000Z",
        trustOrigin: "user-keyboard",
        tool: "fs_read",
        source: "builtin",
        category: "read",
        directory: "/tmp",
        directoryAllowed: true,
        layer: 1,
      }),
    ).rejects.toThrow(/not initialized/);
  });

  it("appendPermissionAuditEntry on fresh file: first entry's prevHash = HMAC(genesis)", async () => {
    const logger = new AuditLogger();
    logger.setupPermissionAuditChain(SECRET);
    const entry = await logger.appendPermissionAuditEntry({
      decision: "allow",
      auditId: "id-1",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_read",
      source: "builtin",
      category: "read",
      directory: "/tmp/x",
      directoryAllowed: true,
      layer: 1,
    });
    expect(entry.prevHash).toBe(computeLineHmac(SECRET, GENESIS_MARKER));

    const lines = readPermissionAuditLines(logger.getPermissionAuditLogFile());
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });

  it("two sequential appends produce a valid chain", async () => {
    const logger = new AuditLogger();
    logger.setupPermissionAuditChain(SECRET);
    await logger.appendPermissionAuditEntry({
      decision: "allow",
      auditId: "id-1",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_read",
      source: "builtin",
      category: "read",
      directory: "/tmp",
      directoryAllowed: true,
      layer: 1,
    });
    await logger.appendPermissionAuditEntry({
      decision: "deny",
      auditId: "id-2",
      ts: "2026-05-09T00:00:01.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_write",
      source: "builtin",
      category: "write",
      denyReasons: [{ layer: 0, reason: "sensitive-path", source: "sensitive-paths" }],
    });
    const lines = readPermissionAuditLines(logger.getPermissionAuditLogFile());
    expect(lines.length).toBe(2);
    expect(verifyChain(SECRET, lines)).toEqual({ ok: true });
  });

  it("appends deferred_resolve entries to the permission audit chain", async () => {
    const logger = new AuditLogger();
    logger.setupPermissionAuditChain(SECRET);
    await logger.appendPermissionAuditEntry({
      decision: "deferred_resolve",
      auditId: "resolve-1",
      ts: "2026-05-09T00:00:02.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_write",
      source: "builtin",
      category: "write",
      reviewerVerdict: { level: "high", reason: "outside allowed dirs" },
      queueId: "queue-1",
      resolution: "approved",
      reason: "manual review",
    });

    const lines = readPermissionAuditLines(logger.getPermissionAuditLogFile());
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      decision: "deferred_resolve",
      queueId: "queue-1",
      resolution: "approved",
    });
    expect(verifyChain(SECRET, lines)).toEqual({ ok: true });
  });

  it("setupPermissionAuditChain re-bootstraps prevHash from an existing file's tail", async () => {
    // Pre-seed a chain manually
    const existing = buildChainedEntries(SECRET, [
      { decision: "allow", auditId: "x1", ts: "t1", tool: "a", trustOrigin: "user-keyboard" },
      { decision: "deny", auditId: "x2", ts: "t2", tool: "b", trustOrigin: "user-keyboard" },
    ]);
    const file = join(auditDir, new Date().toISOString().slice(0, 10) + ".permission-audit.jsonl");
    writeFileSync(file, existing.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const logger = new AuditLogger();
    logger.setupPermissionAuditChain(SECRET);
    // The next entry must chain off the existing tail, not genesis.
    const entry = await logger.appendPermissionAuditEntry({
      decision: "ask",
      auditId: "x3",
      ts: "t3",
      trustOrigin: "user-keyboard",
      tool: "c",
      source: "builtin",
      category: "shell",
      directory: "/tmp",
      layer: 6,
      reason: "user confirm",
    });
    const expectedPrev = computeLineHmac(SECRET, JSON.stringify(existing[1]));
    expect(entry.prevHash).toBe(expectedPrev);

    // Whole file (existing + new) is still verifiable as a chain.
    const lines = readPermissionAuditLines(file);
    expect(lines.length).toBe(3);
    expect(verifyChain(SECRET, lines)).toEqual({ ok: true });
  });

  it("ten-entry chain — tamper line 4 → verify catches at line 5", async () => {
    const logger = new AuditLogger();
    logger.setupPermissionAuditChain(SECRET);
    for (let i = 0; i < 10; i++) {
      await logger.appendPermissionAuditEntry({
        decision: i % 2 === 0 ? "allow" : "deny",
        auditId: `id-${i}`,
        ts: `2026-05-09T00:00:${String(i).padStart(2, "0")}.000Z`,
        trustOrigin: "user-keyboard",
        tool: `tool-${i}`,
        source: "builtin",
        category: "read",
        directory: "/tmp",
        directoryAllowed: true,
        layer: 1,
      } as Parameters<AuditLogger["appendPermissionAuditEntry"]>[0]);
    }
    const file = logger.getPermissionAuditLogFile();
    const lines = readPermissionAuditLines(file);
    expect(lines.length).toBe(10);
    // Tamper line 4
    const obj = JSON.parse(lines[4]) as { tool: string };
    obj.tool = "TAMPERED";
    lines[4] = JSON.stringify(obj);
    writeFileSync(file, lines.join("\n") + "\n");
    const result = verifyChain(SECRET, readPermissionAuditLines(file));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Mutating line 4's payload keeps line 4's own prevHash valid
      // (it was bound to line 3) but breaks line 5's prevHash.
      expect(result.firstBrokenLineIndex).toBe(5);
    }
  });

  it("getPermissionAuditLogFile uses .permission-audit.jsonl extension within the audit dir", () => {
    const logger = new AuditLogger();
    expect(logger.getPermissionAuditLogFile()).toMatch(/\.permission-audit\.jsonl$/);
    expect(logger.getPermissionAuditLogFile()).toContain(auditDir);
  });
});

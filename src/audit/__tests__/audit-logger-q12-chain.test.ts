/**
 * Q12 Phase 5 — AuditLogger Q12 chain integration tests.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 7.
 *
 * Coverage:
 *   1. setupQ12Chain bootstraps cleanly on a fresh file (genesis).
 *   2. setupQ12Chain re-attaches to an existing file's tail.
 *   3. appendQ12Entry computes prevHash and writes JSONL.
 *   4. The full file passes verifyChain after sequential appends.
 *   5. appendQ12Entry throws when chain not initialized.
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
  testHome = mkdtempSync(join(tmpdir(), "lvis-q12-chain-"));
  auditDir = join(testHome, ".lvis", "audit");
  mkdirSync(auditDir, { recursive: true });
  vi.mocked(homedir).mockReturnValue(testHome);
});

afterEach(() => {
  if (existsSync(testHome)) rmSync(testHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function readQ12Lines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf-8").split("\n").filter((l) => l.length > 0);
}

describe("AuditLogger Q12 chain", () => {
  it("isQ12ChainReady is false before setupQ12Chain", () => {
    const logger = new AuditLogger();
    expect(logger.isQ12ChainReady()).toBe(false);
  });

  it("isQ12ChainReady is true after setupQ12Chain", () => {
    const logger = new AuditLogger();
    logger.setupQ12Chain(SECRET);
    expect(logger.isQ12ChainReady()).toBe(true);
  });

  it("appendQ12Entry throws before setupQ12Chain", async () => {
    const logger = new AuditLogger();
    await expect(
      logger.appendQ12Entry({
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

  it("appendQ12Entry on fresh file: first entry's prevHash = HMAC(genesis)", async () => {
    const logger = new AuditLogger();
    logger.setupQ12Chain(SECRET);
    const entry = await logger.appendQ12Entry({
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

    const lines = readQ12Lines(logger.getQ12LogFile());
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toEqual(entry);
  });

  it("two sequential appends produce a valid chain", async () => {
    const logger = new AuditLogger();
    logger.setupQ12Chain(SECRET);
    await logger.appendQ12Entry({
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
    await logger.appendQ12Entry({
      decision: "deny",
      auditId: "id-2",
      ts: "2026-05-09T00:00:01.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_write",
      source: "builtin",
      category: "write",
      denyReasons: [{ layer: 0, reason: "sensitive-path", source: "sensitive-paths" }],
    });
    const lines = readQ12Lines(logger.getQ12LogFile());
    expect(lines.length).toBe(2);
    expect(verifyChain(SECRET, lines)).toEqual({ ok: true });
  });

  it("appends deferred_resolve entries to the Q12 chain", async () => {
    const logger = new AuditLogger();
    logger.setupQ12Chain(SECRET);
    await logger.appendQ12Entry({
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

    const lines = readQ12Lines(logger.getQ12LogFile());
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      decision: "deferred_resolve",
      queueId: "queue-1",
      resolution: "approved",
    });
    expect(verifyChain(SECRET, lines)).toEqual({ ok: true });
  });

  it("setupQ12Chain re-bootstraps prevHash from an existing file's tail", async () => {
    // Pre-seed a chain manually
    const existing = buildChainedEntries(SECRET, [
      { decision: "allow", auditId: "x1", ts: "t1", tool: "a", trustOrigin: "user-keyboard" },
      { decision: "deny", auditId: "x2", ts: "t2", tool: "b", trustOrigin: "user-keyboard" },
    ]);
    const file = join(auditDir, new Date().toISOString().slice(0, 10) + ".q12.jsonl");
    writeFileSync(file, existing.map((e) => JSON.stringify(e)).join("\n") + "\n");

    const logger = new AuditLogger();
    logger.setupQ12Chain(SECRET);
    // The next entry must chain off the existing tail, not genesis.
    const entry = await logger.appendQ12Entry({
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
    const lines = readQ12Lines(file);
    expect(lines.length).toBe(3);
    expect(verifyChain(SECRET, lines)).toEqual({ ok: true });
  });

  it("ten-entry chain — tamper line 4 → verify catches at line 5", async () => {
    const logger = new AuditLogger();
    logger.setupQ12Chain(SECRET);
    for (let i = 0; i < 10; i++) {
      await logger.appendQ12Entry({
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
      } as Parameters<AuditLogger["appendQ12Entry"]>[0]);
    }
    const file = logger.getQ12LogFile();
    const lines = readQ12Lines(file);
    expect(lines.length).toBe(10);
    // Tamper line 4
    const obj = JSON.parse(lines[4]) as { tool: string };
    obj.tool = "TAMPERED";
    lines[4] = JSON.stringify(obj);
    writeFileSync(file, lines.join("\n") + "\n");
    const result = verifyChain(SECRET, readQ12Lines(file));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Mutating line 4's payload keeps line 4's own prevHash valid
      // (it was bound to line 3) but breaks line 5's prevHash.
      expect(result.firstBrokenLineIndex).toBe(5);
    }
  });

  it("getQ12LogFile uses .q12.jsonl extension within the audit dir", () => {
    const logger = new AuditLogger();
    expect(logger.getQ12LogFile()).toMatch(/\.q12\.jsonl$/);
    expect(logger.getQ12LogFile()).toContain(auditDir);
  });
});

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
  closeSync,
  constants,
  existsSync,
  fstatSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
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
  computeDailySeal,
  computeLineHmac,
  GENESIS_MARKER,
  MemorySecretStore,
  sealKeyName,
  type SecretStore,
  verifyChain,
} from "../hmac-chain.js";
import {
  buildHostShellExecutionPlan,
  getHostShellExecutionPlanAuditProjection,
} from "../../permissions/host-shell-execution-plan.js";

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

  it("isPermissionAuditChainReady is true after setupPermissionAuditChain", async () => {
    const logger = new AuditLogger();
    await logger.setupPermissionAuditChain(SECRET);
    expect(logger.isPermissionAuditChainReady()).toBe(true);
  });

  it("rejects a malformed existing chain and leaves privileged audit readiness false", async () => {
    const logger = new AuditLogger();
    writeFileSync(logger.getPermissionAuditLogFile(), "{not-json}\n", "utf-8");

    await expect(logger.setupPermissionAuditChain(SECRET)).rejects.toThrow(/json-parse-error/);
    expect(logger.isPermissionAuditChainReady()).toBe(false);
    expect(() => logger.assertPermissionAuditWritable()).toThrow(/not initialized/);
  });

  it("rejects an existing chain whose HMAC continuity is broken", async () => {
    const logger = new AuditLogger();
    writeFileSync(
      logger.getPermissionAuditLogFile(),
      `${JSON.stringify({ decision: "allow", prevHash: "00".repeat(32) })}\n`,
      "utf-8",
    );

    await expect(logger.setupPermissionAuditChain(SECRET)).rejects.toThrow(/hmac-mismatch/);
    expect(logger.isPermissionAuditChainReady()).toBe(false);
  });

  it.skipIf(process.platform === "win32")("propagates unreadable-chain failures without becoming ready", async () => {
    const logger = new AuditLogger();
    const file = logger.getPermissionAuditLogFile();
    writeFileSync(file, "{}\n", "utf-8");
    chmodSync(file, 0o000);
    try {
      await expect(logger.setupPermissionAuditChain(SECRET)).rejects.toThrow();
      expect(logger.isPermissionAuditChainReady()).toBe(false);
    } finally {
      chmodSync(file, 0o600);
    }
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
    await logger.setupPermissionAuditChain(SECRET);
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
    await logger.setupPermissionAuditChain(SECRET);
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

  it("chains the allowlist-only Plan-B projection without leaking its capability reason", async () => {
    const logger = new AuditLogger();
    await logger.setupPermissionAuditChain(SECRET);
    const plan = buildHostShellExecutionPlan({
      platform: "win32",
      requestedSandbox: true,
      activeCapability: {
        kind: "asrt",
        confidence: "verified",
        platform: "win32",
        reason: "host-only partial ASRT diagnostic",
        confines: { filesystem: true, process: false, network: true },
      },
    });
    const executionPlan = getHostShellExecutionPlanAuditProjection(plan);

    await logger.appendPermissionAuditEntry({
      decision: "ask",
      auditId: "plan-ask",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      toolUseId: "plan-tool-use",
      executionPlan,
      tool: "bash",
      source: "builtin",
      category: "shell",
      layer: 6,
      reason: "requires explicit Plan-B approval",
    });
    await logger.appendPermissionAuditEntry({
      decision: "deny",
      auditId: "plan-deny",
      ts: "2026-05-09T00:00:01.000Z",
      trustOrigin: "user-keyboard",
      toolUseId: "plan-tool-use",
      executionPlan,
      tool: "bash",
      source: "builtin",
      category: "shell",
      denyReasons: [{ layer: 6, reason: "user denied", source: "tool-executor" }],
    });

    const lines = readPermissionAuditLines(logger.getPermissionAuditLogFile());
    expect(verifyChain(SECRET, lines)).toEqual({ ok: true });
    const entries = lines.map((line) => JSON.parse(line) as { executionPlan?: unknown; toolUseId?: string });
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.toolUseId).toBe("plan-tool-use");
      expect(entry.executionPlan).toEqual(executionPlan);
    }
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("host-only partial ASRT diagnostic");
    expect(serialized).not.toContain("command");
    expect(serialized).not.toContain("allowedDirectories");

    const tampered = [...lines];
    const first = JSON.parse(tampered[0]!) as {
      executionPlan: { fallbackReason: string };
    };
    first.executionPlan.fallbackReason = "none";
    tampered[0] = JSON.stringify(first);
    expect(verifyChain(SECRET, tampered)).toMatchObject({ ok: false });
  });
  it("appends deferred_resolve entries to the permission audit chain", async () => {
    const logger = new AuditLogger();
    await logger.setupPermissionAuditChain(SECRET);
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
      approvalSource: "button",
      reason: "manual review",
    });

    const lines = readPermissionAuditLines(logger.getPermissionAuditLogFile());
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      decision: "deferred_resolve",
      queueId: "queue-1",
      resolution: "approved",
      approvalSource: "button",
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
    await logger.setupPermissionAuditChain(SECRET);
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

  it("ten-entry chain — tamper line 4 → self-authentication catches line 4", async () => {
    const logger = new AuditLogger();
    await logger.setupPermissionAuditChain(SECRET);
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
      expect(result.firstBrokenLineIndex).toBe(4);
      expect(result.reason).toBe("entry-hmac-mismatch");
    }
  });

  it("rejects payload tampering in the active tail without requiring a successor", async () => {
    const logger = new AuditLogger();
    await logger.setupPermissionAuditChain(SECRET);
    await logger.appendPermissionAuditEntry({
      decision: "allow",
      auditId: "tail-original",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_read",
      source: "builtin",
      category: "read",
      layer: 1,
    });
    const file = logger.getPermissionAuditLogFile();
    const lines = readPermissionAuditLines(file);
    const tail = JSON.parse(lines.at(-1)!) as { auditId: string };
    tail.auditId = "tail-tampered";
    lines[lines.length - 1] = JSON.stringify(tail);
    writeFileSync(file, lines.join("\n") + "\n", "utf-8");

    expect(() => logger.assertPermissionAuditWritable()).toThrow(
      /not self-authenticated/,
    );
    const rebooted = new AuditLogger();
    await expect(rebooted.setupPermissionAuditChain(SECRET)).rejects.toThrow(/entry-hmac-mismatch/);
    expect(rebooted.isPermissionAuditChainReady()).toBe(false);
  });

  it("archives an unsealed legacy tail instead of trust-on-first-use anchoring it", async () => {
    const logger = new AuditLogger();
    const file = logger.getPermissionAuditLogFile();
    const legacy = {
      decision: "allow",
      auditId: "legacy-tail",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      prevHash: computeLineHmac(SECRET, GENESIS_MARKER),
    };
    writeFileSync(file, `${JSON.stringify(legacy)}\n`, "utf-8");
    const seals = new MemorySecretStore();
    await logger.setupPermissionAuditChain(SECRET, seals);
    const archiveName = readdirSync(auditDir).find((name) =>
      name.includes("permission-audit.legacy-unverified-"),
    );
    expect(archiveName).toBeDefined();
    expect(readFileSync(join(auditDir, archiveName!), "utf-8"))
      .toBe(`${JSON.stringify(legacy)}\n`);
    expect(existsSync(file)).toBe(false);

    const appended = await logger.appendPermissionAuditEntry({
      decision: "allow",
      auditId: "fresh-epoch",
      ts: "2026-05-09T00:00:01.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_read",
      source: "builtin",
      category: "read",
      layer: 1,
    });
    expect(appended.prevHash).toBe(computeLineHmac(SECRET, GENESIS_MARKER));
  });

  it("accepts a legacy tail only when a pre-existing external seal authenticates it", async () => {
    const logger = new AuditLogger();
    const file = logger.getPermissionAuditLogFile();
    const legacy = JSON.stringify({
      decision: "allow",
      auditId: "externally-sealed-legacy",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      prevHash: computeLineHmac(SECRET, GENESIS_MARKER),
    });
    writeFileSync(file, `${legacy}\n`, "utf-8");
    const seals = new MemorySecretStore();
    const date = file.split("/").at(-1)!.slice(0, 10);
    seals.write(sealKeyName(date), computeDailySeal(SECRET, legacy));

    await expect(logger.setupPermissionAuditChain(SECRET, seals)).resolves.toBeUndefined();
    expect(logger.isPermissionAuditChainReady()).toBe(true);
  });

  it("recovers a self-authenticated fsynced row after its seal write was interrupted", async () => {
    const backing = new MemorySecretStore();
    let failNextWrite = false;
    const seals: SecretStore = {
      read: (name, maxBytes) => backing.read(name, maxBytes),
      write: (name, value) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new Error("simulated seal commit interruption");
        }
        backing.write(name, value);
      },
    };
    const logger = new AuditLogger();
    await logger.setupPermissionAuditChain(SECRET, seals);
    failNextWrite = true;
    await expect(logger.appendPermissionAuditEntry({
      decision: "allow",
      auditId: "fsynced-before-seal",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_read",
      source: "builtin",
      category: "read",
      layer: 1,
    })).rejects.toThrow("simulated seal commit interruption");

    const rebooted = new AuditLogger();
    await expect(rebooted.setupPermissionAuditChain(SECRET, seals)).resolves.toBeUndefined();
    expect(rebooted.isPermissionAuditChainReady()).toBe(true);
    expect(() => rebooted.assertPermissionAuditWritable()).not.toThrow();
  });

  it("rolls to a fresh UTC audit file and re-verifies an older epoch before reuse", async () => {
    let now = new Date("2026-07-23T23:59:59.000Z");
    const seals = new MemorySecretStore();
    const logger = new AuditLogger(undefined, { now: () => now });
    await logger.setupPermissionAuditChain(SECRET, seals);
    await logger.appendPermissionAuditEntry({
      decision: "allow", auditId: "day-a", ts: now.toISOString(),
      trustOrigin: "user-keyboard", tool: "fs_read", source: "builtin",
      category: "read", layer: 1,
    });
    const dayAPath = logger.getPermissionAuditLogFile();

    now = new Date("2026-07-24T00:00:01.000Z");
    expect(() => logger.assertPermissionAuditWritable()).not.toThrow();
    await logger.appendPermissionAuditEntry({
      decision: "allow", auditId: "day-b", ts: now.toISOString(),
      trustOrigin: "user-keyboard", tool: "fs_read", source: "builtin",
      category: "read", layer: 1,
    });
    const dayBPath = logger.getPermissionAuditLogFile();
    expect(dayBPath).not.toBe(dayAPath);

    const tampered = JSON.parse(readFileSync(dayAPath, "utf-8").trim()) as { auditId: string };
    tampered.auditId = "tampered-day-a";
    writeFileSync(dayAPath, `${JSON.stringify(tampered)}\n`, "utf-8");
    now = new Date("2026-07-23T23:59:59.500Z");
    await expect(logger.appendPermissionAuditEntry({
      decision: "allow", auditId: "day-a-return", ts: now.toISOString(),
      trustOrigin: "user-keyboard", tool: "fs_read", source: "builtin",
      category: "read", layer: 1,
    })).rejects.toThrow(/entry-hmac-mismatch/);
  });

  it("serializes concurrent appends across a UTC epoch transition", async () => {
    let now = new Date("2026-07-23T23:59:59.000Z");
    const seals = new MemorySecretStore();
    const logger = new AuditLogger(undefined, { now: () => now });
    await logger.setupPermissionAuditChain(SECRET, seals);

    now = new Date("2026-07-24T00:00:01.000Z");
    const entries = await Promise.all([
      logger.appendPermissionAuditEntry({
        decision: "allow", auditId: "rollover-a", ts: now.toISOString(),
        trustOrigin: "user-keyboard", tool: "fs_read", source: "builtin",
        category: "read", layer: 1,
      }),
      logger.appendPermissionAuditEntry({
        decision: "allow", auditId: "rollover-b", ts: now.toISOString(),
        trustOrigin: "user-keyboard", tool: "fs_read", source: "builtin",
        category: "read", layer: 1,
      }),
    ]);

    expect(entries.map((entry) => entry.auditId).sort())
      .toEqual(["rollover-a", "rollover-b"]);
    expect(readFileSync(logger.getPermissionAuditLogFile(), "utf-8").trim().split("\n"))
      .toHaveLength(2);
  });

  it("rejects an unterminated active JSONL tail", async () => {
    const logger = new AuditLogger();
    const linked = {
      decision: "allow",
      auditId: "unterminated",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      prevHash: computeLineHmac(SECRET, GENESIS_MARKER),
    };
    const row = {
      ...linked,
      entryHash: computeLineHmac(SECRET, JSON.stringify(linked)),
    };
    writeFileSync(logger.getPermissionAuditLogFile(), JSON.stringify(row), "utf-8");

    await expect(logger.setupPermissionAuditChain(SECRET)).rejects.toThrow(
      /unterminated tail/,
    );
  });

  it("archives and truncates a torn tail only when the external seal authenticates its predecessor", async () => {
    const seals = new MemorySecretStore();
    const logger = new AuditLogger();
    await logger.setupPermissionAuditChain(SECRET, seals);
    await logger.appendPermissionAuditEntry({
      decision: "allow",
      auditId: "durable-predecessor",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_read",
      source: "builtin",
      category: "read",
      layer: 1,
    });
    const activePath = logger.getPermissionAuditLogFile();
    writeFileSync(activePath, `${readFileSync(activePath, "utf-8")}{\"partial\":`, "utf-8");

    const rebooted = new AuditLogger();
    await expect(rebooted.setupPermissionAuditChain(SECRET, seals)).resolves.toBeUndefined();
    expect(readPermissionAuditLines(activePath)).toHaveLength(1);
    const tornArchives = readdirSync(auditDir).filter((name) =>
      name.includes(".permission-audit.torn-unverified-")
    );
    expect(tornArchives).toHaveLength(1);
    expect(readFileSync(join(auditDir, tornArchives[0]!), "utf-8"))
      .toContain('{"partial":');

    await expect(rebooted.appendPermissionAuditEntry({
      decision: "deny",
      auditId: "after-torn-recovery",
      ts: "2026-05-09T00:00:01.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_write",
      source: "builtin",
      category: "write",
      layer: 2,
    })).resolves.toMatchObject({ auditId: "after-torn-recovery" });
    expect(readPermissionAuditLines(activePath)).toHaveLength(2);
  });

  it("does not overwrite an existing torn-tail archive or expose a staging file", async () => {
    const now = new Date("2026-05-09T00:00:02.000Z");
    const seals = new MemorySecretStore();
    const logger = new AuditLogger(undefined, { now: () => now });
    await logger.setupPermissionAuditChain(SECRET, seals);
    await logger.appendPermissionAuditEntry({
      decision: "allow",
      auditId: "archive-collision-predecessor",
      ts: "2026-05-09T00:00:00.000Z",
      trustOrigin: "user-keyboard",
      tool: "fs_read",
      source: "builtin",
      category: "read",
      layer: 1,
    });
    const activePath = logger.getPermissionAuditLogFile();
    writeFileSync(activePath, `${readFileSync(activePath, "utf-8")}{"partial":`, "utf-8");
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const activeDescriptor = openSync(activePath, constants.O_RDONLY | noFollow);
    try {
      const originalTornBytes = readFileSync(activeDescriptor);
      const archivePath = join(
        auditDir,
        `2026-05-09.permission-audit.torn-unverified-${originalTornBytes.byteLength}-${now.getTime()}.jsonl`,
      );
      writeFileSync(archivePath, "existing-forensic-evidence", { mode: 0o600 });

      const rebooted = new AuditLogger(undefined, { now: () => now });
      await expect(rebooted.setupPermissionAuditChain(SECRET, seals)).rejects.toThrow(
        /archive already exists/,
      );
      expect(rebooted.isPermissionAuditChainReady()).toBe(false);
      const publishedDescriptor = openSync(activePath, constants.O_RDONLY | noFollow);
      try {
        const originalIdentity = fstatSync(activeDescriptor);
        const publishedIdentity = fstatSync(publishedDescriptor);
        expect({ dev: publishedIdentity.dev, ino: publishedIdentity.ino }).toEqual({
          dev: originalIdentity.dev,
          ino: originalIdentity.ino,
        });
        const preservedTornBytes = Buffer.alloc(originalTornBytes.byteLength);
        expect(
          readSync(
            publishedDescriptor,
            preservedTornBytes,
            0,
            preservedTornBytes.byteLength,
            0,
          ),
        ).toBe(preservedTornBytes.byteLength);
        expect(preservedTornBytes).toEqual(originalTornBytes);
      } finally {
        closeSync(publishedDescriptor);
      }
      expect(readFileSync(archivePath, "utf-8")).toBe("existing-forensic-evidence");
      expect(readdirSync(auditDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      closeSync(activeDescriptor);
    }
  });

  it("rejects an oversized audit row without reading the whole file into memory", async () => {
    const logger = new AuditLogger();
    writeFileSync(
      logger.getPermissionAuditLogFile(),
      `${"x".repeat(1024 * 1024 + 1)}\n`,
      "utf-8",
    );
    await expect(logger.setupPermissionAuditChain(SECRET)).rejects.toThrow(
      /maximum size/,
    );
    expect(logger.isPermissionAuditChainReady()).toBe(false);
  });

  it("streams a large existing chain and yields to the event loop", async () => {
    const logger = new AuditLogger();
    const file = logger.getPermissionAuditLogFile();
    const entries = buildChainedEntries(
      SECRET,
      Array.from({ length: 20_000 }, (_, index) => ({
        decision: "allow",
        auditId: `large-${index}`,
        ts: "2026-05-09T00:00:00.000Z",
      })),
    );
    writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n", "utf-8");
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    try {
      await logger.setupPermissionAuditChain(SECRET);
    } finally {
      clearTimeout(timer);
    }
    expect(timerFired).toBe(true);
    expect(logger.isPermissionAuditChainReady()).toBe(true);
  }, 15_000);

  it("getPermissionAuditLogFile uses .permission-audit.jsonl extension within the audit dir", () => {
    const logger = new AuditLogger();
    expect(logger.getPermissionAuditLogFile()).toMatch(/\.permission-audit\.jsonl$/);
    expect(logger.getPermissionAuditLogFile()).toContain(auditDir);
  });
});

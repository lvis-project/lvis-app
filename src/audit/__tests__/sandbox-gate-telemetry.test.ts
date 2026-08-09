/**
 * AuditLogger.logSandboxGate() — boot-time OS-sandbox activation telemetry.
 *
 * ONE record per boot, written to the DEDICATED `<date>.sandbox-gate.jsonl`
 * channel (kept separate from the canonical telemetry channel). Lets the
 * real-world activate / degrade / abort / skip rates be monitored before the
 * Linux/Windows osToolSandbox default is flipped on (the staged rollout).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../testing/tmp-dir-teardown.js";

import { AuditLogger, type SandboxGateAuditEntry } from "../audit-logger.js";

let auditDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), "lvis-sandbox-gate-tel-"));
});

afterEach(async () => {
  if (existsSync(auditDir)) await cleanupTmpDir(auditDir);
});

function readGateLines(): SandboxGateAuditEntry[] {
  const files = existsSync(auditDir)
    ? readdirSync(auditDir).filter((f) => f.endsWith(".sandbox-gate.jsonl"))
    : [];
  const out: SandboxGateAuditEntry[] = [];
  for (const f of files) {
    const raw = readFileSync(join(auditDir, f), "utf-8");
    for (const line of raw.split("\n").filter(Boolean)) {
      out.push(JSON.parse(line) as SandboxGateAuditEntry);
    }
  }
  return out;
}

describe("AuditLogger.logSandboxGate() — activation telemetry", () => {
  it("writes one record with platform / onSignal / outcome / reason and stamps timestamp+type", async () => {
    const logger = new AuditLogger(auditDir);
    logger.logSandboxGate({
      platform: "darwin",
      onSignal: "default-settings",
      outcome: "activate",
      reason: "deps-present",
    });
    await logger.flush();

    const entries = readGateLines();
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect(e.type).toBe("sandbox_gate");
    expect(e.platform).toBe("darwin");
    expect(e.onSignal).toBe("default-settings");
    expect(e.outcome).toBe("activate");
    expect(e.reason).toBe("deps-present");
    // timestamp is stamped by the logger (caller does not supply it).
    expect(new Date(e.timestamp).toISOString()).toBe(e.timestamp);
  });

  it("captures each terminal outcome shape (degrade / abort / skip)", async () => {
    const logger = new AuditLogger(auditDir);
    logger.logSandboxGate({
      platform: "linux",
      onSignal: "default-settings",
      outcome: "degrade",
      reason: "degrade-default-cannot-activate",
    });
    logger.logSandboxGate({
      platform: "linux",
      onSignal: "explicit-env",
      outcome: "abort",
      reason: "abort-explicit-cannot-activate",
    });
    logger.logSandboxGate({
      platform: "linux",
      onSignal: "off",
      outcome: "skip",
      reason: "gate-off",
    });
    await logger.flush();

    const entries = readGateLines();
    expect(entries.map((e) => e.outcome)).toEqual(["degrade", "abort", "skip"]);
    expect(entries.map((e) => e.onSignal)).toEqual([
      "default-settings",
      "explicit-env",
      "off",
    ]);
    expect(entries.every((e) => e.type === "sandbox_gate")).toBe(true);
  });

  it("swallows a failed telemetry write instead of surfacing it at boot", async () => {
    // The failure has to be real for this to prove anything, and the previous
    // version's was not. It pointed the logger at `<auditDir>/missing/deeper`
    // and removed `auditDir`, on the premise that a "non-creatable" parent makes
    // the append fail. Both halves were wrong: the constructor creates its audit
    // dir with a recursive `mkdir`, and so does the write path — so the tree came
    // straight back and the append SUCCEEDED. (Worse, it came back after the
    // teardown had removed it.)
    //
    // Occupying the directory's name with a FILE after construction cannot be
    // undone by `mkdir -p` on any platform, so the write genuinely fails here.
    const gateDir = join(auditDir, "gate");
    const logger = new AuditLogger(gateDir);
    rmSync(gateDir, { recursive: true, force: true });
    writeFileSync(gateDir, "not a directory", "utf-8");

    // The call itself only enqueues, so "does not throw" is about boot never
    // seeing a telemetry error — the write's own failure surfaces later, or not
    // at all, which is the point.
    expect(() =>
      logger.logSandboxGate({
        platform: "win32",
        onSignal: "explicit-env",
        outcome: "abort",
        reason: "abort-explicit-cannot-activate",
      }),
    ).not.toThrow();

    // Draining must not reject either, and the write must be accounted as
    // dropped — that is what "swallowed" means here, and it is 0 if the append
    // quietly succeeded instead of failing.
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(logger.getWriterStats().droppedWrites).toBe(1);
  });
});

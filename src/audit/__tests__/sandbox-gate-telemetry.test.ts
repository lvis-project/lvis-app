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
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { AuditLogger, type SandboxGateAuditEntry } from "../audit-logger.js";

let auditDir: string;

beforeEach(() => {
  auditDir = mkdtempSync(join(tmpdir(), "lvis-sandbox-gate-tel-"));
});

afterEach(() => {
  if (existsSync(auditDir)) rmSync(auditDir, { recursive: true, force: true });
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
  it("writes one record with platform / onSignal / outcome / reason and stamps timestamp+type", () => {
    const logger = new AuditLogger(auditDir);
    logger.logSandboxGate({
      platform: "darwin",
      onSignal: "default-settings",
      outcome: "activate",
      reason: "deps-present",
    });

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

  it("captures each terminal outcome shape (degrade / abort / skip)", () => {
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

    const entries = readGateLines();
    expect(entries.map((e) => e.outcome)).toEqual(["degrade", "abort", "skip"]);
    expect(entries.map((e) => e.onSignal)).toEqual([
      "default-settings",
      "explicit-env",
      "off",
    ]);
    expect(entries.every((e) => e.type === "sandbox_gate")).toBe(true);
  });

  it("never throws — telemetry must not break boot (runs before the abort re-throw)", () => {
    // A non-existent, non-creatable audit dir parent makes the append fail; the
    // method swallows the error so boot's own fail-closed throw is the one that
    // surfaces, not a telemetry write error.
    const logger = new AuditLogger(join(auditDir, "missing", "deeper"));
    rmSync(auditDir, { recursive: true, force: true });
    expect(() =>
      logger.logSandboxGate({
        platform: "win32",
        onSignal: "explicit-env",
        outcome: "abort",
        reason: "abort-explicit-cannot-activate",
      }),
    ).not.toThrow();
  });
});

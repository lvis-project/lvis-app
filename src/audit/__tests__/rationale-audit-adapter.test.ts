import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, it } from "vitest";
import { RATIONALE_CONTROL_CONTRACT_VERSION } from "../../tools/pipeline/rationale-control.js";
import type { InvocationAuditRecord } from "../../tools/pipeline/rationale-ticket-lifecycle.js";
import type { RationaleUiAuditProjection } from "../../tools/pipeline/rationale-resume-contract.js";
import type { RationaleTicketStoreAuditEvent } from "../../tools/pipeline/rationale-ticket-store.js";
import { MemorySecretStore, type SecretStore } from "../hmac-chain.js";
import {
  DurableRationaleAuditAdapter,
  RationaleAuditUnavailableError,
} from "../rationale-audit-adapter.js";

const NOW = 1_900_000_000_000;
const SECRET = "rationale-audit-test-secret-that-is-at-least-32-characters";
const roots: string[] = [];

function createAuditDir(): string {
  const root = mkdtempSync(join(tmpdir(), "lvis-rationale-audit-"));
  roots.push(root);
  return join(root, "nested-audit");
}

function ticketEvent(at = NOW): RationaleTicketStoreAuditEvent {
  return {
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    kind: "host-rationale-ticket-store-audit",
    operation: "created",
    sessionId: "session-a",
    ticketId: randomUUID(),
    actionDigest: "a".repeat(64),
    invocationDigest: "b".repeat(64),
    event: null,
    previousState: null,
    state: "review_required",
    previousVersion: null,
    version: 0,
    terminalReason: null,
    receiptId: null,
    at,
  };
}

class SnapshotSecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  read(name: string): string | null { return this.values.get(name) ?? null; }
  write(name: string, value: string): void { this.values.set(name, value); }
  snapshot(): Map<string, string> { return new Map(this.values); }
  restore(snapshot: Map<string, string>): void {
    this.values.clear();
    for (const [name, value] of snapshot) this.values.set(name, value);
  }
}

function invocationRecord(): InvocationAuditRecord {
  return {
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    ticketId: randomUUID(),
    actionDigest: "c".repeat(64),
    invocationDigest: "d".repeat(64),
    toolUseId: "tool-use-a",
    authorizationReceiptId: randomUUID(),
    invocationStartLeaseId: null,
    version: 0,
    state: "authorized",
    automaticRetry: "forbidden",
  };
}

function uiProjection(): RationaleUiAuditProjection {
  const verdict = {
    level: "medium",
    reason: "The sealed target remains a medium-risk write.",
  } as const;
  return {
    contractVersion: RATIONALE_CONTROL_CONTRACT_VERSION,
    projection: "rationale-ui-audit",
    ticketId: randomUUID(),
    anchorId: randomUUID(),
    actionDigest: "e".repeat(64),
    round: 1,
    reasonCode: "foreground-reviewer-threshold",
    toolName: "write_fixture",
    canonicalTargets: ["workspace/output"],
    requestedEffects: ["mutate-data"],
    affectedResources: ["workspace/output"],
    requiredAuthority: "workspace-write",
    reviewerOutcome: "fresh",
    generationOutcome: "accepted-rationale",
    reevaluationOutcome: "fresh",
    initialVerdict: { ...verdict },
    reevaluatedVerdict: { ...verdict },
    effectiveVerdict: { ...verdict },
    scopeAlignment: "aligned",
    scopeReasons: ["The exact sealed target remains in scope."],
    rationaleStatus: "ready",
    terminalReason: null,
    suggestion: "Apply the exact sealed write.",
    modalFallbackRequired: false,
    autoApproved: false,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("DurableRationaleAuditAdapter", () => {
  it("stays dormant until first use and continues a verified chain after restart", () => {
    const auditDir = createAuditDir();
    const sealStore = new MemorySecretStore();
    const adapter = new DurableRationaleAuditAdapter({
      auditDir,
      auditSecret: SECRET,
      sealStore,
      now: () => NOW,
    });

    expect(existsSync(auditDir)).toBe(false);

    adapter.assertWritable();
    adapter.appendTicket(ticketEvent());
    adapter.appendProjection("session-a", uiProjection(), NOW);
    adapter.appendInvocation("session-a", invocationRecord());

    const restarted = new DurableRationaleAuditAdapter({
      auditDir,
      auditSecret: SECRET,
      sealStore,
      now: () => NOW,
    });
    restarted.assertWritable();
    restarted.appendTicket(ticketEvent());

    const raw = readFileSync(restarted.getLogFile(), "utf8");
    const entries = raw.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(entries.map((entry) => entry.kind)).toEqual([
      "rationale-ticket-lifecycle",
      "rationale-ui-projection",
      "rationale-invocation-lifecycle",
      "rationale-ticket-lifecycle",
    ]);
    expect(entries.every((entry) => entry.sessionId === "session-a")).toBe(true);
    expect(raw).not.toContain("rawIntent");
    expect(raw).not.toContain("originalInput");
  });

  it("rejects projection display fields that bypass DLP or path redaction", () => {
    const auditDir = createAuditDir();
    const adapter = new DurableRationaleAuditAdapter({
      auditDir,
      auditSecret: SECRET,
      sealStore: new MemorySecretStore(),
      now: () => NOW,
    });
    const base = uiProjection();

    expect(() => adapter.appendProjection("session-a", {
      ...base,
      suggestion: "Contact operator@example.com\u0000<script>alert(1)</script>",
    }, NOW)).toThrow(/invalid rationale UI projection/);
    expect(() => adapter.appendProjection("session-a", {
      ...base,
      canonicalTargets: [join(homedir(), "private", "output")],
    }, NOW)).toThrow(/invalid rationale UI projection/);
    expect(existsSync(auditDir)).toBe(false);
  });

  it("poisons itself after detecting an unterminated audit tail", () => {
    const auditDir = createAuditDir();
    const sealStore = new MemorySecretStore();
    const adapter = new DurableRationaleAuditAdapter({
      auditDir,
      auditSecret: SECRET,
      sealStore,
      now: () => NOW,
    });
    adapter.appendTicket(ticketEvent());

    const filePath = adapter.getLogFile();
    const raw = readFileSync(filePath, "utf8");
    writeFileSync(filePath, raw.slice(0, -1), "utf8");

    const restarted = new DurableRationaleAuditAdapter({
      auditDir,
      auditSecret: SECRET,
      sealStore,
      now: () => NOW,
    });
    expect(() => restarted.assertWritable()).toThrow(RationaleAuditUnavailableError);
    expect(() => restarted.appendTicket(ticketEvent())).toThrow(
      /poisoned after an earlier storage failure/,
    );
  });

  it.each([
    ["missing", (path: string, _raw: string) => rmSync(path)],
    ["empty", (path: string, _raw: string) => writeFileSync(path, "", "utf8")],
    ["complete-line prefix", (path: string, raw: string) => {
      writeFileSync(path, `${raw.trimEnd().split("\n")[0]}\n`, "utf8");
    }],
    ["mutated final row", (path: string, raw: string) => {
      const lines = raw.trimEnd().split("\n");
      const last = JSON.parse(lines.at(-1)!) as { auditId: string };
      last.auditId = (last.auditId.startsWith("a") ? "b" : "a") + last.auditId.slice(1);
      lines[lines.length - 1] = JSON.stringify(last);
      writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    }],
  ])("fails closed on %s rollback/tamper even when the remaining prefix is valid",
    (_label, mutate) => {
      const auditDir = createAuditDir();
      const sealStore = new MemorySecretStore();
      const adapter = new DurableRationaleAuditAdapter({
        auditDir, auditSecret: SECRET, sealStore, now: () => NOW,
      });
      adapter.appendTicket(ticketEvent());
      adapter.appendTicket(ticketEvent());
      const path = adapter.getLogFile();
      const raw = readFileSync(path, "utf8");
      mutate(path, raw);

      const restarted = new DurableRationaleAuditAdapter({
        auditDir, auditSecret: SECRET, sealStore, now: () => NOW,
      });
      expect(() => restarted.assertWritable()).toThrow(RationaleAuditUnavailableError);
    });

  it("recovers multiple fsynced rows after both newer checkpoint slots are lost", () => {
    const auditDir = createAuditDir();
    const sealStore = new SnapshotSecretStore();
    const adapter = new DurableRationaleAuditAdapter({
      auditDir, auditSecret: SECRET, sealStore, now: () => NOW,
    });
    adapter.assertWritable();
    const checkpointBeforeRows = sealStore.snapshot();
    adapter.appendTicket(ticketEvent());
    adapter.appendInvocation("session-a", invocationRecord());
    adapter.appendTicket(ticketEvent());
    sealStore.restore(checkpointBeforeRows);

    const restarted = new DurableRationaleAuditAdapter({
      auditDir, auditSecret: SECRET, sealStore, now: () => NOW,
    });
    expect(() => restarted.assertWritable()).not.toThrow();
    restarted.appendTicket(ticketEvent());
    expect(readFileSync(restarted.getLogFile(), "utf8").trimEnd().split("\n")).toHaveLength(4);
  });

  it("fails closed when neither alternating checkpoint slot has a valid seal", () => {
    const auditDir = createAuditDir();
    const sealStore = new SnapshotSecretStore();
    const adapter = new DurableRationaleAuditAdapter({
      auditDir, auditSecret: SECRET, sealStore, now: () => NOW,
    });
    adapter.appendTicket(ticketEvent());
    for (const [name, value] of sealStore.values) {
      sealStore.values.set(name, `${value.slice(0, -1)}${value.endsWith("0") ? "1" : "0"}`);
    }
    const restarted = new DurableRationaleAuditAdapter({
      auditDir, auditSecret: SECRET, sealStore, now: () => NOW,
    });
    expect(() => restarted.assertWritable()).toThrow(RationaleAuditUnavailableError);
  });

  it("rejects even an empty pre-existing file when no sealed first-use checkpoint exists", () => {
    const auditDir = createAuditDir();
    mkdirSync(auditDir, { recursive: true });
    const adapter = new DurableRationaleAuditAdapter({
      auditDir, auditSecret: SECRET, sealStore: new MemorySecretStore(), now: () => NOW,
    });
    writeFileSync(adapter.getLogFile(), "", "utf8");
    expect(() => adapter.assertWritable()).toThrow(RationaleAuditUnavailableError);
  });

  it("re-verifies a prior UTC day after an A-to-B-to-A clock transition", () => {
    const auditDir = createAuditDir();
    const sealStore = new MemorySecretStore();
    const adapter = new DurableRationaleAuditAdapter({
      auditDir, auditSecret: SECRET, sealStore, now: () => NOW,
    });
    const nextDay = NOW + 86_400_000;
    adapter.appendTicket(ticketEvent(NOW));
    adapter.appendTicket(ticketEvent(nextDay));
    const oldPath = adapter.getLogFile(NOW);
    const oldRow = JSON.parse(readFileSync(oldPath, "utf8").trimEnd()) as { auditId: string };
    oldRow.auditId = (oldRow.auditId.startsWith("a") ? "b" : "a") + oldRow.auditId.slice(1);
    writeFileSync(oldPath, `${JSON.stringify(oldRow)}\n`, "utf8");
    expect(() => adapter.appendTicket(ticketEvent(NOW))).toThrow(RationaleAuditUnavailableError);
  });

  it("fails closed at the configured daily row ceiling without appending an extra row", () => {
    const auditDir = createAuditDir();
    const adapter = new DurableRationaleAuditAdapter({
      auditDir, auditSecret: SECRET, sealStore: new MemorySecretStore(), now: () => NOW,
      maxLinesPerDay: 1,
    });
    adapter.appendTicket(ticketEvent());
    expect(() => adapter.appendTicket(ticketEvent())).toThrow(RationaleAuditUnavailableError);
    expect(readFileSync(adapter.getLogFile(), "utf8").trimEnd().split("\n")).toHaveLength(1);
  });

  it("bounds ELOCKED contention without poisoning the adapter", () => {
    const auditDir = createAuditDir();
    const adapter = new DurableRationaleAuditAdapter({
      auditDir, auditSecret: SECRET, sealStore: new MemorySecretStore(), now: () => NOW,
      lockRetries: 0,
    });
    adapter.assertWritable();
    const target = `${adapter.getLogFile()}.lock-target`;
    const release = lockfile.lockSync(target, { realpath: false, stale: 30_000 });
    try {
      expect(() => adapter.appendTicket(ticketEvent())).toThrow(/temporarily unavailable/);
    } finally {
      release();
    }
    expect(() => adapter.appendTicket(ticketEvent())).not.toThrow();
  });

  it.skipIf(process.platform === "win32")(
    "re-hardens pre-existing POSIX audit directories, rows, and stable lock targets",
    () => {
      const auditDir = createAuditDir();
      const sealStore = new MemorySecretStore();
      const adapter = new DurableRationaleAuditAdapter({
        auditDir, auditSecret: SECRET, sealStore, now: () => NOW,
      });
      adapter.appendTicket(ticketEvent());
      chmodSync(auditDir, 0o777);
      chmodSync(adapter.getLogFile(), 0o666);
      const restarted = new DurableRationaleAuditAdapter({
        auditDir, auditSecret: SECRET, sealStore, now: () => NOW,
      });
      restarted.assertWritable();
      expect(statSync(auditDir).mode & 0o777).toBe(0o700);
      expect(statSync(restarted.getLogFile()).mode & 0o777).toBe(0o600);
      expect(statSync(`${restarted.getLogFile()}.lock-target`).mode & 0o777).toBe(0o600);
    },
  );
});

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../../audit/audit-logger.js";
import { verifyChain } from "../../../audit/hmac-chain.js";
import { permissionAuditEntryFromToolCall } from "../audit-entries.js";

const SECRET = "ab".repeat(32);
let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await cleanupTmpDir(root);
  root = undefined;
});

describe("workload broker permission audit correlation", () => {
  it("persists the issued exact-operation grant projection in the authenticated final row", async () => {
    root = mkdtempSync(join(tmpdir(), "lvis-broker-audit-"));
    const logger = new AuditLogger(root);
    await logger.setupPermissionAuditChain(SECRET);
    const correlation = Object.freeze({
      version: "lvis-workload-correlation/v1" as const,
      kind: "tool-invocation" as const,
      toolUseId: "tool-read-1",
      toolName: "read_file",
      operation: "file.read" as const,
      grant: Object.freeze({
        identity: "1".repeat(64),
        effectDigest: "2".repeat(64),
        action: "builtin-tool" as const,
        planIdentity: null,
      }),
    });
    const entry = permissionAuditEntryFromToolCall({
      toolName: "read_file",
      source: "builtin",
      category: "read",
      input: { path: "notes.txt" },
      permission: { decision: "allow", reason: "allowed", layer: 6 },
      rateLimitRemaining: 9,
      trustOrigin: "llm-tool-arg",
      cwd: "/workspace",
      audit: { toolUseId: correlation.toolUseId, workloadBrokerCorrelation: correlation },
    });
    await logger.appendPermissionAuditEntry(entry);
    await logger.flush();

    const lines = readFileSync(logger.getPermissionAuditLogFile(), "utf8")
      .trim().split("\n").filter(Boolean);
    expect(verifyChain(SECRET, lines)).toEqual({ ok: true });
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({
      decision: "allow",
      workloadBrokerCorrelation: correlation,
    });
    const tampered = JSON.parse(lines.at(-1)!) as {
      workloadBrokerCorrelation: { operation: string };
    };
    tampered.workloadBrokerCorrelation.operation = "file.write";
    expect(verifyChain(SECRET, [JSON.stringify(tampered)])).toMatchObject({ ok: false });
    await logger.close();
  });
});

/**
 * Tests for S2 sandbox audit sink.
 * Issue: #691 PR-A4
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, mkdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

const TEST_HOME = join(tmpdir(), `lvis-test-sink-${randomBytes(4).toString("hex")}`);
process.env.LVIS_HOME = TEST_HOME;

import { emitSandboxAudit, sandboxAuditSinkPath } from "../sandbox-audit-sink.js";
import { buildSandboxAuditEntry } from "../sandbox-audit.js";

beforeEach(async () => {
  await mkdir(TEST_HOME, { recursive: true });
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
});

function makeEntry(toolName = "bash_run") {
  return buildSandboxAuditEntry({
    tool: { name: toolName, args: '{"command":"ls"}', source: "user-keyboard" },
    sandbox: { kind: "none", confidence: "verified", events: [], spawnLatencyMs: 0, overheadPercent: 0 },
    reviewer: {
      ruleVerdict: "low",
      llmVerdict: "low",
      finalVerdict: "low",
      compositionRulesTriggered: [],
      userApprovalUsed: null,
    },
  });
}

describe("emitSandboxAudit", () => {
  it("creates daily sandbox.jsonl if absent and appends JSONL entry", async () => {
    const entry = makeEntry();
    await emitSandboxAudit(entry);

    const raw = await readFile(sandboxAuditSinkPath(), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.tool.name).toBe("bash_run");
    expect(typeof parsed.timestamp).toBe("string");
  });

  it("appends multiple entries as separate JSONL lines", async () => {
    await emitSandboxAudit(makeEntry("bash_run"));
    await emitSandboxAudit(makeEntry("file_read"));
    await emitSandboxAudit(makeEntry("memory_write"));

    const raw = await readFile(sandboxAuditSinkPath(), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).tool.name).toBe("bash_run");
    expect(JSON.parse(lines[1]).tool.name).toBe("file_read");
    expect(JSON.parse(lines[2]).tool.name).toBe("memory_write");
  });

  it("concurrent emits produce the correct number of lines", async () => {
    const emits = Array.from({ length: 10 }, (_, i) => emitSandboxAudit(makeEntry(`tool_${i}`)));
    await Promise.all(emits);

    const raw = await readFile(sandboxAuditSinkPath(), "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);
    // All 10 must land; order not guaranteed under concurrency
    expect(lines).toHaveLength(10);
    expect(lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } })).toBe(true);
  });

  it("entry with userApprovalUsed is serialized correctly", async () => {
    const entry = buildSandboxAuditEntry({
      tool: { name: "bash_run", args: '{"command":"rm /tmp/x"}', source: "user-keyboard" },
      sandbox: { kind: "none", confidence: "verified", events: [], spawnLatencyMs: 5, overheadPercent: 1.5 },
      reviewer: {
        ruleVerdict: "high",
        llmVerdict: "high",
        finalVerdict: "high",
        compositionRulesTriggered: [{ rule: "R-1", reason: "weak context" }],
        userApprovalUsed: {
          memoryHit: true,
          nlJustification: "테스트용 파일 정리",
          verdictAtApproval: "high",
        },
      },
    });
    await emitSandboxAudit(entry);

    const raw = await readFile(sandboxAuditSinkPath(), "utf8");
    const parsed = JSON.parse(raw.trim());
    expect(parsed.reviewer.userApprovalUsed?.memoryHit).toBe(true);
    expect(parsed.reviewer.userApprovalUsed?.nlJustification).toBe("테스트용 파일 정리");
  });

  it("sandboxAuditSinkPath returns daily-rotated path under LVIS_HOME/audit/", () => {
    const path = sandboxAuditSinkPath();
    expect(path).toContain(TEST_HOME);
    // Must be under the audit/ subdirectory, not at the root
    expect(path.replace(/\\/g, "/")).toContain("/audit/");
    // Must match the daily-rotate pattern: YYYY-MM-DD.sandbox.jsonl
    expect(path).toMatch(/\d{4}-\d{2}-\d{2}\.sandbox\.jsonl$/);
  });
});

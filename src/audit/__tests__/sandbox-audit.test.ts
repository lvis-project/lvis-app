/**
 * PR-A1 — SandboxAuditEntry schema + buildSandboxAuditEntry tests.
 *
 * Issue: #691
 *
 * Tests the audit entry shape and builder function.
 * Actual sink (audit.log append) lands in PR-A4.
 */
import { describe, it, expect } from "vitest";
import { buildSandboxAuditEntry, type SandboxAuditEntry } from "../sandbox-audit.js";

const VALID_TOOL: SandboxAuditEntry["tool"] = {
  name: "bash_run",
  args: '{"command":"ls /tmp"}',
  source: "user-keyboard",
};

const VALID_SANDBOX: SandboxAuditEntry["sandbox"] = {
  kind: "none",
  confidence: "verified",
  events: [],
  spawnLatencyMs: 12,
  overheadPercent: 5.5,
};

const VALID_REVIEWER: SandboxAuditEntry["reviewer"] = {
  ruleVerdict: "low",
  llmVerdict: "low",
  finalVerdict: "low",
  compositionRulesTriggered: [],
  userApprovalUsed: null,
};

describe("buildSandboxAuditEntry", () => {
  it("returns an entry with a valid ISO 8601 timestamp", () => {
    const entry = buildSandboxAuditEntry({
      tool: VALID_TOOL,
      sandbox: VALID_SANDBOX,
      reviewer: VALID_REVIEWER,
    });
    expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it("preserves all tool fields exactly", () => {
    const entry = buildSandboxAuditEntry({
      tool: VALID_TOOL,
      sandbox: VALID_SANDBOX,
      reviewer: VALID_REVIEWER,
    });
    expect(entry.tool).toEqual(VALID_TOOL);
  });

  it("preserves all sandbox fields including events array", () => {
    const sandboxWithEvents: SandboxAuditEntry["sandbox"] = {
      kind: "bubblewrap",
      confidence: "verified",
      events: [
        { type: "egress_attempted", blocked: true, target: "evil.example.com" },
        { type: "fs_write_attempted", blocked: false, path: "/tmp/out.txt" },
      ],
      spawnLatencyMs: 42,
      overheadPercent: 10.2,
    };
    const entry = buildSandboxAuditEntry({
      tool: VALID_TOOL,
      sandbox: sandboxWithEvents,
      reviewer: VALID_REVIEWER,
    });
    expect(entry.sandbox.events).toHaveLength(2);
    expect(entry.sandbox.events[0]).toMatchObject({
      type: "egress_attempted",
      blocked: true,
      target: "evil.example.com",
    });
    expect(entry.sandbox.events[1]).toMatchObject({
      type: "fs_write_attempted",
      blocked: false,
      path: "/tmp/out.txt",
    });
  });

  it("preserves reviewer composition rules triggered", () => {
    const reviewer: SandboxAuditEntry["reviewer"] = {
      ruleVerdict: "medium",
      llmVerdict: "low",
      finalVerdict: "medium",
      compositionRulesTriggered: [
        { rule: "weak-sandbox no-downgrade", reason: "kind=partial" },
      ],
      userApprovalUsed: null,
    };
    const entry = buildSandboxAuditEntry({
      tool: VALID_TOOL,
      sandbox: VALID_SANDBOX,
      reviewer,
    });
    expect(entry.reviewer.compositionRulesTriggered).toHaveLength(1);
    expect(entry.reviewer.compositionRulesTriggered[0].rule).toBe("weak-sandbox no-downgrade");
  });

  it("preserves userApprovalUsed when present", () => {
    const reviewer: SandboxAuditEntry["reviewer"] = {
      ruleVerdict: "medium",
      llmVerdict: "medium",
      finalVerdict: "medium",
      compositionRulesTriggered: [],
      userApprovalUsed: {
        memoryHit: false,
        nlJustification: "사용자가 명시적으로 실행 요청함",
        verdictAtApproval: "medium",
      },
    };
    const entry = buildSandboxAuditEntry({
      tool: VALID_TOOL,
      sandbox: VALID_SANDBOX,
      reviewer,
    });
    expect(entry.reviewer.userApprovalUsed).toEqual({
      memoryHit: false,
      nlJustification: "사용자가 명시적으로 실행 요청함",
      verdictAtApproval: "medium",
    });
  });

  it("accepts all SandboxKind values in the sandbox field", () => {
    const kinds: SandboxAuditEntry["sandbox"]["kind"][] = [
      "none",
      "bubblewrap",
      "sandbox-exec",
      "appcontainer",
      "partial",
      "fs-only",
    ];
    for (const kind of kinds) {
      const entry = buildSandboxAuditEntry({
        tool: VALID_TOOL,
        sandbox: { ...VALID_SANDBOX, kind },
        reviewer: VALID_REVIEWER,
      });
      expect(entry.sandbox.kind).toBe(kind);
    }
  });

  it("each call produces a distinct ISO timestamp (or same if clock frozen)", () => {
    const e1 = buildSandboxAuditEntry({ tool: VALID_TOOL, sandbox: VALID_SANDBOX, reviewer: VALID_REVIEWER });
    const e2 = buildSandboxAuditEntry({ tool: VALID_TOOL, sandbox: VALID_SANDBOX, reviewer: VALID_REVIEWER });
    // Both must be valid ISO strings regardless of ordering
    expect(new Date(e1.timestamp).getTime()).toBeGreaterThan(0);
    expect(new Date(e2.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("entry is serialisable to JSON without loss", () => {
    const entry = buildSandboxAuditEntry({
      tool: VALID_TOOL,
      sandbox: VALID_SANDBOX,
      reviewer: VALID_REVIEWER,
    });
    const serialised = JSON.parse(JSON.stringify(entry)) as SandboxAuditEntry;
    expect(serialised.timestamp).toBe(entry.timestamp);
    expect(serialised.tool).toEqual(VALID_TOOL);
    expect(serialised.sandbox.kind).toBe("none");
  });
});

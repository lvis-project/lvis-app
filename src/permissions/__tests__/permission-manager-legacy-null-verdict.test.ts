/**
 * Regression test for the fail-closed gate against legacy
 * user-approval entries with `verdictAtApproval: null`.
 *
 * Earlier the user-approval entry shape did not have a
 * `verdictAtApproval` field. A naive `?? "medium"` coerce on read would
 * have turned every such legacy entry into a medium-risk memory hit —
 * fail-permissive for inputs whose original verdict was HIGH. The
 * fail-closed gate rejects the memory hit and forces a fresh approval
 * flow when `verdictAtApproval == null`. This file is the regression
 * guard for that gate.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vi.mock must be at top level (hoisted). We feed the mock from a
// per-test setter so each case can shape the lookup result.
let mockLookupResult: unknown = null;
const { emitSandboxAuditMock } = vi.hoisted(() => ({
  emitSandboxAuditMock: vi.fn(async () => {}),
}));

vi.mock("../user-approval-store.js", async () => {
  const actual: typeof import("../user-approval-store.js") = await vi.importActual(
    "../user-approval-store.js",
  );
  return {
    ...actual,
    lookupApproval: vi.fn(async () => mockLookupResult),
  };
});

vi.mock("../../audit/sandbox-audit-sink.js", async () => {
  const actual: typeof import("../../audit/sandbox-audit-sink.js") =
    await vi.importActual("../../audit/sandbox-audit-sink.js");
  return {
    ...actual,
    emitSandboxAudit: emitSandboxAuditMock,
  };
});

import { PermissionManager } from "../permission-manager.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import {
  LlmRiskClassifier,
  RuleBasedRiskClassifier,
  type RiskClassifier,
} from "../reviewer/risk-classifier.js";

function tmpFile(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lvis-pm-legacy-null-"));
  return join(dir, name);
}

function makeManager(): {
  pm: PermissionManager;
  classifier: RiskClassifier;
} {
  const pm = new PermissionManager(tmpFile("permissions.json"));
  const classifier = new RuleBasedRiskClassifier();
  const cache = new VerdictCache(tmpFile("reviewer-cache.jsonl"));
  const queue = new DeferredQueue(tmpFile("deferred-queue.jsonl"));
  pm.setReviewer({ classifier, cache, deferredQueue: queue });
  return { pm, classifier };
}

describe("PermissionManager — fail-closed gate against legacy null-verdict entries", () => {
  let pm: PermissionManager;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ({ pm } = makeManager());
    mockLookupResult = null;
    emitSandboxAuditMock.mockClear();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("rejects a memory hit whose verdictAtApproval is null (legacy entry) — does not call broadcastUserApprovalHit", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastUserApprovalHit(broadcast);

    // Legacy entry — verdictAtApproval is null (the field was absent at
    // the time of recording, so the store returns null for pre-existing
    // entries).
    mockLookupResult = {
      scope: "persistent",
      verdictAtApproval: null,
      nlJustification: null,
      revokedAt: null,
    };

    await pm.dispatchReviewer("fs_write", {
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });

    expect(broadcast).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    // Stable structured marker (2nd arg) — survives i18n / wording changes
    // (cluster review S-Med-1 + C-Med-4).
    const warnCalls = warnSpy.mock.calls;
    const legacyCall = warnCalls.find((args: unknown[]) => {
      const marker = args[1];
      return (
        marker != null &&
        typeof marker === "object" &&
        (marker as { event?: unknown }).event === "legacy-null-verdict"
      );
    });
    expect(legacyCall).toBeDefined();
    const marker = legacyCall![1] as {
      event: string;
      toolName: string;
      scope: string;
    };
    expect(marker.toolName).toBe("fs_write");
    expect(marker.scope).toBe("persistent");
  });

  it("does broadcast when verdictAtApproval is a real value (sanity — gate only rejects null)", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastUserApprovalHit(broadcast);

    mockLookupResult = {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
      revokedAt: null,
    };

    await pm.dispatchReviewer("fs_write", {
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });

    expect(broadcast).toHaveBeenCalledTimes(1);
    const payload = broadcast.mock.calls[0]?.[0];
    expect(payload.toolName).toBe("fs_write");
    expect(payload.scope).toBe("persistent");
    expect(payload.verdictAtApproval).toBe("low");
    const auditEntry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as
      | { reviewer: { llmVerdict: string | null; userApprovalUsed: { memoryHit: boolean } | null } }
      | undefined;
    expect(auditEntry?.reviewer.llmVerdict).toBeNull();
    expect(auditEntry?.reviewer.userApprovalUsed?.memoryHit).toBe(true);
    // Sanity: the warn path is NOT triggered for valid entries.
    const warnedLegacy = warnSpy.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("legacy entry without verdictAtApproval"),
    );
    expect(warnedLegacy).toBe(false);
  });

  it("no broadcast and no legacy warning when there is no memory hit at all", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastUserApprovalHit(broadcast);

    mockLookupResult = null;

    await pm.dispatchReviewer("fs_write", {
      source: "builtin",
      category: "write",
      pathFields: ["path"],
      finalInput: { path: "/Users/ken/work/note.md" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "user-keyboard" as const,
    });

    expect(broadcast).not.toHaveBeenCalled();
    const auditEntry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as
      | { reviewer: { llmVerdict: string | null; userApprovalUsed: unknown } }
      | undefined;
    expect(auditEntry?.reviewer.llmVerdict).toBeNull();
    expect(auditEntry?.reviewer.userApprovalUsed).toBeNull();
    const warnedLegacy = warnSpy.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("legacy entry without verdictAtApproval"),
    );
    expect(warnedLegacy).toBe(false);
  });

  it("audit separates raw rule verdict, raw LLM verdict, and final composed verdict", async () => {
    const pm = new PermissionManager(tmpFile("permissions.json"));
    const classifier = new LlmRiskClassifier(
      {
        complete: vi.fn(async () => ({
          text: '{"level":"low","reason":"llm would allow"}',
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
        })),
      },
      "gpt-4o-mini",
    );
    const cache = new VerdictCache(tmpFile("reviewer-cache.jsonl"));
    const queue = new DeferredQueue(tmpFile("deferred-queue.jsonl"));
    pm.setReviewer({ classifier, cache, deferredQueue: queue });

    await pm.dispatchReviewer("bash", {
      source: "builtin",
      category: "shell",
      pathFields: [],
      finalInput: { command: "rm -rf /tmp/lvis-audit-probe" },
      allowedDirectories: ["/Users/ken/work"],
      sensitivePathsAdjacent: [],
      trustOrigin: "llm-tool-arg" as const,
    });

    const auditEntry = emitSandboxAuditMock.mock.calls.at(-1)?.[0] as
      | {
          reviewer: {
            ruleVerdict: string;
            llmVerdict: string | null;
            finalVerdict: string;
          };
        }
      | undefined;
    expect(auditEntry?.reviewer.ruleVerdict).toBe("high");
    expect(auditEntry?.reviewer.llmVerdict).toBe("low");
    expect(auditEntry?.reviewer.finalVerdict).toBe("high");
  });
});

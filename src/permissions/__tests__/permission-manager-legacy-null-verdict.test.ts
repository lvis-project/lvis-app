/**
 * Regression test for PR #832 fail-closed gate against legacy R-2
 * user-approval entries with `verdictAtApproval: null` (#833).
 *
 * Pre-PR-A4 R3 (PR #786) the user-approval entry shape did not have a
 * `verdictAtApproval` field. A naive `?? "medium"` coerce on read would
 * have turned every such legacy entry into a medium-risk memory hit —
 * fail-permissive for inputs whose original verdict was HIGH. PR #832
 * landed a fail-closed gate that rejects the memory hit and forces a
 * fresh approval flow when `verdictAtApproval == null`.
 *
 * Critic R1 (#833) flagged the absence of a regression guard. This file
 * is the guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// vi.mock must be at top level (hoisted). We feed the mock from a
// per-test setter so each case can shape the lookup result.
let mockLookupResult: unknown = null;

vi.mock("../user-approval-store.js", async () => {
  const actual: typeof import("../user-approval-store.js") = await vi.importActual(
    "../user-approval-store.js",
  );
  return {
    ...actual,
    lookupApproval: vi.fn(async () => mockLookupResult),
  };
});

import { PermissionManager } from "../permission-manager.js";
import { VerdictCache } from "../reviewer/verdict-cache.js";
import { DeferredQueue } from "../reviewer/deferred-queue.js";
import {
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

describe("PermissionManager — fail-closed gate against legacy R-2 entries (#832, #833)", () => {
  let pm: PermissionManager;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    ({ pm } = makeManager());
    mockLookupResult = null;
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("rejects a memory hit whose verdictAtApproval is null (legacy entry) — does not call broadcastUserApprovalHit", async () => {
    const broadcast = vi.fn();
    pm.setBroadcastUserApprovalHit(broadcast);

    // Legacy R-2 entry — verdictAtApproval is null (the PR-A4 R3 field
    // was absent at the time of recording, so the store returns null for
    // pre-existing entries).
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
    const warnArgs = warnSpy.mock.calls[0]?.[0] as string | undefined;
    expect(warnArgs).toContain("legacy R-2 entry without verdictAtApproval");
    expect(warnArgs).toContain("tool=fs_write");
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
    // Sanity: the warn path is NOT triggered for valid entries.
    const warnedLegacy = warnSpy.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("legacy R-2 entry without verdictAtApproval"),
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
    const warnedLegacy = warnSpy.mock.calls.some(
      (args: unknown[]) =>
        typeof args[0] === "string" &&
        args[0].includes("legacy R-2 entry without verdictAtApproval"),
    );
    expect(warnedLegacy).toBe(false);
  });
});

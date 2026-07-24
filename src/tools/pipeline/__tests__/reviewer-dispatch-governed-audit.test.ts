import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PermissionManager } from "../../../permissions/permission-manager.js";
import { DeferredQueue } from "../../../permissions/reviewer/deferred-queue.js";
import { RuleBasedRiskClassifier } from "../../../permissions/reviewer/risk-classifier.js";
import { VerdictCache } from "../../../permissions/reviewer/verdict-cache.js";
import { dispatchReviewerForHeadless } from "../reviewer-dispatch.js";

describe("headless reviewer governed audit projection", () => {
  it("persists only the Host-owned projection in strict mode", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lvis-strict-governed-"));
    try {
      const permissionManager = new PermissionManager(
        join(directory, "permissions.json"),
      );
      const deferredQueue = new DeferredQueue(
        join(directory, "deferred-queue.jsonl"),
      );
      permissionManager.setMode("strict");
      permissionManager.setReviewer({
        classifier: new RuleBasedRiskClassifier(),
        cache: new VerdictCache(join(directory, "reviewer-cache.jsonl")),
        deferredQueue,
      });

      await dispatchReviewerForHeadless(
        permissionManager,
        "domain_read",
        "plugin",
        "read",
        [],
        {
          operation: "status",
          opaqueSecret: "must-never-reach-deferred-storage",
        },
        {
          operation: "status",
          opaqueSecret: "must-never-reach-deferred-storage",
        },
        [],
        [],
        { trustOrigin: "plugin-emitted" },
        {
          pathFields: [],
          targetFilePaths: [],
          sensitivePathsAdjacent: [],
        },
        {},
        undefined,
        { groupId: "group", toolUseId: "tool-use", displayOrder: 0 },
        undefined,
        undefined,
        undefined,
        { operation: "status" },
      );

      const [pending] = deferredQueue.listPending();
      expect(pending?.inputSummary).toBe('{"operation":"status"}');
      expect(pending?.inputSummary).not.toContain(
        "must-never-reach-deferred-storage",
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

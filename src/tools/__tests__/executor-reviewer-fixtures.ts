// #885 (b4) — shared reviewer-wired fixture. Extracted so the identical
// `makePermissionManager` wiring lives in ONE place (check:test-duplicates
// forbids byte-identical helper bodies across test files). Consumed by
// executor-reviewer-explicit-retry.test.ts and executor-mcp-plugin-parity.test.ts.
import { join } from "node:path";
import { vi } from "vitest";

import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { PermissionManager } from "../../permissions/permission-manager.js";

/**
 * A `PermissionManager` in `default` mode with low-tier interactive auto-approve
 * and a reviewer wired to the given `classify` spy (real VerdictCache +
 * DeferredQueue backed by files under `dir`).
 */
export function makePermissionManager(
  dir: string,
  classifySpy: ReturnType<typeof vi.fn>,
): PermissionManager {
  const permMgr = new PermissionManager(join(dir, "permissions.json"));
  permMgr.setMode("default");
  permMgr.setInteractiveAutoApprove("low");
  permMgr.setReviewer({
    classifier: { classify: classifySpy },
    cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
    deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
  });
  return permMgr;
}

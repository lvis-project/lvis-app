// The one reviewer-wired `PermissionManager` the executor suites build. Every
// copy of this wiring named the same three files under `dir` and differed only
// in the execution mode and the verdict the classifier returns, so both are
// parameters and the rest is not.
import { join } from "node:path";
import { vi } from "vitest";

import type { ExecutionMode } from "../../shared/permission-mode.js";
import { DeferredQueue } from "../../permissions/reviewer/deferred-queue.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import { PermissionManager } from "../../permissions/permission-manager.js";

/**
 * A `PermissionManager` with low-tier interactive auto-approve and a reviewer
 * wired to the given `classify` spy (real VerdictCache + DeferredQueue backed
 * by files under `dir`).
 *
 * `mode` is `default` for the suites that drive an approval prompt, and `auto`
 * for the foreground-rationale suites, where the reviewer — not the prompt —
 * is the thing under test.
 */
export function makePermissionManager(
  dir: string,
  classifySpy: ReturnType<typeof vi.fn>,
  mode: ExecutionMode = "default",
): PermissionManager {
  const permMgr = new PermissionManager(join(dir, "permissions.json"));
  permMgr.setMode(mode);
  permMgr.setInteractiveAutoApprove("low");
  permMgr.setReviewer({
    classifier: { classify: classifySpy },
    cache: new VerdictCache(join(dir, "reviewer-cache.jsonl")),
    deferredQueue: new DeferredQueue(join(dir, "deferred-queue.jsonl")),
  });
  return permMgr;
}

/**
 * A `PermissionManager` whose `checkDetailed` answers with `result` whatever
 * it is asked.
 *
 * The suites that use it are asserting on what the executor does WITH a
 * verdict, so the manager's own evaluation is not the subject; the settings
 * path is deliberately one that does not exist, because a real one would make
 * the fixed answer a lie about persisted rules.
 */
export function permissionManagerReturning(
  result: ReturnType<PermissionManager["checkDetailed"]>,
): PermissionManager {
  const permMgr = new PermissionManager("/tmp/nonexistent-permissions.json");
  permMgr.checkDetailed = () => result;
  return permMgr;
}

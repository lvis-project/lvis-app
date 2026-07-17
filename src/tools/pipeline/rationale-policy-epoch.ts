import { createHash } from "node:crypto";
import { canonicalStringify } from "../../shared/canonical-json.js";
import type { HookRunner } from "../../hooks/hook-runner.js";
import type { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import type { PermissionManager } from "../../permissions/permission-manager.js";
import { getCategoryRegistryGeneration } from "../../permissions/category-registry.js";
import { getUserApprovalGeneration } from "../../permissions/user-approval-store.js";

export interface RationalePolicyEpochSources {
  permissionManager?: PermissionManager;
  hookRunner: HookRunner;
  scriptHookManager?: ScriptHookManager;
  additionalDirectories: readonly string[];
}

/**
 * Capture every mutable host policy surface consulted by the tool permission
 * suffix. Directory values are already canonicalized by the executor; sorting
 * makes the epoch independent of settings serialization order.
 */
export function captureRationalePolicyEpoch(
  sources: RationalePolicyEpochSources,
): string {
  const snapshot = {
    permission: sources.permissionManager?.getPolicyEpoch() ?? "unmanaged",
    hooks: sources.hookRunner.getGeneration(),
    scriptHooks: sources.scriptHookManager?.getGeneration() ?? "unwired",
    approvals: getUserApprovalGeneration(),
    categories: getCategoryRegistryGeneration(),
    additionalDirectories: [...new Set(sources.additionalDirectories)].sort(),
  };
  return createHash("sha256")
    .update(canonicalStringify(snapshot))
    .digest("hex");
}
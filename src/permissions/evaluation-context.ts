import type { ToolCategory, ToolSource, ToolTrustOrigin } from "../tools/types.js";
import { PERMISSION_REVIEWER_FRAMEWORK_VERSION } from "../shared/permission-reviewer-framework.js";

export const PERMISSION_EVALUATION_CONTEXT_VERSION = "permission-evaluation-context/v1";

export interface PermissionEvaluationContext {
  version: typeof PERMISSION_EVALUATION_CONTEXT_VERSION;
  reviewerFrameworkVersion: typeof PERMISSION_REVIEWER_FRAMEWORK_VERSION;
  policyMode: string;
  headless: boolean;
  source: ToolSource;
  category: ToolCategory;
  trustOrigin: ToolTrustOrigin;
  /**
   * Raw-by-design display payload. Approval args are DLP-redacted elsewhere;
   * this context intentionally preserves policy paths so the user can verify
   * the sandbox/scope that the permission decision actually used.
   */
  executionCwd: string;
  allowedDirectories: readonly string[];
  pathFields: readonly string[];
  targetFilePaths: readonly string[];
  sensitivePathsAdjacent: readonly string[];
}

export function buildPermissionEvaluationContext(input: {
  policyMode: string;
  headless: boolean;
  source: ToolSource;
  category: ToolCategory;
  trustOrigin: ToolTrustOrigin;
  executionCwd: string;
  allowedDirectories: readonly string[];
  pathFields: readonly string[];
  targetFilePaths: readonly string[];
  sensitivePathsAdjacent: readonly string[];
}): PermissionEvaluationContext {
  return {
    version: PERMISSION_EVALUATION_CONTEXT_VERSION,
    reviewerFrameworkVersion: PERMISSION_REVIEWER_FRAMEWORK_VERSION,
    policyMode: input.policyMode,
    headless: input.headless,
    source: input.source,
    category: input.category,
    trustOrigin: input.trustOrigin,
    executionCwd: input.executionCwd,
    allowedDirectories: [...input.allowedDirectories],
    pathFields: [...input.pathFields],
    targetFilePaths: [...input.targetFilePaths],
    sensitivePathsAdjacent: [...input.sensitivePathsAdjacent],
  };
}

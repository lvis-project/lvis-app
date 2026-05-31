import type { PolicyFile } from "../policy-store.js";
import type { ToolInvocationContext } from "../reviewer/risk-classifier.js";
import { detectSandboxCapability } from "../sandbox-capability.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../sensitive-paths.js";

const DEFAULT_ALLOWED_DIRECTORIES = ["/Users/ken/work", "/Users/ken/.lvis"].map((dir) =>
  caseFoldForMatch(canonicalizePathForMatch(dir)),
);

export function makeTestPolicy(overrides: Partial<PolicyFile> = {}): PolicyFile {
  return {
    version: 1,
    requireExplicitApproval: true,
    managed: false,
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function makeRiskClassifierContext(
  overrides: Partial<ToolInvocationContext>,
): ToolInvocationContext {
  return {
    toolName: "test_tool",
    source: "builtin",
    category: "write",
    pathFields: ["path"],
    trustOrigin: "user-keyboard",
    finalInput: {},
    allowedDirectories: DEFAULT_ALLOWED_DIRECTORIES,
    sensitivePathsAdjacent: [],
    sandboxCapability: detectSandboxCapability(),
    ...overrides,
  };
}

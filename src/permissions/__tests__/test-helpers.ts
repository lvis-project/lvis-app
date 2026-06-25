import type { PolicyFile } from "../policy-store.js";
import type { ToolInvocationContext } from "../reviewer/risk-classifier.js";
import {
  checkAsrtDependencies,
  isAsrtSandboxSupported,
} from "../asrt-sandbox.js";
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

/**
 * Whether the real ASRT sandbox can actually initialize on this host —
 * supported platform AND no dependency errors (Linux: bwrap + socat + ripgrep).
 * Shared by the asrt-sandbox + worker-spawn UDS live tests so each can
 * early-return as a skip on a host that lacks the binaries.
 */
export async function asrtCanInitialize(): Promise<boolean> {
  if (!(await isAsrtSandboxSupported())) return false;
  const deps = await checkAsrtDependencies();
  return deps.errors.length === 0;
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

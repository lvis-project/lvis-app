import type { PolicyFile } from "../policy-store.js";
import type { ToolInvocationContext } from "../reviewer/risk-classifier.js";
import {
  checkAsrtDependencies,
  isAsrtSandboxSupported,
  DEFAULT_WINDOWS_PROXY_PORT_RANGE,
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
 * Windows: `checkAsrtDependencies` only proves the srt-win binary + a provisioned
 * `srt-sandbox` user exist — it does NOT prove the box can actually SPAWN a
 * process as that user. `CreateProcessWithLogonW` is denied on managed Windows
 * where a GPO or EDR blocks secondary-logon-as-another-user, so the account + WFP
 * can be fully provisioned yet every wrapped spawn fails access-denied. Probe the
 * real egress fence once (the same call `SandboxManager.initialize` makes); a
 * throw means the sandbox cannot initialize on THIS machine. Memoized — the
 * capability is machine-level and never changes within a run.
 */
let _winSpawnProbe: Promise<boolean> | undefined;
async function windowsSandboxCanSpawn(): Promise<boolean> {
  if (_winSpawnProbe === undefined) {
    _winSpawnProbe = (async () => {
      try {
        const { verifyWindowsWfpEgress } = await import("@anthropic-ai/sandbox-runtime");
        await verifyWindowsWfpEgress({ proxyPortRange: DEFAULT_WINDOWS_PROXY_PORT_RANGE });
        return true;
      } catch {
        return false;
      }
    })();
  }
  return _winSpawnProbe;
}

/**
 * Whether the real ASRT sandbox can actually initialize on this host —
 * supported platform AND no dependency errors (Linux: bwrap + socat + ripgrep),
 * AND (Windows only) the srt-sandbox spawn actually works. Shared by the
 * asrt-sandbox + worker-spawn UDS live tests so each can early-return as a skip
 * on a host that lacks the binaries or is policy-blocked from the sandbox logon.
 * The real boot degrades gracefully to unsandboxed on such a box, and CI covers
 * these live-init paths on Linux/mac + the Windows-logic suite covers win32 logic.
 */
export async function asrtCanInitialize(): Promise<boolean> {
  if (!(await isAsrtSandboxSupported())) return false;
  const deps = await checkAsrtDependencies();
  if (deps.errors.length > 0) return false;
  if (process.platform === "win32" && !(await windowsSandboxCanSpawn())) return false;
  return true;
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

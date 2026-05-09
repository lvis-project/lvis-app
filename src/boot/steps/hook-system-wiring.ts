/**
 * Q12 Phase 4 — Layer 6 hook system boot wiring.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 *
 * Boot pipeline:
 *   1. {@link runHookTrustWorkflow} — ensure dir exists, diff against
 *      the lockfile, and strict-deny untrusted hooks.
 *   2. {@link ScriptHookManager.setTrustedHooks} — feed the resolved
 *      trusted hooks into the runtime manager.
 *   3. Return the manager so the executor / approval-gate can call
 *      `runPreToolUse` / `runPostToolUse` / `runPermissionRequest`.
 *
 * Atomic cutover (CLAUDE.md No-Fallback): no single-file hooks.json path.
 * Phase 4 uses only per-script files so every executable hook goes through
 * the lockfile + `.disabled/` quarantine path.
 */
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import {
  runHookTrustWorkflow,
  type RunHookTrustResult,
  type TrustPromptDispatcher,
} from "../../hooks/hook-trust-prompt.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("hook-system-wiring");

export interface WireHookSystemDeps {
  /** Override hook directory (test). */
  hooksDir?: string;
  /** Override lockfile path (test). */
  lockfilePath?: string;
  /** Override disabled subfolder (test). */
  disabledDir?: string;
  /**
   * Test-only trust dispatcher. Production boot deliberately omits this
   * and strict-denies new or changed hooks.
   */
  promptDispatcher?: TrustPromptDispatcher;
}

export interface HookSystemBootResult {
  /** Live runtime manager. Pass to executor + approval-gate. */
  manager: ScriptHookManager;
  /** TOFU workflow result — for audit + diagnostics. */
  trust: RunHookTrustResult;
}

/**
 * Wire the Layer 6 hook system at boot.
 *
 * Production boot has a single path: no renderer prompt, strict-deny
 * every new or changed script. Tests may inject `promptDispatcher` to
 * exercise the lockfile/trust workflow deterministically.
 */
export async function wireHookSystem(
  deps: WireHookSystemDeps = {},
): Promise<HookSystemBootResult> {
  const trust = await runHookTrustWorkflow({
    hooksDir: deps.hooksDir,
    lockfilePath: deps.lockfilePath,
    disabledDir: deps.disabledDir,
    promptDispatcher: deps.promptDispatcher,
  });
  const manager = new ScriptHookManager();
  manager.setTrustedHooks(trust.trustedHooks);
  log.info(
    "boot: hook system ready (trusted=%d, disabled=%d)",
    trust.trustedHooks.length,
    trust.disabledHooks.length,
  );
  return { manager, trust };
}

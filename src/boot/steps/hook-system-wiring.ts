/**
 * Permission policy Phase 4 — Layer 6 hook system boot wiring.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6.
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
import type { AuditLogger } from "../../audit/audit-logger.js";
import { randomUUID } from "node:crypto";

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
  /** Permission policy #633 — structured boot-time quarantine audit surface. */
  auditLogger?: Pick<AuditLogger, "log" | "isPermissionAuditChainReady" | "appendPermissionAuditEntry">;
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
  await emitHookQuarantineAudit(trust, deps.auditLogger);
  return { manager, trust };
}

async function emitHookQuarantineAudit(
  trust: RunHookTrustResult,
  auditLogger?: Pick<AuditLogger, "log" | "isPermissionAuditChainReady" | "appendPermissionAuditEntry">,
): Promise<void> {
  if (!auditLogger || trust.disabledHooks.length === 0) return;
  const disabled = new Set(trust.disabledHooks.map((hook) => hook.fileName));
  for (const entry of trust.diff) {
    if (entry.state !== "new" && entry.state !== "changed") continue;
    if (!disabled.has(entry.hook.fileName)) continue;
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "boot",
      type: "warn",
      input: JSON.stringify({
        kind: "hook.quarantined",
        fileName: entry.hook.fileName,
        hookType: entry.hook.hookType,
        sha256: entry.hook.sha256,
        state: entry.state,
        previousSha256: entry.previousSha256,
      }),
      output: "Hook quarantined during boot trust workflow",
      toolCalls: [{ name: "hook_trust_boot", isError: false, trust: "high" }],
    });
    if (auditLogger.isPermissionAuditChainReady()) {
      await auditLogger.appendPermissionAuditEntry({
        decision: "deny",
        auditId: randomUUID(),
        ts: new Date().toISOString(),
        trustOrigin: "unknown",
        tool: "hook_trust_boot",
        source: "builtin",
        category: "meta",
        denyReasons: [{
          layer: 6,
          reason: `hook.quarantined:${entry.hook.fileName}:${entry.state}`,
          source: "hook-trust-workflow",
        }],
      });
    }
  }
}

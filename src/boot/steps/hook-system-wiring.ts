/**
 * Permission policy Layer 6 hook system boot wiring.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6.
 *
 * Boot pipeline:
 *   1. {@link runHookTrustWorkflow} — ensure dir exists, diff `.sh` files AND
 *      the `hooks.json` trust unit against the lockfile, and strict-deny
 *      (quarantine to `.disabled/`) anything new or changed.
 *   2. {@link ScriptHookManager.setTrustedRegistry} — feed the resolved trusted
 *      `.sh` hooks + trusted `hooks.json` command entries into the runtime
 *      manager as one unified registry.
 *   3. Return the manager so the executor / approval-gate can call
 *      `runPreToolUse` / `runPostToolUse` / `runPermissionRequest`.
 *
 * #811 — `hooks.json` IS loaded, but ONLY through the same TOFU quarantine gate
 * as `.sh` files: a new/changed `hooks.json` is quarantined and its declarative
 * `command` entries NEVER execute until the user runs
 * `/permission hooks accept hooks.json`. A trusted, unchanged `hooks.json`
 * contributes its `command` entries to the registry. There is no path by which
 * an un-trusted config spawns a command — `runHookTrustWorkflow` only returns
 * `trustedConfigEntries` when the synthetic config trust unit is in the trusted
 * set.
 */
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import {
  runHookTrustWorkflow,
  type RunHookTrustResult,
  type TrustPromptDispatcher,
} from "../../hooks/hook-trust-prompt.js";
import { HOOKS_CONFIG_FILENAME } from "../../hooks/hook-config-trust.js";
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
  /** Structured boot-time quarantine audit surface. */
  auditLogger?: Pick<AuditLogger, "log" | "isPermissionAuditChainReady" | "appendPermissionAuditEntry">;
}

export interface HookSystemBootResult {
  /** Live runtime manager. Pass to executor + approval-gate. */
  manager: ScriptHookManager;
  /** Trust workflow result — for audit + diagnostics. */
  trust: RunHookTrustResult;
}

/**
 * Wire the Layer 6 hook system at boot.
 *
 * Production boot has a single path: no renderer prompt, strict-deny
 * every new or changed `.sh` file AND `hooks.json`. Tests may inject
 * `promptDispatcher` to exercise the lockfile/trust workflow deterministically.
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
  // Feed the UNIFIED registry: trusted `.sh` hooks (filter the synthetic
  // `hooks.json` trust unit out — it is not a runnable `.sh`) + trusted
  // `hooks.json` command entries. `trust.trustedConfigEntries` is non-empty
  // ONLY when the config trust unit passed the quarantine gate, so an untrusted
  // config can never contribute a runnable command here.
  const shHooks = trust.trustedHooks.filter((h) => h.fileName !== HOOKS_CONFIG_FILENAME);
  manager.setTrustedRegistry(shHooks, trust.trustedConfigEntries);
  log.info(
    "boot: hook system ready (sh=%d, config-entries=%d, disabled=%d)",
    shHooks.length,
    trust.trustedConfigEntries.length,
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

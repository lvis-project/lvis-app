/**
 * Q12 Phase 4 — Layer 6 hook system boot wiring.
 *
 * Spec ref: docs/architecture/q12-permission-policy-design.md §3 Layer 6.
 *
 * Boot pipeline:
 *   1. {@link runHookTrustWorkflow} — ensure dir exists, diff against
 *      lockfile, surface TOFU prompt to the renderer (when available).
 *   2. {@link ScriptHookManager.setTrustedHooks} — feed the resolved
 *      trusted hooks into the runtime manager.
 *   3. Return the manager so the executor / approval-gate can call
 *      `runPreToolUse` / `runPostToolUse` / `runPermissionRequest`.
 *
 * Atomic cutover (CLAUDE.md No-Fallback): no fallback to single-file
 * hooks.json. Phase 2.5 already relocated to `~/.config/lvis/hooks/`;
 * Phase 4 simply replaces the single-file shape with per-script files.
 */
import type { BrowserWindow } from "electron";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import {
  runHookTrustWorkflow,
  type RunHookTrustResult,
  type TrustPromptDispatcher,
} from "../../hooks/hook-trust-prompt.js";
import type { HookDiff } from "../../hooks/hook-discovery.js";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("hook-system-wiring");

/** IPC channel — main → renderer with the diff. */
export const IPC_HOOKS_TRUST_PROMPT = "lvis:hooks:trust-prompt";
/** IPC channel — renderer → main accept (per-file decision). */
export const IPC_HOOKS_ACCEPT = "lvis:hooks:accept";
/**
 * IPC channel — renderer → main reject everything in the current
 * pending request. Matches the actual handler + preload registration
 * (`src/ipc/domains/hooks.ts`, `src/preload.ts`). Previously named
 * `IPC_HOOKS_DISABLE` with a mismatched value of `lvis:hooks:disable`,
 * which never reached any handler.
 */
export const IPC_HOOKS_REJECT_ALL = "lvis:hooks:reject-all";

export interface WireHookSystemDeps {
  /** Optional renderer for the TOFU prompt. Headless boot omits. */
  mainWindow?: BrowserWindow | null;
  /** Override hook directory (test). */
  hooksDir?: string;
  /** Override lockfile path (test). */
  lockfilePath?: string;
  /** Override disabled subfolder (test). */
  disabledDir?: string;
  /**
   * Override trust-prompt dispatcher entirely. When supplied, the
   * mainWindow IPC channel is *not* used (test path).
   */
  promptDispatcher?: TrustPromptDispatcher;
  /**
   * Optional listener wiring. When present, the renderer responds via
   * the listener's resolve channel rather than the default Electron
   * IPC bridge. Wired in `src/ipc/domains/hooks.ts`.
   */
  awaitRendererDecisions?: (diff: HookDiff[]) => Promise<
    Array<{ fileName: string; trust: boolean }>
  >;
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
 * Order of preference for the trust prompt:
 *   1. `deps.promptDispatcher` (test override)
 *   2. `deps.awaitRendererDecisions` (production — IPC bridge)
 *   3. none → strict-deny (headless boot, e.g. CI smoke tests)
 */
export async function wireHookSystem(
  deps: WireHookSystemDeps = {},
): Promise<HookSystemBootResult> {
  const dispatcher: TrustPromptDispatcher | undefined =
    deps.promptDispatcher ?? buildIpcDispatcher(deps);
  const trust = await runHookTrustWorkflow({
    hooksDir: deps.hooksDir,
    lockfilePath: deps.lockfilePath,
    disabledDir: deps.disabledDir,
    promptDispatcher: dispatcher,
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

function buildIpcDispatcher(
  deps: WireHookSystemDeps,
): TrustPromptDispatcher | undefined {
  if (!deps.awaitRendererDecisions) return undefined;
  return {
    prompt: async (diff) => {
      try {
        const decisions = await deps.awaitRendererDecisions!(diff);
        return decisions;
      } catch (err) {
        log.warn(
          "hook trust IPC dispatcher error: %s (strict-deny applied)",
          (err as Error).message,
        );
        return diff.map((d) => ({ fileName: d.hook.fileName, trust: false }));
      }
    },
  };
}

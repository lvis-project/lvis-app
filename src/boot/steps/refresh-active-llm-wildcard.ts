/**
 * Active LLM vendor → plugin runtime wildcard config-override bridge.
 *
 * Extracted from `boot.ts` (#893 / PR #894) as a standalone factory so the
 * debounce + vendor-change-restart contract can be unit-tested without a
 * full Electron bootstrap.
 *
 * Contract (mirrors the inline `refreshActiveLlmWildcard` closure in boot.ts):
 *   - The wildcard slot carries ONLY non-secret metadata (`hostApiVendor`).
 *     Stale `hostApiKey` slots from older builds are cleared on every call
 *     so a soft-reload after upgrade does not leave a ghost value.
 *   - On the FIRST invocation we seed `lastWildcardVendor` without restarting
 *     plugins — the boot loop drives the first call, not a real vendor swap.
 *   - On subsequent calls, when the active vendor actually changes, restart
 *     every loaded plugin so the next `hostApi.config.get("hostApiVendor")`
 *     and `hostApi.getSecret(...)` calls observe the new value. Debounce
 *     (200ms by default) coalesces bursts from rapid IPC settings churn
 *     (vendor + key + baseUrl patched in one IPC, see `settings.ts`).
 *   - Calls with the same vendor as last seen are no-ops (after the debounced
 *     restart has fired, if any).
 *   - Calls with no/empty vendor are no-ops (the wildcard stays untouched).
 */

import { createLogger } from "../../lib/logger.js";

const log = createLogger("lvis");

export interface RefreshActiveLlmWildcardDeps {
  /** Provider id of the currently-active LLM, e.g. "openai". Empty/undefined → no-op. */
  getActiveVendor: () => string | undefined;
  /** Wildcard-slot writer on `PluginRuntime`. */
  setWildcardConfigOverride: (config: Record<string, unknown>) => void;
  /** Wildcard-slot key cleaner on `PluginRuntime`. */
  clearWildcardConfigOverride: (keys: string[]) => void;
  /** Returns the ids of all currently-loaded plugins. */
  listPluginIds: () => string[];
  /** Restart a plugin so its HostApi observes the new vendor. */
  restartPlugin: (pluginId: string) => Promise<void>;
  /** Debounce window for the post-vendor-change restart sweep (ms). Default 200. */
  debounceMs?: number;
  /** Test seam — defaults to global setTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Test seam — defaults to global clearTimeout. */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface RefreshActiveLlmWildcardHandle {
  /** Idempotent refresh. Safe to call on boot and on every llm-settings IPC change. */
  refresh: () => void;
  /** Drop any pending debounce timer (e.g. on shutdown). */
  dispose: () => void;
}

/**
 * Build a `refresh()` closure with the same semantics as the inline boot
 * helper. Returns a handle so callers can dispose any pending debounce
 * timer (e.g. during host shutdown).
 */
export function createRefreshActiveLlmWildcard(
  deps: RefreshActiveLlmWildcardDeps,
): RefreshActiveLlmWildcardHandle {
  const debounceMs = deps.debounceMs ?? 200;
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;

  let lastWildcardVendor: string | null = null;
  // Browser vs Node return shapes for `setTimeout` differ; using `unknown`
  // for the cross-platform handle keeps the dependency-injected
  // `setTimeoutFn` / `clearTimeoutFn` seam usable from both environments.
  let restartTimer: unknown = null;

  const refresh = (): void => {
    const raw = deps.getActiveVendor();
    const activeVendor = typeof raw === "string" ? raw.trim() : "";
    if (activeVendor.length === 0) {
      // No vendor configured — keep the wildcard slot untouched so a
      // partially-initialized settings store cannot blow away the
      // existing `hostApiVendor` value.
      return;
    }

    // Defensive cleanup — older builds (pre-#894 review B2) populated
    // `hostApiKey` here. A soft reload after upgrade would otherwise
    // leave a ghost value visible to plugins via `config.get(...)`.
    deps.clearWildcardConfigOverride(["hostApiKey"]);
    deps.setWildcardConfigOverride({ hostApiVendor: activeVendor });

    if (lastWildcardVendor !== null && lastWildcardVendor !== activeVendor) {
      if (restartTimer !== null) {
        clearT(restartTimer as ReturnType<typeof setTimeout>);
      }
      restartTimer = setT(() => {
        restartTimer = null;
        const ids = deps.listPluginIds();
        for (const pid of ids) {
          deps.restartPlugin(pid).catch((err: unknown) => {
            log.warn(`restartPlugin(${pid}) after vendor change failed: ${(err as Error).message}`);
          });
        }
      }, debounceMs);
    }
    lastWildcardVendor = activeVendor;
  };

  const dispose = (): void => {
    if (restartTimer !== null) {
      clearT(restartTimer as ReturnType<typeof setTimeout>);
      restartTimer = null;
    }
  };

  return { refresh, dispose };
}

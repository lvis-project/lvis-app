/**
 * Active LLM vendor → plugin runtime wildcard config-override bridge.
 *
 * Extracted from `boot.ts` (#893 / PR #894) as a standalone factory so the
 * debounce + vendor-change-restart contract can be unit-tested without a
 * full Electron bootstrap.
 *
 * Contract (mirrors the inline `refreshActiveLlmWildcard` closure in boot.ts):
 *   - The wildcard slot carries ONLY non-secret API-provider metadata
 *     (`hostApiVendor`). It is deliberately absent while a subscription
 *     runtime owns generation: the persisted API provider is then inactive
 *     and must not be mistaken for the current runtime.
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
 *   - Calls with no/empty vendor remove `hostApiVendor`. This is the
 *     subscription-runtime state, not an initialization failure.
 */

import { createLogger } from "../../lib/logger.js";
import type { LLMSettings } from "../../data/settings-store.js";

const log = createLogger("lvis");

export interface RefreshActiveLlmWildcardDeps {
  /** Active API provider id, e.g. "openai". Undefined when a subscription runtime is active. */
  getActiveVendor: () => string | undefined;
  /** Wildcard-slot writer on `PluginRuntime`. */
  setWildcardConfigOverride: (config: Record<string, unknown>) => void;
  /** Wildcard-slot key cleaner on `PluginRuntime`. */
  clearWildcardConfigOverride: (keys: string[]) => void;
  /** Returns the ids of all currently-loaded plugins. */
  listPluginIds: () => string[];
  /** Restart a plugin so its HostApi observes the new vendor. */
  restartPlugin: (pluginId: string) => Promise<void>;
  /**
   * Cancel restart operations that already passed the debounce boundary.
   * The plugin runtime's cancellation token prevents an in-flight replacement
   * from publishing or starting after host shutdown begins.
   */
  cancelPendingRestarts: () => void;
  /** Debounce window for the post-vendor-change restart sweep (ms). Default 200. */
  debounceMs?: number;

  /** Test seam — defaults to global setTimeout. */
  setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  /** Test seam — defaults to global clearTimeout. */
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

/**
 * Return the only API-vendor identity that may be exposed through plugin
 * `hostApiVendor` metadata. Subscription runtimes own generation separately,
 * so their retained API-provider settings are intentionally not projected.
 */
export function activeHostApiVendor(
  llm: Pick<LLMSettings, "activeChatRuntime" | "provider">,
): string | undefined {
  if (llm.activeChatRuntime?.kind === "subscription") return undefined;
  const vendor = typeof llm.provider === "string" ? llm.provider.trim() : "";
  return vendor || undefined;
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

  let hasRefreshed = false;
  let lastWildcardVendor: string | undefined;
  let disposed = false;
  // Browser vs Node return shapes for `setTimeout` differ; using `unknown`
  // for the cross-platform handle keeps the dependency-injected
  // `setTimeoutFn` / `clearTimeoutFn` seam usable from both environments.
  let restartTimer: unknown = null;

  const refresh = (): void => {
    if (disposed) return;
    const raw = deps.getActiveVendor();
    const activeVendor = typeof raw === "string" ? raw.trim() || undefined : undefined;

    // Defensive cleanup — older builds (pre-#894 review B2) populated
    // `hostApiKey` here. A soft reload after upgrade would otherwise
    // leave a ghost value visible to plugins via `config.get(...)`.
    deps.clearWildcardConfigOverride(["hostApiKey", "hostApiVendor"]);
    if (activeVendor) {
      deps.setWildcardConfigOverride({ hostApiVendor: activeVendor });
    }

    if (hasRefreshed && lastWildcardVendor !== activeVendor) {
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
    hasRefreshed = true;
  };

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    if (restartTimer !== null) {
      clearT(restartTimer as ReturnType<typeof setTimeout>);
      restartTimer = null;
    }
    // Clearing the timer alone is insufficient once its callback has started:
    // PluginRuntime may already be preparing a replacement generation. Cancel
    // its in-flight restart tokens before plugin shutdown runs so no candidate
    // can publish or start after teardown has begun.
    try {
      deps.cancelPendingRestarts();
    } catch (err) {
      // Shutdown remains best-effort; a failure to signal cancellation must
      // not prevent the rest of the host cleanup pipeline from running.
      log.warn(`cancelPendingRestarts during active LLM wildcard disposal failed: ${(err as Error).message}`);
    }
  };

  return { refresh, dispose };
}

/**
 * Lifecycle helpers — host-enforced plugin `start()` timeout and the
 * per-session on-demand activation tracker.
 *
 * Both are lifecycle-adjacent runtime concerns kept out of the PluginRuntime
 * orchestrator: the timeout is a pure policy helper shared by every start
 * site, and the session-activation tracker is self-contained in-memory state
 * with no dependency on the plugin load/registry machinery.
 */

import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

/**
 * Bound plugin factory execution without abandoning a late-created instance.
 * The caller revokes the pending HostApi incarnation when this rejects;
 * `onLateResolution` receives a result that appears after the timeout so it
 * can be stopped without ever becoming runtime-visible.
 */
export async function runPluginFactoryWithTimeout<T>(
  factory: () => Promise<T> | T,
  onLateResolution: (value: T) => Promise<void> | void,
  timeoutMs: number = TOOL_TIMEOUT_POLICY.pluginFactoryMs,
): Promise<T> {
  const operation = Promise.resolve().then(factory);
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`plugin factory timeout (>${timeoutMs}ms)`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) {
      void operation.then(
        (value) => Promise.resolve(onLateResolution(value)).catch(() => undefined),
        () => undefined,
      );
    }
  }
}

/**
 * Run a plugin's `start()` lifecycle hook under a host-enforced timeout. The
 * manifest's declared `startupTimeoutMs` is honored when present and clamped
 * to `pluginStartupMaxMs`; an undeclared value falls back to
 * `pluginStartupDefaultMs`. The call sites share this helper — when they
 * diverge, fix it here, not in multiple places.
 */
export async function runStartWithTimeout(
  start: () => unknown,
  declaredTimeoutMs: number | undefined,
): Promise<void> {
  const hardTimeoutMs = Math.min(
    declaredTimeoutMs ?? TOOL_TIMEOUT_POLICY.pluginStartupDefaultMs,
    TOOL_TIMEOUT_POLICY.pluginStartupMaxMs,
  );
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`startup timeout (>${hardTimeoutMs}ms)`));
    }, hardTimeoutMs);
  });
  try {
    await Promise.race([Promise.resolve(start()), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Transient, per-session on-demand activation map.
 *
 * Key   = sessionId  (a ConversationLoop instance's session UUID).
 * Value = Set of plugin IDs on-demand activated in that session via
 *         `request_plugin` while the plugin was registry-disabled.
 *
 * Using a Map instead of a flat Set scopes each session's activation state
 * independently: clearing session A never affects session B. This is
 * critical for concurrent loops (e.g. a routine running while the user has an
 * active main-chat conversation — the user starting a new chat must not wipe
 * the routine's activation mid-scan).
 *
 * INVARIANT: plugin enablement is NEVER mutated on this path — the plugin
 * remains registry-disabled throughout.
 */
export class SessionActivationTracker {
  private readonly bySession = new Map<string, Set<string>>();

  /**
   * Returns true iff the plugin was on-demand session-activated in the given
   * session.
   */
  isActivated(sessionId: string, pluginId: string): boolean {
    return this.bySession.get(sessionId)?.has(pluginId) ?? false;
  }

  /** Record a plugin as session-activated for the given session. */
  activate(sessionId: string, pluginId: string): void {
    let set = this.bySession.get(sessionId);
    if (!set) {
      set = new Set<string>();
      this.bySession.set(sessionId, set);
    }
    set.add(pluginId);
  }

  /**
   * Clear on-demand activations for `sessionId` ONLY — does NOT affect any
   * other session's activation state.
   */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }
}

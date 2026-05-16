/**
 * Plugin tool invocation origin-chain tracker — issue #664 P2.
 *
 * Wrapper plugins commonly look like:
 *
 *   user clicks panel button
 *     → bridge.callTool("agent_hub_msgraph_signin")        // UI origin
 *       → wrapper handler runs ctx.callTool("msgraph_auth") // plugin origin
 *         → ms-graph handler shows AAD BrowserWindow
 *
 * The user *did* approve the outer wrapper at the panel, but the inner
 * `ctx.callTool` is dispatched with `origin: "plugin"` because that is the
 * HostApi the wrapper holds. Pre-fix, the host then treated the inner call
 * as headless and routed it through the reviewer lane — silently queueing
 * the AAD popup forever (#664 reproducer).
 *
 * This tracker uses {@link AsyncLocalStorage} to thread the outermost
 * (effective) origin through the call chain. The plugin runtime enters a
 * scope per `invokePluginTool` call and resolves the *effective* origin as
 *
 *   effective = parent || current.origin
 *
 * so a UI-rooted chain stays UI all the way down, while a plugin-emitted
 * chain (no UI ancestor) stays plugin. The effective origin is read by
 * `boot.ts` when it constructs `permissionContext.headless`.
 *
 * Boundary: the chain is process-local and follows the JavaScript async
 * frame — a setTimeout/queueMicrotask inside a plugin handler that calls
 * back into callTool retains the chain (this is what we want); an
 * out-of-band IPC message that arrives independently does NOT inherit it
 * (this is also what we want — IPC has its own origin classification at
 * the bridge entry point).
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type InvocationOrigin = "plugin" | "ui";

interface ChainFrame {
  /** Outermost (effective) origin observed in this chain. */
  effectiveOrigin: InvocationOrigin;
}

const storage = new AsyncLocalStorage<ChainFrame>();

/**
 * Run `fn` inside an invocation-origin scope. `parentOrigin` (when present)
 * takes precedence over `current` so a UI ancestor never loses its
 * UI-origin status as it nests deeper. Returns the result of `fn`.
 */
export function runWithInvocationOrigin<T>(
  current: InvocationOrigin,
  parentOrigin: InvocationOrigin | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  // UI wins — once a chain is UI, every descendant stays UI.
  const inherited = storage.getStore()?.effectiveOrigin;
  const effective: InvocationOrigin =
    inherited === "ui" || parentOrigin === "ui" || current === "ui"
      ? "ui"
      : "plugin";
  return storage.run({ effectiveOrigin: effective }, fn);
}

/**
 * Read the effective origin of the current async chain, if any. Returns
 * `undefined` when called outside an invocation scope (e.g. boot-time
 * code, top-level IPC handlers).
 */
export function currentInvocationOrigin(): InvocationOrigin | undefined {
  return storage.getStore()?.effectiveOrigin;
}

/**
 * Plugin tool invocation origin-chain tracker — issue #664 P2.
 *
 * Wrapper plugins commonly look like:
 *
 *   user clicks panel button
 *     → bridge.callTool("<wrapper_signin_tool>")        // UI origin
 *       → wrapper handler runs ctx.callTool("<inner_auth_tool>") // plugin origin
 *         → inner-auth handler shows OS-native sign-in window
 *
 * The user *did* approve the outer wrapper at the panel, but the inner
 * `ctx.callTool` is dispatched with `origin: "plugin"` because that is the
 * HostApi the wrapper holds. Pre-fix, the host then treated the inner call
 * as headless and routed it through the reviewer lane — silently queueing
 * the sign-in popup forever (#664 reproducer).
 *
 * Constraint (#1556): this stickiness only makes the inner call *foreground*;
 * it does NOT make an app-only-visibility inner method reachable. For the inner
 * `ctx.callTool("<inner_auth_tool>")` above to actually run, `inner_auth_tool`
 * must be model-visible in the owner plugin's `tools[]` (the governed
 * ToolExecutor path). An app-only-visibility *non-status* method cannot be
 * invoked from a plugin-origin `ctx.callTool` — HostApi.callTool never forwards
 * `userAction`, so the user-activation gate can never be satisfied, and
 * forwarding it is intentionally out of scope (no shipped first-party plugin
 * nests into an app-only method this way). Attempting it throws the explicit
 * "app-only-visibility method … cannot be invoked from a plugin-origin
 * ctx.callTool" error from `boot/plugin-tool-invocation.ts`
 * (dispatchAppOnlyRuntimeInvocation), NOT a generic activation error. The auth
 * *statusTool* is the exception: its
 * `appOnlyRuntimeInvocationRequiresUserAction` returns false, so it skips the
 * user-activation gate and DOES run on a plugin-origin chain (status polling is
 * a host-managed read, not a user-gesture action). See architecture.md §9.4a.
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

/**
 * The single authority for the host's workspace-root (permission-directory)
 * lifecycle — the object that backs every durable "allow-always" directory
 * approval and every persistent `/permission dir allow|deny`.
 *
 * There is exactly one such object per app run. It is built inside the
 * workspace IPC domain (`ipc/domains/workspace.ts`), because only that module
 * owns the registry/grant/routine sweep a persistent allow or deny must run,
 * and it is published here so every consumer resolves the SAME instance.
 *
 * Why a module holder rather than a dependency field: the lifecycle is created
 * during IPC registration, which happens AFTER the conversation loops, the
 * sub-agent runner and the plugin-surface executor are constructed. Handing it
 * out by value therefore required a hand-written assignment per holder, and
 * every holder that nobody remembered to assign (sub-agent child loops, routine
 * loops) silently degraded to `undefined` — the user was offered "allow-always"
 * in the modal and then got `workspace lifecycle unavailable`. Consumers read
 * through `getWorkspaceRootLifecycle` at approval time, so a consumer created
 * before the producer resolves correctly without any wiring of its own.
 *
 * Unset (before IPC registration, or in a standalone executor) resolves to
 * `undefined`, which every consumer treats as fail-closed: the durable write is
 * refused rather than falling back to a settings-only persist.
 */
import type { PermissionDirectoryLifecycle } from "./permission-slash.js";

let workspaceRootLifecycle: PermissionDirectoryLifecycle | undefined;

/**
 * Publish the host-owned lifecycle. Called once, from the workspace IPC domain
 * registrar. Passing `undefined` clears it (test teardown).
 */
export function setWorkspaceRootLifecycle(
  lifecycle: PermissionDirectoryLifecycle | undefined,
): void {
  workspaceRootLifecycle = lifecycle;
}

/**
 * Resolve the lifecycle at use time. `undefined` means "not wired yet" and MUST
 * be treated as fail-closed by the caller.
 */
export function getWorkspaceRootLifecycle(): PermissionDirectoryLifecycle | undefined {
  return workspaceRootLifecycle;
}

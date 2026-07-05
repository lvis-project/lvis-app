/**
 * E4 — boot-time OS-integration reconcile wiring.
 *
 * Extracted from `main()` so the "register the global accelerator + login item
 * from persisted settings, and surface a login-item registration that the OS
 * did not apply" wiring can be unit-tested without spinning the whole app boot
 * (cluster-review §6a — the boot path fires a notification on a startup-launch
 * conflict, previously only reachable through a full `main()` startup).
 *
 * Unlike the `settings.update` IPC path (which gates on a change signature and
 * runs after a `patch` commit), the boot path reconciles UNCONDITIONALLY: it is
 * the first sync of OS state to the persisted settings this process performs.
 * Both paths share the same failure-surfacing contract — a global-shortcut
 * conflict is notified inside `reconcileGlobalShortcuts`, and a login-item
 * `applied:false` is notified via `notifyStartupLaunchFailureIfNeeded`.
 */
import { reconcileGlobalShortcuts } from "./global-shortcuts.js";
import {
  reconcileStartupLaunch,
  notifyStartupLaunchFailureIfNeeded,
} from "./startup-launch.js";
import type { ShortcutSettings, SystemSettings } from "../data/settings-store.js";

/** Injectable surface so boot wiring can be unit-tested without Electron. */
export interface OsIntegrationReconcilers {
  reconcileGlobalShortcuts: typeof reconcileGlobalShortcuts;
  reconcileStartupLaunch: typeof reconcileStartupLaunch;
  notifyStartupLaunchFailureIfNeeded: typeof notifyStartupLaunchFailureIfNeeded;
}

function defaultReconcilers(): OsIntegrationReconcilers {
  return {
    reconcileGlobalShortcuts,
    reconcileStartupLaunch,
    notifyStartupLaunchFailureIfNeeded,
  };
}

/**
 * Reconcile the OS-level global accelerator + login item to the persisted
 * settings at boot, surfacing a failed login-item registration to the user
 * (mirroring the global-shortcut conflict path). Called once from `main()`
 * after services + tray exist.
 */
export function reconcileOsIntegrationOnBoot(
  settings: { shortcuts: ShortcutSettings; system: SystemSettings },
  deps: OsIntegrationReconcilers = defaultReconcilers(),
): void {
  deps.reconcileGlobalShortcuts(settings.shortcuts);
  const launchInput = {
    launchAtStartup: settings.system.launchAtStartup ?? false,
    launchMinimized: settings.system.launchMinimized ?? false,
  };
  const launchState = deps.reconcileStartupLaunch(launchInput);
  deps.notifyStartupLaunchFailureIfNeeded(launchInput, launchState);
}

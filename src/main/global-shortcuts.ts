/**
 * E4 — global keyboard shortcuts (show/hide window toggle).
 *
 * Registers the user-chosen accelerator with Electron's `globalShortcut` so the
 * main window can be toggled from anywhere in the OS. The registration is
 * reconciled from settings: called once at boot and again whenever the
 * `shortcuts` block (or a relevant `system` field) changes via the existing
 * `settings.update` IPC — no dedicated IPC channel (see `.omc/plans/e4-design.md`
 * §0: settings-IPC reuse).
 *
 * No-Fallback: a registration failure (accelerator already claimed by another
 * app, or rejected by Electron's Accelerator parser) is NEVER swallowed. It is
 * surfaced to the user through the existing NotificationService (`kind:"system"`
 * — the boot/config-cue channel) so a silently-dead shortcut can't happen.
 *
 * Teardown: `unregisterAllGlobalShortcuts()` is called from the app-shutdown
 * cleanup pipeline so accelerators are released on quit.
 */
import { globalShortcut } from "electron";
import type { BrowserWindow } from "electron";
import { createLogger } from "../lib/logger.js";
import { normalizeAccelerator, type ShortcutSettings } from "../shared/shortcuts.js";
import { getMainWindow, getServices } from "./app-state.js";
import { showOrCreateMainWindow } from "./app-tray.js";
import { toggleMainWindowVisibility } from "./main-window.js";
import { t } from "../i18n/index.js";

const log = createLogger("lvis");

/**
 * Injectable surface so registration/conflict/teardown can be unit-tested
 * without Electron. Defaults bind to the real `globalShortcut` + app-state.
 */
export interface GlobalShortcutsDeps {
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
  unregisterAll: () => void;
  isRegistered: (accelerator: string) => boolean;
  /** Invoked when the toggle accelerator fires. */
  onToggle: () => void;
  /** Surface a user-facing failure (accelerator conflict / invalid). */
  notifyFailure: (accelerator: string) => void;
}

/** Default toggle action — raise the window (creating it if needed) or hide it. */
function defaultOnToggle(): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    toggleMainWindowVisibility(win as BrowserWindow);
    return;
  }
  // No live window — recreate + show (shared tray/menu entry point).
  showOrCreateMainWindow("global-shortcut-toggle");
}

function defaultNotifyFailure(accelerator: string): void {
  const services = getServices();
  services?.notificationService?.fire({
    kind: "system",
    title: t("startupTab.shortcutRegisterFailedTitle"),
    body: t("startupTab.shortcutRegisterFailedBody", { accelerator }),
  });
}

function defaultDeps(): GlobalShortcutsDeps {
  return {
    register: (accelerator, callback) => globalShortcut.register(accelerator, callback),
    unregister: (accelerator) => globalShortcut.unregister(accelerator),
    unregisterAll: () => globalShortcut.unregisterAll(),
    isRegistered: (accelerator) => globalShortcut.isRegistered(accelerator),
    onToggle: defaultOnToggle,
    notifyFailure: defaultNotifyFailure,
  };
}

/**
 * Last accelerator we actually bound (so reconcile can unregister precisely
 * rather than blowing away every app-wide shortcut). Module-level: there is one
 * global-shortcut registry per process.
 */
let boundAccelerator: string | null = null;

/** Result of a reconcile, for logging/tests. */
export type ReconcileOutcome =
  | { status: "registered"; accelerator: string }
  | { status: "unregistered" }
  | { status: "disabled" }
  | { status: "no-accelerator" }
  | { status: "invalid"; accelerator: string }
  | { status: "conflict"; accelerator: string };

/**
 * Register/unregister the toggle accelerator to match the given settings.
 * Idempotent: unbinds the previous accelerator first, then binds the new one
 * when `enabled` and a valid accelerator are present.
 */
export function reconcileGlobalShortcuts(
  shortcuts: ShortcutSettings,
  deps: GlobalShortcutsDeps = defaultDeps(),
): ReconcileOutcome {
  // Always release the previously-bound accelerator first so a change of
  // accelerator (or disabling) never leaves a stale binding.
  if (boundAccelerator !== null) {
    try {
      deps.unregister(boundAccelerator);
    } catch (err) {
      log.warn("global-shortcuts: unregister failed: %s", (err as Error).message);
    }
    boundAccelerator = null;
  }

  if (!shortcuts.enabled) {
    return { status: "disabled" };
  }
  if (shortcuts.toggleWindow === null) {
    return { status: "no-accelerator" };
  }

  const accelerator = normalizeAccelerator(shortcuts.toggleWindow);
  if (accelerator === null) {
    // Malformed accelerator that slipped past the store (defensive) — surface it.
    log.warn("global-shortcuts: invalid accelerator %s", JSON.stringify(shortcuts.toggleWindow));
    deps.notifyFailure(String(shortcuts.toggleWindow));
    return { status: "invalid", accelerator: String(shortcuts.toggleWindow) };
  }

  let ok = false;
  try {
    ok = deps.register(accelerator, deps.onToggle);
  } catch (err) {
    // Electron throws on some malformed accelerators rather than returning false.
    log.warn("global-shortcuts: register threw for %s: %s", accelerator, (err as Error).message);
    ok = false;
  }

  if (!ok) {
    // Conflict (another app owns it) or parser rejection — No-Fallback: surface.
    log.warn("global-shortcuts: failed to register %s (conflict or invalid)", accelerator);
    deps.notifyFailure(accelerator);
    return { status: "conflict", accelerator };
  }

  boundAccelerator = accelerator;
  log.info("global-shortcuts: registered toggle accelerator %s", accelerator);
  return { status: "registered", accelerator };
}

/**
 * Release every global shortcut this process holds. Called from the app-shutdown
 * cleanup pipeline. Safe to call multiple times.
 */
export function unregisterAllGlobalShortcuts(
  deps: Pick<GlobalShortcutsDeps, "unregisterAll"> = { unregisterAll: () => globalShortcut.unregisterAll() },
): void {
  try {
    deps.unregisterAll();
  } catch (err) {
    log.warn("global-shortcuts: unregisterAll failed: %s", (err as Error).message);
  }
  boundAccelerator = null;
}

/** @internal test-only — reset module state between cases. */
export function __resetGlobalShortcutsStateForTest(): void {
  boundAccelerator = null;
}

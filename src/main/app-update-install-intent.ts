/**
 * Process-local signal for the Electron updater install path.
 *
 * electron-updater's `quitAndInstall()` first closes BrowserWindows and then
 * quits the app. LVIS lets the first updater-owned window close proceed,
 * intercepts the first updater-owned before-quit to run bounded cleanup, then
 * resumes app quit. Once prepared, updater-owned before-quit events must not
 * be converted back into a second async shutdown pass.
 */
let appUpdateInstallRequested = false;
let appUpdateInstallPrepared = false;

export function beginAppUpdateInstallRequest(): void {
  appUpdateInstallRequested = true;
  appUpdateInstallPrepared = false;
}

export function clearAppUpdateInstallRequested(): void {
  appUpdateInstallRequested = false;
  appUpdateInstallPrepared = false;
}

export function isAppUpdateInstallRequested(): boolean {
  return appUpdateInstallRequested;
}

export function isAppUpdateInstallPrepared(): boolean {
  return appUpdateInstallRequested && appUpdateInstallPrepared;
}

export function markAppUpdateInstallPrepared(): void {
  if (!appUpdateInstallRequested) return;
  appUpdateInstallPrepared = true;
}

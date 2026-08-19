/**
 * App-info IPC handler — `lvis:app:info`.
 *
 * Host identity and runtime versions for the About surface.
 *
 * `version` comes from `shared/app-version.ts`, not `app.getVersion()`:
 * unpackaged runs (`electron dist/src/main/main.js`) make `app.getVersion()`
 * report the Electron binary version instead of the LVIS project version, so
 * dev and packaged builds would disagree. The bootstrap splash resolves the
 * version the same way.
 *
 * Read-only and idempotent, and registered without a sender guard. That is an
 * accepted gap, not parity with `lvis:settings:get`: that handler also skips the
 * guard, but it answers through `rendererSettingsSnapshot()`, which projects the
 * stored settings before returning them, whereas this handler returns the fields
 * it assembles as-is. Adding the guard or narrowing the response is a behaviour
 * change and is tracked separately from the rename that created this module.
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { getLvisAppVersion } from "../../shared/app-version.js";

export function registerAppHandlers(): void {
  ipcMain.handle(CHANNELS.app.info, async () => {
    const { app } = await import("electron");
    return {
      version: getLvisAppVersion(),
      electronVersion: process.versions.electron ?? "",
      nodeVersion: process.versions.node ?? "",
      chromeVersion: process.versions.chrome ?? "",
      v8Version: process.versions.v8 ?? "",
      platform: process.platform,
      arch: process.arch,
      userDataPath: app.getPath("userData"),
    };
  });
}

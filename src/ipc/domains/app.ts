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
 * Read-only and idempotent, and registered without a sender guard — the same
 * posture as `lvis:settings:get`.
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

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
 * Read-only, and gated on `validateHostRendererSender`. A read is still a
 * disclosure: this handler returns the fields it assembles as-is, where
 * `lvis:settings:get` answers through `rendererSettingsSnapshot()` and so
 * projects what it returns. Nothing here narrows the response, which leaves
 * the frame check as the only thing between it and a caller.
 * `ipc/__tests__/host-renderer-only-channels.test.ts` pins both directions for
 * this channel — the plugin shell is refused, the host renderer is not.
 */
import { ipcMain } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { getLvisAppVersion } from "../../shared/app-version.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import type { IpcDeps } from "../types.js";

export function registerAppHandlers(deps: IpcDeps): void {
  const { auditLogger } = deps;
  ipcMain.handle(CHANNELS.app.info, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.app.info, e);
      return UNAUTHORIZED_FRAME;
    }
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

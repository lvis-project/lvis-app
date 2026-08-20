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
 * Read-only, and still gated on `validateHostRendererSender`. A read is a
 * disclosure: the response is assembled and returned as-is rather than being
 * projected the way `lvis:settings:get` projects through
 * `rendererSettingsSnapshot()`, so the frame check is the only thing standing
 * between the plugin trust domain and these fields. That is the rule
 * `validateHostRendererSender` states for every host channel, read-only ones
 * included; `ipc/__tests__/host-renderer-only-channels.test.ts` pins both
 * directions for this channel — the plugin shell is refused, the host renderer
 * is not.
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

/**
 * Synchronous boot-time reader for the persisted workspace mode.
 *
 * The main window is created (in `main.ts:createWindow`) BEFORE the async
 * bootstrap assigns `services` (and thus before `SettingsService` is in
 * memory). To size the window correctly and prime `window.__lvisInitialAppMode`
 * on that first creation, the persisted `system.appMode` must be read straight
 * from the settings file synchronously.
 *
 * Reads from `settingsFilePath(userDataPath)` — the exact path
 * `SettingsService` writes to — so a mode saved via the UI is the one restored
 * on the next launch.
 */
import { readPersistedSystemSectionSync } from "./persisted-settings-sync.js";
import { DEFAULT_APP_MODE, normalizeAppMode, type InitialAppMode } from "../shared/initial-app-mode.js";

/**
 * Read `system.appMode` from the persisted settings file. Returns
 * {@link DEFAULT_APP_MODE} ("work") when the file is absent, unreadable, the
 * field is missing, or its value is not a valid mode — all legitimate first-run
 * / pre-migration defaults, not bug-papering fallbacks. Legacy `"action"`
 * values from older builds are normalized to `"work"`.
 */
export function readPersistedAppModeSync(userDataPath: string): InitialAppMode {
  const mode = readPersistedSystemSectionSync(userDataPath)?.appMode;
  return normalizeAppMode(mode) ?? DEFAULT_APP_MODE;
}

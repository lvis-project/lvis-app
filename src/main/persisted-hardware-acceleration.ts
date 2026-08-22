/**
 * Synchronous boot-time reader + resolver for the hardware-acceleration
 * preference.
 *
 * `app.disableHardwareAcceleration()` only has an effect before
 * `app.whenReady()`, which is long before the async bootstrap constructs
 * `SettingsService`. So, exactly like {@link readPersistedAppModeSync}, the
 * persisted value has to be read straight off the settings file — the same file
 * `SettingsService` writes, via `settingsFilePath`, so a choice made in Settings
 * is the one honored on the next launch.
 *
 * "Next launch" is the whole point and the reason the UI says so: nothing here
 * can be applied to the running process. A toggle that silently did nothing
 * until a restart would be worse than no toggle.
 */
import { readPersistedSystemBooleanSync } from "./persisted-settings-sync.js";

/**
 * Read `system.hardwareAcceleration` from the persisted settings file.
 *
 * Returns `undefined` when the file is absent, unreadable, or the field is
 * missing or not a boolean — all of which mean "the user has not chosen", not
 * "the user chose off". {@link resolveHardwareAcceleration} turns that absence
 * into the platform default; conflating the two here would silently flip the
 * GPU on for every first-run Windows user.
 */
export function readPersistedHardwareAccelerationSync(
  userDataPath: string,
): boolean | undefined {
  return readPersistedSystemBooleanSync(userDataPath, "hardwareAcceleration");
}

export interface HardwareAccelerationInputs {
  /** Persisted `system.hardwareAcceleration`, or undefined when unset. */
  readonly setting: boolean | undefined;
  /** `LVIS_KEEP_GPU` — "1" forces the GPU on regardless of the setting. */
  readonly keepGpuEnv: string | undefined;
  readonly platform: NodeJS.Platform;
}

/**
 * Decide whether Chromium's GPU process may start this launch.
 *
 * Precedence, highest first:
 *   1. `LVIS_KEEP_GPU=1` — the pre-existing escape hatch, kept because it is
 *      the only lever available to a dev/CI launcher that cannot write the
 *      profile (`scripts/run-electron.mjs` mirrors the same guard).
 *   2. The persisted setting — what the person using the packaged app chose.
 *   3. The platform default: OFF on Windows/Linux, where restricted corp/VDI
 *      drivers produce repeated `ContextResult::kFatalFailure` and eventually
 *      take the renderer down with them; ON on macOS, which has no such
 *      failure mode.
 *
 * The env sits ABOVE the setting rather than below it on purpose: it is the
 * lever for the case where the app will not render at all, and a lever that a
 * bad persisted value could veto would be no lever.
 */
export function resolveHardwareAcceleration(inputs: HardwareAccelerationInputs): boolean {
  if (inputs.keepGpuEnv === "1") return true;
  if (inputs.setting !== undefined) return inputs.setting;
  return inputs.platform !== "win32" && inputs.platform !== "linux";
}

/**
 * E4 — launch-at-startup (auto-run at OS login).
 *
 * Wraps Electron's `app.setLoginItemSettings` / `getLoginItemSettings` with the
 * per-platform semantics the two APIs differ on:
 *
 *   - macOS: `openAsHidden` is honoured natively — a hidden login launch starts
 *     without showing the window. `wasOpenedAsHidden` is queryable at boot.
 *   - Windows: there is no `openAsHidden`; a hidden start is expressed by
 *     passing a `--hidden` launch arg that the boot path (`src/main.ts`) reads.
 *   - Linux: Electron's setLoginItemSettings is a no-op (no autostart .desktop
 *     writer built in). We still call it so the code path is uniform; it simply
 *     does nothing, which we surface honestly via `readStartupLaunchState`.
 *
 * dev (`!app.isPackaged`): a login item would point at the Electron dev binary
 * (not the user's installed app), so registering one is meaningless and
 * confusing. We DO NOT register in dev — instead we return `applied:false` with
 * an explicit `dev-unpackaged` reason so the UI / logs can say so plainly
 * (No-Fallback: no silent no-op that masquerades as success).
 */
import { app } from "electron";
import { createLogger } from "../lib/logger.js";

const log = createLogger("lvis");

/** Marker arg appended on Windows for a hidden (tray-only) auto-launch. */
export const HIDDEN_LAUNCH_ARG = "--hidden";

export interface StartupLaunchInput {
  launchAtStartup: boolean;
  launchMinimized: boolean;
}

export interface StartupLaunchState {
  /** Whether `openAtLogin` is actually set according to the OS. */
  openAtLogin: boolean;
  /** Whether a hidden start is configured (openAsHidden / --hidden arg). */
  openAsHidden: boolean;
  /**
   * `true` when the OS launched this process as a hidden login item (macOS
   * `wasOpenedAsHidden`, or a `--hidden` arg on Windows). Drives whether boot
   * suppresses the first window show.
   */
  wasOpenedAsHidden: boolean;
  /** `true` when the setting was actually applied to the OS this platform/mode. */
  applied: boolean;
  /** Why `applied` is false, if it is. */
  reason?: "dev-unpackaged" | "platform-unsupported";
}

/**
 * Injectable Electron surface so the platform semantics can be unit-tested
 * without spinning Electron. Defaults bind to the real `app` + `process`.
 */
export interface StartupLaunchDeps {
  isPackaged: () => boolean;
  platform: () => NodeJS.Platform;
  setLoginItemSettings: (settings: Electron.Settings) => void;
  getLoginItemSettings: () => Electron.LoginItemSettings;
  /** Process argv — used on Windows to detect a `--hidden` cold start. */
  argv: () => readonly string[];
}

function defaultDeps(): StartupLaunchDeps {
  return {
    isPackaged: () => app.isPackaged,
    platform: () => process.platform,
    setLoginItemSettings: (settings) => app.setLoginItemSettings(settings),
    getLoginItemSettings: () => app.getLoginItemSettings(),
    argv: () => process.argv,
  };
}

/**
 * Apply the persisted launch-at-startup settings to the OS and report the
 * resulting state (queried back from the OS so the UI reflects reality, not the
 * value we just wrote).
 */
export function reconcileStartupLaunch(
  input: StartupLaunchInput,
  deps: StartupLaunchDeps = defaultDeps(),
): StartupLaunchState {
  const platform = deps.platform();

  // dev (unpackaged): do not register a login item — it would point at the
  // Electron dev binary. Report honestly.
  if (!deps.isPackaged()) {
    log.info(
      "startup-launch: skipped in dev (unpackaged) — launchAtStartup=%s launchMinimized=%s",
      input.launchAtStartup,
      input.launchMinimized,
    );
    return {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      reason: "dev-unpackaged",
    };
  }

  const settings: Electron.Settings = { openAtLogin: input.launchAtStartup };
  if (platform === "darwin") {
    // macOS honours openAsHidden natively.
    settings.openAsHidden = input.launchAtStartup && input.launchMinimized;
  } else if (platform === "win32") {
    // Windows has no openAsHidden — express "start hidden" via a launch arg the
    // boot path reads. Only pass it when both flags are on.
    settings.args =
      input.launchAtStartup && input.launchMinimized ? [HIDDEN_LAUNCH_ARG] : [];
  }

  try {
    deps.setLoginItemSettings(settings);
  } catch (err) {
    log.warn("startup-launch: setLoginItemSettings failed: %s", (err as Error).message);
    return {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      reason: "platform-unsupported",
    };
  }

  return readStartupLaunchState(deps);
}

/**
 * Query the current OS login-item state. On Windows the OS does not report
 * `openAsHidden`, so we derive "hidden" from our own `--hidden` arg (both in the
 * stored login-item args and in the current process argv for cold-start
 * detection).
 */
export function readStartupLaunchState(
  deps: StartupLaunchDeps = defaultDeps(),
): StartupLaunchState {
  if (!deps.isPackaged()) {
    return {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      reason: "dev-unpackaged",
    };
  }

  const platform = deps.platform();
  const os = deps.getLoginItemSettings();
  const argvHidden = deps.argv().includes(HIDDEN_LAUNCH_ARG);

  if (platform === "win32") {
    // Electron reports the persisted launch args under `executableWillLaunchAtLogin`
    // is not available; use launchItems if present, else fall back to argv.
    const launchItems = (os as Electron.LoginItemSettings & {
      launchItems?: Array<{ args?: string[] }>;
    }).launchItems;
    const hiddenConfigured =
      launchItems?.some((item) => item.args?.includes(HIDDEN_LAUNCH_ARG)) ?? argvHidden;
    return {
      openAtLogin: os.openAtLogin,
      openAsHidden: hiddenConfigured,
      wasOpenedAsHidden: argvHidden,
      applied: true,
    };
  }

  // macOS + Linux. On Linux openAtLogin round-trips as false (Electron no-op),
  // which readStartupLaunchState reports truthfully.
  return {
    openAtLogin: os.openAtLogin,
    openAsHidden: os.openAsHidden ?? false,
    wasOpenedAsHidden: os.wasOpenedAsHidden ?? argvHidden,
    applied: platform === "darwin" || platform === "linux",
    reason: platform === "darwin" || platform === "linux" ? undefined : "platform-unsupported",
  };
}

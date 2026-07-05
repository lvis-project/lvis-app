/**
 * E4 — startup-launch (auto-run at login) platform semantics.
 *
 * MUTATION CONTRACT:
 *  - Dropping the dev (unpackaged) guard makes the dev test fail (it would call
 *    setLoginItemSettings).
 *  - Swapping the macOS `openAsHidden` for the Windows `args:["--hidden"]`
 *    branch (or vice-versa) makes the per-platform tests fail.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  reconcileStartupLaunch,
  readStartupLaunchState,
  HIDDEN_LAUNCH_ARG,
  type StartupLaunchDeps,
} from "../startup-launch.js";

function makeDeps(overrides: Partial<StartupLaunchDeps> = {}): {
  deps: StartupLaunchDeps;
  setLoginItemSettings: ReturnType<typeof vi.fn>;
  loginItemState: Electron.LoginItemSettings;
} {
  const loginItemState = {
    openAtLogin: false,
    openAsHidden: false,
    wasOpenedAsHidden: false,
  } as unknown as Electron.LoginItemSettings;
  const setLoginItemSettings = vi.fn((settings: Electron.Settings) => {
    (loginItemState as { openAtLogin: boolean }).openAtLogin = settings.openAtLogin ?? false;
    if (settings.openAsHidden !== undefined) {
      (loginItemState as { openAsHidden: boolean }).openAsHidden = settings.openAsHidden;
    }
  });
  const deps: StartupLaunchDeps = {
    isPackaged: () => true,
    platform: () => "darwin",
    setLoginItemSettings,
    getLoginItemSettings: () => loginItemState,
    argv: () => [],
    ...overrides,
  };
  return { deps, setLoginItemSettings, loginItemState };
}

describe("reconcileStartupLaunch", () => {
  it("is a no-op in dev (unpackaged) and reports dev-unpackaged", () => {
    const { deps, setLoginItemSettings } = makeDeps({ isPackaged: () => false });
    const state = reconcileStartupLaunch(
      { launchAtStartup: true, launchMinimized: true },
      deps,
    );
    expect(setLoginItemSettings).not.toHaveBeenCalled();
    expect(state.applied).toBe(false);
    expect(state.reason).toBe("dev-unpackaged");
    expect(state.openAtLogin).toBe(false);
  });

  it("macOS: sets openAtLogin + openAsHidden natively", () => {
    const { deps, setLoginItemSettings } = makeDeps({ platform: () => "darwin" });
    const state = reconcileStartupLaunch(
      { launchAtStartup: true, launchMinimized: true },
      deps,
    );
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      openAsHidden: true,
    });
    expect(state.openAtLogin).toBe(true);
    expect(state.applied).toBe(true);
  });

  it("macOS: openAsHidden is false when launchMinimized is off", () => {
    const { deps, setLoginItemSettings } = makeDeps({ platform: () => "darwin" });
    reconcileStartupLaunch({ launchAtStartup: true, launchMinimized: false }, deps);
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      openAsHidden: false,
    });
  });

  it("Windows: expresses hidden start via a --hidden launch arg (no openAsHidden)", () => {
    const { deps, setLoginItemSettings } = makeDeps({ platform: () => "win32" });
    reconcileStartupLaunch({ launchAtStartup: true, launchMinimized: true }, deps);
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: [HIDDEN_LAUNCH_ARG],
    });
  });

  it("Windows: empty args when not hidden", () => {
    const { deps, setLoginItemSettings } = makeDeps({ platform: () => "win32" });
    reconcileStartupLaunch({ launchAtStartup: true, launchMinimized: false }, deps);
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
      args: [],
    });
  });

  it("disabling clears openAtLogin", () => {
    const { deps, setLoginItemSettings } = makeDeps({ platform: () => "darwin" });
    reconcileStartupLaunch({ launchAtStartup: false, launchMinimized: false }, deps);
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: false,
      openAsHidden: false,
    });
  });
});

describe("readStartupLaunchState", () => {
  it("Windows: detects a hidden cold-start from argv --hidden", () => {
    const { deps } = makeDeps({
      platform: () => "win32",
      argv: () => ["electron.exe", HIDDEN_LAUNCH_ARG],
    });
    const state = readStartupLaunchState(deps);
    expect(state.wasOpenedAsHidden).toBe(true);
  });

  it("macOS: reads wasOpenedAsHidden from the OS login-item settings", () => {
    const loginItemState = {
      openAtLogin: true,
      openAsHidden: true,
      wasOpenedAsHidden: true,
    } as unknown as Electron.LoginItemSettings;
    const state = readStartupLaunchState({
      isPackaged: () => true,
      platform: () => "darwin",
      setLoginItemSettings: vi.fn(),
      getLoginItemSettings: () => loginItemState,
      argv: () => [],
    });
    expect(state.wasOpenedAsHidden).toBe(true);
    expect(state.openAtLogin).toBe(true);
  });

  it("dev: reports dev-unpackaged without touching the OS", () => {
    const state = readStartupLaunchState({
      isPackaged: () => false,
      platform: () => "win32",
      setLoginItemSettings: vi.fn(),
      getLoginItemSettings: vi.fn(),
      argv: () => [],
    });
    expect(state.applied).toBe(false);
    expect(state.reason).toBe("dev-unpackaged");
  });
});

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: {} }));
vi.mock("../../lib/logger.js", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
const notificationFire = vi.fn();
const getServices = vi.fn(() => ({ notificationService: { fire: notificationFire } }));
vi.mock("../app-state.js", () => ({ getServices: (...a: unknown[]) => getServices(...a) }));
vi.mock("../../i18n/index.js", () => ({ t: (k: string) => k }));

import {
  reconcileStartupLaunch,
  readStartupLaunchState,
  notifyStartupLaunchFailureIfNeeded,
  HIDDEN_LAUNCH_ARG,
  type StartupLaunchDeps,
  type StartupLaunchState,
} from "../startup-launch.js";

function makeDeps(overrides: Partial<StartupLaunchDeps> = {}): {
  deps: StartupLaunchDeps;
  setLoginItemSettings: ReturnType<typeof vi.fn>;
  loginItemState: Electron.LoginItemSettings;
} {
  const loginItemState = {
    openAtLogin: false,
    wasOpenedAtLogin: false,
  } as unknown as Electron.LoginItemSettings;
  const setLoginItemSettings = vi.fn((settings: Electron.Settings) => {
    (loginItemState as { openAtLogin: boolean }).openAtLogin = settings.openAtLogin ?? false;
  });
  const deps: StartupLaunchDeps = {
    isPackaged: () => true,
    platform: () => "darwin",
    setLoginItemSettings,
    getLoginItemSettings: () => loginItemState,
    argv: () => [],
    launchMinimized: () => false,
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

  it("registers a login item and retains the host minimized preference", () => {
    const { deps, setLoginItemSettings } = makeDeps({ platform: () => "darwin" });
    const state = reconcileStartupLaunch(
      { launchAtStartup: true, launchMinimized: true },
      deps,
    );
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
    });
    expect(state.openAtLogin).toBe(true);
    expect(state.openAsHidden).toBe(true);
    expect(state.applied).toBe(true);
  });

  it("registers a visible login launch when the minimized preference is off", () => {
    const { deps, setLoginItemSettings } = makeDeps({ platform: () => "darwin" });
    reconcileStartupLaunch({ launchAtStartup: true, launchMinimized: false }, deps);
    expect(setLoginItemSettings).toHaveBeenCalledWith({
      openAtLogin: true,
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

  it.each([
    { login: true, minimized: true, hidden: true },
    { login: true, minimized: false, hidden: false },
    { login: false, minimized: true, hidden: false },
    { login: false, minimized: false, hidden: false },
  ])("applies the minimized preference only to a login launch: %j", ({ login, minimized, hidden }) => {
    const { deps } = makeDeps({
      getLoginItemSettings: () => ({
        openAtLogin: true,
        wasOpenedAtLogin: login,
      }) as Electron.LoginItemSettings,
      launchMinimized: () => minimized,
    });
    const state = readStartupLaunchState(deps);
    expect(state.wasOpenedAsHidden).toBe(hidden);
    expect(state.openAsHidden).toBe(minimized);
    expect(state.openAtLogin).toBe(true);
  });

  it("dev: reports dev-unpackaged without touching the OS", () => {
    const state = readStartupLaunchState({
      isPackaged: () => false,
      platform: () => "win32",
      setLoginItemSettings: vi.fn(),
      getLoginItemSettings: vi.fn(),
      argv: () => [],
      launchMinimized: () => false,
    });
    expect(state.applied).toBe(false);
    expect(state.reason).toBe("dev-unpackaged");
  });

  it("reports platform-unsupported (applied:false) when setLoginItemSettings throws", () => {
    const { deps } = makeDeps({
      platform: () => "win32",
      setLoginItemSettings: vi.fn(() => {
        throw new Error("OS refused login item");
      }),
    });
    const state = reconcileStartupLaunch({ launchAtStartup: true, launchMinimized: false }, deps);
    expect(state.applied).toBe(false);
    expect(state.reason).toBe("platform-unsupported");
  });
});

// ─── security M2 / critic M2: surface a login-item registration failure ──────
describe("notifyStartupLaunchFailureIfNeeded", () => {
  function state(overrides: Partial<StartupLaunchState>): StartupLaunchState {
    return {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      ...overrides,
    };
  }

  it("notifies when launch-at-startup was requested but the OS did not apply it", () => {
    const notify = vi.fn();
    notifyStartupLaunchFailureIfNeeded(
      { launchAtStartup: true, launchMinimized: false },
      state({ applied: false, reason: "platform-unsupported" }),
      notify,
    );
    expect(notify).toHaveBeenCalledOnce();
  });

  it("routes the default notification through NotificationService (kind:system)", () => {
    // Exercise the real default notifier (no injected `notify`) so the
    // NotificationService wiring + i18n keys are covered end-to-end.
    notifyStartupLaunchFailureIfNeeded(
      { launchAtStartup: true, launchMinimized: false },
      state({ applied: false, reason: "platform-unsupported" }),
    );
    expect(notificationFire).toHaveBeenCalledWith({
      kind: "system",
      title: "startupTab.launchRegisterFailedTitle",
      body: "startupTab.launchRegisterFailedBody",
    });
  });

  it("does NOT notify on the benign dev-unpackaged skip", () => {
    const notify = vi.fn();
    notifyStartupLaunchFailureIfNeeded(
      { launchAtStartup: true, launchMinimized: false },
      state({ applied: false, reason: "dev-unpackaged" }),
      notify,
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("does NOT notify when the OS applied the setting", () => {
    const notify = vi.fn();
    notifyStartupLaunchFailureIfNeeded(
      { launchAtStartup: true, launchMinimized: false },
      state({ applied: true }),
      notify,
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("does NOT notify when the user did not request launch-at-startup (disable can't fail)", () => {
    const notify = vi.fn();
    notifyStartupLaunchFailureIfNeeded(
      { launchAtStartup: false, launchMinimized: false },
      state({ applied: false, reason: "platform-unsupported" }),
      notify,
    );
    expect(notify).not.toHaveBeenCalled();
  });
});

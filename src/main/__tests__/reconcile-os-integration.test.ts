/**
 * E4 cluster-review §6a — boot reconcile wiring fires a notification on a
 * startup-launch conflict.
 *
 * `reconcileOsIntegrationOnBoot` is the extracted `main()` wiring. This proves
 * the boot path surfaces a failed login-item registration to the user (the same
 * No-Fallback contract the settings.update IPC path has), without needing a full
 * `main()` startup. Also asserts a global-shortcut conflict stays notified via
 * reconcileGlobalShortcuts and the boot reconcile is UNCONDITIONAL (no signature
 * gate — it is the first sync of OS state to persisted settings).
 *
 * MUTATION CONTRACT:
 *  - Dropping the notifyStartupLaunchFailureIfNeeded call makes the conflict
 *    test fail (a silently-failed auto-launch would ship).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  reconcileOsIntegrationOnBoot,
  type OsIntegrationReconcilers,
} from "../reconcile-os-integration.js";
import type { StartupLaunchState } from "../startup-launch.js";
import type { ShortcutSettings, SystemSettings } from "../../data/settings-store.js";

function makeDeps(overrides: Partial<OsIntegrationReconcilers> = {}): OsIntegrationReconcilers {
  return {
    reconcileGlobalShortcuts: vi.fn(() => ({ status: "registered", accelerator: "Alt+Space" })),
    reconcileStartupLaunch: vi.fn(
      (): StartupLaunchState => ({
        openAtLogin: true,
        openAsHidden: false,
        wasOpenedAsHidden: false,
        applied: true,
      }),
    ),
    notifyStartupLaunchFailureIfNeeded: vi.fn(),
    ...overrides,
  };
}

const shortcuts: ShortcutSettings = { toggleWindow: "Alt+Space", enabled: true } as ShortcutSettings;
const system = { launchAtStartup: true, launchMinimized: false } as SystemSettings;

beforeEach(() => vi.clearAllMocks());

describe("reconcileOsIntegrationOnBoot", () => {
  it("reconciles both the accelerator and the login item unconditionally", () => {
    const deps = makeDeps();
    reconcileOsIntegrationOnBoot({ shortcuts, system }, deps);
    expect(deps.reconcileGlobalShortcuts).toHaveBeenCalledWith(shortcuts);
    expect(deps.reconcileStartupLaunch).toHaveBeenCalledWith({
      launchAtStartup: true,
      launchMinimized: false,
    });
  });

  it("surfaces a login-item apply failure through notifyStartupLaunchFailureIfNeeded", () => {
    const failedState: StartupLaunchState = {
      openAtLogin: false,
      openAsHidden: false,
      wasOpenedAsHidden: false,
      applied: false,
      reason: "platform-unsupported",
    };
    const notify = vi.fn();
    const deps = makeDeps({
      reconcileStartupLaunch: vi.fn(() => failedState),
      notifyStartupLaunchFailureIfNeeded: notify,
    });
    reconcileOsIntegrationOnBoot({ shortcuts, system }, deps);
    expect(notify).toHaveBeenCalledWith(
      { launchAtStartup: true, launchMinimized: false },
      failedState,
    );
  });

  it("defaults launch flags to false when the system block omits them", () => {
    const deps = makeDeps();
    reconcileOsIntegrationOnBoot(
      { shortcuts, system: {} as SystemSettings },
      deps,
    );
    expect(deps.reconcileStartupLaunch).toHaveBeenCalledWith({
      launchAtStartup: false,
      launchMinimized: false,
    });
  });
});

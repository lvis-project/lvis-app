/**
 * E4 — global-shortcuts reconcile / conflict / teardown.
 *
 * MUTATION CONTRACT:
 *  - Removing the "unregister previous before binding" step makes the
 *    accelerator-change test fail (stale binding not released).
 *  - Removing the notifyFailure call on register()===false makes the conflict
 *    test fail (No-Fallback: a conflict must be surfaced, never swallowed).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// globalShortcut is imported at module load; provide a stub so the import
// resolves. All tests inject their own `deps`, so this stub is never called.
vi.mock("electron", () => ({
  globalShortcut: {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
    isRegistered: vi.fn(() => false),
  },
}));
vi.mock("../app-tray.js", () => ({ showOrCreateMainWindow: vi.fn() }));
vi.mock("../main-window.js", () => ({ toggleMainWindowVisibility: vi.fn() }));
vi.mock("../app-state.js", () => ({ getMainWindow: vi.fn(() => null), getServices: vi.fn(() => null) }));
vi.mock("../../i18n/index.js", () => ({ t: (k: string) => k }));

import {
  reconcileGlobalShortcuts,
  unregisterAllGlobalShortcuts,
  __resetGlobalShortcutsStateForTest,
  type GlobalShortcutsDeps,
} from "../global-shortcuts.js";
import type { ShortcutSettings } from "../../shared/shortcuts.js";

function makeDeps(overrides: Partial<GlobalShortcutsDeps> = {}): GlobalShortcutsDeps {
  return {
    register: vi.fn(() => true),
    unregister: vi.fn(),
    unregisterAll: vi.fn(),
    isRegistered: vi.fn(() => false),
    onToggle: vi.fn(),
    notifyFailure: vi.fn(),
    ...overrides,
  };
}

const ACCEL = "CommandOrControl+Shift+Space";

beforeEach(() => {
  __resetGlobalShortcutsStateForTest();
});

describe("reconcileGlobalShortcuts", () => {
  it("registers the accelerator when enabled + accelerator present", () => {
    const deps = makeDeps();
    const outcome = reconcileGlobalShortcuts(
      { toggleWindow: ACCEL, enabled: true },
      deps,
    );
    expect(outcome).toEqual({ status: "registered", accelerator: ACCEL });
    expect(deps.register).toHaveBeenCalledWith(ACCEL, deps.onToggle);
    expect(deps.notifyFailure).not.toHaveBeenCalled();
  });

  it("does not register when disabled", () => {
    const deps = makeDeps();
    const outcome = reconcileGlobalShortcuts(
      { toggleWindow: ACCEL, enabled: false },
      deps,
    );
    expect(outcome).toEqual({ status: "disabled" });
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("reports no-accelerator when enabled but toggleWindow is null", () => {
    const deps = makeDeps();
    const outcome = reconcileGlobalShortcuts(
      { toggleWindow: null, enabled: true },
      deps,
    );
    expect(outcome).toEqual({ status: "no-accelerator" });
    expect(deps.register).not.toHaveBeenCalled();
  });

  it("surfaces a conflict (register returns false) via notifyFailure — No-Fallback", () => {
    const deps = makeDeps({ register: vi.fn(() => false) });
    const outcome = reconcileGlobalShortcuts(
      { toggleWindow: ACCEL, enabled: true },
      deps,
    );
    expect(outcome).toEqual({ status: "conflict", accelerator: ACCEL });
    expect(deps.notifyFailure).toHaveBeenCalledWith(ACCEL);
  });

  it("surfaces a register() throw as a conflict + notifyFailure", () => {
    const deps = makeDeps({
      register: vi.fn(() => {
        throw new Error("bad accelerator");
      }),
    });
    const outcome = reconcileGlobalShortcuts(
      { toggleWindow: ACCEL, enabled: true },
      deps,
    );
    expect(outcome).toEqual({ status: "conflict", accelerator: ACCEL });
    expect(deps.notifyFailure).toHaveBeenCalledWith(ACCEL);
  });

  it("rejects an invalid accelerator (lone modifier) before registering", () => {
    const deps = makeDeps();
    const outcome = reconcileGlobalShortcuts(
      { toggleWindow: "Shift", enabled: true },
      deps,
    );
    expect(outcome).toEqual({ status: "invalid", accelerator: "Shift" });
    expect(deps.register).not.toHaveBeenCalled();
    expect(deps.notifyFailure).toHaveBeenCalledWith("Shift");
  });

  it("unregisters the previous accelerator before binding a new one", () => {
    const deps = makeDeps();
    reconcileGlobalShortcuts({ toggleWindow: ACCEL, enabled: true }, deps);
    const second = "Alt+F1";
    reconcileGlobalShortcuts({ toggleWindow: second, enabled: true }, deps);
    // First accelerator must have been released on the second reconcile.
    expect(deps.unregister).toHaveBeenCalledWith(ACCEL);
    expect(deps.register).toHaveBeenLastCalledWith(second, deps.onToggle);
  });

  it("releases the binding when reconciled to disabled", () => {
    const deps = makeDeps();
    reconcileGlobalShortcuts({ toggleWindow: ACCEL, enabled: true }, deps);
    const outcome = reconcileGlobalShortcuts({ toggleWindow: ACCEL, enabled: false }, deps);
    expect(outcome).toEqual({ status: "disabled" });
    expect(deps.unregister).toHaveBeenCalledWith(ACCEL);
  });
});

describe("unregisterAllGlobalShortcuts", () => {
  it("calls unregisterAll and clears the bound accelerator", () => {
    const registerDeps = makeDeps();
    reconcileGlobalShortcuts({ toggleWindow: ACCEL, enabled: true }, registerDeps);
    const unregisterAll = vi.fn();
    unregisterAllGlobalShortcuts({ unregisterAll });
    expect(unregisterAll).toHaveBeenCalledTimes(1);
    // After a full unregister, a subsequent reconcile should NOT try to
    // unregister a stale accelerator (state cleared).
    const nextDeps = makeDeps();
    reconcileGlobalShortcuts({ toggleWindow: ACCEL, enabled: true }, nextDeps);
    expect(nextDeps.unregister).not.toHaveBeenCalled();
  });
});

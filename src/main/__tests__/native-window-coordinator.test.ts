import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureNativeWindowCoordinator,
  requestNativeChromeRefresh,
  requestShowOrCreateMainWindow,
  resetNativeWindowCoordinatorForTests,
} from "../native-window-coordinator.js";

afterEach(() => {
  resetNativeWindowCoordinatorForTests();
});

describe("native window coordinator", () => {
  it("fails clearly before the composition root configures it", () => {
    expect(() => requestShowOrCreateMainWindow("settings-open")).toThrowError(
      "native-window-coordinator-not-configured",
    );
    expect(() => requestNativeChromeRefresh()).toThrowError(
      "native-window-coordinator-not-configured",
    );
  });

  it("forwards window activation and native chrome refresh requests", () => {
    const showOrCreateMainWindow = vi.fn();
    const refreshNativeChrome = vi.fn();
    configureNativeWindowCoordinator({ showOrCreateMainWindow, refreshNativeChrome });

    requestShowOrCreateMainWindow("settings-open");
    requestNativeChromeRefresh();

    expect(showOrCreateMainWindow).toHaveBeenCalledOnce();
    expect(showOrCreateMainWindow).toHaveBeenCalledWith("settings-open");
    expect(refreshNativeChrome).toHaveBeenCalledOnce();
  });

  it("rejects a second owner instead of silently replacing the boundary", () => {
    const first = {
      showOrCreateMainWindow: vi.fn(),
      refreshNativeChrome: vi.fn(),
    };
    configureNativeWindowCoordinator(first);

    expect(() => configureNativeWindowCoordinator(first)).toThrowError(
      "native-window-coordinator-already-configured",
    );
  });
});

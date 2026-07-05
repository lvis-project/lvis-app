/**
 * E4 — StartupTab renderer interactions.
 *
 * Verifies the tab reads settings on mount, toggles persist through
 * `updateSettings` (settings-IPC reuse — no dedicated channel), the accelerator
 * capture records a key combination, and the "enabled but no accelerator"
 * warning surfaces.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { StartupTab } from "../StartupTab.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

const STARTUP_SETTINGS = {
  llm: { authMode: "manual", provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  system: { closeBehavior: "hide-to-tray", launchAtStartup: false, launchMinimized: false },
  shortcuts: { toggleWindow: null, enabled: false },
  features: {},
};

function installApi(settings: Record<string, unknown> = STARTUP_SETTINGS) {
  const { api } = makeMockLvisApi({ settings });
  (globalThis as unknown as { window: typeof window }).window.lvisApi = api as never;
  return api;
}

describe("StartupTab", () => {
  it("loads persisted settings on mount", async () => {
    installApi({
      ...STARTUP_SETTINGS,
      shortcuts: { toggleWindow: "CommandOrControl+Shift+Space", enabled: true },
    });
    const { findByTestId } = render(<StartupTab />);
    const capture = await findByTestId("startup-accelerator-capture");
    await waitFor(() => {
      expect(capture.textContent).toContain("CommandOrControl+Shift+Space");
    });
    const enabled = await findByTestId("startup-shortcut-enabled");
    expect(enabled.getAttribute("aria-checked")).toBe("true");
  });

  it("toggling 'enable global shortcut' persists through updateSettings", async () => {
    const api = installApi();
    const { findByTestId } = render(<StartupTab />);
    const enabled = await findByTestId("startup-shortcut-enabled");
    await waitFor(() => expect(enabled.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(enabled);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: { enabled: true } });
    });
  });

  it("toggling launch-at-startup persists through updateSettings", async () => {
    const api = installApi();
    const { findByTestId } = render(<StartupTab />);
    const launch = await findByTestId("startup-launch-at-startup");
    await waitFor(() => expect(launch.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(launch);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ system: { launchAtStartup: true } });
    });
  });

  it("records an accelerator via keydown capture and persists it", async () => {
    const api = installApi();
    const { findByTestId } = render(<StartupTab />);
    const record = await findByTestId("startup-accelerator-record");
    fireEvent.click(record);
    const capture = await findByTestId("startup-accelerator-capture");
    // Press CommandOrControl+Shift+K.
    fireEvent.keyDown(capture, { key: "k", ctrlKey: true, shiftKey: true });
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        shortcuts: { toggleWindow: "CommandOrControl+Shift+K" },
      });
    });
  });

  it("ignores a modifier-only keypress during capture", async () => {
    const api = installApi();
    const { findByTestId } = render(<StartupTab />);
    const record = await findByTestId("startup-accelerator-record");
    fireEvent.click(record);
    const capture = await findByTestId("startup-accelerator-capture");
    (api.updateSettings as ReturnType<typeof vi.fn>).mockClear();
    // A bare Shift press must NOT persist anything.
    fireEvent.keyDown(capture, { key: "Shift", shiftKey: true });
    // Give React a tick; nothing should have been written.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.updateSettings).not.toHaveBeenCalled();
  });

  it("shows the 'enabled but no accelerator' warning", async () => {
    installApi({
      ...STARTUP_SETTINGS,
      shortcuts: { toggleWindow: null, enabled: true },
    });
    const { findByText } = render(<StartupTab />);
    // The warning key resolves through i18n; assert the rendered warning text
    // node exists (ko runtime locale in this suite).
    await waitFor(async () => {
      const warn = await findByText(/활성화|no key combination|enabled/i);
      expect(warn).toBeTruthy();
    });
  });

  it("clearing the accelerator persists null", async () => {
    const api = installApi({
      ...STARTUP_SETTINGS,
      shortcuts: { toggleWindow: "Alt+F1", enabled: true },
    });
    const { findByTestId } = render(<StartupTab />);
    const clear = await findByTestId("startup-accelerator-clear");
    await waitFor(() => expect(clear.getAttribute("disabled")).toBeNull());
    fireEvent.click(clear);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ shortcuts: { toggleWindow: null } });
    });
  });
});

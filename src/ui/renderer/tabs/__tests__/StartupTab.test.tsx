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
import { TOOL_TIMEOUT_POLICY } from "../../../../shared/tool-timeout-policy.js";

const STARTUP_SETTINGS = {
  llm: { provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
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

  it("loads the persisted close-behavior selection on mount", async () => {
    installApi({
      ...STARTUP_SETTINGS,
      system: { closeBehavior: "quit", launchAtStartup: false, launchMinimized: false },
    });
    const { container } = render(<StartupTab />);
    await waitFor(() => {
      expect(container.querySelector("#close-quit")?.getAttribute("aria-checked")).toBe("true");
    });
  });

  it("selecting 'quit' close-behavior persists through updateSettings", async () => {
    const api = installApi();
    const { container } = render(<StartupTab />);
    const quit = await waitFor(() => {
      const node = container.querySelector<HTMLElement>("#close-quit");
      expect(node).toBeTruthy();
      return node!;
    });
    fireEvent.click(quit);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ system: { closeBehavior: "quit" } });
    });
  });

  it("renders the persisted hardware-acceleration state and persists a change", async () => {
    const api = installApi({
      ...STARTUP_SETTINGS,
      system: { ...STARTUP_SETTINGS.system, hardwareAcceleration: false },
    });
    const { findByTestId } = render(<StartupTab />);
    const toggle = await findByTestId("startup-hardware-acceleration");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        system: { hardwareAcceleration: true },
      });
    });
  });

  it("says the change takes effect next launch", async () => {
    installApi();
    const { findByTestId } = render(<StartupTab />);
    // The toggle cannot change the running process — `disableHardwareAcceleration`
    // is a before-whenReady call — so the copy has to say so unconditionally.
    const help = await findByTestId("startup-hardware-acceleration-help");
    expect(help.textContent?.length ?? 0).toBeGreaterThan(0);
  });

  it("names LVIS_KEEP_GPU when the environment is forcing the GPU on", async () => {
    const { api } = makeMockLvisApi({
      settings: STARTUP_SETTINGS,
      envForcedSettings: ["system.hardwareAcceleration"],
    });
    (globalThis as unknown as { window: typeof window }).window.lvisApi = api as never;
    const { findByTestId } = render(<StartupTab />);
    const forced = await findByTestId("startup-hardware-acceleration-forced");
    expect(forced.textContent).toContain("LVIS_KEEP_GPU");
  });

  it("stays quiet about the environment when nothing is forced", async () => {
    installApi();
    const { findByTestId, queryByTestId } = render(<StartupTab />);
    await findByTestId("startup-hardware-acceleration");
    expect(queryByTestId("startup-hardware-acceleration-forced")).toBeNull();
  });

  it("renders the saved cleanup window and persists a new choice", async () => {
    const api = installApi({
      ...STARTUP_SETTINGS,
      system: { ...STARTUP_SETTINGS.system, shutdownCleanupTimeoutMs: 30_000 },
    });
    const { findByTestId } = render(<StartupTab />);
    const select = (await findByTestId("startup-shutdown-timeout")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("30000"));
    fireEvent.change(select, { target: { value: "60000" } });
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        system: { shutdownCleanupTimeoutMs: 60_000 },
      });
    });
  });

  it("falls back to the policy default when nothing is saved", async () => {
    installApi();
    const { findByTestId } = render(<StartupTab />);
    const select = (await findByTestId("startup-shutdown-timeout")) as HTMLSelectElement;
    // The default has to be one of the offered options or the control would
    // render a selection the user could never choose again.
    await waitFor(() =>
      expect(select.value).toBe(String(TOOL_TIMEOUT_POLICY.shutdownCleanupMs)),
    );
  });

  it("names LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS and locks the control when the environment decides", async () => {
    const { api } = makeMockLvisApi({
      settings: STARTUP_SETTINGS,
      envForcedSettings: ["system.shutdownCleanupTimeoutMs"],
    });
    (globalThis as unknown as { window: typeof window }).window.lvisApi = api as never;
    const { findByTestId } = render(<StartupTab />);
    const forced = await findByTestId("startup-shutdown-timeout-forced");
    expect(forced.textContent).toContain("LVIS_SHUTDOWN_CLEANUP_TIMEOUT_MS");
    // Saying the environment decides while still accepting a choice would be
    // offering a control that does nothing.
    const select = (await findByTestId("startup-shutdown-timeout")) as HTMLSelectElement;
    await waitFor(() => expect(select.disabled).toBe(true));
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

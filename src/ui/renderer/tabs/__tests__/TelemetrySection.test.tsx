/**
 * TelemetrySection — the settings surface for the `telemetry` block.
 *
 * The defect this section exists to fix is covered first: before it, the
 * first-boot consent answer was the only write to `telemetry.enabled` and
 * there was no way to change it afterwards.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { TelemetrySection } from "../TelemetrySection.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

const BASE_SETTINGS = {
  llm: { provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  system: {},
  shortcuts: { toggleWindow: null, enabled: false },
  features: {},
  telemetry: { enabled: false, crashReportingEnabled: false },
};

function installApi(overrides: Parameters<typeof makeMockLvisApi>[0] = {}) {
  const { api } = makeMockLvisApi({ settings: BASE_SETTINGS, ...overrides });
  (globalThis as unknown as { window: typeof window }).window.lvisApi = api as never;
  return api;
}

describe("TelemetrySection", () => {
  it("turns telemetry back off after a consent answer that turned it on", async () => {
    const api = installApi({
      settings: {
        ...BASE_SETTINGS,
        telemetry: { enabled: true, telemetryPromptAnswered: true },
      },
    });
    const { findByTestId } = render(<TelemetrySection />);
    const toggle = await findByTestId("telemetry-enabled");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        telemetry: { enabled: false, telemetryPromptAnswered: true },
      });
    });
  });

  it("marks the consent prompt answered when the switch is the answer", async () => {
    const api = installApi();
    const { findByTestId } = render(<TelemetrySection />);
    const toggle = await findByTestId("telemetry-enabled");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        telemetry: { enabled: true, telemetryPromptAnswered: true },
      });
    });
  });

  it("loads the stored endpoint and persists an edited one on save", async () => {
    const api = installApi({
      settings: {
        ...BASE_SETTINGS,
        telemetry: { enabled: true, endpoint: "https://old.example.com/v1" },
      },
    });
    const { findByTestId } = render(<TelemetrySection />);
    const input = (await findByTestId("telemetry-endpoint")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("https://old.example.com/v1"));
    fireEvent.change(input, { target: { value: "  https://new.example.com/v1  " } });
    fireEvent.click(await findByTestId("telemetry-endpoint-save"));
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        telemetry: { endpoint: "https://new.example.com/v1" },
      });
    });
  });

  it("shows the allowed hosts the endpoint is bounded by", async () => {
    installApi({ telemetryAllowedHosts: ["metrics.corp.example", "localhost"] });
    const { findByTestId } = render(<TelemetrySection />);
    const hosts = await findByTestId("telemetry-allowed-hosts");
    await waitFor(() => {
      expect(hosts.textContent).toContain("metrics.corp.example, localhost");
    });
  });

  it("locks the Sentry DSN and says why when the environment supplies it", async () => {
    installApi({ envForcedSettings: ["telemetry.sentryDsn"] });
    const { findByTestId } = render(<TelemetrySection />);
    const input = (await findByTestId("telemetry-sentry-dsn")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(true));
    const notice = await findByTestId("telemetry-sentry-dsn-forced");
    expect(notice.textContent).toContain("LVIS_SENTRY_DSN");
  });

  it("keeps the crash-report endpoint unreachable while crash reporting is off", async () => {
    installApi();
    const { findByTestId } = render(<TelemetrySection />);
    const input = (await findByTestId("telemetry-crash-endpoint")) as HTMLInputElement;
    await waitFor(() => expect(input.disabled).toBe(true));
    fireEvent.click(await findByTestId("telemetry-crash-reporting"));
    await waitFor(() => expect(input.disabled).toBe(false));
  });
});

import "../../../../../test/renderer/setup.js";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { LocalApiSurfacesSection } from "../LocalApiSurfacesSection.js";

const getSettings = vi.fn();
const updateSettings = vi.fn();
const envForcedSettings = vi.fn();

vi.mock("../../api-client.js", () => ({
  getApi: () => ({ getSettings, updateSettings, envForcedSettings }),
}));

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
  getSettings.mockResolvedValue({ system: {}, features: {} });
  updateSettings.mockResolvedValue({});
  envForcedSettings.mockResolvedValue([]);
});

afterEach(() => {
  setLocale(localeBeforeTest);
  vi.clearAllMocks();
});

describe("LocalApiSurfacesSection", () => {
  it("offers all four gates a packaged app had no way to reach", async () => {
    render(<LocalApiSurfacesSection />);

    for (const id of [
      "local-api-surfaces-local-api",
      "local-api-surfaces-a2a-loopback",
      "local-api-surfaces-a2a-remote-routing",
      "local-api-surfaces-a2a-remote-receiver",
    ]) {
      await waitFor(() => expect(screen.getByTestId(id)).toBeTruthy());
    }
    // The gates are read once at boot, so the section must not imply the
    // surface came up the moment the switch moved.
    expect(screen.getByTestId("local-api-surfaces-restart-note")).toBeTruthy();
  });

  it("writes only the settings key behind the switch that moved", async () => {
    render(<LocalApiSurfacesSection />);
    const toggle = await screen.findByTestId("local-api-surfaces-a2a-remote-routing");

    fireEvent.click(toggle);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({
      features: { a2aRemoteRouting: true },
    }));
  });

  it("puts the switch back when the host refuses the change", async () => {
    updateSettings.mockResolvedValue({ ok: false, error: "managed", message: "Managed by policy" });
    render(<LocalApiSurfacesSection />);
    const toggle = await screen.findByTestId("local-api-surfaces-local-api");

    fireEvent.click(toggle);

    const error = await screen.findByTestId("local-api-surfaces-error");
    expect(error.textContent).toContain("Managed by policy");
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
  });

  it("names the variable when the environment is forcing a gate on", async () => {
    envForcedSettings.mockResolvedValue(["system.localApiServer"]);
    render(<LocalApiSurfacesSection />);

    const note = await screen.findByTestId("local-api-surfaces-local-api-forced");
    expect(note.textContent).toContain("LVIS_LOCAL_API");
    // Only the forced gate says so.
    expect(screen.queryByTestId("local-api-surfaces-a2a-loopback-forced")).toBeNull();
  });

  it("reflects what is already saved rather than defaulting to off", async () => {
    getSettings.mockResolvedValue({
      system: { localApiServer: true },
      features: { a2aLoopbackServer: true },
    });

    render(<LocalApiSurfacesSection />);

    await waitFor(() => expect(
      screen.getByTestId("local-api-surfaces-local-api").getAttribute("aria-checked"),
    ).toBe("true"));
    expect(screen.getByTestId("local-api-surfaces-a2a-loopback").getAttribute("aria-checked"))
      .toBe("true");
    expect(screen.getByTestId("local-api-surfaces-a2a-remote-routing").getAttribute("aria-checked"))
      .toBe("false");
  });
});

import "../../../../../test/renderer/setup.js";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../../i18n/runtime.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../EnvForcedNotice.js";

const envForcedSettings = vi.fn();

vi.mock("../../api-client.js", () => ({
  getApi: () => ({ envForcedSettings }),
}));

let localeBeforeTest = getLocale();

beforeEach(() => {
  localeBeforeTest = getLocale();
  setLocale("en");
  envForcedSettings.mockResolvedValue([]);
});

afterEach(() => {
  setLocale(localeBeforeTest);
  vi.clearAllMocks();
});

function Harness({ settingsPath }: { settingsPath: string }) {
  const forcedPaths = useEnvForcedSettings();
  return (
    <EnvForcedNotice
      settingsPath={settingsPath}
      forcedPaths={forcedPaths}
      messageKey="startupTab.corpCaEnabledEnvForced"
      testId="notice"
    />
  );
}

describe("EnvForcedNotice", () => {
  it("names the variable that is deciding the setting", async () => {
    envForcedSettings.mockResolvedValue(["system.corpCaEnabled"]);

    render(<Harness settingsPath="system.corpCaEnabled" />);

    await waitFor(() => expect(screen.getByTestId("notice")).toBeTruthy());
    expect(screen.getByTestId("notice").textContent).toContain("LVIS_SKIP_CORP_CA");
  });

  it("says nothing while the host has not answered yet", () => {
    render(<Harness settingsPath="system.corpCaEnabled" />);

    // The fetch has not resolved: claiming the environment decides this before
    // knowing would be the one wrong thing to render.
    expect(screen.queryByTestId("notice")).toBeNull();
  });

  it("says nothing for a setting the environment is not forcing", async () => {
    envForcedSettings.mockResolvedValue(["system.corpCaDebugLog"]);

    render(<Harness settingsPath="system.corpCaEnabled" />);

    await waitFor(() => expect(envForcedSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("notice")).toBeNull();
  });

  it("says nothing when no variable is known for the forced path", async () => {
    // A path the host reports but the registry does not know is a wiring
    // mistake; a sentence naming an empty variable tells the user less than
    // silence does.
    envForcedSettings.mockResolvedValue(["system.notARegisteredSetting"]);

    render(<Harness settingsPath="system.notARegisteredSetting" />);

    await waitFor(() => expect(envForcedSettings).toHaveBeenCalled());
    expect(screen.queryByTestId("notice")).toBeNull();
  });
});

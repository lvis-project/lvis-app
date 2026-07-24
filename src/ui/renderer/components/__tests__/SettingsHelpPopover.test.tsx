// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsPageHeader } from "../SettingsPageHeader.js";
import { SettingsSection } from "../SettingsSection.js";

afterEach(cleanup);

describe("settings help popovers", () => {
  it("opens a page description from the title-adjacent help button", async () => {
    render(
      <SettingsPageHeader
        title="Model"
        description="Choose the model provider, API key, and fallback chain."
      />,
    );

    expect(screen.queryByText("Choose the model provider, API key, and fallback chain.")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-page-help"));

    await waitFor(() => {
      expect(screen.getByText("Choose the model provider, API key, and fallback chain.")).toBeTruthy();
    });
  });

  it("opens a section description from the title-adjacent help button", async () => {
    render(
      <SettingsSection
        title="Provider configuration"
        description="Configure the active provider and model."
      >
        <div>Section contents</div>
      </SettingsSection>,
    );

    expect(screen.queryByText("Configure the active provider and model.")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-section-help"));

    await waitFor(() => {
      expect(screen.getByText("Configure the active provider and model.")).toBeTruthy();
    });
  });
});

/**
 * A pick in the settings model chooser is the decision: it persists on its
 * own, through the same debounced save the vendor row and the thinking
 * controls use, without the section's Save button.
 */
import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { makeMockLvisApi } from "./mock-lvis-api.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("settings model chooser", () => {
  it("persists a pick without the Save button", async () => {
    const { api } = makeMockLvisApi();
    vi.stubGlobal("lvisApi", api);
    (window as unknown as { lvisApi: typeof api }).lvisApi = api;
    const { SettingsContent } = await import("../../src/ui/renderer/SettingsContent.js");
    const { TooltipProvider } = await import("../../src/components/ui/tooltip.js");

    const view = render(
      <TooltipProvider>
        <SettingsContent api={api as never} chatGroupId="main" onSaved={() => {}} initialTab="llm" />
      </TooltipProvider>,
    );
    const trigger = await view.findByTestId("llm-model-select");
    await waitFor(() => expect(view.getByTestId("llm-tab:save-providers")).not.toBeDisabled());
    api.updateSettings.mockClear();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const options = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[role='option']")];
      if (found.length < 2) throw new Error("chooser not open yet");
      return found;
    });
    const current = trigger.textContent ?? "";
    const other = options.find((o) => !current.includes(o.textContent?.replace(/^\S+/, "").trim() ?? "\u0000"))
      ?? options[1]!;
    other.focus();
    fireEvent.keyDown(other, { key: "Enter" });

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled(), { timeout: 2_000 });
    const patch = api.updateSettings.mock.calls.at(-1)![0] as { llm: { provider: string; vendors: Record<string, { model: string }> } };
    // Equality, not containment: a stale `gpt-5.4` would sit inside a picked
    // `gpt-5.4-mini` and pass a substring check.
    const pickedModelId = other.querySelector("[data-model-id]")?.getAttribute("data-model-id");
    expect(pickedModelId).toBeTruthy();
    expect(patch.llm.vendors[patch.llm.provider]!.model).toBe(pickedModelId);
  });
});

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
    // The chooser offers what the endpoint answered — a vendor with a fixed
    // /models endpoint has no bundled list standing in — so there is nothing
    // to pick between until a catalogue lands.
    api.listLlmModels = vi.fn(async () => ({
      ok: true,
      vendor: "openai",
      endpoint: "https://api.openai.com/v1/models",
      models: ["gpt-4o-mini", "gpt-4o", "o3"],
      fetchedAt: "2026-01-01T00:00:00.000Z",
    }));
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
    // The pick must ride hydrated settings. Save now belongs to whichever
    // provider card is open, so the section's own hydration flag is the
    // readiness signal rather than a button that may not be on screen.
    await waitFor(() => expect(view.getByTestId("llm-tab:section-providers"))
      .toHaveAttribute("data-settings-loaded", "true"));
    api.updateSettings.mockClear();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const options = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>("[role='option']")];
      if (found.length < 2) throw new Error("chooser not open yet");
      return found;
    });
    // By model id, not by rendered text: the row prints provider and id in
    // adjacent spans, so textContent runs them together and a substring test
    // can land back on the model that is already selected — which Radix does
    // not report as a change, and nothing would be saved.
    const currentModelId = trigger.querySelector("[data-model-id]")?.getAttribute("data-model-id");
    const other = options.find((option) => {
      const id = option.querySelector("[data-model-id]")?.getAttribute("data-model-id");
      return Boolean(id) && id !== currentModelId;
    });
    expect(other).toBeTruthy();
    other!.focus();
    fireEvent.keyDown(other!, { key: "Enter" });

    type VendorPatch = { llm: { provider: string; vendors: Record<string, { model: string }> } };
    // The catalogue's own cache is persisted through the same call, so the
    // last write is not necessarily the pick — take the one carrying vendors.
    const vendorPatch = () => api.updateSettings.mock.calls
      .map((call) => call[0] as Partial<VendorPatch>)
      .filter((call): call is VendorPatch => Boolean(call.llm?.vendors))
      .at(-1);
    await waitFor(() => expect(vendorPatch()).toBeTruthy(), { timeout: 2_000 });
    const patch = vendorPatch()!;
    // Equality, not containment: a stale `gpt-5.4` would sit inside a picked
    // `gpt-5.4-mini` and pass a substring check.
    const pickedModelId = other!.querySelector("[data-model-id]")?.getAttribute("data-model-id");
    expect(pickedModelId).toBeTruthy();
    expect(patch.llm.vendors[patch.llm.provider]!.model).toBe(pickedModelId);
  });
});

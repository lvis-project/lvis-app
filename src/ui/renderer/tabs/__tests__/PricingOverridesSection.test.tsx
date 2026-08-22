/**
 * PricingOverridesSection — the control that replaces `LVIS_PRICING_OVERRIDE`.
 *
 * The rules worth pinning are the ones a table editor gets wrong: a row the
 * store would silently drop must not be savable, a settings broadcast must not
 * wipe a half-typed row, and the whole table must go read-only when the
 * environment is the one supplying the rates.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { PricingOverridesSection } from "../PricingOverridesSection.js";
import { installMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";


const BASE_SETTINGS = {
  llm: {
    provider: "openai",
    vendors: {},
    streamSmoothing: "none",
    fallbackChain: [],
    pricingOverrides: [],
  },
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  system: {},
  shortcuts: { toggleWindow: null, enabled: false },
  features: {},
};

function withOverrides(pricingOverrides: unknown[]) {
  return { ...BASE_SETTINGS, llm: { ...BASE_SETTINGS.llm, pricingOverrides } };
}

describe("PricingOverridesSection", () => {
  it("says nothing is corrected when the list is empty", async () => {
    installMockLvisApi({ settings: BASE_SETTINGS });
    const { findByTestId } = render(<PricingOverridesSection />);
    await findByTestId("llm-pricing-overrides-empty");
  });

  it("loads a stored correction into the table", async () => {
    installMockLvisApi({
      settings: withOverrides([
        { vendor: "claude", model: "claude-sonnet-4-6", inputPer1M: 2, outputPer1M: 9 },
      ]),
    });
    const { findByTestId } = render(<PricingOverridesSection />);
    await waitFor(async () => {
      expect(((await findByTestId("llm-pricing-override-model-0")) as HTMLInputElement).value)
        .toBe("claude-sonnet-4-6");
    });
    expect(((await findByTestId("llm-pricing-override-input-0")) as HTMLInputElement).value).toBe("2");
    expect(((await findByTestId("llm-pricing-override-output-0")) as HTMLInputElement).value).toBe("9");
  });

  it("refuses to save a row the store would silently drop", async () => {
    installMockLvisApi({ settings: BASE_SETTINGS });
    const { findByTestId } = render(<PricingOverridesSection />);
    fireEvent.click(await findByTestId("llm-pricing-override-add"));
    const save = (await findByTestId("llm-pricing-override-save")) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(true));
    await findByTestId("llm-pricing-override-incomplete");

    fireEvent.change(await findByTestId("llm-pricing-override-model-0"), { target: { value: "gpt-4o" } });
    fireEvent.change(await findByTestId("llm-pricing-override-input-0"), { target: { value: "5" } });
    await waitFor(() => expect(save.disabled).toBe(true)); // output rate still missing
  });

  it("persists a completed row through updateSettings", async () => {
    const api = installMockLvisApi({ settings: BASE_SETTINGS });
    const { findByTestId } = render(<PricingOverridesSection />);
    fireEvent.click(await findByTestId("llm-pricing-override-add"));
    fireEvent.change(await findByTestId("llm-pricing-override-vendor-0"), { target: { value: "openai" } });
    fireEvent.change(await findByTestId("llm-pricing-override-model-0"), { target: { value: "  gpt-4o  " } });
    fireEvent.change(await findByTestId("llm-pricing-override-input-0"), { target: { value: "2.5" } });
    fireEvent.change(await findByTestId("llm-pricing-override-output-0"), { target: { value: "0" } });
    fireEvent.click(await findByTestId("llm-pricing-override-save"));
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({
        llm: {
          pricingOverrides: [
            { vendor: "openai", model: "gpt-4o", inputPer1M: 2.5, outputPer1M: 0 },
          ],
        },
      });
    });
  });

  it("removes a row and persists the shorter list", async () => {
    const api = installMockLvisApi({
      settings: withOverrides([
        { vendor: "claude", model: "claude-sonnet-4-6", inputPer1M: 2, outputPer1M: 9 },
      ]),
    });
    const { findByTestId } = render(<PricingOverridesSection />);
    fireEvent.click(await findByTestId("llm-pricing-override-remove-0"));
    fireEvent.click(await findByTestId("llm-pricing-override-save"));
    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalledWith({ llm: { pricingOverrides: [] } });
    });
  });

  it("goes read-only and says why when the environment supplies the rates", async () => {
    installMockLvisApi({
      envForcedSettings: ["llm.pricingOverrides"],
      settings: withOverrides([
        { vendor: "claude", model: "claude-sonnet-4-6", inputPer1M: 2, outputPer1M: 9 },
      ]),
    });
    const { findByTestId } = render(<PricingOverridesSection />);
    const model = (await findByTestId("llm-pricing-override-model-0")) as HTMLInputElement;
    await waitFor(() => expect(model.disabled).toBe(true));
    expect(((await findByTestId("llm-pricing-override-add")) as HTMLButtonElement).disabled).toBe(true);
    expect(((await findByTestId("llm-pricing-override-remove-0")) as HTMLButtonElement).disabled).toBe(true);
    const notice = await findByTestId("llm-pricing-overrides-forced");
    expect(notice.textContent).toContain("LVIS_PRICING_OVERRIDE");
  });
});

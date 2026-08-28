/**
 * Settings tab read-back.
 *
 * `initialTab` has always let an embedder WRITE the settings tab; nothing let it
 * observe a move the user makes inside the panel, so anything outside had to
 * assume the tab it opened on was still the tab in view.
 *
 * These tests wire the panel the way the app does — the consumer's own state is
 * BOTH the seed (`initialTab`) and the sink (`onTabChange`) — and assert on the
 * value that consumer renders. Asserting the callback fired would only prove the
 * component's own rule; the point here is that the value reaches the outside and
 * survives the round trip back in.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import { makeMockLvisApi } from "./mock-lvis-api.js";
import { activeSettingsTab, clickSettingsTab, settingsTabTrigger } from "./helpers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Embedder = "content" | "inline";

async function renderWithConsumer(embedder: Embedder) {
  const { api } = makeMockLvisApi();
  vi.stubGlobal("lvisApi", api);
  (window as unknown as { lvisApi: typeof api }).lvisApi = api;

  const { SettingsContent } = await import("../../src/ui/renderer/SettingsContent.js");
  const { SettingsInlineView } = await import("../../src/ui/renderer/SettingsInlineView.js");
  const { TooltipProvider } = await import("../../src/components/ui/tooltip.js");

  /**
   * Stand-in for the app: holds the tab, seeds the panel with it, and renders it
   * where a test can read it — the same shape as App's `settingsTab` +
   * `onSettingsTabChange`.
   */
  function Consumer() {
    const [settingsTab, setSettingsTab] = useState("llm");
    return (
      <TooltipProvider>
        <div data-testid="consumer-tab">{settingsTab}</div>
        {embedder === "content" ? (
          <SettingsContent
            api={api as never}
            chatGroupId="main"
            onSaved={() => {}}
            initialTab={settingsTab}
            onTabChange={setSettingsTab}
          />
        ) : (
          <SettingsInlineView
            api={api as never}
            chatGroupId="main"
            onSaved={() => {}}
            initialTab={settingsTab}
            onTabChange={setSettingsTab}
          />
        )}
      </TooltipProvider>
    );
  }

  const result = render(<Consumer />);
  await waitFor(() => expect(settingsTabTrigger(result.container, "permissions")).toBeTruthy());
  return { ...result, api };
}

function consumerTab(container: HTMLElement): string {
  return container.querySelector('[data-testid="consumer-tab"]')?.textContent ?? "";
}

describe("settings navigation footer", () => {
  it("names the version main reports, not a literal typed at some release", async () => {
    const { container, api } = await renderWithConsumer("content");
    const footer = container.querySelector('[data-testid="settings-nav-app-version"]');
    expect(footer).toBeTruthy();
    await waitFor(() => expect(footer?.textContent).toBe("v0.0.0-test"));
    expect(api.getAppInfo).toHaveBeenCalled();
  });
});

describe.each<Embedder>(["content", "inline"])("settings tab read-back (%s)", (embedder) => {
  it("hands the new tab to the consumer when the user moves inside the panel", async () => {
    const { container } = await renderWithConsumer(embedder);

    // The consumer opened the panel on the model tab and, until the user moves,
    // that is genuinely where they are.
    expect(consumerTab(container)).toBe("llm");
    expect(activeSettingsTab(container)).toBe("llm");

    clickSettingsTab(container, "permissions");

    // The value the OUTSIDE renders is what matters: without the read-back this
    // stays "llm" while the user looks at Permissions.
    await waitFor(() => expect(consumerTab(container)).toBe("permissions"));
  });

  it("does not bounce the selection when the consumer echoes the value back as the seed", async () => {
    const { container } = await renderWithConsumer(embedder);

    clickSettingsTab(container, "permissions");
    await waitFor(() => expect(consumerTab(container)).toBe("permissions"));

    // The consumer feeds its state straight back in as `initialTab`, which
    // re-seeds the panel. An unstable round trip would show up here as the
    // panel snapping back to the seed, or oscillating between the two.
    await waitFor(() => expect(activeSettingsTab(container)).toBe("permissions"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(activeSettingsTab(container)).toBe("permissions");
    expect(consumerTab(container)).toBe("permissions");
  });

  it("also reports a move the panel makes on the user's behalf", async () => {
    const { container } = await renderWithConsumer(embedder);

    // Not every tab move is a click on the tab list: the model tab's
    // "more in marketplace" affordance navigates the panel itself. That path
    // has its own writer, so it is its own chance to skip the read-back.
    const marketplaceButton = await waitFor(() => {
      const el = container.querySelector<HTMLElement>('[data-testid="llm-tab:marketplace-providers"]');
      if (!el) throw new Error("marketplace affordance not rendered");
      return el;
    });
    fireEvent.click(marketplaceButton);

    await waitFor(() => expect(consumerTab(container)).toBe("marketplace"));
    expect(activeSettingsTab(container)).toBe("marketplace");
  });
});

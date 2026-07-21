/**
 * WebTab — the webView preferredFlow (외부 URL 표시 정책) radio group was
 * relocated here from AppearanceTab because it is browsing behavior and
 * belongs on the Web / Browsing tab. Testid + data-value contract is kept
 * stable so the e2e toggle spec keeps working after the move.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { WebTab } from "../WebTab.js";
import type { LvisApi } from "../../types.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

const WEB_SETTINGS = {
  llm: { provider: "openai", vendors: {}, streamSmoothing: "none", fallbackChain: [] },
  chat: { systemPrompt: "", autoCompact: true },
  webSearch: { provider: "none" },
  webView: { preferredFlow: "in-app" },
  features: {},
};

function installApi(settings: Record<string, unknown> = WEB_SETTINGS): LvisApi {
  const { api } = makeMockLvisApi({ settings });
  (globalThis as unknown as { window: typeof window }).window.lvisApi = api as never;
  return api as unknown as LvisApi;
}

function renderWebTab(api = installApi()) {
  return render(
    <WebTab
      api={api}
      webProvider="none"
      setWebProvider={() => {}}
      hasWebKey={false}
      setHasWebKey={() => {}}
      webKeyInput=""
      setWebKeyInput={() => {}}
      onSaved={() => {}}
    />,
  );
}

describe("WebTab — webView preferredFlow section", () => {
  it("renders in-app and system-browser radio options (relocated from Appearance)", () => {
    const { getByTestId } = renderWebTab();
    const group = getByTestId("webview-preferred-flow");
    expect(group).toBeTruthy();
    expect(group.querySelector('[data-value="in-app"]')).toBeTruthy();
    expect(group.querySelector('[data-value="system-browser"]')).toBeTruthy();
  });
});

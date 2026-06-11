/**
 * LlmTab top-level login toggle UI tests.
 *
 * Verifies that when `authMode === "login"` the LlmTab renders the vendor
 * dropdown and per-vendor fields in a DISABLED state (not removed from the
 * DOM) — the user sees the active login-session values and understands that
 * logging out will restore edit access.
 *
 * When `authMode === "manual"` the full per-vendor form is enabled and
 * editable.
 *
 * Also verifies the host-resolver map textarea renders in both modes.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { LlmTab, type FallbackEntry } from "../LlmTab.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

type HarnessApi = Parameters<typeof LlmTab>[0]["api"];

function llmTabApi(): HarnessApi {
  const { api } = makeMockLvisApi();
  return api as unknown as HarnessApi;
}

function Harness({
  initialAuthMode,
  initialHostResolverMap = "",
  loadedHostResolverMap = "",
  api,
}: {
  initialAuthMode: "manual" | "login";
  initialHostResolverMap?: string;
  loadedHostResolverMap?: string;
  api?: HarnessApi;
}) {
  const [authMode, setAuthMode] = useState<"manual" | "login">(initialAuthMode);
  const [vendor, setVendor] = useState("openai");
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState("gpt-5.4-mini");
  const [baseUrl, setBaseUrl] = useState("");
  const [vertexProject, setVertexProject] = useState("");
  const [vertexLocation, setVertexLocation] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [enableThinking, setEnableThinking] = useState(true);
  const [thinkingBudget, setThinkingBudget] = useState(10_000);
  const [fallbackChain, setFallbackChain] = useState<FallbackEntry[]>([]);
  const [fallbackOpen, setFallbackOpen] = useState(false);
  const [hostResolverMap, setHostResolverMap] = useState(initialHostResolverMap);
  return (
    <LlmTab
      api={api ?? llmTabApi()}
      vendor={vendor}
      setVendor={setVendor}
      baseUrl={baseUrl}
      setBaseUrl={setBaseUrl}
      vertexProject={vertexProject}
      setVertexProject={setVertexProject}
      vertexLocation={vertexLocation}
      setVertexLocation={setVertexLocation}
      hasKey={hasKey}
      setHasKey={setHasKey}
      keyInput={keyInput}
      setKeyInput={setKeyInput}
      authMode={authMode}
      setAuthMode={setAuthMode}
      onOpenLogin={vi.fn()}
      model={model}
      setModel={setModel}
      enableThinking={enableThinking}
      setEnableThinking={setEnableThinking}
      thinkingBudget={thinkingBudget}
      setThinkingBudget={setThinkingBudget}
      fallbackChain={fallbackChain}
      setFallbackChain={setFallbackChain}
      fallbackOpen={fallbackOpen}
      setFallbackOpen={setFallbackOpen}
      hostResolverMap={hostResolverMap}
      setHostResolverMap={setHostResolverMap}
      loadedHostResolverMap={loadedHostResolverMap}
      onSaved={vi.fn()}
    />
  );
}

describe("LlmTab — top-level login toggle UI", () => {
  it("renders manual-section as disabled when authMode='login'", () => {
    const { container } = render(<Harness initialAuthMode="login" />);
    // Login status section is visible.
    expect(container.querySelector('[data-testid="llm-tab:login-section"]')).not.toBeNull();
    // Login button present.
    expect(container.querySelector('[data-testid="llm-tab:open-login"]')).not.toBeNull();
    // Manual section IS in the DOM but marked aria-disabled.
    const manualSection = container.querySelector('[data-testid="llm-tab:manual-section"]');
    expect(manualSection).not.toBeNull();
    expect(manualSection?.getAttribute("aria-disabled")).toBe("true");
    // Vendor select rendered but disabled.
    const vendorTrigger = container.querySelector('#vendor-select');
    expect(vendorTrigger).not.toBeNull();
    // Model selector rendered.
    expect(container.querySelector('[data-testid="llm-model-select"]')).not.toBeNull();
    // API key input disabled.
    const keyInput = container.querySelector('[data-testid="llm-api-key-input"]') as HTMLInputElement | null;
    expect(keyInput).not.toBeNull();
    expect(keyInput?.disabled).toBe(true);
  });

  it("renders vendor dropdown and per-vendor fields enabled when authMode='manual'", () => {
    const { container } = render(<Harness initialAuthMode="manual" />);
    const manualSection = container.querySelector('[data-testid="llm-tab:manual-section"]');
    expect(manualSection).not.toBeNull();
    // Not aria-disabled="true" in manual mode.
    expect(manualSection?.getAttribute("aria-disabled")).not.toBe("true");
    expect(container.querySelector('#vendor-select')).not.toBeNull();
    expect(container.querySelector('[data-testid="llm-model-select"]')).not.toBeNull();
    // Login section NOT shown in manual mode.
    expect(container.querySelector('[data-testid="llm-tab:login-section"]')).toBeNull();
  });

  it("host-resolver map textarea is disabled in login mode", () => {
    const { container } = render(<Harness initialAuthMode="login" />);
    const textarea = container.querySelector('[data-testid="llm-host-resolver-map-input"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(true);
  });

  it("host-resolver map textarea is enabled in manual mode", () => {
    const { container } = render(<Harness initialAuthMode="manual" />);
    const textarea = container.querySelector('[data-testid="llm-host-resolver-map-input"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);
  });

  it("apply-host-map button shown only in manual mode", () => {
    const { container: loginContainer } = render(<Harness initialAuthMode="login" />);
    expect(loginContainer.querySelector('[data-testid="llm-tab:apply-host-map"]')).toBeNull();

    const { container: manualContainer } = render(<Harness initialAuthMode="manual" />);
    expect(manualContainer.querySelector('[data-testid="llm-tab:apply-host-map"]')).not.toBeNull();
  });

  it("disables Apply when the host map is unchanged from the loaded value", () => {
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 endpoint.example.com"}
        loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
      />,
    );
    const applyBtn = container.querySelector(
      '[data-testid="llm-tab:apply-host-map"]',
    ) as HTMLButtonElement | null;
    expect(applyBtn).not.toBeNull();
    expect(applyBtn?.disabled).toBe(true);
  });

  it("enables Apply once the host map differs from the loaded value", () => {
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 changed.example.com"}
        loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
      />,
    );
    const applyBtn = container.querySelector(
      '[data-testid="llm-tab:apply-host-map"]',
    ) as HTMLButtonElement | null;
    expect(applyBtn?.disabled).toBe(false);
  });

  it("opens the relaunch dialog and applies the textarea value on confirm", async () => {
    const api = llmTabApi();
    const applyHostMap = vi.spyOn(
      api as unknown as { applyHostMap: (v: string) => Promise<{ ok: boolean }> },
      "applyHostMap",
    );
    const { container, getByTestId } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 changed.example.com"}
        loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
        api={api}
      />,
    );

    // No dialog confirm button until Apply is clicked.
    expect(container.querySelector('[data-testid="llm-tab:relaunch-confirm"]')).toBeNull();

    fireEvent.click(getByTestId("llm-tab:apply-host-map"));

    // Dialog now open with confirm button.
    const confirm = getByTestId("llm-tab:relaunch-confirm");
    expect(confirm).not.toBeNull();
    expect(applyHostMap).not.toHaveBeenCalled();

    // Confirm → api.applyHostMap called with the current textarea value.
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(applyHostMap).toHaveBeenCalledWith("10.0.0.10 changed.example.com");
  });

  it("renders the parsed entry count for a valid host map in manual mode", () => {
    const { container } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 a.example.com\n10.0.0.11 b.example.com"}
        loadedHostResolverMap={""}
      />,
    );
    const section = container.querySelector('[data-testid="llm-tab:host-resolver-section"]');
    // i18n plural form interpolates the count (en: "2 entries parsed").
    expect(section?.textContent).toContain("2");
  });

  it("toggles between manual and login via the auth-mode radio group", () => {
    const { container } = render(<Harness initialAuthMode="manual" />);
    // Manual mode: no login section, manual section not disabled.
    expect(container.querySelector('[data-testid="llm-tab:login-section"]')).toBeNull();
    const manualBefore = container.querySelector('[data-testid="llm-tab:manual-section"]');
    expect(manualBefore?.getAttribute("aria-disabled")).not.toBe("true");

    // Click the Login radio.
    const loginRadio = container.querySelector('#auth-mode-login') as HTMLElement;
    fireEvent.click(loginRadio);

    // After toggle: login section present, manual section disabled.
    expect(container.querySelector('[data-testid="llm-tab:login-section"]')).not.toBeNull();
    const manualAfter = container.querySelector('[data-testid="llm-tab:manual-section"]');
    expect(manualAfter?.getAttribute("aria-disabled")).toBe("true");
  });
});

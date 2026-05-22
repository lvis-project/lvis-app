/**
 * #893 — LlmTab top-level login toggle UI tests.
 *
 * Verifies that when `authMode === "login"` the LlmTab renders only the
 * Login status + Login button — the vendor dropdown and every per-vendor
 * field (baseUrl, vertex, API key, model selector) must be removed from the DOM.
 * When `authMode === "manual"` the full per-vendor form returns.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { LlmTab, type FallbackEntry } from "../LlmTab.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";

function llmTabApi() {
  const { api } = makeMockLvisApi();
  return api as unknown as Parameters<typeof LlmTab>[0]["api"];
}

function Harness({ initialAuthMode }: { initialAuthMode: "manual" | "login" }) {
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
  return (
    <LlmTab
      api={llmTabApi()}
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
      onSaved={vi.fn()}
    />
  );
}

describe("LlmTab — #893 top-level login toggle UI", () => {
  it("hides vendor dropdown and per-vendor fields when authMode='login'", () => {
    const { container } = render(<Harness initialAuthMode="login" />);
    // Login section visible.
    expect(container.querySelector('[data-testid="llm-tab:login-section"]')).not.toBeNull();
    // Vendor dropdown gone.
    expect(container.querySelector('#vendor-select')).toBeNull();
    // Manual section absent.
    expect(container.querySelector('[data-testid="llm-tab:manual-section"]')).toBeNull();
    // Model selector gone.
    expect(container.querySelector('[data-testid="llm-model-select"]')).toBeNull();
    // Login button present.
    expect(container.querySelector('[data-testid="llm-tab:open-login"]')).not.toBeNull();
  });

  it("renders vendor dropdown and per-vendor fields when authMode='manual'", () => {
    const { container } = render(<Harness initialAuthMode="manual" />);
    expect(container.querySelector('[data-testid="llm-tab:manual-section"]')).not.toBeNull();
    expect(container.querySelector('#vendor-select')).not.toBeNull();
    expect(container.querySelector('[data-testid="llm-model-select"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="llm-model-input"]')).toBeNull();
    expect(container.querySelector('[data-testid="llm-tab:login-section"]')).toBeNull();
  });

  it("toggles between manual and login via the auth-mode radio group", () => {
    const { container } = render(<Harness initialAuthMode="manual" />);
    // Manual visible initially.
    expect(container.querySelector('[data-testid="llm-tab:manual-section"]')).not.toBeNull();

    // Click the Login radio.
    const loginRadio = container.querySelector('#auth-mode-login') as HTMLElement;
    fireEvent.click(loginRadio);

    // After toggle: login section, no manual section.
    expect(container.querySelector('[data-testid="llm-tab:login-section"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="llm-tab:manual-section"]')).toBeNull();
    expect(container.querySelector('#vendor-select')).toBeNull();
  });
});

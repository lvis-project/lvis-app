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
import { VENDORS } from "../../constants.js";
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
  initialVendor = "openai",
  settingsLoaded = true,
  api,
}: {
  initialAuthMode: "manual" | "login";
  initialHostResolverMap?: string;
  loadedHostResolverMap?: string;
  initialVendor?: string;
  settingsLoaded?: boolean;
  api?: HarnessApi;
}) {
  const [authMode, setAuthMode] = useState<"manual" | "login">(initialAuthMode);
  const [vendor, setVendor] = useState(initialVendor);
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
      settingsLoaded={settingsLoaded}
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

  // (1) The login-mode logout affordance must not desync renderer state from
  // persisted llm.authMode. The old local `setAuthMode("manual")` button is
  // removed; only a hint pointing at the canonical GeneralTab logout remains.
  it("renders a logout hint (not a local toggle button) in login mode", () => {
    const { container } = render(<Harness initialAuthMode="login" />);
    // The broken local-only logout affordance is gone.
    expect(container.querySelector('[data-testid="llm-tab:logout-to-edit"]')).toBeNull();
    // A static hint directing the user to the canonical logout is present.
    const hint = container.querySelector('[data-testid="llm-tab:logout-hint"]');
    expect(hint).not.toBeNull();
    // It is a non-interactive paragraph, not a button.
    expect(hint?.tagName.toLowerCase()).toBe("p");
  });

  // (2) When api.applyHostMap rejects, the relaunch confirm dialog must stay
  // open with an inline error and must not leave an unhandled promise
  // rejection. relaunchPending is also released so the user can retry.
  it("keeps the relaunch dialog open and surfaces an error when applyHostMap fails", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => {
      e.preventDefault();
      unhandled.push(e.reason);
    };
    window.addEventListener("unhandledrejection", onUnhandled);
    try {
      const api = llmTabApi();
      vi.spyOn(
        api as unknown as { applyHostMap: (v: string) => Promise<{ ok: boolean }> },
        "applyHostMap",
      ).mockRejectedValue(new Error("ipc failed"));

      // Dialog renders in a portal (document.body), so query via the
      // testing-library helpers that scope to the document, not `container`.
      const { getByTestId, queryByTestId } = render(
        <Harness
          initialAuthMode="manual"
          initialHostResolverMap={"10.0.0.10 changed.example.com"}
          loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
          api={api}
        />,
      );

      fireEvent.click(getByTestId("llm-tab:apply-host-map"));
      await act(async () => {
        fireEvent.click(getByTestId("llm-tab:relaunch-confirm"));
      });
      // Let any pending microtasks/rejections settle.
      await act(async () => {
        await Promise.resolve();
      });

      // Dialog still open: confirm button + inline error present.
      expect(queryByTestId("llm-tab:relaunch-confirm")).not.toBeNull();
      const error = queryByTestId("llm-tab:relaunch-error");
      expect(error).not.toBeNull();
      expect(error?.getAttribute("role")).toBe("alert");
      // Confirm button re-enabled so the user can retry (relaunchPending released).
      const confirm = getByTestId("llm-tab:relaunch-confirm") as HTMLButtonElement;
      expect(confirm.disabled).toBe(false);
      // No unhandled promise rejection escaped.
      expect(unhandled).toHaveLength(0);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled);
    }
  });

  // (2b) The IPC handler signals failure by RESOLVING { ok: false } (e.g.
  // authMode-not-manual, invalid payload, or an unauthorized frame) rather
  // than throwing. The dialog must behave identically to the thrown case:
  // stay open with the inline error and release relaunchPending — never
  // proceed as if the relaunch succeeded.
  it("keeps the relaunch dialog open when applyHostMap resolves { ok: false }", async () => {
    const api = llmTabApi();
    vi.spyOn(
      api as unknown as {
        applyHostMap: (
          v: string,
        ) => Promise<{ ok: boolean; error?: string; message?: string }>;
      },
      "applyHostMap",
    ).mockResolvedValue({ ok: false, error: "auth-mode-not-manual", message: "locked" });

    const { getByTestId, queryByTestId } = render(
      <Harness
        initialAuthMode="manual"
        initialHostResolverMap={"10.0.0.10 changed.example.com"}
        loadedHostResolverMap={"10.0.0.10 endpoint.example.com"}
        api={api}
      />,
    );

    fireEvent.click(getByTestId("llm-tab:apply-host-map"));
    await act(async () => {
      fireEvent.click(getByTestId("llm-tab:relaunch-confirm"));
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Dialog still open with inline error; the relaunch never proceeded.
    expect(queryByTestId("llm-tab:relaunch-confirm")).not.toBeNull();
    const error = queryByTestId("llm-tab:relaunch-error");
    expect(error).not.toBeNull();
    expect(error?.getAttribute("role")).toBe("alert");
    // Confirm button re-enabled so the user can retry.
    const confirm = getByTestId("llm-tab:relaunch-confirm") as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  // (3) Pre-hydration the parent passes vendor="" / settingsLoaded=false. The
  // API-key label must not flash the stale first-vendor name (VENDORS[0]).
  it("does not render a stale vendor label before hydration (vendor='')", () => {
    const { container } = render(
      <Harness initialAuthMode="manual" initialVendor="" settingsLoaded={false} />,
    );
    const label = container.querySelector('[data-testid="llm-tab:api-key-label"]');
    expect(label).not.toBeNull();
    // No vendor name leaked — neither the fallback first vendor nor any other.
    for (const v of VENDORS) {
      expect(label?.textContent ?? "").not.toContain(v.label);
    }
  });

  it("renders the hydrated vendor label once settings load (vendor set)", () => {
    const { container } = render(
      <Harness initialAuthMode="manual" initialVendor="openai" settingsLoaded={true} />,
    );
    const label = container.querySelector('[data-testid="llm-tab:api-key-label"]');
    const openai = VENDORS.find((v) => v.id === "openai")!;
    expect(label?.textContent ?? "").toContain(openai.label);
  });
});

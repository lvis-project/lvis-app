/**
 * Cross-PR first-boot integration — renderer level (#986 / #988).
 *
 * Sequences the combined first-boot funnel that no per-PR spec exercises
 * on its own:
 *
 *   1. Returning-user boot with demo activation captured by main
 *      (`demo.status().activated === true`) + `onboardingCompleted === true`
 *      → `useDemoAutoplay` activates and the Live Auto-play overlay mounts.
 *   2. User hands the keyboard back ("키 잡기 →") → `onFinished` fires,
 *      the demo turn collapses, the overlay unmounts, and the
 *      `document.body[data-demo-active]` mutex flag clears.
 *   3. User hits ⌘+Shift+/ → the App-level help shortcut fires
 *      `api.tour.start("first-boot-essentials")` exactly once and the
 *      SpotlightTour card becomes visible.
 *
 * Regression locks (issues #986 / #988):
 *   - The demo↔tour mutual-exclusion: while the demo overlay is up the
 *     ⌘+Shift+/ shortcut is swallowed (the Spotlight backdrop must never
 *     paint over the scripted demo). Verified by firing the shortcut
 *     mid-demo and asserting `tour.start` is NOT called, then firing it
 *     again after take-over and asserting it IS.
 *   - The mutex is implemented by the `demoActiveRef` / `data-demo-active`
 *     useEffect in `src/ui/renderer/App.tsx` (the help-shortcut handler
 *     reads `demoActiveRef.current`). A mutation that drops the
 *     mid-demo guard, or one that never fires `tour.start`, breaks this
 *     spec while the narrower per-component specs stay green.
 */
import "./setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { fakeLlmSettings } from "../../src/shared/__tests__/fake-llm-settings.js";
import {
  makeMockLvisApi,
  makeMockLvisNamespace,
  type MockLvisApi,
} from "./mock-lvis-api.js";

/**
 * Returning-user settings: onboarding already complete (so the demo
 * activation predicate's first-run gate passes) and the demo flag left
 * at its default (undefined → implicit returning-user activation). The
 * boot probe sees `onboardingCompleted === true` and dispatches
 * `probe-skip`, so the Z onboarding chain collapses straight to "done"
 * and the demo overlay is the only first-boot surface in play.
 */
function returningUserSettings() {
  return {
    llm: fakeLlmSettings({ provider: "openai", model: "gpt-4o-mini" }),
    chat: { systemPrompt: "", autoCompact: true },
    roles: { presets: [] },
    webSearch: { provider: "none" },
    routine: {},
    privacy: { piiRedactEnabled: false },
    features: { idlePreferenceRefresh: false, onboardingCompleted: true },
  };
}

/**
 * Mounts <App /> with a mock api whose `demo.status()` reports captured
 * demo activation (vendor mirrors the `LVIS_DEMO_VENDOR` env that main
 * would have read at boot). The default mock returns `{ active: false }`
 * which the activation hook treats as a dead path — we must override it
 * BEFORE the hook's mount probe runs.
 */
async function mountFirstBootApp() {
  const { api, emitTourStart } = makeMockLvisApi({
    settings: returningUserSettings(),
    hasApiKey: true,
  });
  // Override demo.status into the shape `useDemoAutoplay` reads:
  // `{ ok, activated, vendor }`. `activated: true` mirrors main having
  // captured demo credentials for the mocked `LVIS_DEMO_VENDOR`.
  api.demo.status = vi.fn(async () => ({ ok: true, activated: true, vendor: "openai" }));
  const { ns } = makeMockLvisNamespace();

  vi.stubGlobal("lvisApi", api);
  vi.stubGlobal("lvis", ns);
  (window as unknown as { lvisApi: MockLvisApi }).lvisApi = api;
  (window as unknown as { lvis: unknown }).lvis = ns;

  const { App } = await import("../../src/renderer.js");
  const { render } = await import("@testing-library/react");
  const result = render(<App />);
  return { container: result.container, api, emitTourStart };
}

function pressHelpShortcut() {
  fireEvent.keyDown(window, { key: "/", metaKey: true, shiftKey: true });
}

describe("first-boot funnel integration (login → demo → ⌘⇧/ → tour)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    if (typeof document !== "undefined") {
      document.body.removeAttribute("data-demo-active");
    }
  });

  it("activates the demo overlay for a returning user with captured demo state", async () => {
    const { container, api } = await mountFirstBootApp();
    await waitFor(() => expect(api.getSettings).toHaveBeenCalled());
    await waitFor(() =>
      expect(container.querySelector('[data-testid="demo-autoplay-overlay"]')).toBeTruthy(),
    );
    // While the demo is up, the mutex flag must be set so the Spotlight
    // subscriber + the help shortcut both self-guard.
    await waitFor(() =>
      expect(document.body.getAttribute("data-demo-active")).toBe("true"),
    );
  });

  it("⌘+Shift+/ is swallowed while the demo runs (demo↔tour mutex)", async () => {
    const { container, api } = await mountFirstBootApp();
    await waitFor(() =>
      expect(container.querySelector('[data-testid="demo-autoplay-overlay"]')).toBeTruthy(),
    );
    await waitFor(() =>
      expect(document.body.getAttribute("data-demo-active")).toBe("true"),
    );

    api.tour.start.mockClear();
    await act(async () => {
      pressHelpShortcut();
    });
    // Mutex: tour MUST NOT start on top of the scripted demo overlay.
    expect(api.tour.start).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="spotlight-tour"]')).toBeNull();
  });

  it("after demo take-over, ⌘+Shift+/ starts the first-boot tour exactly once", async () => {
    const { container, api, emitTourStart } = await mountFirstBootApp();

    // (1) Demo overlay mounts.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="demo-autoplay-overlay"]')).toBeTruthy(),
    );

    // (2) User hands the keyboard back via "키 잡기 →".
    const takeOver = container.querySelector<HTMLButtonElement>(
      '[data-testid="demo-autoplay-banner:take-over"]',
    );
    expect(takeOver).toBeTruthy();
    await act(async () => {
      takeOver!.click();
    });

    // Demo overlay collapses and the mutex flag clears.
    await waitFor(() =>
      expect(container.querySelector('[data-testid="demo-autoplay-overlay"]')).toBeNull(),
    );
    await waitFor(() =>
      expect(document.body.getAttribute("data-demo-active")).not.toBe("true"),
    );

    // (3) ⌘+Shift+/ now reaches the help handler → tour.start fires once.
    api.tour.start.mockClear();
    await act(async () => {
      pressHelpShortcut();
    });
    await waitFor(() => expect(api.tour.start).toHaveBeenCalledTimes(1));
    expect(api.tour.start).toHaveBeenCalledWith("first-boot-essentials");

    // The SpotlightTour subscriber mounts the card once the broadcast
    // fans back through `api.tour.onStart`. The mock's `start` does not
    // auto-fan, so emit the broadcast explicitly (mirrors the host's
    // `lvis:tour:start` IPC fan-out that production wires from
    // `tour.start`).
    await act(async () => {
      emitTourStart("first-boot-essentials");
    });
    await waitFor(() =>
      expect(container.querySelector('[data-testid="spotlight-tour"]')).toBeTruthy(),
    );
    const card = container.querySelector('[data-testid="spotlight-tour:card"]');
    expect(card).toBeTruthy();
    expect(
      container
        .querySelector('[data-testid="spotlight-tour"]')
        ?.getAttribute("data-scenario-id"),
    ).toBe("first-boot-essentials");
  });
});

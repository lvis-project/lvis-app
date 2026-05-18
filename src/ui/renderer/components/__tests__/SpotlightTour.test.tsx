// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import {
  SpotlightTour,
  type SpotlightTourApi,
} from "../SpotlightTour.js";
import type { TourScenario } from "../../onboarding/default-tour-scenarios.js";

/**
 * Tutorial-C — SpotlightTour component tests.
 *
 * Verifies:
 *   - Mounts hidden until a `tour.onStart` event flips it on.
 *   - Step navigation: 다음 advances, ESC dismisses, 1..9 jumps.
 *   - Final step "완료" click → `tour.markComplete` + close.
 *   - Backdrop click dismisses (calls `tour.dismiss`).
 *   - Keyboard jump out of range is ignored (no crash, no desync).
 */

function makeApi(): {
  api: SpotlightTourApi;
  fireStart: (scenarioId: string) => void;
  markComplete: ReturnType<typeof vi.fn>;
  dismiss: ReturnType<typeof vi.fn>;
} {
  let onStartHandler: ((p: { scenarioId: string }) => void) | null = null;
  const markComplete = vi.fn(async () => ({ ok: true as const }));
  const dismiss = vi.fn(async () => ({ ok: true as const }));
  const api: SpotlightTourApi = {
    tour: {
      getState: vi.fn(async () => ({
        ok: true as const,
        state: {
          lastSeenScenario: null,
          completedScenarios: [],
          dismissedAt: null,
        },
      })),
      markComplete,
      dismiss,
      onStart: (handler) => {
        onStartHandler = handler;
        return () => {
          onStartHandler = null;
        };
      },
    },
  };
  return {
    api,
    fireStart: (scenarioId: string) =>
      act(() => {
        onStartHandler?.({ scenarioId });
      }),
    markComplete,
    dismiss,
  };
}

const FIXTURE_SCENARIO: TourScenario = {
  id: "test-scenario",
  title: "Test scenario",
  steps: [
    { anchorSelector: '[data-tour-anchor="a"]', title: "Step 1", body: "Body 1" },
    { anchorSelector: '[data-tour-anchor="b"]', title: "Step 2", body: "Body 2" },
    { anchorSelector: '[data-tour-anchor="c"]', title: "Step 3", body: "Body 3" },
  ],
};

const FIXTURE_REGISTRY: Readonly<Record<string, TourScenario>> = Object.freeze({
  [FIXTURE_SCENARIO.id]: FIXTURE_SCENARIO,
});

describe("SpotlightTour", () => {
  it("renders nothing until tour.onStart fires", () => {
    const { api } = makeApi();
    const { queryByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    expect(queryByTestId("spotlight-tour")).toBeNull();
  });

  it("renders the active scenario when onStart fires", async () => {
    const { api, fireStart } = makeApi();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    const card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("0");
  });

  it("advances on '다음' click", async () => {
    const { api, fireStart } = makeApi();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    const nextButton = await findByTestId("spotlight-tour:next");
    act(() => {
      nextButton.click();
    });
    const card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("1");
  });

  it("ESC dismisses + calls tour.dismiss exactly once", async () => {
    const { api, fireStart, dismiss } = makeApi();
    const { findByTestId, queryByTestId } = render(
      <SpotlightTour
        api={api}
        scenarios={FIXTURE_REGISTRY}
        initialScenarioId={undefined}
      />,
    );
    fireStart("test-scenario");
    await findByTestId("spotlight-tour:card");
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    await waitFor(() => {
      expect(queryByTestId("spotlight-tour:card")).toBeNull();
    });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(dismiss).toHaveBeenCalledWith("test-scenario");
  });

  it("numeric keys jump to the matching step (1..N)", async () => {
    const { api, fireStart } = makeApi();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    await findByTestId("spotlight-tour:card");
    act(() => {
      fireEvent.keyDown(window, { key: "3" });
    });
    const card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("2");
  });

  it("ignores out-of-range numeric keys without desyncing", async () => {
    const { api, fireStart } = makeApi();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    await findByTestId("spotlight-tour:card");
    act(() => {
      fireEvent.keyDown(window, { key: "9" }); // scenario only has 3 steps
    });
    const card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("0");
  });

  it("ArrowLeft moves back one step", async () => {
    const { api, fireStart } = makeApi();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    await findByTestId("spotlight-tour:card");
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowRight" });
    });
    act(() => {
      fireEvent.keyDown(window, { key: "ArrowLeft" });
    });
    const card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("0");
  });

  it("final step '완료' triggers tour.markComplete and closes", async () => {
    const { api, fireStart, markComplete } = makeApi();
    const { findByTestId, queryByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    // Step through to the final step.
    for (let i = 0; i < FIXTURE_SCENARIO.steps.length; i++) {
      const next = await findByTestId("spotlight-tour:next");
      act(() => {
        next.click();
      });
    }
    await waitFor(() => {
      expect(queryByTestId("spotlight-tour:card")).toBeNull();
    });
    expect(markComplete).toHaveBeenCalledTimes(1);
    expect(markComplete).toHaveBeenCalledWith("test-scenario");
  });

  it("backdrop click dismisses the tour", async () => {
    const { api, fireStart, dismiss } = makeApi();
    const { findByTestId, queryByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    const backdrop = await findByTestId("spotlight-tour:backdrop");
    act(() => {
      backdrop.click();
    });
    await waitFor(() => {
      expect(queryByTestId("spotlight-tour:card")).toBeNull();
    });
    expect(dismiss).toHaveBeenCalledWith("test-scenario");
  });

  it("opens immediately when initialScenarioId is provided", async () => {
    const { api } = makeApi();
    const { findByTestId } = render(
      <SpotlightTour
        api={api}
        scenarios={FIXTURE_REGISTRY}
        initialScenarioId="test-scenario"
      />,
    );
    const card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("0");
  });

  // F5 — `prefers-reduced-motion: reduce` swaps the animated drop-shadow
  // glow for an opacity-only static border. We assert the
  // `data-reduce-motion` attribute on the tour root so future renders can
  // be inspected from the DOM without re-reading inline styles.
  it("hides animation when prefers-reduced-motion is set (F5)", async () => {
    const originalMatchMedia = window.matchMedia;
    // Stub matchMedia so the `(prefers-reduced-motion: reduce)` query
    // returns `matches: true` for the duration of this test.
    // @ts-expect-error — jsdom polyfill from setup.ts is mutable.
    window.matchMedia = (query: string) => ({
      matches: query.includes("prefers-reduced-motion: reduce"),
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
      media: query,
    });
    try {
      const { api, fireStart } = makeApi();
      const { findByTestId } = render(
        <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
      );
      fireStart("test-scenario");
      const root = await findByTestId("spotlight-tour");
      expect(root.getAttribute("data-reduce-motion")).toBe("true");
      const card = await findByTestId("spotlight-tour:card");
      // The animated drop-shadow is replaced with no shadow under
      // reduced motion. Inline `style.boxShadow` reflects the resolved
      // value rather than the keyword, so a literal "none" or empty
      // string is acceptable; we just assert the heavy `30px` glow
      // shadow from the default path is absent.
      const inlineShadow = (card as HTMLElement).style.boxShadow;
      expect(inlineShadow).not.toContain("30px");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

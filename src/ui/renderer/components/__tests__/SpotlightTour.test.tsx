// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import {
  SpotlightTour,
  type SpotlightTourApi,
} from "../SpotlightTour.js";
import type { TourScenario } from "../../onboarding/default-tour-scenarios.js";
import { makeMockLvisApi } from "../../../../../test/renderer/mock-lvis-api.js";
import { BLOCKING_SURFACE_SELECTOR, TEST_IDS } from "../../../../shared/test-ids.js";

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

function spotlightTourHarness(): {
  api: SpotlightTourApi;
  fireStart: (scenarioId: string) => void;
  markComplete: ReturnType<typeof vi.fn>;
  dismiss: ReturnType<typeof vi.fn>;
} {
  const { api, emitTourStart } = makeMockLvisApi();
  const tour = api.tour as unknown as SpotlightTourApi["tour"];
  return {
    api: { tour },
    fireStart: (scenarioId: string) =>
      act(() => {
        emitTourStart(scenarioId);
      }),
    markComplete: tour.markComplete as ReturnType<typeof vi.fn>,
    dismiss: tour.dismiss as ReturnType<typeof vi.fn>,
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
    const { api } = spotlightTourHarness();
    const { queryByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    expect(queryByTestId("spotlight-tour")).toBeNull();
  });

  it("renders the active scenario when onStart fires", async () => {
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    const card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("0");
  });

  it("advances on '다음' click", async () => {
    const { api, fireStart } = spotlightTourHarness();
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
    const { api, fireStart, dismiss } = spotlightTourHarness();
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
    const { api, fireStart } = spotlightTourHarness();
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
    const { api, fireStart } = spotlightTourHarness();
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
    const { api, fireStart } = spotlightTourHarness();
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
    const { api, fireStart, markComplete } = spotlightTourHarness();
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
    const { api, fireStart, dismiss } = spotlightTourHarness();
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
    const { api } = spotlightTourHarness();
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

  // U6 — when a Radix Dialog is already mounted, the tour.start broadcast
  // is queued. The MutationObserver inside SpotlightTour flushes the
  // queued scenario when every dialog closes.
  it("U6 — queues tour.start when a modal dialog is already open", async () => {
    // Mount a stand-in modal first.
    const modal = document.createElement("div");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("data-state", "open");
    document.body.appendChild(modal);
    const { api, fireStart } = spotlightTourHarness();
    const { queryByTestId, findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    // Tour must NOT mount yet — a modal is open.
    expect(queryByTestId("spotlight-tour:card")).toBeNull();
    // Close the modal. The MutationObserver should pick this up and
    // flush the queued scenario.
    await act(async () => {
      modal.setAttribute("data-state", "closed");
      // Give the observer one microtask to fire.
      await new Promise((r) => setTimeout(r, 0));
    });
    const card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("0");
    document.body.removeChild(modal);
  });

  // A question card is a turn waiting on the user exactly as an approval card
  // is. A tour backdrop over it hides the thing that has to be answered before
  // anything else can move, so the tour queues behind one too.
  it("queues tour.start while a user-question card is waiting for an answer", async () => {
    const question = document.createElement("div");
    question.setAttribute("data-testid", TEST_IDS.questionOverlay);
    document.body.appendChild(question);
    const { api, fireStart } = spotlightTourHarness();
    const { queryByTestId, findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    expect(queryByTestId("spotlight-tour:card")).toBeNull();

    await act(async () => {
      question.remove();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect((await findByTestId("spotlight-tour:card")).getAttribute("data-step-index")).toBe("0");
  });

  // U8 — auto-advance on declared completion trigger. Typing in the
  // composer matching the step's input selector should fire `handleNext`
  // automatically without the user clicking 다음.
  it("U8 — input trigger auto-advances when the user types in the anchor", async () => {
    const SCENARIO_WITH_INPUT_TRIGGER: TourScenario = {
      id: "input-scenario",
      title: "Input scenario",
      steps: [
        {
          anchorSelector: "#composer-fake",
          title: "Type something",
          body: "Composer body",
          completionTrigger: { kind: "input", selector: "#composer-fake" },
        },
        {
          anchorSelector: "#composer-fake",
          title: "Done",
          body: "Final body",
        },
      ],
    };
    const REGISTRY: Readonly<Record<string, TourScenario>> = Object.freeze({
      [SCENARIO_WITH_INPUT_TRIGGER.id]: SCENARIO_WITH_INPUT_TRIGGER,
    });
    // Inject the anchor target.
    const composer = document.createElement("input");
    composer.id = "composer-fake";
    stubRect(composer, ANCHOR_WIDTH, ANCHOR_HEIGHT);
    document.body.appendChild(composer);
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={REGISTRY} />,
    );
    fireStart("input-scenario");
    let card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("0");
    // Fire an input event on the anchor.
    act(() => {
      fireEvent.input(composer, { target: { value: "hello" } });
    });
    card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("1");
    document.body.removeChild(composer);
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
      const { api, fireStart } = spotlightTourHarness();
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

  // 2026-05-19 — "스팟하이라이트 시퀀스가 2번 노출" regression. The Z chain
  // side-effect + React 18 StrictMode dev double-mount + the modal-queue
  // flush path can all deliver the same `tour.start` scenario id more
  // than once. Without a same-scenario guard the second broadcast re-runs
  // `setActiveScenarioId(id)`, which retriggers the
  // `useEffect [activeScenarioId]` reset (stepIndex → 0, dismissedRef
  // cleared), visibly re-mounting the tour at step 0 mid-flight. This
  // spec advances the tour to step 1 and then re-fires the same scenario
  // id; the tour must stay on step 1.
  it("ignores a duplicate tour.start for the already-active scenario", async () => {
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    let card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("0");
    // Advance past step 0 so a regression to "reset on duplicate" is
    // observable in the assertion below.
    fireEvent.click(await findByTestId("spotlight-tour:next"));
    card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("1");
    // Duplicate broadcast for the same scenario must be a no-op — no
    // re-mount, no step reset.
    fireStart("test-scenario");
    card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-step-index")).toBe("1");
  });
});

/**
 * jsdom lays nothing out: every element reports a 0×0 rect. The tour reads
 * that rect to tell an on-screen match from an off-screen one, so a spec that
 * wants an anchor to be findable has to give it a box. Sizes are arbitrary
 * except where a spec reads them back off the ring.
 */
const ANCHOR_WIDTH = 240;
const ANCHOR_HEIGHT = 32;

function stubRect(el: HTMLElement, width: number, height: number): void {
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
}

/**
 * The highlight is carried by the element a step is about, not by coordinates
 * copied from it. These specs hold that contract from the DOM: the mark lands
 * on the anchor and only the anchor, it follows the step, and it is gone the
 * moment the tour is.
 *
 * jsdom lays nothing out, so none of these assert pixels — a geometry
 * assertion here would pass without measuring anything. What they assert is
 * the mechanism: which node is marked, and whether the card is placed by the
 * shared popover against that node or by arithmetic of the tour's own.
 */
describe("SpotlightTour anchoring", () => {
  const mountedAnchors: HTMLElement[] = [];

  function mountAnchors(names: string[]): HTMLElement[] {
    return names.map((name) => {
      const el = document.createElement("button");
      el.setAttribute("data-tour-anchor", name);
      el.textContent = name;
      stubRect(el, ANCHOR_WIDTH, ANCHOR_HEIGHT);
      document.body.appendChild(el);
      mountedAnchors.push(el);
      return el;
    });
  }

  function marked(): Element[] {
    return [...document.querySelectorAll("[data-tour-highlight]")];
  }

  afterEach(() => {
    for (const el of mountedAnchors.splice(0)) el.remove();
  });

  it("marks the active step's anchor, and only that element", async () => {
    const [a] = mountAnchors(["a", "b", "c"]);
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    await findByTestId("spotlight-tour:card");
    expect(marked()).toEqual([a]);
    expect(a.getAttribute("data-tour-highlight")).toBe("true");
  });

  it("moves the mark when the step advances", async () => {
    const [a, b] = mountAnchors(["a", "b", "c"]);
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    await findByTestId("spotlight-tour:card");
    expect(marked()).toEqual([a]);
    act(() => {
      fireEvent.click(document.querySelector('[data-testid="spotlight-tour:next"]')!);
    });
    await findByTestId("spotlight-tour:card");
    expect(marked()).toEqual([b]);
  });

  it("clears the mark when the tour is skipped", async () => {
    mountAnchors(["a", "b", "c"]);
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId, queryByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    const skip = await findByTestId("spotlight-tour:skip");
    act(() => {
      skip.click();
    });
    await waitFor(() => {
      expect(queryByTestId("spotlight-tour:card")).toBeNull();
    });
    expect(marked()).toEqual([]);
  });

  it("clears the mark when the last step completes", async () => {
    mountAnchors(["a", "b", "c"]);
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId, queryByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    for (let i = 0; i < FIXTURE_SCENARIO.steps.length; i++) {
      const next = await findByTestId("spotlight-tour:next");
      act(() => {
        next.click();
      });
    }
    await waitFor(() => {
      expect(queryByTestId("spotlight-tour:card")).toBeNull();
    });
    expect(marked()).toEqual([]);
  });

  it("clears the mark on unmount", async () => {
    mountAnchors(["a", "b", "c"]);
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId, unmount } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    await findByTestId("spotlight-tour:card");
    expect(marked()).toHaveLength(1);
    unmount();
    expect(marked()).toEqual([]);
  });

  // An anchor that leaves the DOM mid-step takes its mark with it, so nothing
  // is left ringed. This is what replaces the old off-screen guard: a ring
  // that lives on the element cannot be pinned where the element is not — it
  // scrolls out of view with the element and disappears with it.
  it("leaves nothing marked when the anchor disappears mid-step", async () => {
    const [a] = mountAnchors(["a", "b", "c"]);
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId, queryByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    await findByTestId("spotlight-tour:card");
    expect(marked()).toEqual([a]);
    a.remove();
    expect(marked()).toEqual([]);
    // The ring is a layer of its own, so it has to be told: the tour watches
    // the document and re-resolves the anchor, and with nothing left to point
    // at the ring goes with it rather than floating where the anchor was.
    await waitFor(() => {
      expect(queryByTestId("spotlight-tour:ring")).toBeNull();
    });
  });

  // The step card is the shared popover, so it carries `role="dialog"` and
  // `data-state="open"` like any dialog. The tour reads the blocking-surface
  // set to decide whether it may open at all — if its own card were in that
  // set, the tour would be queueing behind itself.
  it("does not count its own card as a blocking surface", async () => {
    mountAnchors(["a", "b", "c"]);
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    const card = await findByTestId("spotlight-tour:card");
    expect(card.getAttribute("data-state")).toBe("open");
    expect(card.getAttribute("role")).toBe("dialog");
    expect(document.querySelectorAll(BLOCKING_SURFACE_SELECTOR)).toHaveLength(0);
  });

  it("centres the card and marks nothing when the selector matches no element", async () => {
    // No anchors mounted — every selector in the fixture misses.
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId } = render(
      <SpotlightTour api={api} scenarios={FIXTURE_REGISTRY} />,
    );
    fireStart("test-scenario");
    const card = await findByTestId("spotlight-tour:card");
    expect(marked()).toEqual([]);
    // The anchorless card centres itself against the viewport, which is the
    // one placement the tour still computes for itself.
    expect(card.style.position).toBe("fixed");
    expect(card.style.marginLeft).toBe("auto");
    expect(card.closest("[data-radix-popper-content-wrapper]")).toBeNull();
  });

  // The reported bug: the card landed in the wrong place, and whether it
  // landed right depended on how long the translated copy was — the old
  // placement compared the space below the anchor against a hard-coded
  // 200px card height, so any body longer than that guess put the card
  // where it did not fit.
  //
  // The fix removes the guess: the card is the shared popover's content,
  // anchored to the same element the mark is on, and Radix owns the flip.
  // jsdom cannot measure that, so this asserts the mechanism — with copy far
  // longer than the old constant the card is still the popover content of the
  // marked anchor, and its placement is not computed by the tour.
  it("keeps a long-copy card attached to its anchor rather than placing it by a height guess", async () => {
    const [anchor] = mountAnchors(["a"]);
    const longBody =
      "긴 번역 문구가 카드 높이를 키우는 경우에도 카드는 앵커에 붙어 있어야 한다. ".repeat(
        12,
      );
    const LONG_COPY_SCENARIO: TourScenario = {
      id: "long-copy-scenario",
      title: "Long copy",
      steps: [
        {
          anchorSelector: '[data-tour-anchor="a"]',
          title: "Step 1",
          body: longBody,
        },
      ],
    };
    const { api, fireStart } = spotlightTourHarness();
    const { findByTestId } = render(
      <SpotlightTour
        api={api}
        scenarios={Object.freeze({ [LONG_COPY_SCENARIO.id]: LONG_COPY_SCENARIO })}
      />,
    );
    fireStart("long-copy-scenario");
    const card = await findByTestId("spotlight-tour:card");
    expect(card.textContent).toContain("앵커에 붙어 있어야 한다");
    // The marked element and the popover's anchor are the same node — the
    // component resolves it once and hands that node to both.
    expect(marked()).toEqual([anchor]);
    // The card is the popover's content, so the popper positions it against
    // the anchor on every layout change.
    expect(card.closest("[data-radix-popper-content-wrapper]")).not.toBeNull();
    // …and the tour computes no placement of its own for it: no viewport
    // coordinates, and nothing derived from a card-height constant.
    expect(card.style.position).toBe("");
    expect(card.style.top).toBe("");
    expect(card.style.bottom).toBe("");
  });
});

/**
 * The ring is a portaled layer placed against the anchor, not a shadow the
 * anchor paints. It has to be: the anchors the tour points at sit inside a
 * chain of `overflow: hidden` ancestors that clips a shadow drawn outside the
 * border box, under a route canvas whose `isolation: isolate` traps any
 * z-index put on the anchor below the tour's own backdrop.
 *
 * jsdom paints nothing, so what these specs hold is the wiring: a ring node
 * exists for an anchored step, it is sized from the anchor's own box, and it
 * neither takes a role that would read as a blocking dialog nor leaves the
 * anchor unusable.
 */
describe("SpotlightTour ring", () => {
  const mounted: HTMLElement[] = [];

  function mountAnchor(
    name: string,
    opts: { width?: number; height?: number; display?: string; visibility?: string } = {},
  ): HTMLElement {
    const el = document.createElement("button");
    el.setAttribute("data-tour-anchor", name);
    if (opts.display) el.style.display = opts.display;
    if (opts.visibility) el.style.visibility = opts.visibility;
    stubRect(el, opts.width ?? ANCHOR_WIDTH, opts.height ?? ANCHOR_HEIGHT);
    document.body.appendChild(el);
    mounted.push(el);
    return el;
  }

  const SINGLE_STEP: TourScenario = {
    id: "ring-scenario",
    title: "Ring",
    steps: [
      { anchorSelector: '[data-tour-anchor="a"]', title: "Step 1", body: "Body 1" },
    ],
  };
  const REGISTRY = Object.freeze({ [SINGLE_STEP.id]: SINGLE_STEP });

  function renderTour() {
    const { api, fireStart } = spotlightTourHarness();
    const utils = render(<SpotlightTour api={api} scenarios={REGISTRY} />);
    fireStart(SINGLE_STEP.id);
    return utils;
  }

  afterEach(() => {
    for (const el of mounted.splice(0)) el.remove();
  });

  it("renders a ring for an anchored step, sized from the anchor's own box", async () => {
    mountAnchor("a", { width: 300, height: 44 });
    const { findByTestId } = renderTour();
    const ring = await findByTestId("spotlight-tour:ring");
    // The ring stands off the anchor's edge by a fixed inset on every side, so
    // it reads as a highlight around the control rather than a border on it.
    const width = Number.parseFloat(ring.style.width);
    const height = Number.parseFloat(ring.style.height);
    expect(width).toBeGreaterThan(300);
    expect(height).toBeGreaterThan(44);
    expect(width - 300).toBe(height - 44);
    // Placed by the popper against the live anchor — the tour computes no
    // coordinates of its own for it.
    expect(ring.closest("[data-radix-popper-content-wrapper]")).not.toBeNull();
    expect(ring.style.top).toBe("");
    expect(ring.style.left).toBe("");
  });

  // A control that grows mid-step — the composer gaining a line — must take
  // the ring with it. jsdom ships no ResizeObserver, so the spec supplies a
  // driveable one and fires it the way the browser would.
  it("re-sizes the ring when the anchor grows", async () => {
    // The popper observes elements of its own, so entries are keyed by target
    // and only the anchor's are fired.
    type ObserverCallback = (entries: Array<{ target: Element }>) => void;
    const observed: Array<{ target: Element; cb: ObserverCallback }> = [];
    class DriveableResizeObserver {
      constructor(private readonly cb: ObserverCallback) {}
      observe(target: Element) {
        observed.push({ target, cb: this.cb });
      }
      unobserve() {}
      disconnect() {}
    }
    const original = window.ResizeObserver;
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: DriveableResizeObserver,
    });
    try {
      const anchor = mountAnchor("a", { width: 300, height: 44 });
      const { findByTestId } = renderTour();
      const ring = await findByTestId("spotlight-tour:ring");
      expect(ring.style.height).toBe("50px");
      const onAnchor = observed.filter((entry) => entry.target === anchor);
      expect(onAnchor.length).toBeGreaterThan(0);
      stubRect(anchor, 300, 88);
      act(() => {
        for (const entry of onAnchor) entry.cb([{ target: anchor }]);
      });
      await waitFor(() => {
        expect(
          (document.querySelector(
            '[data-testid="spotlight-tour:ring"]',
          ) as HTMLElement).style.height,
        ).toBe("94px");
      });
    } finally {
      Object.defineProperty(window, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  it("is decorative: no dialog role, and no blocking surface for the rest of the app", async () => {
    mountAnchor("a");
    const { findByTestId } = renderTour();
    const ring = await findByTestId("spotlight-tour:ring");
    expect(ring.getAttribute("role")).toBe("presentation");
    expect(ring.getAttribute("aria-hidden")).toBe("true");
    expect(document.querySelectorAll(BLOCKING_SURFACE_SELECTOR)).toHaveLength(0);
  });

  it("leaves the anchor usable — nothing forces pointer-events off on it", async () => {
    const anchor = mountAnchor("a");
    const { findByTestId } = renderTour();
    await findByTestId("spotlight-tour:ring");
    expect(anchor.getAttribute("data-tour-highlight")).toBe("true");
    expect(anchor.style.pointerEvents).toBe("");
    // The stylesheet is the other half of that claim: a rule keyed on the mark
    // used to disable the very control a step asks the user to type into.
    const styles = readFileSync(
      resolve(fileURLToPath(import.meta.url), "../../../../../styles.css"),
      "utf8",
    );
    expect(styles).not.toContain("[data-tour-highlight");
    expect(styles).toContain(".lvis-tour-ring");
  });

  it("anchors to the visible match when an earlier one is display:none", async () => {
    const hidden = mountAnchor("a", { display: "none", width: 0, height: 0 });
    const visible = mountAnchor("a");
    const { findByTestId } = renderTour();
    await findByTestId("spotlight-tour:ring");
    expect(hidden.hasAttribute("data-tour-highlight")).toBe(false);
    expect(visible.getAttribute("data-tour-highlight")).toBe("true");
  });

  it("anchors to the visible match when an earlier one has a zero-area box", async () => {
    const collapsed = mountAnchor("a", { width: 0, height: 0 });
    const visible = mountAnchor("a");
    const { findByTestId } = renderTour();
    await findByTestId("spotlight-tour:ring");
    expect(collapsed.hasAttribute("data-tour-highlight")).toBe(false);
    expect(visible.getAttribute("data-tour-highlight")).toBe("true");
  });

  it("anchors to the visible match when an earlier one is visibility:hidden", async () => {
    const invisible = mountAnchor("a", { visibility: "hidden" });
    const visible = mountAnchor("a");
    const { findByTestId } = renderTour();
    await findByTestId("spotlight-tour:ring");
    expect(invisible.hasAttribute("data-tour-highlight")).toBe(false);
    expect(visible.getAttribute("data-tour-highlight")).toBe("true");
  });
});

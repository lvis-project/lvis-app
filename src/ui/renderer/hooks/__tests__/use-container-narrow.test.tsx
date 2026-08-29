import "../../../../../test/renderer/setup.js";

/**
 * useContainerNarrow measures the ChatView container; `sidePanelLayout(width)`
 * says how the panel lays out inside it — a docked column with the pixel
 * floors when the container can hold both, an overlay over the transcript's
 * right edge (the panel keeping its own floor) when it cannot.
 *
 * The docking threshold is derived from the shared side-panel reserve (card
 * plus insets) plus a transcript floor — NOT a magic constant that exceeds
 * chat mode's reserved window. Chat mode's OS window reserves
 * `SIDE_PANEL_MIN_RESERVE` on top of its base width for the docked panel, so
 * its container clears the threshold and docks (regression guard for the
 * chat-mode modal-blur bug).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import { DOCK_ENTER_WIDTH, DOCK_EXIT_WIDTH, MIN_DOCKED_TRANSCRIPT_WIDTH, useContainerNarrow, sidePanelLayout } from "../use-container-narrow.js";
import { SIDE_PANEL_MIN_RESERVE, SIDE_PANEL_MIN_WIDTH } from "../../../../shared/side-panel.js";
import { MAIN_WINDOW_MIN_WIDTH } from "../../../../shared/shell-geometry.js";

/**
 * A controllable ResizeObserver stub: capture the callback so a test can push
 * a specific content-box inline size and assert the hook's reaction. Replaces
 * the no-op stub from the shared setup for the lifetime of a test.
 */
function installControllableResizeObserver() {
  let latestCallback: ResizeObserverCallback | null = null;
  let observed: Element | null = null;
  const original = window.ResizeObserver;
  window.ResizeObserver = class {
    constructor(cb: ResizeObserverCallback) {
      latestCallback = cb;
    }
    observe(el: Element) {
      observed = el;
    }
    unobserve() {}
    disconnect() {
      latestCallback = null;
      observed = null;
    }
  } as unknown as typeof ResizeObserver;
  return {
    emit(inlineSize: number) {
      if (!latestCallback || !observed) throw new Error("observer not attached");
      act(() => {
        latestCallback!(
          [
            {
              target: observed!,
              contentBoxSize: [{ inlineSize, blockSize: 600 }],
              contentRect: { width: inlineSize } as DOMRectReadOnly,
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });
    },
    restore() {
      window.ResizeObserver = original;
    },
  };
}

function renderContainerNarrow() {
  return renderHook(() => {
    const ref = useRef<HTMLDivElement | null>(null);
    // Give the ref a real element so the effect attaches the observer.
    if (!ref.current) ref.current = document.createElement("div");
    return useContainerNarrow(ref);
  });
}

describe("useContainerNarrow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("derives the docking threshold from the side-panel SoT (not a magic 900)", () => {
    // The enter threshold must leave room for the panel plus a transcript
    // column, and must sit BELOW chat mode's reserved container so chat docks.
    expect(DOCK_ENTER_WIDTH).toBeGreaterThan(SIDE_PANEL_MIN_WIDTH);
    expect(DOCK_EXIT_WIDTH).toBeGreaterThan(DOCK_ENTER_WIDTH);
    // The chat-mode side-panel window reserves SIDE_PANEL_MIN_RESERVE on top
    // of the ~460px base window; after the collapsed sidebar padding the
    // observed chat-view-root is ≈ 800px. Docking must be allowed there.
    expect(DOCK_EXIT_WIDTH).toBeLessThan(MAIN_WINDOW_MIN_WIDTH + SIDE_PANEL_MIN_RESERVE);
  });

  it("docks (isNarrow=false) at chat-mode side-panel container width", () => {
    const observer = installControllableResizeObserver();
    try {
      const { result } = renderContainerNarrow();
      // Chat mode with the side panel open: ~460 base + 448 panel window minus
      // the collapsed sidebar padding + chrome ≈ 800px chat-view-root.
      observer.emit(800);
      expect(result.current.isNarrow).toBe(false);
    } finally {
      observer.restore();
    }
  });

  it("falls back to the drawer (isNarrow=true) for a genuinely too-narrow container", () => {
    const observer = installControllableResizeObserver();
    try {
      const { result } = renderContainerNarrow();
      // A hand-shrunk container that cannot fit the 448px panel + a usable
      // transcript column side by side.
      observer.emit(500);
      expect(result.current.isNarrow).toBe(true);
    } finally {
      observer.restore();
    }
  });

  it("applies hysteresis so widths in the dead-band do not flip-flop", () => {
    const observer = installControllableResizeObserver();
    try {
      const { result } = renderContainerNarrow();
      // Enter narrow below DOCK_ENTER_WIDTH.
      observer.emit(DOCK_ENTER_WIDTH - 20);
      expect(result.current.isNarrow).toBe(true);
      // A width inside the dead-band ([enter, exit)) stays narrow — no dock flip.
      observer.emit(DOCK_ENTER_WIDTH + 10);
      expect(result.current.isNarrow).toBe(true);
      // Only crossing the exit threshold re-docks.
      observer.emit(DOCK_EXIT_WIDTH + 10);
      expect(result.current.isNarrow).toBe(false);
    } finally {
      observer.restore();
    }
  });
});

describe("sidePanelLayout", () => {
  it("docks with the pixel floors when the container can hold both columns", () => {
    // `min` names the reserve it is about, so the assertion says which width it
    // means rather than repeating a number. The maxima stay absolute px:
    // `width - MIN_DOCKED_TRANSCRIPT_WIDTH` would restate the implementation
    // and pass however the transcript floor moved, so the literals are what
    // actually pins them.
    expect(sidePanelLayout(Number.POSITIVE_INFINITY, false)).toEqual({ mode: "docked", min: SIDE_PANEL_MIN_RESERVE, max: Number.POSITIVE_INFINITY });
    expect(sidePanelLayout(DOCK_ENTER_WIDTH, false)).toEqual({ mode: "docked", min: SIDE_PANEL_MIN_RESERVE, max: DOCK_ENTER_WIDTH - 320 });
    expect(sidePanelLayout(1200, false)).toEqual({ mode: "docked", min: SIDE_PANEL_MIN_RESERVE, max: 880 });
    // Both constants the expectations lean on, pinned to their absolute values
    // once. Without this the `min` assertions would be identities — the
    // implementation returns SIDE_PANEL_MIN_RESERVE, so comparing against it
    // holds whatever it becomes.
    expect(SIDE_PANEL_MIN_RESERVE).toBe(464);
    expect(MIN_DOCKED_TRANSCRIPT_WIDTH).toBe(320);
  });

  it("floats over the transcript, keeping its own floor, when the container cannot", () => {
    // A 2×2 tile: the card keeps its floor and the transcript stays laid out beneath.
    expect(sidePanelLayout(496, true)).toEqual({ mode: "overlay", min: SIDE_PANEL_MIN_RESERVE, max: 496 });
    // Narrower than the reserve: the card fills the tile.
    expect(sidePanelLayout(400, true)).toEqual({ mode: "overlay", min: 400, max: 400 });
  });

  it("takes the mode from the hysteresis verdict, so a gutter dragged across the threshold does not flip it", () => {
    // Inside the dead-band: still narrow → still floating, its range still the container's.
    expect(sidePanelLayout(DOCK_ENTER_WIDTH + 30, true)).toEqual({ mode: "overlay", min: SIDE_PANEL_MIN_RESERVE, max: DOCK_ENTER_WIDTH + 30 });
    // Not yet narrow at the enter width: docked, the range never below the reserve floor.
    expect(sidePanelLayout(DOCK_ENTER_WIDTH - 1, false)).toEqual({ mode: "docked", min: SIDE_PANEL_MIN_RESERVE, max: SIDE_PANEL_MIN_RESERVE });
  });
});

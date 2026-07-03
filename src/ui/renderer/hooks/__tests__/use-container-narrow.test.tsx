import "../../../../../test/renderer/setup.js";

/**
 * useContainerNarrow drives the ChatView docked-vs-drawer branch: `isNarrow`
 * false → the side panel DOCKS beside the transcript (both panes interactive),
 * true → the modal WorkspaceRailDrawer (backdrop-blur, focus-trap) fallback.
 *
 * The docking threshold is derived from the shared side-panel min width plus a
 * transcript floor — NOT a magic constant that exceeds chat mode's reserved
 * window. Chat mode's OS window reserves `SIDE_PANEL_MIN_WIDTH` on top of its
 * base width for the docked panel, so its container clears the threshold and
 * docks (regression guard for the chat-mode modal-blur bug).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRef } from "react";
import {
  DOCK_ENTER_WIDTH,
  DOCK_EXIT_WIDTH,
  useContainerNarrow,
} from "../use-container-narrow.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../../shared/side-panel.js";

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
    // The chat-mode side-panel window reserves SIDE_PANEL_MIN_WIDTH on top of
    // the ~460px base window; after the collapsed sidebar padding the observed
    // chat-view-root is ≈ 800px. Docking must be allowed there.
    expect(DOCK_EXIT_WIDTH).toBeLessThan(460 + SIDE_PANEL_MIN_WIDTH);
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

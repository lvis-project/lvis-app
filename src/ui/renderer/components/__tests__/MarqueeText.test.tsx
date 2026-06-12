// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MarqueeText } from "../MarqueeText.js";

/**
 * jsdom never lays out, so `scrollWidth`/`clientWidth` are 0 by default. These
 * helpers force a chosen overflow ratio so we can exercise both code paths.
 * The component measures synchronously inside its effect (before the no-op
 * ResizeObserver polyfill observes), so the initial render reflects the stub.
 */
function stubLayout(contentWidth: number, viewportWidth: number) {
  Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
    configurable: true,
    get() {
      return contentWidth;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get() {
      return viewportWidth;
    },
  });
}

function setReducedMotion(reduce: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: reduce && query.includes("reduce"),
      media: query,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
}

describe("MarqueeText", () => {
  const originalGlobalResizeObserver = globalThis.ResizeObserver;
  const originalWindowResizeObserver = window.ResizeObserver;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    setReducedMotion(false);
  });

  afterEach(() => {
    cleanup();
    delete (HTMLElement.prototype as { scrollWidth?: number }).scrollWidth;
    delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: originalGlobalResizeObserver,
    });
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: originalWindowResizeObserver,
    });
    window.matchMedia = originalMatchMedia;
    vi.restoreAllMocks();
  });

  it("renders static (truncate + title) when the text fits its container", () => {
    stubLayout(80, 200);
    render(<MarqueeText text="short" data-testid="mq" />);
    const el = screen.getByTestId("mq");
    expect(el).toHaveAttribute("data-marquee", "static");
    expect(el.className).toContain("relative");
    expect(el.className).toContain("truncate");
    expect(el).toHaveAttribute("title", "short");
    expect(el).not.toHaveAttribute("tabindex");
  });

  it("animates (duplicated track) when the text overflows", () => {
    stubLayout(600, 200);
    render(<MarqueeText text="a very long announcement body that overflows" data-testid="mq" />);
    const el = screen.getByTestId("mq");
    expect(el).toHaveAttribute("data-marquee", "animate");
    expect(el.className).toContain("relative");
    expect(el.className).toContain("lvis-marquee-viewport");
    expect(el).toHaveAttribute("tabindex", "0");
    expect(el.querySelector(".lvis-marquee-track")).not.toBeNull();
    // The text appears twice (visible copy + aria-hidden duplicate) for the loop.
    const copies = Array.from(el.querySelectorAll("span")).filter((s) =>
      s.textContent?.includes("a very long announcement body that overflows"),
    );
    expect(copies.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to static under prefers-reduced-motion even when overflowing", () => {
    setReducedMotion(true);
    stubLayout(600, 200);
    render(<MarqueeText text="overflowing but reduced" data-testid="mq" />);
    const el = screen.getByTestId("mq");
    expect(el).toHaveAttribute("data-marquee", "static");
    expect(el.className).toContain("truncate");
    expect(el).toHaveAttribute("title", "overflowing but reduced");
  });

  it("switches to static when reduced-motion changes while mounted", async () => {
    stubLayout(600, 200);
    let matches = false;
    let changeListener: (() => void) | null = null;
    window.matchMedia = ((query: string) =>
      ({
        get matches() {
          return matches && query.includes("reduce");
        },
        media: query,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
          changeListener = () => {
            if (typeof listener === "function") {
              listener({} as Event);
            } else {
              listener.handleEvent({} as Event);
            }
          };
        },
        removeEventListener: () => {},
        dispatchEvent: () => false,
      })) as typeof window.matchMedia;

    render(<MarqueeText text="live reduced motion update" data-testid="mq" />);
    expect(screen.getByTestId("mq")).toHaveAttribute("data-marquee", "animate");

    matches = true;
    await act(async () => {
      changeListener?.();
    });

    const el = screen.getByTestId("mq");
    expect(el).toHaveAttribute("data-marquee", "static");
    expect(el.querySelector(".lvis-marquee-track")).toBeNull();
  });

  it("uses window.ResizeObserver when the global identifier is absent", () => {
    stubLayout(600, 200);
    class WindowOnlyResizeObserver {
      observe = vi.fn();
      disconnect = vi.fn();
    }
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: WindowOnlyResizeObserver,
    });

    render(<MarqueeText text="window observer only and overflowing" data-testid="mq" />);

    expect(screen.getByTestId("mq")).toHaveAttribute("data-marquee", "animate");
  });

  it("keeps observing the stable measurer when overflow mode flips", async () => {
    let contentWidth = 80;
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() {
        return contentWidth;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() {
        return 200;
      },
    });
    const observed = new Set<Element>();
    let resizeCallback: ResizeObserverCallback | null = null;
    class TestResizeObserver {
      observe = vi.fn((element: Element) => {
        observed.add(element);
      });
      disconnect = vi.fn();
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
    }
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      value: TestResizeObserver,
    });

    render(<MarqueeText text="mode flips while observed" data-testid="mq" />);
    const root = screen.getByTestId("mq");
    const measurer = root.querySelector("[aria-hidden='true']");
    expect(root).toHaveAttribute("data-marquee", "static");
    expect(measurer).not.toBeNull();
    expect(observed.has(measurer as Element)).toBe(true);

    contentWidth = 600;
    await act(async () => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(screen.getByTestId("mq")).toHaveAttribute("data-marquee", "animate");
    expect(observed.has(measurer as Element)).toBe(true);
    expect(screen.getByTestId("mq").querySelector("[aria-hidden='true']")).toBe(measurer);
  });
});

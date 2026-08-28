/**
 * jsdom setup for renderer tests.
 *
 * Imported from each test file (import "./setup"). Sets up:
 *   - @testing-library/jest-dom matchers
 *   - global afterEach cleanup
 *   - matchMedia / scrollIntoView / pointer-capture polyfills
 *   - a driveable IntersectionObserver (see `triggerIntersection`)
 */
import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

const stubbedGlobals = new Map<string, unknown>();

if (typeof (vi as { stubGlobal?: unknown }).stubGlobal !== "function") {
  (vi as {
    stubGlobal: (key: string, value: unknown) => void;
    unstubAllGlobals?: () => void;
  }).stubGlobal = (key: string, value: unknown) => {
    if (!stubbedGlobals.has(key)) {
      stubbedGlobals.set(key, (globalThis as Record<string, unknown>)[key]);
    }
    (globalThis as Record<string, unknown>)[key] = value;
  };
}

if (typeof (vi as { unstubAllGlobals?: unknown }).unstubAllGlobals !== "function") {
  (vi as {
    unstubAllGlobals: () => void;
  }).unstubAllGlobals = () => {
    for (const [key, value] of stubbedGlobals.entries()) {
      if (typeof value === "undefined") {
        delete (globalThis as Record<string, unknown>)[key];
      } else {
        (globalThis as Record<string, unknown>)[key] = value;
      }
    }
    stubbedGlobals.clear();
  };
}

afterEach(() => {
  cleanup();
});

const liveIntersectionObservers = new Set<TestIntersectionObserver>();

/**
 * jsdom lays nothing out, so a real IntersectionObserver would never report an
 * intersection and scroll-driven UI could not be exercised at all. Every
 * observer registers here instead, and `triggerIntersection` delivers the
 * entry a test wants — the intersection becomes an explicit act of the test
 * rather than layout jsdom will never produce.
 */
class TestIntersectionObserver implements IntersectionObserver {
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin: string;
  readonly thresholds: readonly number[];
  private readonly targets = new Set<Element>();
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.callback = callback;
    this.root = (options?.root as Element | Document | null | undefined) ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    this.scrollMargin = options?.scrollMargin ?? "0px";
    const threshold = options?.threshold ?? 0;
    this.thresholds = Array.isArray(threshold) ? threshold : [threshold];
    liveIntersectionObservers.add(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    liveIntersectionObservers.delete(this);
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  deliver(target: Element, isIntersecting: boolean): boolean {
    if (!this.targets.has(target)) return false;
    const rect = target.getBoundingClientRect();
    this.callback(
      [{
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: rect,
        intersectionRect: rect,
        rootBounds: null,
        time: 0,
      } as IntersectionObserverEntry],
      this,
    );
    return true;
  }
}

/**
 * Report `target` as having scrolled into (or out of) its observer's root.
 * Returns the number of observers that were watching it, so a test can assert
 * that the element it picked is actually observed.
 */
export function triggerIntersection(target: Element, isIntersecting = true): number {
  let delivered = 0;
  for (const observer of [...liveIntersectionObservers]) {
    if (observer.deliver(target, isIntersecting)) delivered += 1;
  }
  return delivered;
}

if (typeof window !== "undefined") {
  if (!window.matchMedia) {
    // @ts-expect-error — jsdom doesn't provide matchMedia.
    window.matchMedia = () => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    });
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = function () {};
  }
  if (!Element.prototype.scrollTo) {
    Element.prototype.scrollTo = function () {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = function () {
      return false;
    };
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function () {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function () {};
  }
  if (!window.IntersectionObserver) {
    window.IntersectionObserver = TestIntersectionObserver;
  }
  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      // Match the real ResizeObserver(callback) signature so production
      // `new ResizeObserver(cb)` is not flagged as a superfluous argument.
      constructor(_callback: ResizeObserverCallback) {}
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}

/**
 * Phase 1 — jsdom setup for renderer tests.
 *
 * Imported from each test file (import "./setup"). Sets up:
 *   - @testing-library/jest-dom matchers
 *   - global afterEach cleanup
 *   - matchMedia / scrollIntoView polyfills
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
  if (!window.ResizeObserver) {
    window.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
}

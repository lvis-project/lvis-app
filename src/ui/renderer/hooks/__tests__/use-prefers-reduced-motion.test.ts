// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePrefersReducedMotion } from "../use-prefers-reduced-motion.js";

const originalMatchMedia = window.matchMedia;

/** A controllable `(prefers-reduced-motion: reduce)` query. */
function stubReducedMotion(initial: boolean) {
  let matches = initial;
  let listener: (() => void) | null = null;
  const removeEventListener = vi.fn(() => { listener = null; });
  window.matchMedia = ((query: string) => ({
    get matches() { return matches && query.includes("prefers-reduced-motion: reduce"); },
    media: query,
    addEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
      listener = () => (typeof cb === "function" ? cb({} as Event) : cb.handleEvent({} as Event));
    },
    removeEventListener,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    flip(next: boolean) { matches = next; listener?.(); },
    removeEventListener,
  };
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("usePrefersReducedMotion", () => {
  it("reads the preference at mount", () => {
    stubReducedMotion(true);
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(true);
  });

  it("follows the OS toggle while mounted and unsubscribes on unmount", () => {
    const query = stubReducedMotion(false);
    const { result, unmount } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);

    act(() => query.flip(true));
    expect(result.current).toBe(true);

    act(() => query.flip(false));
    expect(result.current).toBe(false);

    unmount();
    expect(query.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("is false where matchMedia is absent", () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia;
    const { result } = renderHook(() => usePrefersReducedMotion());
    expect(result.current).toBe(false);
  });
});

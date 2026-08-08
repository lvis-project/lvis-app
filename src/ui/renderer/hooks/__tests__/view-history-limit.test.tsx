// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useViewHistory, VIEW_HISTORY_LIMIT } from "../use-view-history.js";
import type { ViewLocation } from "../../utils/view-location.js";

/**
 * The cap, exercised at the hook because reaching it through the app would
 * mean scripting more than fifty real navigations for one property. The
 * wiring itself is proven end to end in App-view-history.test.tsx.
 */
describe("useViewHistory entry cap", () => {
  it("drops the oldest entries instead of growing without bound", () => {
    let location: ViewLocation = { view: "home" };
    const { result, rerender } = renderHook(
      () => useViewHistory(location, (to) => { location = to; }),
    );

    // Alternate between two settings pages so every step is a distinct
    // location and therefore a real entry.
    const overshoot = 12;
    for (let i = 0; i < VIEW_HISTORY_LIMIT + overshoot; i += 1) {
      location = { view: "settings", settingsTab: i % 2 === 0 ? "llm" : "permissions" };
      rerender();
    }

    expect(result.current.depth).toBe(VIEW_HISTORY_LIMIT);
    expect(result.current.canGoBack).toBe(true);
    expect(result.current.canGoForward).toBe(false);
  });

  it("keeps the newest entries — back still replays the most recent steps", () => {
    let location: ViewLocation = { view: "home" };
    const { result, rerender } = renderHook(
      () => useViewHistory(location, (to) => { location = to; }),
    );

    for (let i = 0; i < VIEW_HISTORY_LIMIT + 5; i += 1) {
      location = { view: "settings", settingsTab: i % 2 === 0 ? "llm" : "permissions" };
      rerender();
    }
    const landedOn = location;

    act(() => result.current.goBack());
    rerender();
    // The step back moved somewhere, and it is not where we just were.
    expect(location).not.toEqual(landedOn);
    expect(result.current.canGoForward).toBe(true);
  });
});

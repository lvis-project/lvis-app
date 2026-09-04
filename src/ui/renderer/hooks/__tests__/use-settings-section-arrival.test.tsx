/**
 * Arrival on a settings deep link: scroll, focus, ring, then let go.
 *
 * The ring is the only part a reader can see, and the part most easily broken
 * by a refactor — it is added by one effect and removed by another, and the
 * consuming `onApplied` runs in between. Fuse the two and the ring is torn off
 * in the tick it appeared, which looks exactly like "nothing happened".
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SETTINGS_SECTION_ARRIVAL_CLASS,
  useSettingsSectionArrival,
} from "../use-settings-tab.js";

let frames: FrameRequestCallback[] = [];
let scrolled: ScrollIntoViewOptions[] = [];
let reducedMotion = false;
let motionListeners: (() => void)[] = [];

function anchor(section: string): HTMLElement {
  const node = document.createElement("div");
  node.setAttribute("data-settings-section", section);
  node.tabIndex = -1;
  node.scrollIntoView = ((options: ScrollIntoViewOptions) => {
    scrolled.push(options);
  }) as HTMLElement["scrollIntoView"];
  document.body.append(node);
  return node;
}

/** Run the frame the hook queued, inside `act` so its state update lands. */
function flushFrame(): void {
  const queued = frames;
  frames = [];
  act(() => {
    for (const frame of queued) frame(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  frames = [];
  scrolled = [];
  reducedMotion = false;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  motionListeners = [];
  // The hook reads the preference through `usePrefersReducedMotion`, which
  // subscribes, so this stub has to be a working `EventTarget` and not just a
  // `matches` snapshot — and the listeners are kept so a test can flip the OS
  // setting the way the OS does.
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query.includes("prefers-reduced-motion") && reducedMotion;
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => {
      motionListeners.push(listener);
    },
    removeEventListener: (_type: string, listener: () => void) => {
      motionListeners = motionListeners.filter((entry) => entry !== listener);
    },
  })) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe("useSettingsSectionArrival", () => {
  it("scrolls, focuses and rings the section, then drops the ring", () => {
    const node = anchor("permissions-os-sandbox");
    const onApplied = vi.fn();
    renderHook(() => useSettingsSectionArrival("permissions-os-sandbox", onApplied));

    flushFrame();

    expect(scrolled).toEqual([{ block: "start", behavior: "smooth" }]);
    expect(document.activeElement).toBe(node);
    expect(node.classList.contains(SETTINGS_SECTION_ARRIVAL_CLASS)).toBe(true);
    expect(onApplied).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(node.classList.contains(SETTINGS_SECTION_ARRIVAL_CLASS)).toBe(false);
  });

  it("keeps the ring on after the caller has dropped the one-shot", () => {
    // The window clears its target the moment `onApplied` fires. Were the ring
    // owned by the same effect, that clear would remove it immediately.
    const node = anchor("permissions-os-sandbox");
    const { rerender } = renderHook(
      ({ section }: { section: string | null }) =>
        useSettingsSectionArrival(section, () => undefined),
      { initialProps: { section: "permissions-os-sandbox" as string | null } },
    );

    flushFrame();
    rerender({ section: null });

    expect(node.classList.contains(SETTINGS_SECTION_ARRIVAL_CLASS)).toBe(true);
  });

  it("does not animate the ring in under reduced motion", () => {
    reducedMotion = true;
    anchor("permissions-os-sandbox");
    renderHook(() => useSettingsSectionArrival("permissions-os-sandbox", () => undefined));

    flushFrame();

    // The stylesheet turns the transition off for this class; the hook's own
    // share is the scroll, which must not animate either.
    expect(scrolled).toEqual([{ block: "start", behavior: "auto" }]);
  });

  it("does not arrive a second time when the OS motion setting flips", () => {
    // The preference is subscribed, so it can change while the panel is open.
    // Arrival is an event, not a state: re-running it would scroll and re-ring
    // a section the reader had already moved past.
    anchor("permissions-os-sandbox");
    const onApplied = vi.fn();
    renderHook(() => useSettingsSectionArrival("permissions-os-sandbox", onApplied));

    flushFrame();
    expect(scrolled).toEqual([{ block: "start", behavior: "smooth" }]);

    reducedMotion = true;
    act(() => {
      for (const listener of motionListeners) listener();
    });
    flushFrame();

    expect(scrolled).toHaveLength(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("consumes the target even when the tab anchors nothing by that name", () => {
    const onApplied = vi.fn();
    renderHook(() => useSettingsSectionArrival("not-a-section", onApplied));

    flushFrame();

    expect(scrolled).toEqual([]);
    expect(onApplied).toHaveBeenCalledTimes(1);
  });

  it("does nothing at all without a target", () => {
    const onApplied = vi.fn();
    renderHook(() => useSettingsSectionArrival(null, onApplied));

    expect(frames).toHaveLength(0);
    expect(onApplied).not.toHaveBeenCalled();
  });
});

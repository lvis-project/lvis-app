import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebouncedSave } from "../use-debounced-save.js";

describe("useDebouncedSave", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires saveFn once after the debounce window when scheduled once", () => {
    const saveFn = vi.fn();
    const { result } = renderHook(() => useDebouncedSave(saveFn, 200));

    act(() => {
      result.current.schedule();
    });

    expect(saveFn).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(saveFn).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("collapses a rapid burst of schedules into a single fire", () => {
    const saveFn = vi.fn();
    const { result } = renderHook(() => useDebouncedSave(saveFn, 200));

    act(() => {
      result.current.schedule();
      vi.advanceTimersByTime(100);
      result.current.schedule();
      vi.advanceTimersByTime(100);
      result.current.schedule();
    });

    // The second + third schedules reset the timer; the saveFn should only
    // fire 200ms after the last schedule call.
    expect(saveFn).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(199);
    });
    expect(saveFn).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("cancel prevents a pending saveFn from firing", () => {
    const saveFn = vi.fn();
    const { result } = renderHook(() => useDebouncedSave(saveFn, 200));

    act(() => {
      result.current.schedule();
      vi.advanceTimersByTime(100);
      result.current.cancel();
      vi.advanceTimersByTime(200);
    });

    expect(saveFn).not.toHaveBeenCalled();
  });

  it("cancel after fire is a no-op (does not error)", () => {
    const saveFn = vi.fn();
    const { result } = renderHook(() => useDebouncedSave(saveFn, 200));

    act(() => {
      result.current.schedule();
      vi.advanceTimersByTime(200);
    });
    expect(saveFn).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.cancel();
    });
    expect(saveFn).toHaveBeenCalledTimes(1);
  });

  it("uses the latest saveFn closure when the timer fires", () => {
    const firstSave = vi.fn();
    const secondSave = vi.fn();

    const { result, rerender } = renderHook(({ fn }) => useDebouncedSave(fn, 200), {
      initialProps: { fn: firstSave },
    });

    act(() => {
      result.current.schedule();
      vi.advanceTimersByTime(100);
    });

    // Re-render the hook with a new saveFn before the timer fires.
    rerender({ fn: secondSave });

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(firstSave).not.toHaveBeenCalled();
    expect(secondSave).toHaveBeenCalledTimes(1);
  });

  it("clears the pending timer on unmount (no leak, no fire)", () => {
    const saveFn = vi.fn();
    const { result, unmount } = renderHook(() => useDebouncedSave(saveFn, 200));

    act(() => {
      result.current.schedule();
      vi.advanceTimersByTime(100);
    });
    unmount();
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(saveFn).not.toHaveBeenCalled();
  });

  it("schedule + cancel + schedule fires exactly once for the second schedule", () => {
    const saveFn = vi.fn();
    const { result } = renderHook(() => useDebouncedSave(saveFn, 200));

    act(() => {
      result.current.schedule();
      result.current.cancel();
      result.current.schedule();
      vi.advanceTimersByTime(200);
    });

    expect(saveFn).toHaveBeenCalledTimes(1);
  });
});

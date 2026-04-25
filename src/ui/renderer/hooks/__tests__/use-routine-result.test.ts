/**
 * useRoutineResult — queue semantics: stacking, in-place updates, FIFO drop,
 * navigation, snooze re-push and snooze cap.
 */
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useRoutineResult } from "../use-routine-result.js";
import type { LvisApi } from "../../types.js";

type RoutineResult = {
  routineId: string;
  trigger: string;
  summary: string;
  generatedAt: string;
};

function makeResult(routineId: string, summary: string): RoutineResult {
  return {
    routineId,
    trigger: routineId.startsWith("schedule") ? "schedule" : routineId,
    summary,
    generatedAt: new Date().toISOString(),
  };
}

function makeApi(latest: RoutineResult | null = null) {
  let onCompleted: ((r: RoutineResult) => void) | null = null;
  const api = {
    onRoutineCompleted: vi.fn((cb: (r: RoutineResult) => void) => {
      onCompleted = cb;
      return () => {
        onCompleted = null;
      };
    }),
    getLatestRoutineResult: vi.fn(async () => latest),
  } as unknown as LvisApi;
  return {
    api,
    emit: (r: RoutineResult) => onCompleted?.(r),
  };
}

describe("useRoutineResult — queue semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("appends results with distinct routineIds and indicates the stack size", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useRoutineResult(api));

    await act(async () => {
      emit(makeResult("wakeup", "morning"));
    });
    await act(async () => {
      emit(makeResult("schedule-1", "midday"));
    });
    await act(async () => {
      emit(makeResult("shutdown", "evening"));
    });

    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(3);
    });
    expect(result.current.routineResult?.summary).toBe("evening");
    expect(result.current.routineQueueIndex).toBe(2);
  });

  it("in-place updates a slot when the same routineId arrives", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useRoutineResult(api));

    await act(async () => {
      emit(makeResult("wakeup", "v1"));
    });
    await act(async () => {
      emit(makeResult("schedule-1", "midday"));
    });
    await act(async () => {
      emit(makeResult("wakeup", "v2"));
    });

    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(2);
    });
    expect(result.current.routineResult?.summary).toBe("v2");
    expect(result.current.routineResult?.routineId).toBe("wakeup");
  });

  it("FIFO-drops the oldest entry when the queue exceeds the cap (5)", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useRoutineResult(api));

    for (let i = 0; i < 6; i++) {
      await act(async () => {
        emit(makeResult(`schedule-${i}`, `s${i}`));
      });
    }

    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(5);
    });
    expect(result.current.routineResult?.summary).toBe("s5");
  });

  it("prev/next navigates through the queue without mutating it", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useRoutineResult(api));

    await act(async () => {
      emit(makeResult("a", "first"));
    });
    await act(async () => {
      emit(makeResult("b", "second"));
    });

    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(2);
    });
    expect(result.current.routineResult?.summary).toBe("second");

    act(() => result.current.goPrev());
    expect(result.current.routineResult?.summary).toBe("first");
    expect(result.current.routineQueueIndex).toBe(0);

    act(() => result.current.goNext());
    expect(result.current.routineResult?.summary).toBe("second");
    expect(result.current.routineQueueIndex).toBe(1);
  });

  it("dismiss removes only the current entry", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useRoutineResult(api));

    await act(async () => {
      emit(makeResult("a", "first"));
    });
    await act(async () => {
      emit(makeResult("b", "second"));
    });

    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(2);
    });
    act(() => result.current.dismiss());

    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(1);
    });
    expect(result.current.routineResult?.summary).toBe("first");
  });

  it("snooze removes the card and re-pushes it after the requested delay", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useRoutineResult(api));

    await act(async () => {
      emit(makeResult("wakeup", "first"));
    });
    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(1);
    });

    act(() => result.current.snooze(15 * 60_000));
    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(0);
    });

    await act(async () => {
      vi.advanceTimersByTime(15 * 60_000);
    });

    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(1);
    });
    expect(result.current.routineResult?.summary).toBe("first");
  });

  it("stops re-pushing after the snooze cap (3) is reached", async () => {
    const { api, emit } = makeApi();
    const { result } = renderHook(() => useRoutineResult(api));

    await act(async () => {
      emit(makeResult("wakeup", "loop"));
    });

    for (let i = 0; i < 3; i++) {
      await waitFor(() => {
        expect(result.current.routineQueueTotal).toBe(1);
      });
      act(() => result.current.snooze(15 * 60_000));
      await waitFor(() => {
        expect(result.current.routineQueueTotal).toBe(0);
      });
      await act(async () => {
        vi.advanceTimersByTime(15 * 60_000);
      });
    }

    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(1);
    });

    // 4th snooze: card disappears and never returns.
    act(() => result.current.snooze(15 * 60_000));
    await waitFor(() => {
      expect(result.current.routineQueueTotal).toBe(0);
    });
    await act(async () => {
      vi.advanceTimersByTime(60 * 60_000);
    });
    expect(result.current.routineQueueTotal).toBe(0);
  });

  it("does not let the rehydrated latest result overwrite a live event", async () => {
    let resolveLatest: ((value: RoutineResult | null) => void) | null = null;
    const onCompletedHandlers: Array<(r: RoutineResult) => void> = [];
    const api = {
      onRoutineCompleted: vi.fn((cb: (r: RoutineResult) => void) => {
        onCompletedHandlers.push(cb);
        return () => {};
      }),
      getLatestRoutineResult: vi.fn(
        () =>
          new Promise<RoutineResult | null>((resolve) => {
            resolveLatest = resolve;
          }),
      ),
    } as unknown as LvisApi;

    const { result } = renderHook(() => useRoutineResult(api));

    await act(async () => {
      onCompletedHandlers[0]?.(makeResult("wakeup", "fresh"));
    });
    await waitFor(() => {
      expect(result.current.routineResult?.summary).toBe("fresh");
    });

    await act(async () => {
      resolveLatest?.(makeResult("wakeup", "stale"));
    });

    expect(result.current.routineResult?.summary).toBe("fresh");
    expect(result.current.routineQueueTotal).toBe(1);
  });
});

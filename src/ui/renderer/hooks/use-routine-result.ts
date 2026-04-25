import { useCallback, useEffect, useReducer, useRef } from "react";
import type { LvisApi } from "../types.js";

type RoutineResult = {
  routineId: string;
  trigger: string;
  summary: string;
  generatedAt: string;
};

interface QueueEntry {
  result: RoutineResult;
  /** Number of times this entry has been re-pushed via snooze. Capped at MAX_SNOOZE. */
  snoozeCount: number;
}

interface State {
  queue: QueueEntry[];
  currentIndex: number;
}

type Action =
  | { type: "enqueue"; result: RoutineResult; snoozeCount: number }
  | { type: "seed"; result: RoutineResult }
  | { type: "dismiss" }
  | { type: "snooze" }
  | { type: "prev" }
  | { type: "next" };

const MAX_QUEUE = 5;
const MAX_SNOOZE = 3;
const INITIAL_STATE: State = { queue: [], currentIndex: 0 };

/**
 * Single reducer keeps `queue` and `currentIndex` in lockstep. A previous
 * implementation split them across two `useState` hooks plus a microtask to
 * sync the index after each `setQueue`; under React 18 batching that opens a
 * stale-closure window where dismiss/snooze could splice the wrong slot if
 * the user acted before the microtask flushed. The reducer makes every
 * mutation atomic.
 */
function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "enqueue": {
      const existingIdx = state.queue.findIndex(
        (e) => e.result.routineId === action.result.routineId,
      );
      if (existingIdx >= 0) {
        // In-place refresh — preserve slot, reset snooze count, jump to it so
        // the freshest data is what the user sees on next render.
        const next = state.queue.slice();
        next[existingIdx] = { result: action.result, snoozeCount: 0 };
        return { queue: next, currentIndex: existingIdx };
      }
      const appended = [...state.queue, { result: action.result, snoozeCount: action.snoozeCount }];
      const droppedCount = Math.max(0, appended.length - MAX_QUEUE);
      const trimmed = droppedCount > 0 ? appended.slice(droppedCount) : appended;
      return { queue: trimmed, currentIndex: trimmed.length - 1 };
    }
    case "seed": {
      // Only seeds when empty — the live event stream takes priority.
      if (state.queue.length > 0) return state;
      return { queue: [{ result: action.result, snoozeCount: 0 }], currentIndex: 0 };
    }
    case "dismiss":
    case "snooze": {
      if (state.currentIndex < 0 || state.currentIndex >= state.queue.length) return state;
      const next = state.queue
        .slice(0, state.currentIndex)
        .concat(state.queue.slice(state.currentIndex + 1));
      const nextIdx = next.length === 0 ? 0 : Math.min(state.currentIndex, next.length - 1);
      return { queue: next, currentIndex: nextIdx };
    }
    case "prev": {
      return state.currentIndex > 0
        ? { ...state, currentIndex: state.currentIndex - 1 }
        : state;
    }
    case "next": {
      return state.currentIndex < state.queue.length - 1
        ? { ...state, currentIndex: state.currentIndex + 1 }
        : state;
    }
  }
}

/**
 * Routine result queue hook.
 *
 * Maintains an in-memory stack of unread RoutineResults (max MAX_QUEUE).
 * Behavior:
 *   - new result with same routineId as a queued entry → in-place update
 *     (slot kept, summary/generatedAt overwritten); currentIndex jumps to it
 *   - new result with a fresh routineId → appended; currentIndex jumps to it.
 *     If over cap, the oldest entry is FIFO-dropped before computing the new
 *     index so we always land on the new card
 *   - dismiss → remove current entry, neighbour-clamp
 *   - snooze(ms) → remove current entry, schedule re-push after `ms`. The
 *     re-pushed entry carries snoozeCount; once a card has been snoozed
 *     MAX_SNOOZE times, it dismisses instead of scheduling another re-push
 *
 * Persistence: in-memory only — full reload starts empty (the latest single
 * result is still rehydrated from `getLatestRoutineResult` for continuity).
 */
export function useRoutineResult(api: LvisApi) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const aliveRef = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const snoozeTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    aliveRef.current = true;
    const timersAtMount = snoozeTimers.current;
    const unsubscribe = api.onRoutineCompleted((result) => {
      if (aliveRef.current) dispatch({ type: "enqueue", result, snoozeCount: 0 });
    });
    void api.getLatestRoutineResult().then((latest) => {
      if (!aliveRef.current || !latest) return;
      dispatch({ type: "seed", result: latest });
    }).catch((e: Error) => {
      console.warn("[lvis] getLatestRoutineResult failed:", e.message);
    });
    return () => {
      aliveRef.current = false;
      unsubscribe();
      for (const t of timersAtMount) clearTimeout(t);
      timersAtMount.clear();
    };
  }, [api]);

  const dismiss = useCallback(() => {
    if (!aliveRef.current) return;
    dispatch({ type: "dismiss" });
  }, []);

  const snooze = useCallback((durationMs: number = 60 * 60_000) => {
    if (!aliveRef.current) return;
    // Capture the entry being snoozed *before* dispatching, so the eventual
    // re-push references the result the user actually saw — a concurrent
    // enqueue would otherwise mutate the slot under us.
    const cur = stateRef.current;
    if (cur.currentIndex < 0 || cur.currentIndex >= cur.queue.length) return;
    const entry = cur.queue[cur.currentIndex];
    const nextSnoozeCount = entry.snoozeCount + 1;
    dispatch({ type: "snooze" });
    if (nextSnoozeCount <= MAX_SNOOZE) {
      const timer = setTimeout(() => {
        snoozeTimers.current.delete(timer);
        if (!aliveRef.current) return;
        dispatch({ type: "enqueue", result: entry.result, snoozeCount: nextSnoozeCount });
      }, durationMs);
      snoozeTimers.current.add(timer);
    }
  }, []);

  const goPrev = useCallback(() => {
    if (!aliveRef.current) return;
    dispatch({ type: "prev" });
  }, []);

  const goNext = useCallback(() => {
    if (!aliveRef.current) return;
    dispatch({ type: "next" });
  }, []);

  const queue = state.queue;
  const idx = queue.length === 0 ? 0 : Math.min(state.currentIndex, queue.length - 1);
  const routineResult = queue.length === 0 ? null : (queue[idx]?.result ?? null);

  return {
    routineResult,
    routineQueueIndex: idx,
    routineQueueTotal: queue.length,
    dismiss,
    snooze,
    goPrev,
    goNext,
  };
}

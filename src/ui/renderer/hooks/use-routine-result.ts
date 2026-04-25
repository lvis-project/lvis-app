import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

const MAX_QUEUE = 5;
const MAX_SNOOZE = 3;

/**
 * Routine result queue hook.
 *
 * Maintains an in-memory stack of unread RoutineResults (max MAX_QUEUE).
 * Behavior:
 *   - new result with same routineId as a queued entry → in-place update
 *     (slot kept, summary/generatedAt overwritten); currentIndex jumps to it
 *   - new result with a fresh routineId → appended; currentIndex jumps to it
 *   - queue overflow → oldest entry FIFO-dropped
 *   - dismiss → remove current entry, currentIndex moves to neighbor
 *   - snooze(ms) → remove current entry, schedule re-push after `ms`. The
 *     re-pushed entry carries snoozeCount; once a card has been snoozed
 *     MAX_SNOOZE times, it dismisses instead of scheduling another re-push
 *
 * Persistence: the queue is in-memory only — full reload starts empty (the
 * latest single result is still rehydrated from `getLatestRoutineResult` for
 * continuity).
 */
export function useRoutineResult(api: LvisApi) {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const aliveRef = useRef(true);
  const snoozeTimers = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  const enqueue = useCallback((result: RoutineResult, snoozeCount = 0) => {
    setQueue((prev) => {
      const existingIdx = prev.findIndex((e) => e.result.routineId === result.routineId);
      if (existingIdx >= 0) {
        // In-place update — preserve slot position, refresh content, reset snooze.
        const next = prev.slice();
        next[existingIdx] = { result, snoozeCount: 0 };
        // Defer index update to a microtask so two state updates in the same
        // render don't fight. Point currentIndex at the refreshed slot to
        // surface the new data.
        queueMicrotask(() => {
          if (aliveRef.current) setCurrentIndex(existingIdx);
        });
        return next;
      }
      // Append; FIFO-drop oldest if over cap.
      const appended = [...prev, { result, snoozeCount }];
      const trimmed = appended.length > MAX_QUEUE
        ? appended.slice(appended.length - MAX_QUEUE)
        : appended;
      const newIdx = trimmed.length - 1;
      queueMicrotask(() => {
        if (aliveRef.current) setCurrentIndex(newIdx);
      });
      return trimmed;
    });
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    const timersAtMount = snoozeTimers.current;
    const unsubscribe = api.onRoutineCompleted((result) => {
      if (aliveRef.current) enqueue(result);
    });
    void api.getLatestRoutineResult().then((latest) => {
      if (!aliveRef.current || !latest) return;
      // Only seed if queue is still empty — avoid re-injecting after live events.
      setQueue((prev) => {
        if (prev.length > 0) return prev;
        return [{ result: latest, snoozeCount: 0 }];
      });
    }).catch((e: Error) => {
      console.warn("[lvis] getLatestRoutineResult failed:", e.message);
    });
    return () => {
      aliveRef.current = false;
      unsubscribe();
      for (const t of timersAtMount) clearTimeout(t);
      timersAtMount.clear();
    };
  }, [api, enqueue]);

  // Clamp currentIndex when queue shrinks.
  useEffect(() => {
    if (queue.length === 0) {
      if (currentIndex !== 0) setCurrentIndex(0);
      return;
    }
    if (currentIndex >= queue.length) {
      setCurrentIndex(queue.length - 1);
    }
  }, [queue.length, currentIndex]);

  const dismiss = useCallback(() => {
    if (!aliveRef.current) return;
    setQueue((prev) => {
      if (currentIndex < 0 || currentIndex >= prev.length) return prev;
      const next = prev.slice(0, currentIndex).concat(prev.slice(currentIndex + 1));
      queueMicrotask(() => {
        if (!aliveRef.current) return;
        setCurrentIndex((cur) => {
          if (next.length === 0) return 0;
          if (cur > currentIndex) return cur - 1;
          return Math.min(cur, next.length - 1);
        });
      });
      return next;
    });
  }, [currentIndex]);

  const snooze = useCallback((durationMs: number = 60 * 60_000) => {
    if (!aliveRef.current) return;
    setQueue((prev) => {
      if (currentIndex < 0 || currentIndex >= prev.length) return prev;
      const entry = prev[currentIndex];
      const nextSnoozeCount = entry.snoozeCount + 1;
      const next = prev.slice(0, currentIndex).concat(prev.slice(currentIndex + 1));
      queueMicrotask(() => {
        if (!aliveRef.current) return;
        setCurrentIndex((cur) => {
          if (next.length === 0) return 0;
          if (cur > currentIndex) return cur - 1;
          return Math.min(cur, next.length - 1);
        });
      });
      // Schedule re-push only if under MAX_SNOOZE; otherwise the card is gone for good.
      if (nextSnoozeCount <= MAX_SNOOZE) {
        const timer = setTimeout(() => {
          snoozeTimers.current.delete(timer);
          if (!aliveRef.current) return;
          enqueue(entry.result, nextSnoozeCount);
        }, durationMs);
        snoozeTimers.current.add(timer);
      }
      return next;
    });
  }, [currentIndex, enqueue]);

  const goPrev = useCallback(() => {
    setCurrentIndex((cur) => (cur > 0 ? cur - 1 : cur));
  }, []);

  const goNext = useCallback(() => {
    setCurrentIndex((cur) => (cur < queue.length - 1 ? cur + 1 : cur));
  }, [queue.length]);

  const routineResult = useMemo<RoutineResult | null>(() => {
    if (queue.length === 0) return null;
    const idx = Math.min(currentIndex, queue.length - 1);
    return queue[idx]?.result ?? null;
  }, [queue, currentIndex]);

  return {
    routineResult,
    routineQueueIndex: queue.length === 0 ? 0 : Math.min(currentIndex, queue.length - 1),
    routineQueueTotal: queue.length,
    dismiss,
    snooze,
    goPrev,
    goNext,
  };
}

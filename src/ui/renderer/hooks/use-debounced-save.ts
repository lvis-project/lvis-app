import { useCallback, useEffect, useMemo, useRef } from "react";

export interface DebouncedSave {
  /** Schedule a save call `ms` after the most recent invocation. */
  schedule: () => void;
  /** Cancel any pending save without firing. Safe to call when nothing is pending. */
  cancel: () => void;
}

/**
 * Trailing-edge debounced save. Returns a `{ schedule, cancel }` pair.
 *
 * Usage:
 *   const save = useDebouncedSave(() => void api.savePref(draft), 200);
 *   // call save.schedule() after every immediate-apply control change;
 *   // rapid bursts collapse to a single save invocation 200ms after
 *   // the most recent call. Call save.cancel() if a manual save fires
 *   // in the meantime so the same payload doesn't double-write.
 *
 * The save function is called via a ref so consumers can pass an inline
 * arrow without thrashing the debounce when the closure identity changes
 * every render. Only the most recent `saveFn` runs when the timer fires.
 */
export function useDebouncedSave(saveFn: () => void, ms = 200): DebouncedSave {
  const savedFn = useRef(saveFn);
  savedFn.current = saveFn;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => cancel, [cancel]);

  const schedule = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      savedFn.current();
    }, ms);
  }, [ms]);

  return useMemo(() => ({ schedule, cancel }), [schedule, cancel]);
}

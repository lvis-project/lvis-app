/**
 * useStackedChat — reverse infinite scroll hook for StackedChatView.
 *
 * Loads sessions for today + yesterday on mount, then prefetches one
 * additional day each time the user scrolls to the top of the list.
 * Scroll position is preserved after prepending older entries.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LvisApi } from "../types.js";
import type { SessionSummary } from "./use-sessions.js";

// Lightweight dev console logger — guarded against renderer contexts where
// `process` is not defined (esbuild --platform=browser without process shim).
const debugLog = (msg: string, ...args: unknown[]) => {
  if (typeof process !== "undefined" && process.env?.NODE_ENV !== "production") {
    console.debug("[useStackedChat]", msg, ...args);
  }
};

export type StackedSession = SessionSummary & {
  /** ISO date string for day grouping, e.g. "2026-04-30" */
  dayKey: string;
};

/** How many days back we've loaded so far (0 = today only, 1 = + yesterday, …) */
const INITIAL_DAYS_BACK = 1;

function toISODateKey(iso: string): string {
  return iso.split("T")[0] ?? iso.substring(0, 10);
}

function dateKeyDaysBack(daysBack: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().split("T")[0] as string;
}

export interface UseStackedChatReturn {
  /** All loaded sessions ordered oldest → newest */
  sessions: StackedSession[];
  /** True while initial load or prefetch in progress */
  loading: boolean;
  /** True when there are no more historical sessions to load */
  reachedEnd: boolean;
  /** Call to load one more day of history (typically triggered by sentinel observer) */
  loadMore: () => Promise<void>;
  /** Ref to attach to a sentinel element at the top of the list */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  /** Ref to attach to the scroll container for position preservation */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}

export function useStackedChat(api: LvisApi): UseStackedChatReturn {
  const [sessions, setSessions] = useState<StackedSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [daysLoaded, setDaysLoaded] = useState(INITIAL_DAYS_BACK);
  const [reachedEnd, setReachedEnd] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);

  const fetchSessionsForDayRange = useCallback(
    async (fromDaysBack: number, toDaysBack: number): Promise<StackedSession[]> => {
      const fromKey = dateKeyDaysBack(fromDaysBack);
      const toKey = dateKeyDaysBack(toDaysBack);
      try {
        const { sessions: all } = await api.chatSessions();
        return all
          .filter((s) => {
            const dk = toISODateKey(s.modifiedAt);
            return dk >= fromKey && dk <= toKey;
          })
          .map((s) => ({ ...s, dayKey: toISODateKey(s.modifiedAt) }))
          .sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt));
      } catch {
        return [];
      }
    },
    [api],
  );

  // Initial load: today (0) + yesterday (1)
  useEffect(() => {
    let cancelled = false;
    debugLog("mount — loading initial sessions (today + yesterday)");
    void (async () => {
      setLoading(true);
      const loaded = await fetchSessionsForDayRange(0, INITIAL_DAYS_BACK);
      if (cancelled) return;
      debugLog("initial load complete, session count:", loaded.length, loaded.map((s) => s.id.slice(0, 8)));
      setSessions(loaded);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchSessionsForDayRange]);

  const loadMore = useCallback(async () => {
    if (loadingRef.current || reachedEnd) return;
    loadingRef.current = true;
    setLoading(true);

    const nextDay = daysLoaded + 1;
    const older = await fetchSessionsForDayRange(nextDay, nextDay);

    // Preserve scroll position during prepend
    const container = scrollContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;
    const prevScrollTop = container?.scrollTop ?? 0;

    setSessions((prev) => {
      if (older.length === 0) {
        return prev;
      }
      // De-duplicate by session id
      const existingIds = new Set(prev.map((s) => s.id));
      const novel = older.filter((s) => !existingIds.has(s.id));
      return [...novel, ...prev];
    });

    if (older.length === 0) {
      setReachedEnd(true);
    } else {
      setDaysLoaded(nextDay);
    }

    // Restore scroll position after prepend so view doesn't jump
    if (container) {
      requestAnimationFrame(() => {
        const delta = container.scrollHeight - prevScrollHeight;
        container.scrollTop = prevScrollTop + delta;
      });
    }

    setLoading(false);
    loadingRef.current = false;
  }, [daysLoaded, fetchSessionsForDayRange, reachedEnd]);

  // IntersectionObserver on sentinel element — fires when user scrolls to top
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !loadingRef.current && !reachedEnd) {
          void loadMore();
        }
      },
      { root: scrollContainerRef.current, threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore, reachedEnd]);

  return {
    sessions,
    loading,
    reachedEnd,
    loadMore,
    sentinelRef,
    scrollContainerRef,
  };
}

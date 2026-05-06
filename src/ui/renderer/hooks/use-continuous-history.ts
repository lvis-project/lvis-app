import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";
import { sessionHistoryToEntries, type SessionSummary } from "./use-sessions.js";

export type ContinuousHistorySession = SessionSummary & {
  dayKey: string;
  entries: ChatEntry[];
};

const PAGE_SIZE = 20;

type HistoryCursor = {
  modifiedAt: string;
  id: string;
};

export function useContinuousHistory(
  api: LvisApi,
  currentSessionId: string,
  enabled = true,
  currentSessionAnchor?: HistoryCursor,
) {
  const [sessions, setSessions] = useState<ContinuousHistorySession[]>([]);
  const [loading, setLoading] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const dayCursorRef = useRef<HistoryCursor | undefined>(undefined);
  const targetDayKeyRef = useRef<string | undefined>(undefined);
  const loadingRef = useRef(false);
  const reachedEndRef = useRef(false);
  const requestTokenRef = useRef(0);
  const currentSessionIdRef = useRef(currentSessionId);
  const currentSessionAnchorId = currentSessionAnchor?.id;
  const currentSessionAnchorModifiedAt = currentSessionAnchor?.modifiedAt;

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const loadEntries = useCallback(async (sessionId: string): Promise<ChatEntry[]> => {
    try {
      const history = await api.chatSessionHistory(sessionId);
      if (!history.ok) return [];
      return sessionHistoryToEntries(history);
    } catch {
      return [];
    }
  }, [api]);

  const loadMore = useCallback(async () => {
    if (!enabled || !currentSessionId || loadingRef.current || reachedEndRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    const viewport = scrollViewportRef.current;
    const prevScrollHeight = viewport?.scrollHeight ?? 0;
    const prevScrollTop = viewport?.scrollTop ?? 0;
    const requestToken = requestTokenRef.current;

    try {
      const page = await loadNextDayPage(api, targetDayKeyRef.current, dayCursorRef.current);
      if (requestToken !== requestTokenRef.current) return;
      const pageSessions = page.sessions;
      const oldest = pageSessions[pageSessions.length - 1];

      const filtered = pageSessions.filter((session) => session.id !== currentSessionIdRef.current);
      const hydrated = await Promise.all(
        filtered.map(async (session) => ({
          ...session,
          dayKey: toDateKey(session.modifiedAt),
          entries: await loadEntries(session.id),
        })),
      );
      if (requestToken !== requestTokenRef.current) return;
      if (page.exhausted) {
        reachedEndRef.current = true;
        setReachedEnd(true);
      } else if (oldest && pageSessions.length >= PAGE_SIZE) {
        targetDayKeyRef.current = page.dayKey;
        dayCursorRef.current = { modifiedAt: oldest.modifiedAt, id: oldest.id };
      } else {
        targetDayKeyRef.current = previousDateKey(page.dayKey);
        dayCursorRef.current = undefined;
      }
      const visible = hydrated
        .filter((session) => session.entries.length > 0)
        .sort((a, b) => {
          const timeDelta = a.modifiedAt.localeCompare(b.modifiedAt);
          return timeDelta !== 0 ? timeDelta : a.id.localeCompare(b.id);
        });

      setSessions((prev) => {
        if (visible.length === 0) return prev;
        const existing = new Set(prev.map((session) => session.id));
        const novel = visible.filter((session) => !existing.has(session.id));
        return [...novel, ...prev];
      });

      if (viewport && prevScrollHeight > 0) {
        requestAnimationFrame(() => {
          const delta = viewport.scrollHeight - prevScrollHeight;
          viewport.scrollTop = prevScrollTop + delta;
        });
      }
    } finally {
      if (requestToken === requestTokenRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [api, currentSessionId, enabled, loadEntries]);

  useEffect(() => {
    requestTokenRef.current += 1;
    setSessions([]);
    setReachedEnd(false);
    reachedEndRef.current = false;
    targetDayKeyRef.current = previousDateKey(
      currentSessionAnchorModifiedAt ? toDateKey(currentSessionAnchorModifiedAt) : toDateKey(new Date().toISOString()),
    );
    dayCursorRef.current = undefined;
    loadingRef.current = false;
    if (enabled && currentSessionId) {
      void loadMore();
    }
  }, [currentSessionId, currentSessionAnchorId, currentSessionAnchorModifiedAt, enabled, loadMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!enabled || !sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          void loadMore();
        }
      },
      { root: scrollViewportRef.current, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [enabled, loadMore]);

  return {
    historicalSessions: sessions,
    loading,
    reachedEnd,
    sentinelRef,
    scrollViewportRef,
    loadMore,
  };
}

async function loadNextDayPage(
  api: LvisApi,
  targetDayKey: string | undefined,
  dayCursor: HistoryCursor | undefined,
): Promise<{ dayKey: string; sessions: SessionSummary[]; exhausted: boolean }> {
  const dayKey = targetDayKey ?? previousDateKey(toDateKey(new Date().toISOString()));
  const dayBounds = dayWindow(dayKey);
  const page = await api.chatSessions({
    limit: PAGE_SIZE,
    before: dayCursor?.modifiedAt ?? dayBounds.before,
    ...(dayCursor ? { beforeId: dayCursor.id } : {}),
    after: dayBounds.after,
  });
  if (page.sessions.length > 0) {
    return { dayKey, sessions: page.sessions, exhausted: false };
  }

  const older = await api.chatSessions({ limit: 1, before: dayBounds.after });
  const nextAvailable = older.sessions[0];
  if (!nextAvailable) {
    return { dayKey, sessions: [], exhausted: true };
  }

  const nextDayKey = toDateKey(nextAvailable.modifiedAt);
  const nextDayBounds = dayWindow(nextDayKey);
  const nextPage = await api.chatSessions({
    limit: PAGE_SIZE,
    before: nextDayBounds.before,
    after: nextDayBounds.after,
  });
  return {
    dayKey: nextDayKey,
    sessions: nextPage.sessions,
    exhausted: nextPage.sessions.length === 0,
  };
}

function toDateKey(iso: string): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function previousDateKey(dateKey: string): string {
  return shiftDateKey(dateKey, -1);
}

function shiftDateKey(dateKey: string, offsetDays: number): string {
  const [year, month, day] = parseDateKey(dateKey);
  const utcNoon = new Date(Date.UTC(year, month - 1, day + offsetDays, 12, 0, 0));
  return utcNoon.toISOString().slice(0, 10);
}

function dayWindow(dateKey: string): { after: string; before: string } {
  return {
    after: koreaDateBoundary(dateKey).toISOString(),
    before: koreaDateBoundary(shiftDateKey(dateKey, 1)).toISOString(),
  };
}

function koreaDateBoundary(dateKey: string): Date {
  const [year, month, day] = parseDateKey(dateKey);
  return new Date(Date.UTC(year, month - 1, day, -9, 0, 0));
}

function parseDateKey(dateKey: string): [number, number, number] {
  const [rawYear, rawMonth, rawDay] = dateKey.split("-");
  const year = Number.parseInt(rawYear ?? "", 10);
  const month = Number.parseInt(rawMonth ?? "", 10);
  const day = Number.parseInt(rawDay ?? "", 10);
  return [
    Number.isFinite(year) ? year : 1970,
    Number.isFinite(month) ? month : 1,
    Number.isFinite(day) ? day : 1,
  ];
}

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
) {
  const [sessions, setSessions] = useState<ContinuousHistorySession[]>([]);
  const [loading, setLoading] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const cursorRef = useRef<HistoryCursor | undefined>(undefined);
  const loadingRef = useRef(false);
  const reachedEndRef = useRef(false);
  const requestTokenRef = useRef(0);
  const currentSessionIdRef = useRef(currentSessionId);

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
      const cursor = cursorRef.current;
      const page = await api.chatSessions({
        limit: PAGE_SIZE,
        ...(cursor ? { before: cursor.modifiedAt, beforeId: cursor.id } : {}),
      });
      if (requestToken !== requestTokenRef.current) return;
      const pageSessions = page.sessions;
      const oldest = pageSessions[pageSessions.length - 1];
      const nextCursor = oldest ? { modifiedAt: oldest.modifiedAt, id: oldest.id } : cursorRef.current;

      const filtered = pageSessions.filter((session) => session.id !== currentSessionIdRef.current);
      const hydrated = await Promise.all(
        filtered.map(async (session) => ({
          ...session,
          dayKey: toDateKey(session.modifiedAt),
          entries: await loadEntries(session.id),
        })),
      );
      if (requestToken !== requestTokenRef.current) return;
      cursorRef.current = nextCursor;
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

      if (pageSessions.length < PAGE_SIZE || !oldest) {
        reachedEndRef.current = true;
        setReachedEnd(true);
      }

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
    cursorRef.current = undefined;
    loadingRef.current = false;
    if (enabled && currentSessionId) {
      void loadMore();
    }
  }, [currentSessionId, enabled, loadMore]);

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

import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";
import { historyToEntries } from "../utils/history.js";

export interface SessionSummary {
  id: string;
  modifiedAt: string;
  title: string;
}

/**
 * Phase 5 — sessions hook.
 * Owns session list, current session id, load/fork actions. The streaming
 * guard on load lives here; callers pass `streaming` so we don't swap
 * history mid-turn (ConversationLoop.runTurn has no concurrency guard).
 *
 * Fork needs to truncate renderer entries (which include reasoning/tool_group
 * rows the backend history doesn't track) — so the caller passes the resolved
 * history index and a `setEntries` truncator.
 */
export function useSessions(
  api: LvisApi,
  applyInitialSession?: (entries: ChatEntry[]) => void,
) {
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const sessionReadTokenRef = useRef(0);

  const refreshSessionId = useCallback(async () => {
    const token = ++sessionReadTokenRef.current;
    try {
      const h = await api.chatGetHistory();
      if (token !== sessionReadTokenRef.current) return;
      setCurrentSessionId(h.sessionId);
    } catch { /* ignore */ }
  }, [api]);

  const hydrateInitialSession = useCallback(async () => {
    const token = ++sessionReadTokenRef.current;
    try {
      const h = await api.chatGetHistory();
      if (token !== sessionReadTokenRef.current) return;
      setCurrentSessionId(h.sessionId);
      // The renderer state contract is: active in-memory stream entries and
      // persisted session replay both enter ChatView as ChatEntry[].  Hydrate
      // the current session at startup, but let the chat-state owner reject a
      // late result if the user already started a live turn.
      applyInitialSession?.(historyToEntries(h.messages));
    } catch { /* ignore */ }
  }, [api, applyInitialSession]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.chatSessions();
      setSessions(r.sessions);
      setCurrentSessionId(r.current);
    } catch { /* ignore */ }
  }, [api]);

  useEffect(() => { void hydrateInitialSession(); }, [hydrateInitialSession]);

  const handleLoadSession = useCallback(
    async (
      sessionId: string,
      streaming: boolean,
      applyLoadedSession: (entries: ChatEntry[]) => void,
    ) => {
      // Don't swap sessions mid-stream — ConversationLoop.runTurn() has no
      // concurrency guard, so replacing history while a turn is writing to it
      // would race. The "기록" button is also disabled during streaming, but
      // keep this guard here too for programmatic callers (e.g. starred jump).
      if (streaming) return;
      try {
        const res = await api.chatSessionResume(sessionId);
        if (!res?.ok) return;
        const h = await api.chatGetHistory();
        applyLoadedSession(historyToEntries(h.messages));
        setCurrentSessionId(h.sessionId);
      } catch { /* ignore */ }
    },
    [api],
  );

  const handleFork = useCallback(
    async (
      histIdx: number,
      entryIdx: number,
      truncateToEntry: (entryIndex: number) => void,
    ): Promise<{ ok: boolean }> => {
      try {
        const res = await api.chatFork(histIdx);
        if (res.ok) {
          truncateToEntry(entryIdx);
          await refreshSessionId();
          return { ok: true };
        }
        return { ok: false };
      } catch (err) {
        console.warn("[useSessions] fork failed", err);
        return { ok: false };
      }
    },
    [api, refreshSessionId],
  );

  return {
    currentSessionId,
    setCurrentSessionId,
    sessions,
    refreshSessionId,
    refreshSessions,
    handleLoadSession,
    handleFork,
  };
}

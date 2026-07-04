import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";
import { historyToEntries } from "../utils/history.js";

export interface SessionSummary {
  id: string;
  modifiedAt: string;
  title: string;
  sessionKind: "main" | "routine";
  routineId?: string;
  routineTitle?: string;
  routineFiredAt?: string;
  projectRoot?: string;
  projectName?: string;
  /** Compact number of the checkpoint this session was forked from. Only set on true checkpoint forks. */
  branchedFromCompactNum?: number;
}

export interface SessionProjectSummary {
  projectRoot?: string;
  projectName?: string;
}

function sessionProjectFromHistory(history: SessionProjectSummary): SessionProjectSummary {
  return {
    ...(history.projectRoot ? { projectRoot: history.projectRoot } : {}),
    ...(history.projectName ? { projectName: history.projectName } : {}),
  };
}

/**
 * Sessions hook.
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
  const [currentSessionKind, setCurrentSessionKind] = useState<"main" | "routine">("main");
  const [currentSessionTitle, setCurrentSessionTitle] = useState<string | undefined>(undefined);
  const [currentSessionProject, setCurrentSessionProject] = useState<SessionProjectSummary>({});
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const sessionReadTokenRef = useRef(0);

  const refreshSessionId = useCallback(async () => {
    const token = ++sessionReadTokenRef.current;
    try {
      const h = await api.chatGetHistory();
      if (token !== sessionReadTokenRef.current) return;
      setCurrentSessionId(h.sessionId);
      setCurrentSessionKind(h.sessionKind ?? "main");
      setCurrentSessionTitle(h.sessionTitle);
      setCurrentSessionProject(sessionProjectFromHistory(h));
    } catch { /* ignore */ }
  }, [api]);

  const hydrateInitialSession = useCallback(async () => {
    const token = ++sessionReadTokenRef.current;
    const applyFreshMain = async (current: Awaited<ReturnType<LvisApi["chatGetHistory"]>>) => {
      if ((current.sessionKind ?? "main") === "main" && current.messages.length === 0) {
        setCurrentSessionId(current.sessionId);
        setCurrentSessionKind("main");
        setCurrentSessionTitle(undefined);
        setCurrentSessionProject(sessionProjectFromHistory(current));
        applyInitialSession?.([]);
        return;
      }
      await api.chatNew();
      if (token !== sessionReadTokenRef.current) return;
      const fresh = await api.chatGetHistory();
      if (token !== sessionReadTokenRef.current) return;
      setCurrentSessionId(fresh.sessionId);
      setCurrentSessionKind("main");
      setCurrentSessionTitle(undefined);
      setCurrentSessionProject(sessionProjectFromHistory(fresh));
      applyInitialSession?.([]);
    };

    try {
      const h = await api.chatGetHistory();
      if (token !== sessionReadTokenRef.current) return;
      const listed = await api.chatSessions({ kind: "main" });
      if (token !== sessionReadTokenRef.current) return;
      setSessions(listed.sessions);
      const activeState = await api.chatMainActiveState();
      if (token !== sessionReadTokenRef.current) return;
      if (!activeState || activeState.mainActiveMode === "fresh" || !activeState.mainActiveSessionId) {
        await applyFreshMain(h);
        return;
      }

      if ((h.sessionKind ?? "main") === "main" && h.sessionId === activeState.mainActiveSessionId && h.messages.length > 0) {
        setCurrentSessionId(h.sessionId);
        setCurrentSessionKind("main");
        setCurrentSessionTitle(h.sessionTitle);
        setCurrentSessionProject(sessionProjectFromHistory(h));
        // The renderer state contract is: active in-memory stream entries and
        // persisted session replay both enter ChatView as ChatEntry[]. Hydrate
        // only the exact active main session so routine re-entry never replaces
        // the persisted main active state.
        applyInitialSession?.(historyToEntries(h.messages));
        return;
      }
      const resumed = await api.chatSessionResume(activeState.mainActiveSessionId);
      if (token !== sessionReadTokenRef.current) return;
      if (!resumed?.ok) {
        await applyFreshMain(h);
        return;
      }
      const persisted = await api.chatSessionHistory(activeState.mainActiveSessionId);
      if (token !== sessionReadTokenRef.current) return;
      if (!persisted.ok) {
        await applyFreshMain(h);
        return;
      }
      setCurrentSessionId(activeState.mainActiveSessionId);
      setCurrentSessionKind("main");
      setCurrentSessionTitle(persisted.sessionTitle);
      setCurrentSessionProject(sessionProjectFromHistory(persisted));
      applyInitialSession?.(sessionHistoryToEntries(persisted));
    } catch { /* ignore */ }
  }, [api, applyInitialSession]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.chatSessions({ kind: "main" });
      setSessions(r.sessions);
    } catch { /* ignore */ }
  }, [api]);

  useEffect(() => { void hydrateInitialSession(); }, [hydrateInitialSession]);

  const handleLoadSession = useCallback(
    async (
      sessionId: string,
      streaming: boolean,
      applyLoadedSession: (entries: ChatEntry[]) => void,
    ): Promise<boolean> => {
      // Don't swap sessions mid-stream — ConversationLoop.runTurn() has no
      // concurrency guard, so replacing history while a turn is writing to it

      // keep this guard here too for programmatic callers (e.g. starred jump).
      if (streaming) return false;
      const token = ++sessionReadTokenRef.current;
      try {
        const res = await api.chatSessionResume(sessionId);
        if (token !== sessionReadTokenRef.current) return false;
        if (!res?.ok) return false;
        const h = await api.chatSessionHistory(sessionId);
        if (token !== sessionReadTokenRef.current) return false;
        if (!h.ok) return false;
        applyLoadedSession(sessionHistoryToEntries(h));
        setCurrentSessionId(sessionId);
        setCurrentSessionKind(h.sessionKind ?? "main");
        setCurrentSessionTitle(h.sessionTitle);
        setCurrentSessionProject(sessionProjectFromHistory(h));
        return true;
      } catch {
        return false;
      }
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
          await refreshSessions();
          return { ok: true };
        }
        return { ok: false };
      } catch (err) {
        console.warn("[useSessions] fork failed", err);
        return { ok: false };
      }
    },
    [api, refreshSessionId, refreshSessions],
  );

  return {
    currentSessionId,
    currentSessionKind,
    currentSessionTitle,
    currentSessionProject,
    setCurrentSessionId,
    sessions,
    refreshSessionId,
    refreshSessions,
    handleLoadSession,
    handleFork,
  };
}

export function sessionHistoryToEntries(history: Awaited<ReturnType<LvisApi["chatSessionHistory"]>>): ChatEntry[] {
  const entries = historyToEntries(history.messages);
  if ((history.preambleChars ?? 0) <= 0) return entries;
  return [
    {
      kind: "session_resume",
      preambleChars: history.preambleChars ?? 0,
    },
    ...entries,
  ];
}

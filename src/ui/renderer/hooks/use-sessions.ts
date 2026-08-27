import type { RestoredSubAgentRow } from "./use-workflow-tools.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TileSession } from "../components/chat-group-session-registry.js";
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
  /** ISO time the user archived this conversation. Absent = not archived. */
  archivedAt?: string;
  /** ISO time the user marked it unread. Absent = read. */
  unreadSince?: string;
}

export interface SessionProjectSummary {
  projectRoot?: string;
  projectName?: string;
  /** True when projectRoot/projectName reflect the ambient default directory
   *  binding rather than an explicit project selection — see
   *  `chatGetHistory`'s `projectIsDefault` field. Absent (undefined) for
   *  sources that read PERSISTED session metadata (chatSessionHistory) rather
   *  than the live in-memory context, where "no project fields at all" is
   *  already the unambiguous "no explicit project" signal. */
  isDefault?: boolean;
}

function sessionProjectFromHistory(
  history: { projectRoot?: string; projectName?: string; projectIsDefault?: boolean },
): SessionProjectSummary {
  return {
    ...(history.projectRoot ? { projectRoot: history.projectRoot } : {}),
    ...(history.projectName ? { projectName: history.projectName } : {}),
    ...(history.projectIsDefault ? { isDefault: true } : {}),
  };
}

/**
 * The window's list of conversations.
 *
 * Separate from `useCurrentSession` because the two answer to different
 * owners: the LIST describes the window and is the same for every tile, while
 * which session a tile is holding is that tile's own business. Keeping them in
 * one hook meant every tile would have refetched the list, and the sidebar
 * would have had to pick one tile's copy of it to render.
 */
export function useSessionList(api: LvisApi) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);

  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.chatSessions({ kind: "main" });
      setSessions(r.sessions);
    } catch { /* ignore */ }
  }, [api]);

  return { sessions, refreshSessions };
}

export interface CurrentSessionDeps {
  applyInitialSession?: (entries: ChatEntry[]) => void;
  onLoadedSession?: () => void;
  /**
   * Seed the sub-agent panel from rows the load handlers rebuilt on disk. The
   * panel is otherwise fed only by the live `agent_spawn` event stream, which
   * is empty after a restart. Called on EVERY path that establishes a session's
   * entries, so a restored conversation and a switched-to one behave alike.
   */
  restoreSubAgents?: (rows: readonly RestoredSubAgentRow[]) => void;
  /**
   * Tell the window its list is stale. A fork creates a session, and the
   * sidebar has to learn about it — but the LIST is not this hook's to hold.
   */
  onSessionsChanged?: () => void | Promise<void>;
}

/**
 * Which conversation ONE tile is holding, plus the load and fork actions that
 * change it.
 *
 * `api` is the tile's group-bound surface, so every read here answers about
 * that tile's ConversationLoop and two tiles never see each other's session.
 *
 * The streaming guard on load lives here; callers pass `streaming` so we don't
 * swap history mid-turn (ConversationLoop.runTurn has no concurrency guard).
 *
 * Fork needs to truncate renderer entries (which include reasoning/tool_group
 * rows the backend history doesn't track) — so the caller passes the resolved
 * history index and a `setEntries` truncator.
 */
export function useCurrentSession(api: LvisApi, deps: CurrentSessionDeps = {}) {
  const { applyInitialSession, onLoadedSession, restoreSubAgents, onSessionsChanged } = deps;
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [currentSessionKind, setCurrentSessionKind] = useState<"main" | "routine">("main");
  const [currentSessionTitle, setCurrentSessionTitle] = useState<string | undefined>(undefined);
  const [currentSessionProject, setCurrentSessionProject] = useState<SessionProjectSummary>({});
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
      // Hydration is also the window's first chance to fill its list.
      await onSessionsChanged?.();
      if (token !== sessionReadTokenRef.current) return;
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
        restoreSubAgents?.(h.restoredSubAgents ?? []);
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
      restoreSubAgents?.(persisted.restoredSubAgents ?? []);
      applyInitialSession?.(sessionHistoryToEntries(persisted));
    } catch { /* ignore */ }
  }, [api, applyInitialSession, restoreSubAgents, onSessionsChanged]);

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
        restoreSubAgents?.(h.restoredSubAgents ?? []);
        applyLoadedSession(sessionHistoryToEntries(h));
        onLoadedSession?.();
        setCurrentSessionId(sessionId);
        setCurrentSessionKind(h.sessionKind ?? "main");
        setCurrentSessionTitle(h.sessionTitle);
        setCurrentSessionProject(sessionProjectFromHistory(h));
        return true;
      } catch {
        return false;
      }
    },
    [api, onLoadedSession],
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
          await onSessionsChanged?.();
          return { ok: true };
        }
        return { ok: false };
      } catch (err) {
        console.warn("[useSessions] fork failed", err);
        return { ok: false };
      }
    },
    [api, refreshSessionId, onSessionsChanged],
  );

  return {
    currentSessionId,
    currentSessionKind,
    currentSessionTitle,
    currentSessionProject,
    setCurrentSessionId,
    refreshSessionId,
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

/**
 * Where the user is looking: the focused tile, and whether the conversation
 * surface is on screen at all (Settings and plugin views cover it).
 */
export interface Attention {
  focusedChatGroupId: string;
  conversationVisible: boolean;
}

/**
 * The conversations whose turn just ended somewhere the user was not looking.
 *
 * A turn ending under the user's eyes needs no mark — they saw it. One that
 * ends in another tile, or while Settings covers the conversation, is what a
 * chat app bolds: something happened that has not been seen. A tile that
 * moved to a different conversation between the two readings is skipped;
 * the turn that ended belonged to a session the tile no longer shows, and
 * marking it would point at history the user already left.
 */
export function turnsEndedUnseen(
  previous: readonly TileSession[],
  current: readonly TileSession[],
  attention: Attention,
): string[] {
  const before = new Map(previous.map((tile) => [tile.chatGroupId, tile]));
  const unseen: string[] = [];
  for (const tile of current) {
    const was = before.get(tile.chatGroupId);
    if (!was?.streaming || tile.streaming) continue;
    if (was.sessionId !== tile.sessionId || !tile.sessionId) continue;
    const looking = attention.conversationVisible && tile.chatGroupId === attention.focusedChatGroupId;
    if (!looking) unseen.push(tile.sessionId);
  }
  return unseen;
}

/**
 * Keeps the unread mark honest against what is on screen: a turn that ends
 * unseen marks its conversation, and looking at a conversation reads it.
 *
 * "Looking" is a transition — focusing the tile, returning to the conversation
 * view, or loading a session into the focused tile — not a standing condition.
 * A conversation the user marks unread by hand while it is in front of them
 * therefore stays marked until they look away and back, which is what the
 * manual mark is for.
 */
export function useTurnAttention(input: {
  tiles: readonly TileSession[];
  attention: Attention;
  isUnread: (sessionId: string) => boolean;
  setUnread: (sessionId: string, unread: boolean) => void | Promise<void>;
}): void {
  const { tiles, attention } = input;
  const { focusedChatGroupId, conversationVisible } = attention;
  const previousTiles = useRef(tiles);
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    const previous = previousTiles.current;
    previousTiles.current = tiles;
    for (const sessionId of turnsEndedUnseen(previous, tiles, latest.current.attention)) {
      void latest.current.setUnread(sessionId, true);
    }
  }, [tiles]);

  const focusedSessionId = tiles.find((tile) => tile.chatGroupId === focusedChatGroupId)?.sessionId;
  useEffect(() => {
    if (!conversationVisible || !focusedSessionId) return;
    if (latest.current.isUnread(focusedSessionId)) void latest.current.setUnread(focusedSessionId, false);
  }, [conversationVisible, focusedChatGroupId, focusedSessionId]);
}

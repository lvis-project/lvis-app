import type { RestoredSubAgentRow } from "./use-workflow-tools.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TileSession } from "../components/chat-group-session-registry.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";
import { historyToEntries } from "../utils/history.js";
import { projectRootEquals } from "../../../shared/project-identity.js";

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
  /**
   * Whether this tile is the one the window's "main active" state addresses.
   * Only the primary tile resumes that conversation on mount; any other tile
   * starts on its own loop's fresh session. The state is window-scoped, so a
   * second tile resuming it would hold the SAME session id as the primary —
   * two loops flushing their own history to one file, last turn wins.
   */
  resumeWindowActiveSession?: boolean;
  /**
   * The project a non-primary tile's fresh conversation is created under —
   * the window's active one. The sidebar files a conversation by its
   * project, so a tile that started unscoped would show up in the plain
   * "chats" tab while the user is looking at the project's group.
   */
  freshProject?: { projectRoot?: string; projectName?: string };
  /**
   * A session this tile asked for is held by another chat group — one that
   * may be folded away by chat mode, so the renderer's mounted tiles cannot
   * find it. Returns whether that group was brought forward.
   */
  focusSessionHolder?: (chatGroupId: string) => boolean;
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
  const { applyInitialSession, onLoadedSession, restoreSubAgents, onSessionsChanged, focusSessionHolder } = deps;
  const resumeWindowActiveSession = deps.resumeWindowActiveSession ?? true;
  // Read at hydration time, not a dependency of it: the window's active
  // project changing must not re-hydrate a tile that is holding a conversation.
  const freshProjectRef = useRef(deps.freshProject);
  freshProjectRef.current = deps.freshProject;
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
    const applyFreshMain = async (
      current: Awaited<ReturnType<LvisApi["chatGetHistory"]>>,
      project?: { projectRoot?: string; projectName?: string },
    ) => {
      // A loop already on an empty main session is the fresh state — unless
      // the conversation has to be created under a project, which only
      // chatNew records.
      const alreadyUnderProject = !project
        || projectRootEquals(sessionProjectFromHistory(current).projectRoot, project.projectRoot);
      // Only an empty loop reaches here: a held conversation was adopted above.
      if (alreadyUnderProject && (current.sessionKind ?? "main") === "main") {
        setCurrentSessionId(current.sessionId);
        setCurrentSessionKind("main");
        setCurrentSessionTitle(undefined);
        setCurrentSessionProject(sessionProjectFromHistory(current));
        restoreSubAgents?.([]);
        applyInitialSession?.([]);
        return;
      }
      const created = await api.chatNew(project);
      if (token !== sessionReadTokenRef.current) return;
      // A refused chatNew left the loop on its old session; emptying the
      // transcript here would show a conversation the loop does not hold.
      if (!created.ok) return;
      const fresh = await api.chatGetHistory();
      if (token !== sessionReadTokenRef.current) return;
      setCurrentSessionId(fresh.sessionId);
      setCurrentSessionKind("main");
      setCurrentSessionTitle(undefined);
      setCurrentSessionProject(sessionProjectFromHistory(fresh));
      restoreSubAgents?.([]);
      applyInitialSession?.([]);
    };

    try {
      const h = await api.chatGetHistory();
      if (token !== sessionReadTokenRef.current) return;
      // Hydration is also the window's first chance to fill its list.
      await onSessionsChanged?.();
      if (token !== sessionReadTokenRef.current) return;
      // A loop that already holds a conversation is the authority for what its
      // tile shows. This is a mount, not a reset: a tile folded away by chat
      // mode and brought back, or a holder brought forward for the conversation
      // it holds, must show that conversation — the window's main-active
      // pointer may name another one (it never names a routine session).
      // Nothing here touches the persisted main-active state.
      if (h.messages.length > 0) {
        setCurrentSessionId(h.sessionId);
        setCurrentSessionKind(h.sessionKind ?? "main");
        setCurrentSessionTitle(h.sessionTitle);
        setCurrentSessionProject(sessionProjectFromHistory(h));
        restoreSubAgents?.(h.restoredSubAgents ?? []);
        applyInitialSession?.(historyToEntries(h.messages));
        return;
      }
      if (!resumeWindowActiveSession) {
        await applyFreshMain(h, freshProjectRef.current);
        return;
      }
      const activeState = await api.chatMainActiveState();
      if (token !== sessionReadTokenRef.current) return;
      if (!activeState || activeState.mainActiveMode === "fresh" || !activeState.mainActiveSessionId) {
        await applyFreshMain(h);
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
  }, [api, applyInitialSession, restoreSubAgents, onSessionsChanged, resumeWindowActiveSession]);

  useEffect(() => { void hydrateInitialSession(); }, [hydrateInitialSession]);

  const handleLoadSession = useCallback(
    async (
      sessionId: string,
      applyLoadedSession: (entries: ChatEntry[]) => void,
    ): Promise<boolean> => {
      // Whether this group may take a session is main's answer, not one this
      // hook re-derives: the loop it would swap out from under lives there,
      // and `chatSessionResume` refuses while that loop is mid-turn. A second
      // copy of the rule here could only drift from the first.
      const token = ++sessionReadTokenRef.current;
      try {
        const res = await api.chatSessionResume(sessionId);
        if (token !== sessionReadTokenRef.current) return false;
        if (!res?.ok) {
          // Held by another group: showing that group IS showing the session.
          return res?.holderChatGroupId !== undefined && (focusSessionHolder?.(res.holderChatGroupId) ?? false);
        }
        const h = await api.chatSessionHistory(sessionId);
        if (token !== sessionReadTokenRef.current) return false;
        if (!h.ok) return false;
        // Reset first: the reset clears the sub-agent rows, so restoring
        // before it would hand the incoming conversation an empty panel.
        onLoadedSession?.();
        restoreSubAgents?.(h.restoredSubAgents ?? []);
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
    [api, onLoadedSession, focusSessionHolder],
  );

  const handleFork = useCallback(
    async (
      messageId: string,
      entryIdx: number,
      truncateToEntry: (entryIndex: number) => void,
    ): Promise<{ ok: boolean }> => {
      try {
        const res = await api.chatFork(messageId);
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
  // "Looking" is a property of the conversation, not the tile, and the user
  // sees its turn end through the focused tile — provided that tile is drawn.
  // A hidden one is mounted only so its turn survives; nobody is watching it.
  const watched = attention.conversationVisible
    ? current.find((tile) =>
      tile.chatGroupId === attention.focusedChatGroupId && !tile.hidden)?.sessionId
    : undefined;
  return turnsEnded(previous, current).filter((sessionId) => sessionId !== watched);
}

/**
 * The conversations whose turn ended between two readings of the tiles,
 * whether or not anyone was looking. A tile that is gone from the reading took
 * its turn with it — that now means closed, since leaving the view keeps the
 * tile mounted and its turn running — and one that moved to another
 * conversation no longer speaks for the turn that ended.
 */
export function turnsEnded(
  previous: readonly TileSession[],
  current: readonly TileSession[],
): string[] {
  const now = new Map(current.map((tile) => [tile.chatGroupId, tile]));
  const ended: string[] = [];
  for (const was of previous) {
    if (!was.streaming || !was.sessionId) continue;
    const tile = now.get(was.chatGroupId);
    if (tile && (tile.streaming || tile.sessionId !== was.sessionId)) continue;
    if (!ended.includes(was.sessionId)) ended.push(was.sessionId);
  }
  return ended;
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
  /**
   * Every turn end, seen or not. The window's conversation list is read, not
   * pushed, and a turn is what gives a fresh tile's session a file and a
   * title — without this the list learns about it only by chance.
   */
  onTurnsEnded?: (sessionIds: readonly string[]) => void | Promise<void>;
}): void {
  const { tiles, attention } = input;
  const { focusedChatGroupId, conversationVisible } = attention;
  const previousTiles = useRef(tiles);
  const latest = useRef(input);
  latest.current = input;

  useEffect(() => {
    const previous = previousTiles.current;
    previousTiles.current = tiles;
    const ended = turnsEnded(previous, tiles);
    if (ended.length > 0) void latest.current.onTurnsEnded?.(ended);
    for (const sessionId of turnsEndedUnseen(previous, tiles, latest.current.attention)) {
      if (!latest.current.isUnread(sessionId)) void latest.current.setUnread(sessionId, true);
    }
  }, [tiles]);

  const focusedSessionId = tiles.find((tile) => tile.chatGroupId === focusedChatGroupId)?.sessionId;
  useEffect(() => {
    if (!conversationVisible || !focusedSessionId) return;
    if (latest.current.isUnread(focusedSessionId)) void latest.current.setUnread(focusedSessionId, false);
  }, [conversationVisible, focusedChatGroupId, focusedSessionId]);
}

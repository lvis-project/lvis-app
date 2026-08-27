import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { RestoredSubAgentRow } from "../hooks/use-workflow-tools.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { SendMode } from "../hooks/use-send-message.js";
import type { SessionProjectSummary } from "../hooks/use-sessions.js";

/**
 * What the WINDOW still needs from a conversation once the conversation lives
 * inside a tile.
 *
 * Almost nothing does: search over a transcript, starring an entry, aborting a
 * turn — those act on one conversation and moved into the tile with it. What is
 * left is the handful of things the window chrome genuinely owns and cannot
 * answer for itself: the toolbar and sidebar disable controls while a turn is
 * running, the unified search panel searches the transcript the user is looking
 * at, and loading or starting a session replaces what the focused tile holds.
 *
 * Every one of them means "the FOCUSED tile", which is why this is a registry
 * keyed by group rather than props threaded down.
 */
export interface ChatGroupSessionHandle {
  /**
   * The transcript. Its IDENTITY is the store's change signal, so it must be
   * held as state and replaced only when the transcript changes — a fresh array
   * per render would republish forever.
   */
  entries: readonly ChatEntry[];
  streaming: boolean;
  /** Replace the transcript with a session loaded from disk. */
  applyLoadedSession: (loaded: ChatEntry[]) => void;
  /** Seed an empty transcript, leaving a non-empty one alone. */
  applyInitialSession: (loaded: ChatEntry[]) => void;
  /** Empty the transcript for a new conversation. */
  clearForNewChat: () => void;
  /** Drop the workflow-tool state (questions, spawns) a new session invalidates. */
  resetForNewSession: () => void;
  restoreSubAgentSpawns: (restored: readonly RestoredSubAgentRow[]) => void;
  /**
   * Start a turn in this conversation.
   *
   * The routine overlay and the plugin trigger-import path are window-level
   * subscriptions with a conversation to say something to, and the one they
   * mean is the focused tile's.
   */
  ask: (
    question: string,
    mode?: SendMode,
    userIntent?: UserKeyboardIntentSnapshot,
  ) => Promise<void>;
  /** Put a trigger-import row in the transcript — same window-level origin. */
  insertImportedTriggerEntry: (input: {
    sessionId: string;
    /** Provenance tag — `plugin:<pluginId>` or `app:<serverId>`. */
    source: string;
    prompt: string;
    summary: string;
  }) => void;
  /** Which session this tile is holding — the sidebar highlights it. */
  currentSessionId: string;
  currentSessionProject: SessionProjectSummary;
  /** Load a session into this tile, refusing mid-turn. */
  loadSession: (sessionId: string) => Promise<boolean>;
  /** The provider-fallback banner App renders above the content area. */
  fallbackToast: string | null;
  /** Put text in this tile's composer without sending it. */
  prefillComposer: (text: string) => void;
  /** Write a system row into this tile's transcript. */
  appendSystemEntry: (message: string) => void;
  /**
   * Start a fresh conversation IN THIS TILE.
   *
   * The tile owns it because `chatNew` has to reach this tile's loop and the
   * reset has to land on this tile's transcript — doing it from the window
   * would start the conversation in the primary group no matter which tile the
   * user was looking at.
   */
  startNewChat: (project?: { projectRoot?: string; projectName?: string }) => Promise<void>;
}

type Listener = () => void;

/**
 * The handle a reader sees while no tile has published.
 *
 * "Not streaming, nothing to search" is the honest state of a conversation that
 * does not exist yet, and the one that leaves the window's controls usable
 * rather than stuck disabled.
 */
export const EMPTY_CHAT_GROUP_SESSION: ChatGroupSessionHandle = Object.freeze({
  entries: [] as readonly ChatEntry[],
  streaming: false,
  applyLoadedSession: () => {},
  applyInitialSession: () => {},
  clearForNewChat: () => {},
  resetForNewSession: () => {},
  restoreSubAgentSpawns: () => {},
  ask: async () => {},
  insertImportedTriggerEntry: () => {},
  currentSessionId: "",
  currentSessionProject: {},
  loadSession: async () => false,
  fallbackToast: null,
  prefillComposer: () => {},
  appendSystemEntry: () => {},
  startNewChat: async () => {},
});

/**
 * The live handles, one per mounted tile.
 *
 * A store rather than React state because the writers are the CHILDREN: a tile
 * publishing during App's render would be a render-phase update, and publishing
 * to state in an effect would re-render every tile whenever any one of them
 * streamed. Subscribers here are woken by group id, so a tile's own churn stays
 * inside that tile.
 */
export class ChatGroupSessionRegistry {
  /** The newest handle a tile published — where every call is dispatched. */
  private readonly latest = new Map<string, ChatGroupSessionHandle>();
  /** What readers see. Replaced only when the DATA changes, so it is a stable
   *  snapshot in the sense useSyncExternalStore requires. */
  private readonly snapshots = new Map<string, ChatGroupSessionHandle>();
  private readonly listeners = new Map<string, Set<Listener>>();

  publish(chatGroupId: string, handle: ChatGroupSessionHandle): void {
    const previous = this.latest.get(chatGroupId);
    this.latest.set(chatGroupId, handle);

    // A tile republishes on every render and its reader is an ancestor that
    // renders it, so waking unconditionally is a loop — each side asking the
    // other to go again. Only the DATA decides: the callbacks are dispatched
    // through `latest`, so their identity is not something a reader can观 see,
    // and comparing it would put the loop back for any caller that forgot to
    // memoize one of them.
    const unchanged = previous !== undefined
      && previous.entries === handle.entries
      && previous.streaming === handle.streaming
      && previous.currentSessionId === handle.currentSessionId
      && previous.currentSessionProject === handle.currentSessionProject
      && previous.fallbackToast === handle.fallbackToast
      && this.snapshots.has(chatGroupId);
    if (unchanged) return;

    this.snapshots.set(chatGroupId, this.snapshot(chatGroupId, handle));
    this.wake(chatGroupId);
  }

  retract(chatGroupId: string): void {
    const held = this.latest.delete(chatGroupId);
    this.snapshots.delete(chatGroupId);
    if (!held) return;
    this.wake(chatGroupId);
  }

  read(chatGroupId: string): ChatGroupSessionHandle | null {
    return this.snapshots.get(chatGroupId) ?? null;
  }

  subscribe(chatGroupId: string, listener: Listener): () => void {
    let group = this.listeners.get(chatGroupId);
    if (!group) {
      group = new Set();
      this.listeners.set(chatGroupId, group);
    }
    group.add(listener);
    return () => {
      group.delete(listener);
      if (group.size === 0) this.listeners.delete(chatGroupId);
    };
  }

  /**
   * A frozen view of the data, with every call forwarded to whatever the tile
   * published most recently. A reader can hold this across renders and still
   * never call into a stale closure.
   */
  private snapshot(chatGroupId: string, handle: ChatGroupSessionHandle): ChatGroupSessionHandle {
    const live = () => this.latest.get(chatGroupId);
    return Object.freeze({
      entries: handle.entries,
      streaming: handle.streaming,
      applyLoadedSession: (loaded: ChatEntry[]) => live()?.applyLoadedSession(loaded),
      applyInitialSession: (loaded: ChatEntry[]) => live()?.applyInitialSession(loaded),
      clearForNewChat: () => live()?.clearForNewChat(),
      resetForNewSession: () => live()?.resetForNewSession(),
      restoreSubAgentSpawns: (restored: readonly RestoredSubAgentRow[]) =>
        live()?.restoreSubAgentSpawns(restored),
      ask: async (
        question: string,
        mode?: SendMode,
        userIntent?: UserKeyboardIntentSnapshot,
      ) => {
        await live()?.ask(question, mode, userIntent);
      },
      insertImportedTriggerEntry: (input: Parameters<
        ChatGroupSessionHandle["insertImportedTriggerEntry"]
      >[0]) => live()?.insertImportedTriggerEntry(input),
      currentSessionId: handle.currentSessionId,
      currentSessionProject: handle.currentSessionProject,
      loadSession: async (sessionId: string) => await live()?.loadSession(sessionId) ?? false,
      fallbackToast: handle.fallbackToast,
      prefillComposer: (text: string) => live()?.prefillComposer(text),
      appendSystemEntry: (message: string) => live()?.appendSystemEntry(message),
      startNewChat: async (project?: { projectRoot?: string; projectName?: string }) => {
        await live()?.startNewChat(project);
      },
    });
  }

  private wake(chatGroupId: string): void {
    for (const listener of this.listeners.get(chatGroupId) ?? []) listener();
  }
}

/**
 * Publish this tile's handle for as long as it is mounted.
 *
 * The handle is republished whenever any part of it changes, because the window
 * reads the CURRENT transcript and streaming flag — a handle captured once
 * would leave the toolbar enabled through a turn.
 */
export function useRegisterChatGroupSession(
  registry: ChatGroupSessionRegistry,
  chatGroupId: string,
  handle: ChatGroupSessionHandle,
): void {
  const latest = useRef(handle);
  latest.current = handle;

  useEffect(() => {
    registry.publish(chatGroupId, latest.current);
  });

  useEffect(() => () => registry.retract(chatGroupId), [registry, chatGroupId]);
}

/** The focused tile's handle, or a quiet stand-in while no tile has published. */
export function useChatGroupSession(
  registry: ChatGroupSessionRegistry,
  chatGroupId: string,
): ChatGroupSessionHandle {
  const subscribe = useCallback(
    (listener: Listener) => registry.subscribe(chatGroupId, listener),
    [registry, chatGroupId],
  );
  const read = useCallback(() => registry.read(chatGroupId), [registry, chatGroupId]);
  return useSyncExternalStore(subscribe, read, read) ?? EMPTY_CHAT_GROUP_SESSION;
}

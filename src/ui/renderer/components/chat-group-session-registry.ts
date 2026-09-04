import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { RestoredSubAgentRow } from "../hooks/use-workflow-tools.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { SessionFamily } from "../../../shared/session-lookup.js";
import type { SendMode } from "../hooks/use-send-message.js";
import type { SessionProjectSummary } from "../hooks/use-sessions.js";
import type { ApprovalRequest } from "../types.js";
import type { AskUserQuestionRequest } from "./AskUserQuestionCard.js";

/**
 * The side chat a tile's work panel holds, as the window sees it.
 *
 * A side chat is a drawing surface of its own — it claims its session and
 * draws its own approval and question cards — but the window has to know it
 * exists: a tile must not adopt a question the side chat beside it already
 * draws, and the sidebar has to mark the side chat's row while a card waits
 * where the user cannot see it. `shown` is whether the side chat is on screen
 * at all: its tab active, its panel open, and the tile's conversation drawn.
 */
export interface SideChatSurface {
  sessionId: string;
  askQuestions: readonly AskUserQuestionRequest[];
  shown: boolean;
}

const NO_SESSION_IDS: ReadonlySet<string> = new Set();

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
  /**
   * The `ask_user_question` gates this tile is holding. Published, not kept
   * private, because a hidden tile draws nothing: the window has to mark the
   * conversation's sidebar row so the user knows to come back. Same identity
   * contract as `entries` — React state, replaced only when the list changes.
   */
  askQuestions: readonly AskUserQuestionRequest[];
  /**
   * Sessions of the sub-agents this tile spawned. A child's ask names the
   * child's session, and the tile that spawned it is the conversation waiting
   * on the answer — so the window maps a parked child ask to this tile's row
   * through the same `sessionOwnedBy` rule the tile's own claim uses.
   */
  childSessionIds: ReadonlySet<string>;
  /** The side chat drawn beside this conversation, once it has a session. */
  sideChat: SideChatSurface | null;
  /** Retire one of them, wherever it was answered from. */
  resolveAskQuestion: (id: string) => void;
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
  /**
   * The view is not drawing this tile right now (chat mode, or another tile
   * maximized). It is still mounted, because its conversation may be mid-turn
   * and the turn's subscription lives here — but nothing it renders is on
   * screen, so it must not CLAIM anything the user has to see.
   */
  hidden: boolean;
  /**
   * The TREE is not drawing this pane: another tile has its box (maximized,
   * or chat mode's single tile). One of the two reasons `hidden` is true,
   * published apart because they route differently — see `overlayCardTile`.
   */
  paneHidden: boolean;
  currentSessionProject: SessionProjectSummary;
  /** Load a session into this tile, refusing mid-turn. */
  loadSession: (sessionId: string) => Promise<boolean>;
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
const EMPTY_CHAT_GROUP_SESSION: ChatGroupSessionHandle = Object.freeze({
  entries: [] as readonly ChatEntry[],
  streaming: false,
  askQuestions: [] as readonly AskUserQuestionRequest[],
  childSessionIds: NO_SESSION_IDS,
  sideChat: null,
  resolveAskQuestion: () => {},
  applyLoadedSession: () => {},
  applyInitialSession: () => {},
  clearForNewChat: () => {},
  resetForNewSession: () => {},
  restoreSubAgentSpawns: () => {},
  ask: async () => {},
  insertImportedTriggerEntry: () => {},
  currentSessionId: "",
  hidden: false,
  paneHidden: false,
  currentSessionProject: {},
  loadSession: async () => false,
  prefillComposer: () => {},
  appendSystemEntry: () => {},
  startNewChat: async () => {},
});

/**
 * One tile as the window sees it: which conversation it holds and whether a
 * turn is running there. What the sidebar needs to mark a row, and nothing a
 * row could act on.
 */
export interface TileSession {
  chatGroupId: string;
  sessionId: string;
  streaming: boolean;
  /** Mounted but not drawn — see {@link ChatGroupSessionHandle.hidden}. */
  hidden: boolean;
  /** The pane itself is not drawn — see {@link ChatGroupSessionHandle.paneHidden}. */
  paneHidden: boolean;
  /**
   * The gates this tile holds. On the tile list rather than read through the
   * handle because the window has to RE-DECIDE which rows to mark whenever a
   * tile is hidden, and only a subscribed list wakes it for that.
   */
  askQuestions: readonly AskUserQuestionRequest[];
  /** See {@link ChatGroupSessionHandle.childSessionIds}. */
  childSessionIds: ReadonlySet<string>;
  /** See {@link ChatGroupSessionHandle.sideChat}. */
  sideChat: SideChatSurface | null;
}

/**
 * The tile already holding `sessionId`, if any. A conversation is opened in
 * one tile at a time: two loops on one session would each flush their own
 * history to the same file. Callers focus the holder instead of loading again.
 */
export function tileHoldingSession(
  tiles: readonly TileSession[],
  sessionId: string,
): TileSession | undefined {
  return tiles.find((tile) => tile.sessionId === sessionId);
}

/**
 * Does a tile holding `currentSessionId`, whose sub-agents run in
 * `childSessionIds`, own `sessionId`? A child runs its own session, so a card
 * or a frame it raises names an id that is not the tile's — the tile that
 * spawned it is still the conversation waiting on it. ONE rule: the stable
 * subscription predicates read it through refs, render reads it from state.
 */
export function sessionOwnedBy(
  currentSessionId: string,
  childSessionIds: ReadonlySet<string>,
  sessionId: string,
): boolean {
  return sessionId === currentSessionId || childSessionIds.has(sessionId);
}

/** Where an overlay card renders, and whether it can still be acted on. */
export interface OverlayCardPlacement {
  /**
   * The one tile that shows the card, or `null` when no drawn pane can: the
   * card is then held, undrawn, and the sidebar marks the conversation it
   * belongs to (see `pendingAnswers`).
   */
  chatGroupId: string | null;
  /**
   * The card names a conversation NO drawn tile is holding — it was closed,
   * maximized away, or folded out of sight by chat mode.
   *
   * The card is not drawn until that conversation is opened again, and must
   * not be: its primary action continues the origin conversation, and running
   * it in another would put a prompt staged for one conversation into a
   * different one. Main refuses exactly that mismatch on the way in, and the
   * renderer must not undo the refusal.
   */
  orphaned: boolean;
}

/**
 * The ONE surface an overlay card belongs to.
 *
 * A card is a single thing the user acts on once, so it renders in exactly one
 * place: rendering it in every tile gives the user N copies of which only the
 * one they happen to click in does anything, and dismissing one leaves the
 * rest behind.
 *
 * A card that names the conversation it came from goes to the tile holding
 * that conversation, because its action continues THAT conversation. When no
 * drawn pane holds it, the card is orphaned: it waits, and the sidebar row of
 * its conversation carries the attention dot until the row is opened.
 *
 * A card with NO origin conversation — a plugin trigger, a headless routine —
 * is drawn in the FOCUSED pane, and follows focus. The window holds one queue
 * of such cards and that queue has one reader, the user, who is at the focused
 * pane: a card parked in an unfocused pane is a card nobody is looking at, and
 * with several panes open it would soon be one card per pane. The region that
 * draws it acts in its own pane (`actionChatGroupId`), so confirming the card
 * starts the turn where the user is.
 *
 * "Drawn" is asked of the PANE, not of its conversation: a pane routed to
 * Settings or a plugin view hides its conversation, but the pane is drawn and
 * the overlay lane is the pane frame's — so the card is drawn in it, whatever
 * the pane shows. Only a pane the tree is not drawing (`paneHidden`) holds its
 * cards undrawn.
 */
export function overlayCardTile(
  tiles: readonly TileSession[],
  focusedChatGroupId: string,
  card: { originSessionId?: string },
): OverlayCardPlacement {
  const drawn = tiles.filter((tile) => !tile.paneHidden);
  if (card.originSessionId !== undefined) {
    const holder = tileHoldingSession(drawn, card.originSessionId);
    return holder === undefined
      ? { chatGroupId: null, orphaned: true }
      : { chatGroupId: holder.chatGroupId, orphaned: false };
  }
  if (drawn.some((tile) => tile.chatGroupId === focusedChatGroupId)) {
    return { chatGroupId: focusedChatGroupId, orphaned: false };
  }
  return { chatGroupId: null, orphaned: false };
}

/**
 * The tile whose turn `sessionId` belongs to — the tile showing it, or the
 * tile that spawned it as a sub-agent. Drawn or not: a tile the tree hides
 * still holds its conversation and its children.
 */
function tileOwningSession(
  tiles: readonly TileSession[],
  sessionId: string,
): TileSession | undefined {
  return tiles.find((tile) => sessionOwnedBy(tile.sessionId, tile.childSessionIds, sessionId));
}

/** The tile whose side chat runs `sessionId`, if any side chat does. */
function tileWithSideChat(
  tiles: readonly TileSession[],
  sessionId: string,
): TileSession | undefined {
  return tiles.find((tile) => tile.sideChat?.sessionId === sessionId);
}

/**
 * Does this tile draw a window-wide card (a question, a skill badge) addressed
 * to `sessionId`?
 *
 * Ownership alone is not enough. Turns run in sessions no tile is showing: a
 * routine fires headless, and a background sub-agent outlives the moment its
 * parent tile switched to another conversation. `ask_user_question` is
 * reachable from both, and a card only its own tile may draw is a card nobody
 * draws — the gate then sits out its full timeout with nothing on screen to
 * answer.
 *
 * So a session NO surface holds is ADOPTED by the focused tile. Exactly one
 * tile is focused, so the card is drawn once. A session some surface already
 * holds is never adopted: another tile draws its own conversation and its
 * children, and a side chat is a drawing surface of its own, so the tile
 * beside it leaves the side chat's questions to it. A tile the tree hides
 * still holds its sessions — its cards wait with it, undrawn, rather than
 * moving to whichever pane is focused.
 */
export function tileDrawsSession(args: {
  tiles: readonly TileSession[];
  sessionId: string;
  /** The tile already knows this session (its own conversation or a child it spawned). */
  owned: boolean;
  focused: boolean;
}): boolean {
  if (args.owned) return true;
  if (!args.focused) return false;
  return tileOwningSession(args.tiles, args.sessionId) === undefined
    && tileWithSideChat(args.tiles, args.sessionId) === undefined;
}

/** What `pendingAnswers` reads: the window's queues and what each tile holds. */
export interface PendingAnswerInput {
  /** The window's approval queue, every request the host is parked on. */
  approvals: readonly ApprovalRequest[];
  tiles: readonly TileSession[];
  /** Sessions of the reviewer's deferred entries still awaiting the user. */
  deferredSessionIds: readonly string[];
  /** Overlay cards that name the conversation they came from. */
  overlayCards: readonly { originSessionId?: string }[];
  /** The conversation list, for the family of a row and a side chat's parent. */
  sessions: readonly { id: string; family: SessionFamily; originSessionId?: string }[];
}

/** Every place the attention dot goes, and the requests the focused pane's lane draws. */
export interface PendingAnswers {
  /**
   * Sidebar rows to mark: every conversation whose turn is parked on a card,
   * seen or not, plus one whose overlay card has no visible pane to be in.
   */
  sessionIds: ReadonlySet<string>;
  /** Panes the tree hides while holding a parked card — the restore control's dot. */
  hiddenPaneIds: ReadonlySet<string>;
  /** Side chats holding a parked card off screen — the panel toggle's and the tab's dot. */
  sideChatSessionIds: ReadonlySet<string>;
  /** Requests no conversation owns, in queue order — the focused pane's lane draws these. */
  unattributed: readonly ApprovalRequest[];
}

/**
 * "This conversation is stopped on a card you must answer" — decided ONCE for
 * every surface that shows the attention dot, so the sidebar, a pane header
 * and a panel tab can never disagree about who is waiting.
 *
 * A parked card is one of: an approval request in the window's queue, an
 * `ask_user_question` a tile or side chat holds, a deferred approval the
 * reviewer set aside, or an overlay card whose origin conversation is not
 * open. The sidebar row of the conversation it stops is marked whether or not
 * the card is on screen: the row says "interrupted here", and a card the user
 * is looking at is still an interruption. The controls that lead to a surface
 * — the maximize control over a pane the tree hides, the work-panel toggle and
 * the side-chat tab — are marked only while that surface is off screen, since
 * their dot means "the card is behind this". An overlay card stops no turn, so
 * its row is marked only when the card has no visible pane to be in.
 *
 * A request that names no conversation, or a session no surface holds and no
 * row lists, is drawn as an answer-shaped card in the focused pane's lane
 * (`unattributed`) rather than marked anywhere: there is no row to mark and no
 * composer to cover.
 */
export function pendingAnswers(input: PendingAnswerInput): PendingAnswers {
  const sessionIds = new Set<string>();
  const hiddenPaneIds = new Set<string>();
  const sideChatSessionIds = new Set<string>();
  const unattributed: ApprovalRequest[] = [];
  const listed = new Map(input.sessions.map((session) => [session.id, session]));

  // A side chat's row nests under its parent's, and a card parked in a side
  // chat is news about the parent conversation too. The list knows the
  // parent when the side chat has a file; before that, the tile holding the
  // side chat is the only parent there is. The rows are marked whether or not
  // the side chat is on screen; the toggle and the tab only when it is not.
  const markSideChat = (sessionId: string, tile: TileSession | undefined, drawn: boolean) => {
    sessionIds.add(sessionId);
    const parent = listed.get(sessionId)?.originSessionId ?? tile?.sessionId;
    if (parent) sessionIds.add(parent);
    if (drawn) return;
    sideChatSessionIds.add(sessionId);
    if (tile?.paneHidden) hiddenPaneIds.add(tile.chatGroupId);
  };

  // One session, one verdict: its row is marked because its turn is parked;
  // the control leading to its surface only when that surface is off screen.
  const park = (sessionId: string): void => {
    const sideChatTile = tileWithSideChat(input.tiles, sessionId);
    if (sideChatTile !== undefined) {
      markSideChat(sessionId, sideChatTile, sideChatTile.sideChat!.shown && !sideChatTile.paneHidden);
      return;
    }
    const owner = tileOwningSession(input.tiles, sessionId);
    if (owner !== undefined) {
      sessionIds.add(owner.sessionId);
      if (owner.paneHidden) hiddenPaneIds.add(owner.chatGroupId);
      return;
    }
    const row = listed.get(sessionId);
    if (row === undefined) return;
    if (row.family === "side-chat") markSideChat(sessionId, undefined, false);
    else sessionIds.add(sessionId);
  };

  for (const request of input.approvals) {
    if (request.sessionId === undefined) {
      unattributed.push(request);
      continue;
    }
    const held = tileWithSideChat(input.tiles, request.sessionId) !== undefined
      || tileOwningSession(input.tiles, request.sessionId) !== undefined
      || listed.has(request.sessionId);
    if (held) park(request.sessionId);
    else unattributed.push(request);
  }

  for (const tile of input.tiles) {
    // A question a tile holds is drawn by that tile — its own conversation's,
    // a child's, or one it adopted from a session nobody holds. The row marked
    // is the one the user would open to see it: the tile's conversation for
    // its own and its children's, the asking session's row for an adopted one.
    for (const question of tile.askQuestions) {
      const own = sessionOwnedBy(tile.sessionId, tile.childSessionIds, question.sessionId);
      sessionIds.add(own ? tile.sessionId : question.sessionId);
      if (tile.paneHidden) hiddenPaneIds.add(tile.chatGroupId);
    }
    const sideChat = tile.sideChat;
    if (sideChat !== null && sideChat.askQuestions.length > 0) {
      markSideChat(sideChat.sessionId, tile, sideChat.shown && !tile.paneHidden);
    }
  }

  for (const sessionId of input.deferredSessionIds) park(sessionId);

  // An overlay card parks no turn: its row is marked only when the card has
  // nowhere visible to be — its conversation is in a hidden pane, or in none.
  for (const card of input.overlayCards) {
    if (card.originSessionId === undefined) continue;
    const holder = tileHoldingSession(input.tiles, card.originSessionId);
    if (holder === undefined) {
      if (listed.has(card.originSessionId)) sessionIds.add(card.originSessionId);
    } else if (holder.paneHidden) {
      sessionIds.add(holder.sessionId);
      hiddenPaneIds.add(holder.chatGroupId);
    }
  }

  return { sessionIds, hiddenPaneIds, sideChatSessionIds, unattributed };
}

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
  private tiles: readonly TileSession[] = Object.freeze([]);
  private readonly tileListeners = new Set<Listener>();

  publish(chatGroupId: string, handle: ChatGroupSessionHandle): void {
    const previous = this.latest.get(chatGroupId);
    this.latest.set(chatGroupId, handle);

    // A tile republishes on every render and its reader is an ancestor that
    // renders it, so waking unconditionally is a loop — each side asking the
    // other to go again. Only the DATA decides: the callbacks are dispatched
    // through `latest`, so their identity is not something a reader can see,
    // and comparing it would put the loop back for any caller that forgot to
    // memoize one of them.
    const unchanged = previous !== undefined
      && previous.entries === handle.entries
      && previous.streaming === handle.streaming
      && previous.currentSessionId === handle.currentSessionId
      && previous.hidden === handle.hidden
      && previous.paneHidden === handle.paneHidden
      && previous.askQuestions === handle.askQuestions
      && previous.childSessionIds === handle.childSessionIds
      && previous.sideChat === handle.sideChat
      && previous.currentSessionProject === handle.currentSessionProject
      && this.snapshots.has(chatGroupId);
    if (unchanged) return;

    this.snapshots.set(chatGroupId, this.snapshot(chatGroupId, handle));
    this.refreshTiles();
    this.wake(chatGroupId);
  }

  retract(chatGroupId: string): void {
    const held = this.latest.delete(chatGroupId);
    this.snapshots.delete(chatGroupId);
    if (!held) return;
    this.refreshTiles();
    this.wake(chatGroupId);
  }

  /** Every tile, in publish order. The same array until a tile's session or streaming changes. */
  readTiles(): readonly TileSession[] {
    return this.tiles;
  }

  subscribeTiles(listener: Listener): () => void {
    this.tileListeners.add(listener);
    return () => { this.tileListeners.delete(listener); };
  }

  // A transcript changes with every token; the tile list must not. It is
  // rebuilt only when a field it carries changed, so a subscriber keyed on
  // its identity re-renders on session and streaming edges, not on tokens.
  private refreshTiles(): void {
    const next = [...this.snapshots].map(([chatGroupId, handle]) => ({
      chatGroupId,
      sessionId: handle.currentSessionId,
      streaming: handle.streaming,
      hidden: handle.hidden,
      paneHidden: handle.paneHidden,
      askQuestions: handle.askQuestions,
      childSessionIds: handle.childSessionIds,
      sideChat: handle.sideChat,
    }));
    const same = next.length === this.tiles.length && next.every((tile, index) => {
      const previous = this.tiles[index]!;
      return previous.chatGroupId === tile.chatGroupId
        && previous.sessionId === tile.sessionId
        && previous.streaming === tile.streaming
        && previous.hidden === tile.hidden
        && previous.paneHidden === tile.paneHidden
        && previous.askQuestions === tile.askQuestions
        && previous.childSessionIds === tile.childSessionIds
        && previous.sideChat === tile.sideChat;
    });
    if (same) return;
    this.tiles = Object.freeze(next.map((tile) => Object.freeze(tile)));
    for (const listener of this.tileListeners) listener();
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
      askQuestions: handle.askQuestions,
      childSessionIds: handle.childSessionIds,
      sideChat: handle.sideChat,
      resolveAskQuestion: (id: string) => live()?.resolveAskQuestion(id),
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
      hidden: handle.hidden,
      paneHidden: handle.paneHidden,
      currentSessionProject: handle.currentSessionProject,
      loadSession: async (sessionId: string) => await live()?.loadSession(sessionId) ?? false,
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

/** Every tile's conversation and streaming state — what the sidebar marks rows with. */
export function useTileSessions(registry: ChatGroupSessionRegistry): readonly TileSession[] {
  const subscribe = useCallback((listener: Listener) => registry.subscribeTiles(listener), [registry]);
  const read = useCallback(() => registry.readTiles(), [registry]);
  return useSyncExternalStore(subscribe, read, read);
}

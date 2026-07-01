import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { ViewModeState } from "../components/ViewModeBanner.js";
import { bottomFollowSignature } from "../utils/chat-entry-revision.js";
import {
  CHAT_BOTTOM_THRESHOLD_PX,
  clampScrollTop,
  commitScrollSnapshot,
  getLastSavedScrollPosition,
  getSavedScrollPosition,
  type SavedChatScrollPosition,
} from "../state/chat-scroll-store.js";

export interface UseChatScrollParams {
  entries: ChatEntry[];
  currentSessionId: string;
  chatEndRef: RefObject<HTMLDivElement | null>;
  viewMode: ViewModeState | null;
  searchOpen: boolean;
  searchMatches: number[];
  searchIdx: number;
}

export interface UseChatScrollResult {
  scrollViewportRef: RefObject<HTMLDivElement | null>;
  showJumpToBottom: boolean;
  scrollChatToBottom: (behavior?: ScrollBehavior) => void;
  handleJumpToEntry: (entryIndex: number) => void;
}

/**
 * Owns the chat transcript scroll machinery: viewport pinning, jump-to-bottom
 * visibility, cross-navigation scroll restore (via `chat-scroll-store`), auto
 * bottom-follow while streaming, and search-match scroll-into-view.
 *
 * The module-level scroll singletons live in `state/chat-scroll-store.ts`
 * (imported here) — they MUST NOT be duplicated per mount or cross-navigation
 * scroll restore breaks.
 */
export function useChatScroll({
  entries,
  currentSessionId,
  chatEndRef,
  viewMode,
  searchOpen,
  searchMatches,
  searchIdx,
}: UseChatScrollParams): UseChatScrollResult {
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const previousEntryCountRef = useRef(entries.length);
  const previousSessionIdRef = useRef(currentSessionId);
  const pinnedToBottomRef = useRef(true);
  const autoBottomPinFrameRef = useRef<number | null>(null);
  const scrollFollowSignature = useMemo(() => bottomFollowSignature(entries), [entries]);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const isNearBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return true;
    return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= CHAT_BOTTOM_THRESHOLD_PX;
  }, [scrollViewportRef]);

  const saveScrollPosition = useCallback((
    viewport: HTMLElement | null = scrollViewportRef.current,
    options: { preserveAwayFromBottom?: boolean } = {},
  ) => {
    if (!viewport) return;
    const snapshot: SavedChatScrollPosition = {
      sessionId: currentSessionId ?? null,
      top: viewport.scrollTop,
      bottomGap: Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight),
      entryCount: entries.length,
      updatedAt: Date.now(),
    };
    commitScrollSnapshot(snapshot, options);
  }, [currentSessionId, entries.length, scrollViewportRef]);

  const restoredSessionScrollRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !currentSessionId) return;
    if (restoredSessionScrollRef.current === currentSessionId) return;

    const lastSaved = getLastSavedScrollPosition();
    const saved = getSavedScrollPosition(currentSessionId)
      ?? (lastSaved?.entryCount === entries.length ? lastSaved : undefined);
    if (saved && entries.length === 0 && viewport.scrollHeight <= viewport.clientHeight) {
      return;
    }

    const applyRestore = () => {
      const targetTop = saved
        ? viewport.scrollHeight - viewport.clientHeight - saved.bottomGap
        : viewport.scrollHeight;
      viewport.scrollTop = clampScrollTop(targetTop, viewport);
      const bottomGap = Math.max(0, viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight);
      const nearBottom = bottomGap <= CHAT_BOTTOM_THRESHOLD_PX;
      pinnedToBottomRef.current = nearBottom;
      setShowJumpToBottom(!nearBottom);
      saveScrollPosition(viewport);
    };

    applyRestore();
    previousEntryCountRef.current = entries.length;
    previousSessionIdRef.current = currentSessionId;
    restoredSessionScrollRef.current = currentSessionId;
    const frame = window.requestAnimationFrame(applyRestore);
    return () => window.cancelAnimationFrame(frame);
  }, [currentSessionId, entries.length, saveScrollPosition, scrollViewportRef]);

  const cancelAutoBottomPin = useCallback(() => {
    if (autoBottomPinFrameRef.current === null) return;
    window.cancelAnimationFrame(autoBottomPinFrameRef.current);
    autoBottomPinFrameRef.current = null;
  }, []);

  const pinChatToBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    } else {
      chatEndRef.current?.scrollIntoView({ behavior: "auto" });
    }
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [chatEndRef, scrollViewportRef]);

  const scheduleAutoBottomPin = useCallback(() => {
    if (autoBottomPinFrameRef.current !== null) return;
    autoBottomPinFrameRef.current = window.requestAnimationFrame(() => {
      autoBottomPinFrameRef.current = null;
      pinChatToBottom();
    });
  }, [pinChatToBottom]);

  const scrollChatToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    cancelAutoBottomPin();
    const viewport = scrollViewportRef.current;
    if (viewport) {
      if (typeof viewport.scrollTo === "function") {
        viewport.scrollTo({ top: viewport.scrollHeight, behavior });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    } else {
      chatEndRef.current?.scrollIntoView({ behavior });
    }
    pinnedToBottomRef.current = true;
    setShowJumpToBottom(false);
  }, [cancelAutoBottomPin, chatEndRef, scrollViewportRef]);

  useEffect(() => () => cancelAutoBottomPin(), [cancelAutoBottomPin]);

  useEffect(() => {
    if (!searchOpen || searchMatches.length === 0) return;
    const entryIndex = searchMatches[searchIdx];
    if (entryIndex === undefined) return;
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const frame = window.requestAnimationFrame(() => {
      const target = viewport.querySelector<HTMLElement>(`[data-chat-entry-index="${entryIndex}"]`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [searchIdx, searchMatches, searchOpen, scrollViewportRef]);

  useEffect(() => {
    setShowJumpToBottom(false);
  }, [currentSessionId]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const onScroll = () => {
      const nearBottom = isNearBottom();
      pinnedToBottomRef.current = nearBottom;
      if (!nearBottom) cancelAutoBottomPin();
      setShowJumpToBottom(!nearBottom);
      saveScrollPosition(viewport);
    };
    onScroll();
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      saveScrollPosition(viewport, { preserveAwayFromBottom: true });
      viewport.removeEventListener("scroll", onScroll);
    };
  }, [cancelAutoBottomPin, isNearBottom, saveScrollPosition, scrollViewportRef]);

  useEffect(() => {
    const previousEntryCount = previousEntryCountRef.current;
    const previousSessionId = previousSessionIdRef.current;
    previousEntryCountRef.current = entries.length;
    previousSessionIdRef.current = currentSessionId;
    // Suppress auto-scroll while in view-mode so new live entries don't
    // yank the viewport away from the frozen checkpoint slice the user is reading.
    if (viewMode) return;
    if (
      entries.length > 1 &&
      (previousEntryCount === 0 || previousSessionId !== currentSessionId)
    ) {
      scheduleAutoBottomPin();
      return;
    }
    if (pinnedToBottomRef.current || isNearBottom()) {
      scheduleAutoBottomPin();
    }
  }, [currentSessionId, entries.length, isNearBottom, scheduleAutoBottomPin, scrollFollowSignature, viewMode]);

  const handleJumpToEntry = useCallback((entryIndex: number) => {
    const el = scrollViewportRef.current?.querySelector<HTMLElement>(
      `[data-chat-entry-index="${entryIndex}"]`,
    );
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollViewportRef]);

  return { scrollViewportRef, showJumpToBottom, scrollChatToBottom, handleJumpToEntry };
}

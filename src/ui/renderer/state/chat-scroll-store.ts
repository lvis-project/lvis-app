/**
 * Cross-navigation chat scroll store.
 *
 * Owns the module-level scroll-position singletons that MUST outlive any
 * ChatView mount so that switching sessions (or remounting the view) restores
 * the reader's prior scroll offset. `use-chat-scroll.ts` is the ONLY consumer;
 * the singletons live here (never duplicated) because a per-mount copy would
 * lose cross-navigation scroll state (the exact regression this module guards).
 */

/** Below this bottom gap (px) the viewport counts as "pinned to bottom". */
export const CHAT_BOTTOM_THRESHOLD_PX = 96;
const MAX_SAVED_CHAT_SCROLL_POSITIONS = 24;

export type SavedChatScrollPosition = {
  sessionId: string | null;
  top: number;
  bottomGap: number;
  entryCount: number;
  updatedAt: number;
};

// Module-level singletons — persist across ChatView mounts / session switches.
const savedChatScrollPositions = new Map<string, SavedChatScrollPosition>();
let lastSavedChatScrollPosition: SavedChatScrollPosition | null = null;

export function clampScrollTop(top: number, viewport: HTMLElement): number {
  const maxTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
  return Math.max(0, Math.min(top, maxTop));
}

function pruneSavedChatScrollPositions(): void {
  if (savedChatScrollPositions.size <= MAX_SAVED_CHAT_SCROLL_POSITIONS) return;
  const oldestKeys = [...savedChatScrollPositions.entries()]
    .sort((a, b) => a[1].updatedAt - b[1].updatedAt)
    .slice(0, savedChatScrollPositions.size - MAX_SAVED_CHAT_SCROLL_POSITIONS)
    .map(([key]) => key);
  for (const key of oldestKeys) savedChatScrollPositions.delete(key);
}

/**
 * Commit a freshly-measured snapshot to the singletons. Mirrors the original
 * `saveScrollPosition` tail: the `preserveAwayFromBottom` guard suppresses a
 * near-bottom overwrite when the last committed snapshot was intentionally
 * scrolled away from the bottom for the same session/entry-count.
 */
export function commitScrollSnapshot(
  snapshot: SavedChatScrollPosition,
  options: { preserveAwayFromBottom?: boolean } = {},
): void {
  if (
    options.preserveAwayFromBottom === true &&
    snapshot.bottomGap <= CHAT_BOTTOM_THRESHOLD_PX &&
    lastSavedChatScrollPosition &&
    lastSavedChatScrollPosition.bottomGap > CHAT_BOTTOM_THRESHOLD_PX &&
    lastSavedChatScrollPosition.entryCount === snapshot.entryCount &&
    lastSavedChatScrollPosition.sessionId === snapshot.sessionId
  ) {
    return;
  }
  lastSavedChatScrollPosition = snapshot;
  // Falsy session id ("" before first session resolves, or null) is not keyed
  // into the per-session map — only `lastSavedChatScrollPosition` tracks it.
  if (!snapshot.sessionId) return;
  savedChatScrollPositions.set(snapshot.sessionId, snapshot);
  pruneSavedChatScrollPositions();
}

export function getSavedScrollPosition(
  sessionId: string,
): SavedChatScrollPosition | undefined {
  return savedChatScrollPositions.get(sessionId);
}

export function getLastSavedScrollPosition(): SavedChatScrollPosition | null {
  return lastSavedChatScrollPosition;
}

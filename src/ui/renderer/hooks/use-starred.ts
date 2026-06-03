import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";
import { t } from "../../../i18n/runtime.js";

export interface StarredItem {
  id: string;
  sessionId: string;
  messageIndex: number;
  role: string;
  text: string;
  starredAt: string;
}

/**
 * Starred messages hook.
 * Owns the starred list, refresh, and toggle action. `handleToggleStar`
 * needs the current entries/sessionId/map to resolve which history index
 * is being toggled, so callers pass those in at call time.
 */
export function useStarred(api: LvisApi) {
  const [starred, setStarred] = useState<StarredItem[]>([]);

  const refreshStarred = useCallback(async () => {
    try { const list = await api.starredList(); setStarred(list); } catch { /* ignore */ }
  }, [api]);

  useEffect(() => { void refreshStarred(); }, [refreshStarred]);

  // O(1) lookup index keyed by `${sessionId}:${messageIndex}` → starred id.
  // Avoids O(n×m) linear scan when rendering many entries.
  const starredIndex = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of starred) map.set(`${s.sessionId}:${s.messageIndex}`, s.id);
    return map;
  }, [starred]);

  const sessionStarredIndex = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of starred) {
      if (s.messageIndex === -1) map.set(s.sessionId, s.id);
    }
    return map;
  }, [starred]);

  const isEntryStarred = useCallback(
    (entryIdx: number, currentSessionId: string, entryIndexToHistoryIndex: Map<number, number>): string | null => {
      const histIdx = entryIndexToHistoryIndex.get(entryIdx);
      if (histIdx === undefined) return null;
      return starredIndex.get(`${currentSessionId}:${histIdx}`) ?? null;
    },
    [starredIndex],
  );

  const handleToggleStar = useCallback(
    async (
      entryIdx: number,
      entries: ChatEntry[],
      currentSessionId: string,
      entryIndexToHistoryIndex: Map<number, number>,
    ) => {
      const entry = entries[entryIdx];
      if (!entry || (entry.kind !== "user" && entry.kind !== "assistant")) return;
      const histIdx = entryIndexToHistoryIndex.get(entryIdx);
      if (histIdx === undefined) return;
      const existingId = isEntryStarred(entryIdx, currentSessionId, entryIndexToHistoryIndex);
      try {
        if (existingId) {
          await api.starredRemove({ id: existingId });
        } else {
          await api.starredAdd({
            sessionId: currentSessionId,
            messageIndex: histIdx,
            role: entry.kind,
            text: entry.text,
          });
        }
        await refreshStarred();
      } catch (err) {
        // Caller uses `void handleToggleStar(...)`, so don't re-throw.
        console.warn("[useStarred] toggle failed", err);
      }
    },
    [api, isEntryStarred, refreshStarred],
  );

  const isSessionStarred = useCallback(
    (sessionId: string): string | null => sessionStarredIndex.get(sessionId) ?? null,
    [sessionStarredIndex],
  );

  const handleToggleSessionStar = useCallback(
    async (sessionId: string, title?: string) => {
      const existingId = sessionStarredIndex.get(sessionId);
      try {
        if (existingId) {
          await api.starredRemove({ id: existingId });
        } else {
          await api.starredAdd({
            sessionId,
            messageIndex: -1,
            role: "session",
            text: title?.trim() || t("useStarred.sessionFallbackText", { sessionId: sessionId.slice(0, 8) }),
          });
        }
        await refreshStarred();
      } catch (err) {
        console.warn("[useStarred] session toggle failed", err);
      }
    },
    [api, refreshStarred, sessionStarredIndex],
  );

  return {
    starred,
    refreshStarred,
    isEntryStarred,
    handleToggleStar,
    isSessionStarred,
    handleToggleSessionStar,
  };
}

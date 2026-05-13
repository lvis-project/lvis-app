import { useCallback } from "react";
import type { getApi } from "../api-client.js";
import type { useSessions } from "./use-sessions.js";
import type { useStarred } from "./use-starred.js";
import type { useChatState } from "./use-chat-state.js";

/**
 * Collects the small adapter callbacks that bridge hook outputs to ChatView props.
 * Purely wiring — no new state. Extracted from App.tsx to reduce composition-root noise.
 */
export function useChatActions(opts: {
  api: ReturnType<typeof getApi>;
  streaming: boolean;
  currentSessionId: ReturnType<typeof useSessions>["currentSessionId"];
  entries: ReturnType<typeof useChatState>["entries"];
  entryIndexToHistoryIndex: ReturnType<typeof useChatState>["entryIndexToHistoryIndex"];
  applyLoadedSession: ReturnType<typeof useChatState>["applyLoadedSession"];
  truncateToEntry: ReturnType<typeof useChatState>["truncateToEntry"];
  sessionLoad: ReturnType<typeof useSessions>["handleLoadSession"];
  sessionFork: ReturnType<typeof useSessions>["handleFork"];
  starredIsEntry: ReturnType<typeof useStarred>["isEntryStarred"];
  starredToggle: ReturnType<typeof useStarred>["handleToggleStar"];
}) {
  const {
    api, streaming, currentSessionId, entries, entryIndexToHistoryIndex,
    applyLoadedSession, truncateToEntry, sessionLoad, sessionFork,
    starredIsEntry, starredToggle,
  } = opts;

  const handleLoadSession = useCallback(
    (sessionId: string) => sessionLoad(sessionId, streaming, applyLoadedSession),
    [sessionLoad, streaming, applyLoadedSession],
  );

  const isEntryStarred = useCallback(
    (entryIdx: number): string | null => starredIsEntry(entryIdx, currentSessionId, entryIndexToHistoryIndex),
    [starredIsEntry, currentSessionId, entryIndexToHistoryIndex],
  );

  const handleFork = useCallback(async (entryIdx: number) => {
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return;
    await sessionFork(histIdx, entryIdx, truncateToEntry);
  }, [entryIndexToHistoryIndex, sessionFork, truncateToEntry]);

  const handleToggleStar = useCallback(
    (entryIdx: number) => starredToggle(entryIdx, entries, currentSessionId, entryIndexToHistoryIndex),
    [starredToggle, entries, currentSessionId, entryIndexToHistoryIndex],
  );

  const handleAbort = useCallback(async () => {
    try { await api.chatAbort(); } catch { /* no-op */ }
  }, [api]);

  /**
   * "guide" — non-interrupting mid-stream direction adjustment. The current
   * turn keeps running; the engine consumes the queued text at the next
   * round boundary (between tool execution and the next LLM stream) and
   * appends it to history as a user message. Caller is responsible for
   * disabling the affordance when not streaming — the main-process handler
   * returns `{ ok: false, error: "no-active-turn" }` as a defense-in-depth
   * boundary check.
   */
  const handleGuide = useCallback(async (text: string) => {
    if (text.trim().length === 0) return;
    try { await api.chatGuide(text); } catch { /* no-op */ }
  }, [api]);

  const handleFeedback = useCallback(async (messageIdx: number, rating: "up" | "down", reason?: string) => {
    if (!api.submitFeedback) return;
    try { await api.submitFeedback({ sessionId: currentSessionId, messageIndex: messageIdx, rating, reason }); } catch { /* no-op */ }
  }, [api, currentSessionId]);

  const handleExport = useCallback(async (format: "markdown" | "json") => {
    try { await api.chatExport(format); } catch (err) { console.warn("[lvis] export failed:", (err as Error).message); }
  }, [api]);

  return { handleLoadSession, isEntryStarred, handleFork, handleToggleStar, handleAbort, handleGuide, handleFeedback, handleExport };
}

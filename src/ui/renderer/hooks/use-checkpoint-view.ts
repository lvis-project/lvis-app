import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { useTranslation } from "../../../i18n/react.js";
import { SHORT_TOAST_TTL_MS } from "../constants.js";
import type { ViewModeState } from "../components/ViewModeBanner.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";

export interface UseCheckpointViewParams {
  api: LvisApi;
  currentSessionId: string;
  entries: ChatEntry[];
  streaming: boolean;
  hasActiveStreamingEntry: boolean;
  onLoadSession?: (sessionId: string) => void | boolean | Promise<void | boolean>;
  onContinueFromLastUser?: (sessionId: string) => void | Promise<void>;
  setViewMode: React.Dispatch<React.SetStateAction<ViewModeState | null>>;
  scrollChatToBottom: (behavior?: ScrollBehavior) => void;
}

export interface UseCheckpointViewResult {
  forkToast: string | null;
  handleEnterView: (compactNum: number) => Promise<void>;
  handleExitView: () => Promise<void>;
  handleBranchFrom: (compactNum: number) => Promise<void>;
}

/**
 * Owns the checkpoint view-mode navigation handlers + the brief fork-success
 * toast. `viewMode` state itself lives at the ChatView composition root because
 * it is read by `useChatScroll` (auto-scroll suppression) and the transcript
 * slicing — this hook only sets it via `setViewMode`. Depends on the scroll
 * hook (`scrollChatToBottom`).
 */
export function useCheckpointView({
  api,
  currentSessionId,
  entries,
  streaming,
  hasActiveStreamingEntry,
  onLoadSession,
  onContinueFromLastUser,
  setViewMode,
  scrollChatToBottom,
}: UseCheckpointViewParams): UseCheckpointViewResult {
  const { t } = useTranslation();
  // Brief fork-success toast (auto-dismisses after 3 s).
  const [forkToast, setForkToast] = useState<string | null>(null);
  const forkToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup fork toast timer on unmount to avoid setState-after-unmount.
  useEffect(() => {
    return () => {
      if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
    };
  }, []);

  // Checkpoint view-mode handlers.
  const handleEnterView = useCallback(async (compactNum: number) => {
    const result = await api.chatEnterCheckpointView?.(currentSessionId, compactNum);
    if (!result || "error" in result) return;
    // messageIndexAtCreation is engine history message count — it does NOT
    // map 1:1 to renderer entries (which include reasoning/tool_group/checkpoint entries).
    // We cap to entries.length so the slice is always valid, accepting that in tool-heavy
    // sessions the visible range may show slightly more entries than the exact checkpoint.
    // A precise renderer↔engine index mapping can be added later if needed.
    const slicedRangeEnd = Math.min(result.messageIndexAtCreation, entries.length);
    setViewMode({ compactNum, slicedRangeEnd });
    scrollChatToBottom("auto");
  }, [api, currentSessionId, entries.length, scrollChatToBottom, setViewMode]);

  const handleExitView = useCallback(async () => {
    await api.chatExitCheckpointView?.();
    setViewMode(null);
    scrollChatToBottom("auto");
  }, [api, scrollChatToBottom, setViewMode]);

  const handleBranchFrom = useCallback(async (compactNum: number) => {
    if (streaming || hasActiveStreamingEntry) {
      if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
      setForkToast(t("chatView.forkBusyToast"));
      forkToastTimerRef.current = setTimeout(() => setForkToast(null), SHORT_TOAST_TTL_MS);
      return;
    }
    const result = await api.chatBranchFromCheckpoint?.(currentSessionId, compactNum);
    if (!result || "error" in result) return;
    // Exit view-mode before loading the new session so it opens in live mode.
    setViewMode(null);
    // Load the branched session
    if (!onLoadSession) return;
    const loaded = await onLoadSession(result.newSessionId);
    if (loaded === false) return;
    // Show fork-success toast (shorter than default — single-line confirmation needs less time)
    if (forkToastTimerRef.current) clearTimeout(forkToastTimerRef.current);
    setForkToast(
      result.shouldAutoContinue
        ? t("chatView.forkSuccessAutoContinue", { compactNum })
        : t("chatView.forkSuccess", { compactNum }),
    );
    forkToastTimerRef.current = setTimeout(() => setForkToast(null), SHORT_TOAST_TTL_MS); // single-line fork confirmation needs less read time
    if (result.shouldAutoContinue) {
      await onContinueFromLastUser?.(result.newSessionId);
    }
  }, [api, currentSessionId, hasActiveStreamingEntry, onContinueFromLastUser, onLoadSession, streaming, setViewMode]);

  return { forkToast, handleEnterView, handleExitView, handleBranchFrom };
}

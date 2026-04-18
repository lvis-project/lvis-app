import { useCallback, useRef, useState, type MutableRefObject } from "react";
import {
  finalizeStreamingAssistant,
  finalizeStreamingReasoning,
  setAssistantError,
  type ChatEntry,
} from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";

/**
 * Phase 3.2 — chat state hook.
 *
 * Owns: entries, streaming flag, stream accumulator refs, edit state,
 * and the edit / retry handlers. The stream-event subscription lives in
 * App.tsx still (it touches briefing / other non-chat side effects), but
 * this hook exposes `setEntries` / refs / `setStreaming` so the subscription
 * can drive them.
 *
 * Handlers that need `entryIndexToHistoryIndex` (computed in App from
 * `entries`) receive it as an argument rather than duplicating the memo.
 */
export function useChatState(api: LvisApi) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const streamRef = useRef("");
  const thoughtRef = useRef("");

  const [editingEntryIdx, setEditingEntryIdx] = useState<number | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  const handleEditSave = useCallback(
    async (
      entryIdx: number,
      newText: string,
      entryIndexToHistoryIndex: Map<number, number>,
    ) => {
      const histIdx = entryIndexToHistoryIndex.get(entryIdx);
      if (histIdx === undefined) return;
      setEditBusy(true);
      const prevEntries = entries;
      let failed = false;
      try {
        setEntries((p) => [...p.slice(0, entryIdx), { kind: "user", text: newText }]);
        streamRef.current = "";
        thoughtRef.current = "";
        setStreaming(true);
        const res = await api.chatEditResend(histIdx, newText);
        if (!res?.ok) {
          failed = true;
          setEntries(
            setAssistantError(
              prevEntries,
              `편집 실패: ${res?.error ?? "알 수 없는 오류"}`,
              thoughtRef.current,
            ),
          );
        }
      } catch (err) {
        failed = true;
        setEntries((p) =>
          setAssistantError(p, `오류: ${(err as Error).message}`, thoughtRef.current),
        );
      } finally {
        setEditBusy(false);
        setStreaming(false);
        if (!failed) setEditingEntryIdx(null);
      }
    },
    [api, entries],
  );

  const handleRetryEffort = useCallback(async () => {
    const prevEntries = entries;
    setEntries((p) => {
      const next = [...p];
      while (
        next.length > 0 &&
        (next[next.length - 1].kind === "assistant" ||
          next[next.length - 1].kind === "reasoning" ||
          next[next.length - 1].kind === "tool_group")
      ) {
        next.pop();
      }
      return next;
    });
    streamRef.current = "";
    thoughtRef.current = "";
    setStreaming(true);
    try {
      const res = await api.chatRetryEffort({
        enableThinking: true,
        thinkingBudgetTokens: 20000,
      });
      if (!res?.ok) {
        setEntries(
          setAssistantError(
            prevEntries,
            `재시도 실패: ${res?.error ?? "알 수 없는 오류"}`,
            thoughtRef.current,
          ),
        );
      }
    } catch (err) {
      setEntries((p) =>
        setAssistantError(p, `오류: ${(err as Error).message}`, thoughtRef.current),
      );
    } finally {
      setStreaming(false);
    }
  }, [api, entries]);

  // Used by App's `done` stream branch to finalize leftover streaming state.
  const finalizeLeftoverStream = useCallback(() => {
    if (streamRef.current || thoughtRef.current) {
      setEntries((p) => {
        let next = finalizeStreamingReasoning(p, thoughtRef.current);
        next = finalizeStreamingAssistant(next, streamRef.current);
        return next;
      });
      streamRef.current = "";
      thoughtRef.current = "";
    }
  }, []);

  return {
    entries,
    setEntries,
    streaming,
    setStreaming,
    streamRef: streamRef as MutableRefObject<string>,
    thoughtRef: thoughtRef as MutableRefObject<string>,
    editingEntryIdx,
    setEditingEntryIdx,
    editBusy,
    handleEditSave,
    handleRetryEffort,
    finalizeLeftoverStream,
  };
}

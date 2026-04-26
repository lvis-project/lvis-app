import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendDeltaToImportedTriggerResponse,
  appendImportedTriggerEntry,
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  finalizeImportedTriggerResponse,
  finalizeStreamingAssistant,
  finalizeStreamingReasoning,
  isImportedTriggerStreaming,
  reopenLastAssistant,
  setAssistantError,
  upsertStreamingAssistant,
  upsertStreamingReasoning,
  type ChatEntry,
} from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";

/**
 * Phase 5 — chat state + stream hook.
 *
 * Owns everything chat-lifecycle: entries, streaming flag, the IPC
 * stream subscription (finalize/tool/error/redact/compact/done), edit state,
 * and edit/retry handlers.
 *
 * Exposes intent methods (seedRoutineEntries / clearForNewChat / appendUserEntry /
 * applyLoadedSession / truncateToEntry) instead of raw `setEntries` so that
 * App-level orchestration cannot mutate entry shape directly.
 */
export function useChatState(api: LvisApi) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const streamRef = useRef("");
  const thoughtRef = useRef("");
  const activeStreamIdRef = useRef<number | null>(null);
  const streamingRequestRef = useRef(0);
  const guidanceResetPendingRef = useRef(false);

  const [editingEntryIdx, setEditingEntryIdx] = useState<number | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  // Guard against setState after unmount — Fix 1 (PR #98).
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Map renderer `entries` (which include reasoning/tool_group/system) to
  // backend history indices which only track user + assistant messages.
  const entryIndexToHistoryIndex = useMemo(() => {
    const map = new Map<number, number>();
    let backend = 0;
    entries.forEach((e, i) => {
      if (e.kind === "user" || e.kind === "assistant") {
        map.set(i, backend);
        backend += 1;
      }
    });
    return map;
  }, [entries]);

  // Stream subscription — Phase 5: absorbed from App.tsx.
  useEffect(() => {
    const unsub = api.onChatStream((ev) => {
      if (!aliveRef.current) return;
      // `process` is not defined in the renderer (browser context — esbuild
      // bundles with --platform=browser and no `define:process.env.*`). An
      // unguarded `process.env` reference throws ReferenceError on EVERY
      // stream event, killing the entire listener so text_delta /
      // reasoning_delta / message_complete never get processed — the user
      // sees an empty response. Guard with typeof.
      if (
        typeof process !== "undefined" &&
        process.env?.VITE_DEBUG_STREAM === "1"
      ) {
        console.log("[lvis:chat:stream]", ev);
      }
      const streamId = typeof ev.streamId === "number" ? ev.streamId : null;
      if (ev.type === "guidance_reset") {
        if (streamId !== null) activeStreamIdRef.current = streamId;
        guidanceResetPendingRef.current = true;
        setEntries((p) => {
          const reopened = reopenLastAssistant(p);
          streamRef.current = reopened.text;
          thoughtRef.current = "";
          return reopened.entries;
        });
        return;
      }
      if (streamId !== null) {
        if (activeStreamIdRef.current === null) {
          activeStreamIdRef.current = streamId;
        } else if (activeStreamIdRef.current !== streamId) {
          return;
        }
      }
      if (ev.type === "text_delta" && ev.text) {
        setEntries((p) => {
          // Brain trigger flow — when the LLM is responding to an
          // accepted proactive trigger, redirect deltas INTO the
          // imported_trigger card's response field so the whole
          // interaction stays visually grouped. Falls back to the
          // normal streaming-assistant path for ordinary user turns.
          //
          // Critical: do NOT accumulate streamRef when routing to the
          // card. Otherwise the `done` handler's fallback in
          // finalizeStreamingAssistant sees streamRef populated and
          // appends a phantom assistant entry below the card, which
          // looks like a duplicate response.
          if (isImportedTriggerStreaming(p)) {
            return appendDeltaToImportedTriggerResponse(p, ev.text!);
          }
          streamRef.current += ev.text!;
          const base = guidanceResetPendingRef.current ? reopenLastAssistant(p).entries : p;
          guidanceResetPendingRef.current = false;
          return upsertStreamingAssistant(base, streamRef.current);
        });
      } else if (ev.type === "reasoning_delta" && ev.text) {
        thoughtRef.current += ev.text;
        setEntries((p) => {
          const base = guidanceResetPendingRef.current ? reopenLastAssistant(p).entries : p;
          guidanceResetPendingRef.current = false;
          return upsertStreamingReasoning(base, thoughtRef.current);
        });
      } else if (ev.type === "assistant_round") {
        setEntries((p) => {
          // Brain trigger flow — DO NOT finalize the card here.
          // assistant_round fires once per LLM round (tool_use → next
          // round → end_turn). Finalizing on the first round (with
          // stopReason="tool_use") would close the card before the
          // LLM's actual reply text arrives in the next round, and
          // those subsequent text_deltas would land in a sibling
          // streaming-assistant entry — exactly the duplicate-response
          // bug we're fixing. We finalize only on the `done` event.
          if (isImportedTriggerStreaming(p)) {
            return p;
          }
          const base = guidanceResetPendingRef.current ? reopenLastAssistant(p).entries : p;
          guidanceResetPendingRef.current = false;
          let next = finalizeStreamingReasoning(base, ev.thought ?? thoughtRef.current);
          next = finalizeStreamingAssistant(next, ev.text ?? streamRef.current);
          return next;
        });
        streamRef.current = "";
        thoughtRef.current = "";
      } else if (ev.type === "tool_start" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, displayOrder = 0, name, input } = ev;
        setEntries((p) => applyToolStart(p, { groupId, toolUseId, displayOrder, name, input }));
      } else if (ev.type === "tool_end" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, result, isError, uiPayload } = ev;
        setEntries((p) => applyToolEnd(p, { groupId, toolUseId, result, isError, uiPayload }));
      } else if (ev.type === "error") {
        setEntries((p) => {
          // Error during a brain-trigger import turn: also close the
          // card's streaming indicator so the spinner doesn't hang
          // forever. The error message itself still surfaces via the
          // normal setAssistantError sibling path — surfacing it inside
          // the card would conflate the proactive interaction with a
          // host-level error and is likely more confusing than helpful.
          const closed = isImportedTriggerStreaming(p)
            ? finalizeImportedTriggerResponse(p)
            : p;
          return setAssistantError(
            closed,
            `오류: ${ev.error || "알 수 없는 오류"}`,
            thoughtRef.current,
          );
        });
        streamRef.current = "";
        thoughtRef.current = "";
        activeStreamIdRef.current = null;
        guidanceResetPendingRef.current = false;
      } else if (ev.type === "redact_notice") {
        // Sprint E §3 — user draft 에서 PII 가 리댁트되었음을 알리는 시스템 배지.
        const count = (ev as unknown as { count?: number }).count ?? 0;
        const byKind = (ev as unknown as { byKind?: Record<string, number> }).byKind ?? {};
        const kindLabel = Object.entries(byKind)
          .map(([k, v]) => `${k}:${v}`)
          .join(", ");
        setEntries((p) => [
          ...p,
          { kind: "system", text: `🔒 전송 전 PII ${count}건 리댁트됨${kindLabel ? ` (${kindLabel})` : ""}` },
        ]);
      } else if (ev.type === "compact_notice") {
        const n = ev.removedMessages ?? 0;
        setEntries((p) => [...p, { kind: "system", text: `💾 이전 ${n}개 대화를 요약했습니다 (목표·결정사항 보존)` }]);
      } else if (ev.type === "done") {
        // Brain trigger flow — close the card's streaming indicator.
        // Independent of the regular streaming-assistant finalize; the
        // card may have absorbed every text_delta of this turn so
        // streamRef.current can be empty even though the card has
        // content to seal.
        setEntries((p) => finalizeImportedTriggerResponse(p));
        if (streamRef.current || thoughtRef.current) {
          setEntries((p) => {
            const base = guidanceResetPendingRef.current ? reopenLastAssistant(p).entries : p;
            guidanceResetPendingRef.current = false;
            let next = finalizeStreamingReasoning(base, thoughtRef.current);
            next = finalizeStreamingAssistant(next, streamRef.current);
            return next;
          });
          streamRef.current = "";
          thoughtRef.current = "";
        }
        activeStreamIdRef.current = null;
        guidanceResetPendingRef.current = false;
      }
    });
    return () => { unsub(); };
  }, [api]);

  // Imperative method exposed to App.tsx — App owns the trigger-import
  // listener (it has access to handleAsk for the auto-fired chat
  // follow-up). use-chat-state just provides the entry-mutation
  // primitive; orchestration stays at App level.
  const addImportedTriggerEntry = useCallback(
    (payload: {
      sessionId: string;
      source: string;
      prompt: string;
      summary: string;
      toolCallCount: number;
      importedAt: string;
    }) => {
      setEntries((p) => appendImportedTriggerEntry(p, payload));
    },
    [],
  );

  // Fallback toast — shown briefly when the LLM provider auto-switches.
  const [fallbackToast, setFallbackToast] = useState<string | null>(null);
  const fallbackToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsub = api.onChatFallback(({ from, to }) => {
      if (!aliveRef.current) return;
      if (fallbackToastTimerRef.current) clearTimeout(fallbackToastTimerRef.current);
      setFallbackToast(`⚡ ${from}→${to} 자동 전환`);
      fallbackToastTimerRef.current = setTimeout(() => setFallbackToast(null), 4000);
    });
    return () => {
      unsub();
      if (fallbackToastTimerRef.current) clearTimeout(fallbackToastTimerRef.current);
    };
  }, [api]);

  const beginStreamingRequest = useCallback(() => {
    const requestId = ++streamingRequestRef.current;
    setStreaming(true);
    return requestId;
  }, []);

  const finishStreamingRequest = useCallback((requestId: number) => {
    if (streamingRequestRef.current === requestId) {
      setStreaming(false);
    }
  }, []);

  const handleEditSave = useCallback(
    async (entryIdx: number, newText: string) => {
      const histIdx = entryIndexToHistoryIndex.get(entryIdx);
      if (histIdx === undefined) return;
      setEditBusy(true);
      const prevEntries = entries;
      let failed = false;
      const requestId = beginStreamingRequest();
      try {
        setEntries((p) => [...p.slice(0, entryIdx), { kind: "user", text: newText }]);
        streamRef.current = "";
        thoughtRef.current = "";
        activeStreamIdRef.current = null;
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
        finishStreamingRequest(requestId);
        if (!failed) setEditingEntryIdx(null);
      }
    },
    [api, entries, entryIndexToHistoryIndex, beginStreamingRequest, finishStreamingRequest],
  );

  const handleRetryEffort = useCallback(async () => {
    const prevEntries = entries;
    const requestId = beginStreamingRequest();
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
    activeStreamIdRef.current = null;
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
      finishStreamingRequest(requestId);
    }
  }, [api, entries, beginStreamingRequest, finishStreamingRequest]);

  // Used by handleAsk in App.tsx to reset stream accumulators before chatSend.
  const resetStreamAccumulators = useCallback(() => {
    streamRef.current = "";
    thoughtRef.current = "";
    activeStreamIdRef.current = null;
    guidanceResetPendingRef.current = false;
  }, []);

  // Used by handleAsk error path to show an error bubble with the current thought.
  const setErrorWithThought = useCallback((message: string) => {
    setEntries((p) => setAssistantError(p, message, thoughtRef.current));
    streamRef.current = "";
    thoughtRef.current = "";
    activeStreamIdRef.current = null;
    guidanceResetPendingRef.current = false;
  }, []);

  // ── Intent methods (replace raw setEntries) ──
  const seedRoutineEntries = useCallback((seeded: ChatEntry[]) => {
    setEntries(seeded);
  }, []);

  const clearForNewChat = useCallback(() => {
    setEntries([]);
    streamRef.current = "";
    thoughtRef.current = "";
    activeStreamIdRef.current = null;
    guidanceResetPendingRef.current = false;
  }, []);

  const appendUserMessage = useCallback((content: string): void => {
    setEntries((p) => appendUserEntry(p, content));
  }, []);

  const applyLoadedSession = useCallback((loaded: ChatEntry[]) => {
    setEntries(loaded);
  }, []);

  const truncateToEntry = useCallback((entryIndex: number) => {
    setEntries((p) => p.slice(0, entryIndex + 1));
  }, []);

  /**
   * B1 — /compact manual command handler.
   * Intercepts user messages starting with "/compact", calls IPC, then shows
   * a system banner with the result. Returns true if intercepted.
   */
  const handleCompactCommand = useCallback(
    async (input: string): Promise<boolean> => {
      if (!input.trimStart().startsWith("/compact")) return false;
      try {
        const res = await api.chatCompact();
        const banner = res.compacted
          ? `대화 압축: ${res.removedMessageCount}개 메시지 요약됨`
          : "컴팩트 불필요: 메시지 수가 충분히 적습니다.";
        setEntries((p) => [...p, { kind: "system", text: banner }]);
      } catch (err) {
        setEntries((p) => [...p, { kind: "system", text: `압축 오류: ${(err as Error).message}` }]);
      }
      return true;
    },
    [api],
  );

  return {
    entries,
    streaming,
    setStreaming,
    beginStreamingRequest,
    finishStreamingRequest,
    editingEntryIdx,
    setEditingEntryIdx,
    editBusy,
    entryIndexToHistoryIndex,
    fallbackToast,
    handleEditSave,
    handleRetryEffort,
    resetStreamAccumulators,
    setErrorWithThought,
    handleCompactCommand,
    // intent methods
    seedRoutineEntries,
    clearForNewChat,
    appendUserEntry: appendUserMessage,
    applyLoadedSession,
    truncateToEntry,
    addImportedTriggerEntry,
  };
}

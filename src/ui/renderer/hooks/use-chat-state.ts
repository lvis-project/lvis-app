import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  finalizeStreamingAssistant,
  finalizeStreamingReasoning,
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
 * Exposes intent methods (seedBriefing / clearForNewChat / appendUserEntry /
 * applyLoadedSession / truncateToEntry) instead of raw `setEntries` so that
 * App-level orchestration cannot mutate entry shape directly.
 */
export function useChatState(api: LvisApi) {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [streaming, setStreaming] = useState(false);
  const streamRef = useRef("");
  const thoughtRef = useRef("");

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
      if (ev.type === "text_delta" && ev.text) {
        streamRef.current += ev.text;
        setEntries((p) => upsertStreamingAssistant(p, streamRef.current));
      } else if (ev.type === "reasoning_delta" && ev.text) {
        thoughtRef.current += ev.text;
        setEntries((p) => upsertStreamingReasoning(p, thoughtRef.current));
      } else if (ev.type === "assistant_round") {
        setEntries((p) => {
          let next = finalizeStreamingReasoning(p, ev.thought ?? thoughtRef.current);
          next = finalizeStreamingAssistant(next, ev.text ?? streamRef.current);
          return next;
        });
        streamRef.current = "";
        thoughtRef.current = "";
      } else if (ev.type === "tool_start" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, displayOrder = 0, name, input } = ev;
        setEntries((p) => applyToolStart(p, { groupId, toolUseId, displayOrder, name, input }));
      } else if (ev.type === "tool_end" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, result, isError } = ev;
        setEntries((p) => applyToolEnd(p, { groupId, toolUseId, result, isError }));
      } else if (ev.type === "error") {
        setEntries((p) => setAssistantError(p, `오류: ${ev.error || "알 수 없는 오류"}`, thoughtRef.current));
        streamRef.current = "";
        thoughtRef.current = "";
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
        if (streamRef.current || thoughtRef.current) {
          setEntries((p) => {
            let next = finalizeStreamingReasoning(p, thoughtRef.current);
            next = finalizeStreamingAssistant(next, streamRef.current);
            return next;
          });
          streamRef.current = "";
          thoughtRef.current = "";
        }
      }
    });
    return () => { unsub(); };
  }, [api]);

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

  const handleEditSave = useCallback(
    async (entryIdx: number, newText: string) => {
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
    [api, entries, entryIndexToHistoryIndex],
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

  // Used by handleAsk in App.tsx to reset stream accumulators before chatSend.
  const resetStreamAccumulators = useCallback(() => {
    streamRef.current = "";
    thoughtRef.current = "";
  }, []);

  // Used by handleAsk error path to show an error bubble with the current thought.
  const setErrorWithThought = useCallback((message: string) => {
    setEntries((p) => setAssistantError(p, message, thoughtRef.current));
    streamRef.current = "";
    thoughtRef.current = "";
  }, []);

  // ── Intent methods (replace raw setEntries) ──
  const seedBriefing = useCallback((seeded: ChatEntry[]) => {
    setEntries(seeded);
  }, []);

  const clearForNewChat = useCallback(() => {
    setEntries([]);
    streamRef.current = "";
    thoughtRef.current = "";
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
    seedBriefing,
    clearForNewChat,
    appendUserEntry: appendUserMessage,
    applyLoadedSession,
    truncateToEntry,
  };
}

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
  setAssistantError,
  upsertStreamingAssistant,
  upsertStreamingReasoning,
  type ChatEntry,
} from "../../../lib/chat-stream-state.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import { debugLog, isDebugStreamEnabled } from "../../../lib/debug-stream.js";
import type { LvisApi } from "../types.js";

/**
 * Chat state + stream hook.
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

  // Stream subscription absorbed from App.tsx.
  useEffect(() => {
    const unsub = api.onChatStream((ev) => {
      if (!aliveRef.current) return;
      const debugStreamEnabled = isDebugStreamEnabled();
      // `process` is not defined in the renderer (browser context — esbuild
      // bundles with --platform=browser and no `define:process.env.*`). Read
      // the flag through debug-stream.ts so the preload bridge / renderer-safe
      // fallbacks decide whether diagnostics are enabled.
      if (debugStreamEnabled) {
        debugLog("stream", "ev", {
          type: ev.type,
          streamId: ev.streamId ?? null,
          textLen: typeof ev.text === "string" ? ev.text.length : null,
          thoughtLen: typeof ev.thought === "string" ? ev.thought.length : null,
          stopReason: (ev as { stopReason?: string }).stopReason,
          hasToolCalls: (ev as { hasToolCalls?: boolean }).hasToolCalls,
          groupId: (ev as { groupId?: string }).groupId,
          toolUseId: (ev as { toolUseId?: string }).toolUseId,
          accStream: streamRef.current.length,
          accThought: thoughtRef.current.length,
        });
      }
      const streamId = typeof ev.streamId === "number" ? ev.streamId : null;
      if (ev.type === "guidance_injected") {
        // Non-interrupting "guide" mode (chat utterance taxonomy) — engine
        // consumed a queued guide utterance at the round boundary and
        // appended it to history. Surface to the user as a system entry
        // so they can see their direction-adjustment landed; the assistant
        // round that follows reads it like any other user message.
        const text = typeof ev.text === "string" ? ev.text : "";
        if (text.length === 0) return;
        setEntries((p) => [
          ...p,
          { kind: "system", text: `방향 지시 적용: ${text}` },
        ]);
        return;
      }
      if (ev.type === "guidance_dropped") {
        // Round-cap reached before the queued guidance could be injected
        // (edge case — normal end-turn extends one more round to deliver
        // the guide). Surface so the user knows their direction-adjustment
        // was NOT applied — otherwise the silent-drop is worse UX than the
        // pre-redesign abort-and-restart flow. Use a "⚠️" prefix so the
        // failure surface is visually distinguishable from the "방향 지시
        // 적용" success entry (round 2 critic m1 — same `system` kind
        // styling, only the leading glyph + text differs).
        const text = typeof ev.text === "string" ? ev.text : "";
        if (text.length === 0) return;
        setEntries((p) => [
          ...p,
          { kind: "system", text: `⚠️ 방향 지시 미적용 (응답 한도 도달): ${text}` },
        ]);
        return;
      }
      if (ev.type === "permission_mode_changed" && ev.mode) {
        window.dispatchEvent(new CustomEvent("lvis:permissions:mode-changed", { detail: { mode: ev.mode } }));
        return;
      }
      if (streamId !== null) {
        if (activeStreamIdRef.current === null) {
          activeStreamIdRef.current = streamId;
          if (debugStreamEnabled) debugLog("stream", "activeStreamId:adopt", { streamId });
        } else if (activeStreamIdRef.current !== streamId) {
          if (debugStreamEnabled) {
            debugLog("stream", "ev:rejected-stale-streamId", {
              evStreamId: streamId,
              active: activeStreamIdRef.current,
              evType: ev.type,
            });
          }
          return;
        }
      }
      if (ev.type === "llm_status") {
        const message = formatLlmStatusMessage(ev);
        if (!message) return;
        setEntries((p) => {
          if (isImportedTriggerStreaming(p)) return p;
          const base = p;
          return upsertStreamingAssistant(base, message);
        });
      } else if (ev.type === "text_delta" && ev.text) {
        setEntries((p) => {
          // Overlay trigger import flow — when the LLM is responding to an
          // accepted overlay trigger, redirect deltas INTO the
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
          const base = p;
          return upsertStreamingAssistant(base, streamRef.current);
        });
      } else if (ev.type === "reasoning_delta" && ev.text) {
        thoughtRef.current += ev.text;
        setEntries((p) => {
          const base = p;
          return upsertStreamingReasoning(dropPendingLlmStatusAssistant(base), thoughtRef.current);
        });
      } else if (ev.type === "assistant_round") {
        if (debugStreamEnabled) {
          debugLog("stream", "assistant_round:enter", {
            evTextLen: ev.text?.length ?? 0,
            evThoughtLen: ev.thought?.length ?? 0,
            evTextEmpty: ev.text === "",
            evThoughtEmpty: ev.thought === "",
            accStream: streamRef.current.length,
            accThought: thoughtRef.current.length,
            stopReason: ev.stopReason,
          });
        }
        setEntries((p) => {
          // Overlay trigger import flow — DO NOT finalize the imported_trigger
          // card here. assistant_round fires once per LLM round
          // (tool_use → next round → end_turn). Finalizing on the
          // first round (stopReason="tool_use") would close the card
          // before the LLM's actual reply text arrives in the next
          // round, and those subsequent text_deltas would land in a
          // sibling streaming-assistant entry — exactly the
          // duplicate-response bug we're fixing.
          //
          // BUT: a streaming `reasoning` entry for THIS round still
          // needs sealing. Without this, a per-round reasoning entry
          // stays `streaming: true` forever (thoughtRef gets reset
          // on the next round, and the `done` branch only finalizes
          // when thoughtRef is non-empty). Finalize reasoning even
          // on the trigger path.
          if (isImportedTriggerStreaming(p)) {
            return finalizeStreamingReasoning(p, ev.thought ?? thoughtRef.current);
          }
          const base = p;
          const beforeCount = base.length;
          let next = finalizeStreamingReasoning(base, ev.thought ?? thoughtRef.current);
          const afterReasoningCount = next.length;
           // Bugfix #561 follow-up: empty-string `ev.text` from the engine
           // would be picked by the previous `ev.text ?? streamRef.current`
           // form (since `""` is not nullish), erasing the renderer's
           // accumulated body and leaving the assistant entry blank. Use
           // `||` so an empty string falls through to the delta-accumulated
           // `streamRef.current` instead of overwriting body content.
          const rawText = ev.text || streamRef.current;
          const detected = detectFromStream(rawText);
          const finalText = visibleAssistantText(detected.cleanedText);
          const phase = ev.stopReason === "tool_use" || ev.hasToolCalls ? "work" : "final";
          next = finalizeStreamingAssistant(next, finalText, { phase, overrideText: finalText });
          const afterAssistantCount = next.length;
          if (debugStreamEnabled) {
            debugLog("stream", "assistant_round:finalized", {
              beforeCount,
              afterReasoningCount,
              afterAssistantCount,
              usedThought: (ev.thought ?? thoughtRef.current).length,
              rawTextLen: rawText.length,
              cleanedTextLen: finalText.length,
              phase,
              kinds: next.map((e) => e.kind).join(","),
            });
          }
          return next;
        });
        streamRef.current = "";
        thoughtRef.current = "";
      } else if (ev.type === "tool_start" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, displayOrder = 0, name, input } = ev;
        setEntries((p) => applyToolStart(dropPendingLlmStatusAssistant(p), { groupId, toolUseId, displayOrder, name, input }));
      } else if (ev.type === "tool_end" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, result, isError, uiPayload, durationMs } = ev;
        setEntries((p) => applyToolEnd(p, { groupId, toolUseId, result, isError, uiPayload, durationMs }));
      } else if (ev.type === "error") {
        setEntries((p) => {
          // Error during an overlay-trigger import turn: also close the
          // card's streaming indicator so the spinner doesn't hang
          // forever. The error message itself still surfaces via the
          // normal setAssistantError sibling path — surfacing it inside
          // the card would conflate the overlay-trigger interaction with a
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
      } else if (ev.type === "turn_summary") {
        // Turn aggregate footer (§ chat transcript per-turn footer) — append a
        // single `kind: "turn_summary"` entry. Lives in the entries stream so
        // it survives session reload + historical rendering rather than being
        // re-derived from per-tool / per-round events. Renderer (ChatView)
        // consumes this entry to render <TurnSummaryFooter> next to the final
        // assistant card. tokensIn / tokensOut are routed from the LLM
        // provider's usage report (Vercel AI SDK forwards prompt_tokens +
        // completion_tokens through stream-mapper.ts; see the engine-side
        // `onTurnSummary` wiring in conversation-loop.ts runTurn).
        const turnDurationMs = ev.turnDurationMs ?? 0;
        const toolCount = ev.toolCount ?? 0;
        const cumulativeToolMs = ev.cumulativeToolMs ?? 0;
        const tokensIn = ev.tokensIn ?? 0;
        const freshInputTokens = ev.freshInputTokens ?? 0;
        const tokensOut = ev.tokensOut ?? 0;
        setEntries((p) => [
          ...p,
          {
            kind: "turn_summary",
            turnDurationMs,
            toolCount,
            cumulativeToolMs,
            tokensIn,
            freshInputTokens,
            tokensOut,
            ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
            ...(ev.cacheWriteTokens !== undefined ? { cacheWriteTokens: ev.cacheWriteTokens } : {}),
            ...(ev.breakdown ? { breakdown: ev.breakdown } : {}),
          },
        ]);
      } else if (ev.type === "compact_notice") {
        // §457 PR-A: emit a structured `kind: "checkpoint"` entry instead of
        // a free-text system bubble. ChatView reads `tier` to pick a
        // tier-aware label/color. Keeping the old prose route would
        // force a brittle string-match (`entry.text.includes("checkpoint")`)
        // that never fired in production because the legacy text didn't
        // contain that token. See Issue #457 Phase 1+2 cleanup.
        const removed = ev.removedMessages ?? 0;
        const freed = ev.freedTokens ?? 0;
        setEntries((p) => {
          // Find the last known tokensIn so we can synthesize a post-compact
          // context_usage entry. useContextBudget scans entries in reverse for
          // turn_summary or context_usage; without this entry the ring stays
          // at the pre-compact value even though history was trimmed.
          let lastKnownTokens = 0;
          for (let i = p.length - 1; i >= 0; i--) {
            const e = p[i];
            if (e?.kind === "turn_summary" || e?.kind === "context_usage") {
              lastKnownTokens = e.tokensIn;
              break;
            }
          }
          const postCompactTokens = Math.max(0, lastKnownTokens - freed);
          return [
            ...p,
            {
              kind: "checkpoint",
              removedMessages: removed,
              freedTokens: freed,
              ...(ev.tier ? { tier: ev.tier } : {}),
              ...(ev.summary ? { summary: ev.summary } : {}),
              ...(ev.compactNum !== undefined ? { compactNum: ev.compactNum } : {}),
            },
            // Synthetic usage carrier so contextOverflowPct drops immediately
            // after compact. Source tag distinguishes this from a live
            // provider-reported turn_summary.
            {
              kind: "context_usage" as const,
              tokensIn: postCompactTokens,
              source: "session-estimate" as const,
            },
          ];
        });
      } else if (ev.type === "done") {
        if (debugStreamEnabled) {
          debugLog("stream", "done:enter", {
            accStream: streamRef.current.length,
            accThought: thoughtRef.current.length,
            route: ev.route,
          });
        }
        // Overlay trigger import flow — close the card's streaming indicator.
        // Independent of the regular streaming-assistant finalize; the
        // card may have absorbed every text_delta of this turn so
        // streamRef.current can be empty even though the card has
        // content to seal.
        setEntries((p) =>
          finalizeImportedTriggerResponse(p, (response) => detectFromStream(response).cleanedText),
        );
        if (streamRef.current || thoughtRef.current) {
          const doneRoute = ev.route;
          // §PR-3: strip <title>...</title> and [checkpoint] markers
          // that may have been streamed as raw deltas before post-turn cleanup.
          const detected = detectFromStream(streamRef.current);
          const finalText = visibleAssistantText(detected.cleanedText);
          if (debugStreamEnabled) {
            debugLog("stream", "done:detect", {
              rawLen: streamRef.current.length,
              cleanedLen: detected.cleanedText.length,
              usedFinalLen: finalText.length,
              newTitle: detected.newTitle,
              checkpointSuggested: detected.checkpointSuggested,
            });
          }
          setEntries((p) => {
            const base = p;
            let next = finalizeStreamingReasoning(base, thoughtRef.current);
            next = finalizeStreamingAssistant(
              next,
              finalText,
              doneRoute ? { route: doneRoute, overrideText: finalText } : { overrideText: finalText },
            );
            if (debugStreamEnabled) {
              debugLog("stream", "done:finalized", {
                kinds: next.map((e) => e.kind).join(","),
                total: next.length,
              });
            }
            return next;
          });
          streamRef.current = "";
          thoughtRef.current = "";
        } else {
          setEntries((p) => dropPendingLlmStatusAssistant(p));
          if (debugStreamEnabled) {
            debugLog("stream", "done:skip-finalize", {
              reason: "streamRef and thoughtRef both empty",
            });
          }
        }
        activeStreamIdRef.current = null;
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

  /**
   * Plugin overlay confirm → main chat insert.
   *
   * Inserts an imported_trigger entry (kind="imported_trigger") so the
   * plugin-authored prompt is visible in chat history with proper overlay-trigger
   * provenance — NOT as a plain user bubble. The user's next send turn (or
   * an auto-fired handleAsk) will pick up from there.
   *
   * Conservative default: user message inserted, auto-turn NOT started.
   * The caller (App.tsx handlePluginPrimaryAction) decides whether to also
   * call handleAsk with the prompt.
   */
  const insertImportedTriggerEntry = useCallback(
    (input: {
      sessionId: string;
      pluginId: string;
      prompt: string;
      summary: string;
      title: string;
    }) => {
      setEntries((p) =>
        appendImportedTriggerEntry(p, {
          sessionId: input.sessionId,
          source: `plugin:${input.pluginId}`,
          prompt: input.prompt,
          summary: input.summary,
          toolCallCount: 0,
          importedAt: new Date().toISOString(),
        }),
      );
    },
    [],
  );

  /**
   * Close any open imported_trigger card without surfacing an error.
   * Used by App's handleAsk catch path: a `chatSend` rejection (network
   * fail, abort) would otherwise leave the card's streaming spinner
   * spinning forever — the `done` event never lands so the normal
   * finalize doesn't fire. The error message itself surfaces via the
   * regular setAssistantError sibling path.
   */
  const closeOpenImportedTrigger = useCallback(() => {
    setEntries((p) => finalizeImportedTriggerResponse(p));
  }, []);

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
    if (isDebugStreamEnabled()) {
      debugLog("stream", "BEGIN", {
        requestId,
        currentRef: streamingRequestRef.current,
      });
    }
    setStreaming(true);
    return requestId;
  }, []);

  const finishStreamingRequest = useCallback((requestId: number) => {
    const match = streamingRequestRef.current === requestId;
    if (isDebugStreamEnabled()) {
      debugLog("stream", "FINISH", {
        requestId,
        currentRef: streamingRequestRef.current,
        match,
        action: match ? "setStreaming(false)" : "ignored-stale",
      });
    }
    if (match) {
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
  }, []);

  // Used by handleAsk error path to show an error bubble with the current thought.
  const setErrorWithThought = useCallback((message: string) => {
    setEntries((p) => setAssistantError(p, message, thoughtRef.current));
    streamRef.current = "";
    thoughtRef.current = "";
    activeStreamIdRef.current = null;
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
  }, []);

  const appendUserMessage = useCallback((content: string): void => {
    setEntries((p) => appendUserEntry(p, content));
  }, []);

  const appendAssistantStatus = useCallback((content: string): void => {
    setEntries((p) => upsertStreamingAssistant(p, content));
  }, []);

  const appendSystemEntry = useCallback((text: string): void => {
    if (text.length === 0) return;
    setEntries((p) => [...p, { kind: "system", text }]);
  }, []);

  const applyLoadedSession = useCallback((loaded: ChatEntry[]) => {
    setEntries(loaded);
  }, []);

  const applyInitialSession = useCallback((loaded: ChatEntry[]) => {
    setEntries((current) => (current.length === 0 ? loaded : current));
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
    appendAssistantStatus,
    appendSystemEntry,
    applyInitialSession,
    applyLoadedSession,
    truncateToEntry,
    // Trigger import methods.
    addImportedTriggerEntry,
    closeOpenImportedTrigger,
    insertImportedTriggerEntry,
  };
}

function visibleAssistantText(text: string): string {
  // Return the cleaned text as-is, or "" for marker-only / tool-only rounds.
  // Never return a user-visible placeholder — finalizeStreamingAssistant
  // decides whether to preserve or splice the entry based on surrounding
  // context (tool_group / checkpoint siblings), not on placeholder text.
  return text.trim().length > 0 ? text : "";
}

function formatLlmStatusMessage(ev: {
  phase?: "attempt" | "retry" | "fallback";
  label?: string;
  attempt?: number;
  maxAttempts?: number;
  from?: string;
  to?: string;
}): string {
  if (ev.phase === "fallback") {
    const to = ev.to ? ` (${ev.to})` : "";
    return `생각 중... 기본 모델 응답이 지연되어 백업 모델로 전환 중입니다${to}.`;
  }
  if (ev.phase === "retry") {
    const attempt = ev.attempt ?? 1;
    const max = ev.maxAttempts ?? 5;
    return `생각 중... 모델 응답이 지연되어 재시도 중입니다. (${attempt}/${max})`;
  }
  if (ev.phase === "attempt") {
    const attempt = ev.attempt ?? 1;
    const max = ev.maxAttempts ?? 5;
    return attempt <= 1
      ? "생각 중..."
      : `생각 중... 모델 응답을 다시 기다리는 중입니다. (${attempt}/${max})`;
  }
  return "";
}

function dropPendingLlmStatusAssistant(entries: ChatEntry[]): ChatEntry[] {
  let idx = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (
      entry.kind === "assistant" &&
      entry.streaming === true &&
      isLlmStatusAssistantText(entry.text)
    ) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return entries;
  return [...entries.slice(0, idx), ...entries.slice(idx + 1)];
}

function isLlmStatusAssistantText(text: string): boolean {
  return text === "생각 중..." || text.startsWith("생각 중... ");
}

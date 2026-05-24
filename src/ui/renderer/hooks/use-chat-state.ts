import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  appendImportedTriggerEntry,
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  dropPermissionReviewEntries,
  finalizeStreamingAssistant,
  finalizeStreamingReasoning,
  setAssistantError,
  upsertPermissionReview,
  upsertStreamingAssistant,
  upsertStreamingReasoning,
  type ChatEntry,
} from "../../../lib/chat-stream-state.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import { debugLog, isDebugStreamEnabled } from "../../../lib/debug-stream.js";
import { isLLMVendor } from "../../../shared/llm-vendor-defaults.js";
import type { LvisApi } from "../types.js";
import { DEFAULT_TOAST_TTL_MS } from "../constants.js";

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
  /** True while a pre-turn auto-compact is running. */
  const [isCompacting, setIsCompacting] = useState(false);
  /** triggerSource of the most recent compact_started event — used to render
   *  the force-recover OFF-override banner (#916). Reset to null on compact_notice / done. */
  const [compactTriggerSource, setCompactTriggerSource] = useState<"estimate" | "context-tokens" | "manual" | "force-recover" | null>(null);
  /** True once recovery_exhausted fires — compact cannot reduce context (#917).
   *  Cleared on clearForNewChat. */
  const [isRecoveryExhausted, setIsRecoveryExhausted] = useState(false);
  const streamRef = useRef("");
  const thoughtRef = useRef("");
  const activeStreamIdRef = useRef<number | null>(null);
  const streamingRequestRef = useRef(0);

  const [editingEntryIdx, setEditingEntryIdx] = useState<number | null>(null);
  const [editBusy, setEditBusy] = useState(false);

  // Guard against setState after unmount.
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
    const handleStreamEvent = (ev: Parameters<Parameters<typeof api.onChatStream>[0]>[0]) => {
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
        // 사용자 피드백 (2026-05-15): system entry → user bubble + 작은 hint 배지.
        const text = typeof ev.text === "string" ? ev.text : "";
        if (text.length === 0) return;
        setEntries((p) => [...p, { kind: "user", text, injectHint: "queue", createdAt: Date.now() }]);
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
          const base = p;
          return upsertStreamingAssistant(base, message);
        });
      } else if (ev.type === "text_delta" && ev.text) {
        setEntries((p) => {
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
      } else if (
        ev.type === "permission_review" &&
        ev.reviewStatus &&
        ev.name &&
        ev.groupId &&
        ev.toolUseId !== undefined
      ) {
        const {
          reviewStatus,
          name,
          toolCategory,
          source,
          groupId,
          toolUseId,
          displayOrder = 0,
          verdictLevel,
          reason,
          approvalPurpose,
        } = ev;
        setEntries((p) =>
          upsertPermissionReview(dropPendingLlmStatusAssistant(p), {
            status: reviewStatus,
            toolName: name,
            groupId,
            toolUseId,
            displayOrder,
            ...(toolCategory ? { toolCategory } : {}),
            ...(source ? { source } : {}),
            ...(verdictLevel ? { verdictLevel } : {}),
            ...(reason ? { reason } : {}),
            ...(approvalPurpose ? { approvalPurpose } : {}),
          }),
        );
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
        const { groupId, toolUseId, displayOrder = 0, name, input, source, toolCategory, pluginId, mcpServerId } = ev;
        setEntries((p) =>
          applyToolStart(
            dropPermissionReviewEntries(dropPendingLlmStatusAssistant(p), { groupId, toolUseId }),
            {
              groupId,
              toolUseId,
              displayOrder,
              name,
              input,
              ...(source ? { source } : {}),
              ...(toolCategory ? { category: toolCategory } : {}),
              ...(pluginId ? { pluginId } : {}),
              ...(mcpServerId ? { mcpServerId } : {}),
            },
          ),
        );
      } else if (ev.type === "tool_end" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, result, isError, uiPayload, durationMs, source, toolCategory, pluginId, mcpServerId } = ev;
        setEntries((p) => applyToolEnd(p, {
          groupId,
          toolUseId,
          result,
          isError,
          uiPayload,
          durationMs,
          ...(source ? { source } : {}),
          ...(toolCategory ? { category: toolCategory } : {}),
          ...(pluginId ? { pluginId } : {}),
          ...(mcpServerId ? { mcpServerId } : {}),
        }));
      } else if (ev.type === "error") {
        // LLM compact may have started but thrown — clear the indicator
        // so the StatusBar item doesn't stick when compact_notice never arrives.
        setIsCompacting(false);
        setEntries((p) =>
          setAssistantError(
            dropPermissionReviewEntries(p),
            `오류: ${ev.error || "알 수 없는 오류"}`,
            thoughtRef.current,
            ev.systemNotice,
          ),
        );
        streamRef.current = "";
        thoughtRef.current = "";
        activeStreamIdRef.current = null;
      } else if (ev.type === "redact_notice") {
        // user draft 에서 PII 가 리댁트되었음을 알리는 시스템 배지.
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
        const summary = parseTurnSummaryEvent(ev);
        if (!summary) {
          console.warn("Malformed turn_summary stream event ignored", ev);
          return;
        }
        setEntries((p) => [
          ...p,
          {
            kind: "turn_summary",
            ...summary,
            ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
            ...(ev.cacheWriteTokens !== undefined ? { cacheWriteTokens: ev.cacheWriteTokens } : {}),
            ...(summary.vendorProvider !== undefined ? { vendorProvider: summary.vendorProvider } : {}),
            ...(summary.vendorModel !== undefined ? { vendorModel: summary.vendorModel } : {}),
            ...(ev.breakdown ? { breakdown: ev.breakdown } : {}),
          },
        ]);
      } else if (ev.type === "compact_started") {
        // Pre-turn auto-compact started — show a transient "자동 압축 중..." hint.
        // Cleared when `compact_notice` (completion) arrives.
        setIsCompacting(true);
        // Capture triggerSource so ChatView/App can show distinct banner for
        // force-recover (autoCompact OFF-override) vs normal compact (#916).
        setCompactTriggerSource(ev.triggerSource ?? null);
      } else if (ev.type === "recovery_exhausted") {
        // Issue #917 — force-recover budget consumed; compact cannot reduce context.
        setIsRecoveryExhausted(true);
      } else if (ev.type === "compact_notice") {
        // Compact completed — clear the in-progress indicator.
        setIsCompacting(false);
        setCompactTriggerSource(null);
        // Emit a structured `kind: "checkpoint"` entry so ChatView can render
        // a consistent checkpoint divider instead of string-matching prose.
        const removed = ev.removedMessages ?? 0;
        const freed = ev.freedTokens ?? 0;
        const estimatedAfter = ev.estimatedAfter;
        setEntries((p) => {
          const hasReliableAfter = typeof estimatedAfter === "number" && estimatedAfter >= 0;
          const checkpointEntry = {
            kind: "checkpoint" as const,
            removedMessages: removed,
            freedTokens: freed,
            ...(ev.trigger ? { trigger: ev.trigger } : {}),
            ...(ev.summary ? { summary: ev.summary } : {}),
            ...(ev.compactNum !== undefined ? { compactNum: ev.compactNum } : {}),
            ...(ev.compactStatus !== undefined ? { compactStatus: ev.compactStatus } : {}),
            ...(ev.truncatedDir !== undefined ? { truncatedDir: ev.truncatedDir } : {}),
          };
          if (!hasReliableAfter) {
            return [...p, checkpointEntry];
          }
          return [
            ...p,
            checkpointEntry,
            {
              kind: "context_usage" as const,
              tokensIn: estimatedAfter,
              source: "compact-estimate" as const,
            },
          ];
        });
      } else if (ev.type === "done") {
        // Defensive clear — if compact started but compact_notice never
        // arrived (engine error path swallowed the throw), this prevents
        // the indicator from sticking forever.
        setIsCompacting(false);
        setCompactTriggerSource(null);
        if (debugStreamEnabled) {
          debugLog("stream", "done:enter", {
            accStream: streamRef.current.length,
            accThought: thoughtRef.current.length,
            route: ev.route,
          });
        }
        if (streamRef.current || thoughtRef.current) {
          const doneRoute = ev.route;
          // Strip <title>...</title> and [checkpoint] markers.
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
            const base = dropPermissionReviewEntries(p);
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
          setEntries((p) => dropPermissionReviewEntries(dropPendingLlmStatusAssistant(p)));
          if (debugStreamEnabled) {
            debugLog("stream", "done:skip-finalize", {
              reason: "streamRef and thoughtRef both empty",
            });
          }
        }
        activeStreamIdRef.current = null;
      }
    };
    const unsub = api.onChatStream(handleStreamEvent);

    // E2E test seam — only exposed when LVIS_DEV=1 (preload reads the env at
    // runtime, so the gate stays inert in packaged production builds where the
    // launcher never sets that flag). Playwright specs use this to inject
    // synthetic tool_start / tool_end events without a live LLM provider.
    // NOTE: `__lvisDevMode` cannot be used as the gate here — esbuild inlines
    // NODE_ENV at preload bundle time, so that flag is always `false` in the
    // built app regardless of how the process is launched.
    const w = window as unknown as {
      lvis?: { env?: { isDev?: boolean } };
      __lvisChatStream?: { _emit: typeof handleStreamEvent };
    };
    if (w.lvis?.env?.isDev === true) {
      w.__lvisChatStream = { _emit: handleStreamEvent };
    }

    return () => {
      unsub();
      if (w.__lvisChatStream && w.__lvisChatStream._emit === handleStreamEvent) {
        delete w.__lvisChatStream;
      }
    };
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

  // Fallback toast — shown briefly when the LLM provider auto-switches.
  const [fallbackToast, setFallbackToast] = useState<string | null>(null);
  const fallbackToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const unsub = api.onChatFallback(({ from, to }) => {
      if (!aliveRef.current) return;
      if (fallbackToastTimerRef.current) clearTimeout(fallbackToastTimerRef.current);
      setFallbackToast(`⚡ ${from}→${to} 자동 전환`);
      fallbackToastTimerRef.current = setTimeout(() => setFallbackToast(null), DEFAULT_TOAST_TTL_MS);
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
        setEntries((p) => [...p.slice(0, entryIdx), { kind: "user", text: newText, createdAt: Date.now() }]);
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
    // New chat: any prior session's in-flight compact indicator is stale.
    setIsCompacting(false);
    setCompactTriggerSource(null);
    setIsRecoveryExhausted(false);
  }, []);

  const appendUserMessage = useCallback((content: string, injectHint?: "queue" | "interrupt"): void => {
    setEntries((p) => appendUserEntry(p, content, injectHint));
  }, []);

  const appendAssistantStatus = useCallback((content: string): void => {
    setEntries((p) => upsertStreamingAssistant(p, content));
  }, []);

  const handleContinueFromLastUser = useCallback(async (sessionId: string) => {
    const requestId = beginStreamingRequest();
    streamRef.current = "";
    thoughtRef.current = "";
    activeStreamIdRef.current = null;
    appendAssistantStatus("이 지점부터 다시 시작했습니다. 마지막 질문에 대한 답변을 이어서 생성합니다.");
    try {
      const res = await api.chatContinueLastUser(sessionId);
      if (!res?.ok) {
        setErrorWithThought(`이어 생성 실패: ${res?.error ?? "알 수 없는 오류"}`);
      }
    } catch (err) {
      setErrorWithThought(`오류: ${(err as Error).message}`);
    } finally {
      finishStreamingRequest(requestId);
    }
  }, [api, beginStreamingRequest, finishStreamingRequest, appendAssistantStatus, setErrorWithThought]);

  const appendSystemEntry = useCallback((text: string): void => {
    if (text.length === 0) return;
    setEntries((p) => [...p, { kind: "system", text }]);
  }, []);

  const applyLoadedSession = useCallback((loaded: ChatEntry[]) => {
    // Session switch: clear any in-flight compact indicator. If a compact
    // was running in the previous session, its compact_notice may never
    // arrive for this hook instance — the StatusBar hint would stick.
    setIsCompacting(false);
    setEntries(loaded);
  }, []);

  const applyInitialSession = useCallback((loaded: ChatEntry[]) => {
    setEntries((current) => (current.length === 0 ? loaded : current));
  }, []);

  const truncateToEntry = useCallback((entryIndex: number) => {
    // Edit/retry rewind drops history forward of `entryIndex`. If a pre-turn
    // compact was mid-flight, its `compact_notice` will land in a different
    // streaming context (or never arrive for this hook instance), so clear
    // the indicator here too — same class as applyLoadedSession / clearForNewChat.
    setIsCompacting(false);
    setEntries((p) => p.slice(0, entryIndex + 1));
  }, []);

  /**
   * B1 — /compact manual command handler.
   * Intercepts user messages starting with "/compact", calls IPC, then shows
   * a system banner with the result. Returns true if intercepted.
   */
  const handleCompactCommand = useCallback(
    async (input: string): Promise<boolean> => {
      if (!/^\/compact(?:\s|$)/.test(input.trimStart())) return false;
      try {
        const res = await api.chatCompact();
        const banner = res.compacted
          ? `대화 압축: ${res.removedMessageCount}개 메시지 요약됨`
          : res.summary;
        setEntries((p) => [...p, { kind: "system", text: banner }]);
      } catch (err) {
        setEntries((p) => [...p, { kind: "system", text: `압축 오류: ${(err as Error).message}` }]);
      } finally {
        setIsCompacting(false);
      }
      return true;
    },
    [api],
  );

  return {
    entries,
    streaming,
    setStreaming,
    isCompacting,
    compactTriggerSource,
    isRecoveryExhausted,
    beginStreamingRequest,
    finishStreamingRequest,
    editingEntryIdx,
    setEditingEntryIdx,
    editBusy,
    entryIndexToHistoryIndex,
    fallbackToast,
    handleEditSave,
    handleRetryEffort,
    handleContinueFromLastUser,
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

function parseTurnSummaryEvent(ev: Parameters<Parameters<LvisApi["onChatStream"]>[0]>[0]): Pick<
  Extract<ChatEntry, { kind: "turn_summary" }>,
  | "turnDurationMs"
  | "toolCount"
  | "cumulativeToolMs"
  | "tokensIn"
  | "freshInputTokens"
  | "tokensOut"
  | "vendorProvider"
  | "vendorModel"
  | "usageByModel"
> | null {
  if (ev.type !== "turn_summary") return null;
  const {
    turnDurationMs,
    toolCount,
    cumulativeToolMs,
    tokensIn,
    freshInputTokens,
    tokensOut,
    vendorProvider,
    vendorModel,
  } = ev;
  if (
    !isFiniteNonNegative(turnDurationMs) ||
    !isFiniteNonNegative(toolCount) ||
    !isFiniteNonNegative(cumulativeToolMs) ||
    !isFiniteNonNegative(tokensIn) ||
    !isFiniteNonNegative(freshInputTokens) ||
    !isFiniteNonNegative(tokensOut)
  ) {
    return null;
  }
  return {
    turnDurationMs,
    toolCount,
    cumulativeToolMs,
    tokensIn,
    freshInputTokens,
    tokensOut,
    ...(isLLMVendor(vendorProvider) ? { vendorProvider } : {}),
    ...(typeof vendorModel === "string" && vendorModel.length > 0 ? { vendorModel } : {}),
    ...(parseUsageByModel(ev.usageByModel) !== undefined
      ? { usageByModel: parseUsageByModel(ev.usageByModel) }
      : {}),
  };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseUsageByModel(value: unknown): Extract<ChatEntry, { kind: "turn_summary" }>["usageByModel"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.flatMap((segment) => {
    if (!segment || typeof segment !== "object") return [];
    const s = segment as {
      vendorProvider?: unknown;
      vendorModel?: unknown;
      tokenUsage?: {
        inputTokens?: unknown;
        outputTokens?: unknown;
        cacheReadTokens?: unknown;
        cacheWriteTokens?: unknown;
      };
    };
    if (!isLLMVendor(s.vendorProvider) || typeof s.vendorModel !== "string" || s.vendorModel.length === 0) return [];
    const usage = s.tokenUsage;
    if (
      !usage ||
      !isFiniteNonNegative(usage.inputTokens) ||
      !isFiniteNonNegative(usage.outputTokens)
    ) {
      return [];
    }
    return [{
      vendorProvider: s.vendorProvider,
      vendorModel: s.vendorModel,
      tokenUsage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(isFiniteNonNegative(usage.cacheReadTokens) ? { cacheReadTokens: usage.cacheReadTokens } : {}),
        ...(isFiniteNonNegative(usage.cacheWriteTokens) ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
      },
    }];
  });
  return parsed.length > 0 ? parsed : undefined;
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

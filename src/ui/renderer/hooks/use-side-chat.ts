/**
 * use-side-chat — a LIGHTWEIGHT side-chat controller hook that renders through
 * the SAME shared TranscriptRenderer as the main chat.
 *
 * Deliberately NOT built on the heavy main-chat ChatContext (~40 fields,
 * checkpoint/compact/fork/star machinery). Side chat is a compact second session
 * in the workspace rail, so this hook keeps ONLY what a minimal transcript needs:
 * a local `entries: ChatEntry[]` list, a `send`, `newSession`, `loadSession`,
 * `listSessions`, `isStreaming`, and `abort`.
 *
 * RENDER PARITY: the side channel already emits the full frame set
 * (`reasoning_delta` / `permission_review` / `tool_start` / `tool_end` /
 * `turn_summary` / `compact_notice` / `assistant_round` / `done`) via the shared
 * `runStreamedTurn`. This hook ports the main chat's ChatEntry reducer so tool
 * calls, thinking, and permission-review status cards render identically to the
 * main transcript. Backend is unchanged.
 *
 * ISOLATION: it subscribes to the DEDICATED `api.sideChat.onStream` channel —
 * NEVER `onChatStream` — so main-chat frames can never leak into this transcript
 * (and vice versa). The stale-frame guard (monotonic streamId adoption + drop of
 * superseded turns) and the unmount abort are preserved verbatim from the prior
 * lightweight hook; they gate on `event.streamId` (a number) BEFORE any reducer
 * runs, so they are orthogonal to the entry shape.
 *
 * Tool APPROVAL (blocking modal) is NOT handled here: the side loop shares the
 * host's global ApprovalGate, which broadcasts on the app-global
 * `lvis:approval:request` channel and surfaces in the main app-level
 * ApprovalDialog (App.tsx `useApproval`). Only the informational
 * `permission_review` STATUS card flows through this transcript.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../i18n/runtime.js";
import {
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
  type StreamEvent,
} from "../../../lib/chat-stream-state.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import { isLLMVendor } from "../../../shared/llm-vendor-defaults.js";
import { historyToEntries } from "../utils/history.js";
import { isTurnStartEntry } from "../utils/classify-turn-entries.js";
import type { TurnSummary } from "../components/TranscriptRenderer.js";
import type { LvisApi } from "../types.js";

export interface SideChatSessionSummary {
  id: string;
  modifiedAt: string;
  title: string;
}

export interface UseSideChat {
  entries: ChatEntry[];
  turnSummaryByTurnStart: Map<number, TurnSummary>;
  isStreaming: boolean;
  sessionId: string | null;
  send: (text: string) => Promise<void>;
  newSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  listSessions: () => Promise<{ current: string | null; sessions: SideChatSessionSummary[] }>;
  abort: () => Promise<void>;
}

export function useSideChat(api: LvisApi): UseSideChat {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);

  // Stream-accumulator refs — mirror the main hook so `assistant_round` / `done`
  // can finalize the streamed body / thought exactly as the main transcript does.
  const streamRef = useRef("");
  const thoughtRef = useRef("");
  // Final assistant text is canonical at assistant_round(end_turn). Later deltas
  // in the same stream are protocol tail noise, not a new response.
  const finalAssistantRoundClosedRef = useRef(false);

  // ── Isolation guard (unchanged from the lightweight hook) ──
  // Guards the reducer against stale frames after abort / new-session: only the
  // in-flight streamId is applied to the transcript. The main process allocates
  // the streamId monotonically (`++nextSideStreamId`), so the renderer cannot
  // know it at `send` time (the send invoke resolves only when the turn ENDS).
  // Instead the FIRST frame of a turn ADOPTS its streamId here; any later frame
  // whose streamId differs is from a superseded turn and is dropped. `send`
  // re-arms `activeStreamIdRef` to null so the next turn's first frame adopts the
  // new id; `done`/`error`/`abort`/`newSession`/`loadSession` clear it back.
  const activeStreamIdRef = useRef<number | null>(null);
  // Highest streamId ever adopted. Because main allocates ids monotonically, a
  // straggler frame from a JUST-FINISHED turn carries a LOWER id than the next
  // turn's — after a re-arm we must adopt only a strictly-greater id so such a
  // straggler can never be mistaken for the new turn's first frame.
  const maxStreamIdRef = useRef<number>(-1);
  // Mirror of `isStreaming` for the unmount teardown, which cannot read the
  // latest state directly without re-subscribing on every toggle.
  const isStreamingRef = useRef(false);
  isStreamingRef.current = isStreaming;

  // Reset the stream accumulators + re-arm the stale-frame guard. Called before
  // a new turn and when swapping sessions so a prior turn's residue never bleeds.
  const resetStreamState = useCallback(() => {
    streamRef.current = "";
    thoughtRef.current = "";
    finalAssistantRoundClosedRef.current = false;
    activeStreamIdRef.current = null;
  }, []);

  // Abort the in-flight turn when the view unmounts (e.g. switching workspace
  // tabs unmounts SideChatView). Without this the main-process side turn keeps
  // running orphaned — burning tokens and leaving frames that would land on the
  // NEXT mount's subscriber. Runs only on final unmount ([] deps), not on the
  // `api`-identity churn that re-runs the subscribe effect below.
  useEffect(() => {
    return () => {
      if (isStreamingRef.current) void api.sideChat?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Subscribe to the DEDICATED side-chat stream. The reducer is a port of the
  // main chat's stream reducer (use-chat-state.ts) so tool / reasoning /
  // permission-review render identically. The stale-frame guard runs FIRST,
  // before any reducer, so it stays orthogonal to the richer frame set.
  useEffect(() => {
    if (!api.sideChat) return;
    const handleSideStreamEvent = (event: StreamEvent) => {
      const streamId = typeof event.streamId === "number" ? event.streamId : null;
      if (streamId !== null) {
        if (activeStreamIdRef.current === null) {
          // Between turns: adopt this frame's streamId ONLY if it is newer than
          // any id we've already seen. A lower/equal id is a straggler from a
          // finished turn and is dropped (never adopted as the "new" turn).
          if (streamId <= maxStreamIdRef.current) return;
          activeStreamIdRef.current = streamId;
          maxStreamIdRef.current = streamId;
        } else if (streamId !== activeStreamIdRef.current) {
          // A frame from a superseded turn (aborted / replaced) is dropped.
          return;
        }
      }

      const ev = event;
      if (ev.type === "text_delta" && ev.text) {
        if (finalAssistantRoundClosedRef.current) return;
        const delta = ev.text;
        streamRef.current += delta;
        setEntries((p) => upsertStreamingAssistant(p, streamRef.current));
      } else if (ev.type === "reasoning_delta" && ev.text) {
        if (finalAssistantRoundClosedRef.current) return;
        thoughtRef.current += ev.text;
        setEntries((p) => upsertStreamingReasoning(p, thoughtRef.current));
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
          upsertPermissionReview(p, {
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
        const phase = ev.stopReason === "tool_use" || ev.hasToolCalls ? "work" : "final";
        if (finalAssistantRoundClosedRef.current) return;
        setEntries((p) => {
          let next = finalizeStreamingReasoning(p, ev.thought ?? thoughtRef.current);
          const rawText = ev.text || streamRef.current;
          const finalText = visibleText(detectFromStream(rawText).cleanedText);
          next = finalizeStreamingAssistant(next, finalText, { phase, overrideText: finalText });
          return next;
        });
        finalAssistantRoundClosedRef.current = phase === "final";
        streamRef.current = "";
        thoughtRef.current = "";
      } else if (ev.type === "tool_start" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, displayOrder = 0, name, input, source, toolCategory, pluginId, mcpServerId } = ev;
        setEntries((p) =>
          applyToolStart(dropPermissionReviewEntries(p, { groupId, toolUseId }), {
            groupId,
            toolUseId,
            displayOrder,
            name,
            input,
            ...(source ? { source } : {}),
            ...(toolCategory ? { category: toolCategory } : {}),
            ...(pluginId ? { pluginId } : {}),
            ...(mcpServerId ? { mcpServerId } : {}),
          }),
        );
      } else if (ev.type === "tool_end" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, result, isError, durationMs, source, toolCategory, pluginId, mcpServerId } = ev;
        setEntries((p) =>
          applyToolEnd(dropPermissionReviewEntries(p, { groupId, toolUseId }), {
            groupId,
            toolUseId,
            result,
            isError,
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...(source ? { source } : {}),
            ...(toolCategory ? { category: toolCategory } : {}),
            ...(pluginId ? { pluginId } : {}),
            ...(mcpServerId ? { mcpServerId } : {}),
          }),
        );
      } else if (ev.type === "turn_summary") {
        const summary = parseTurnSummaryEvent(ev);
        if (!summary) return;
        setEntries((p) => [
          ...p,
          {
            kind: "turn_summary",
            ...summary,
            ...(ev.cacheReadTokens !== undefined ? { cacheReadTokens: ev.cacheReadTokens } : {}),
            ...(ev.cacheWriteTokens !== undefined ? { cacheWriteTokens: ev.cacheWriteTokens } : {}),
          },
        ]);
      } else if (ev.type === "compact_notice") {
        // Side chat is a full ConversationLoop and CAN compact mid-conversation.
        // Emit the same checkpoint (+ context_usage) divider the main transcript
        // renders so a side compaction is not silently dropped.
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
          if (!hasReliableAfter) return [...p, checkpointEntry];
          return [
            ...p,
            checkpointEntry,
            { kind: "context_usage" as const, tokensIn: estimatedAfter, source: "compact-estimate" as const },
          ];
        });
      } else if (ev.type === "error") {
        setEntries((p) =>
          setAssistantError(
            dropPermissionReviewEntries(p),
            t("useChatState.errorPrefix", { error: ev.error || t("useChatState.unknownError") }),
            thoughtRef.current,
            ev.systemNotice,
          ),
        );
        setIsStreaming(false);
        resetStreamState();
      } else if (ev.type === "done") {
        if (finalAssistantRoundClosedRef.current) {
          setEntries((p) => dropPermissionReviewEntries(p));
        } else if (streamRef.current || thoughtRef.current) {
          const detected = detectFromStream(streamRef.current);
          const finalText = visibleText(detected.cleanedText);
          setEntries((p) => {
            const base = dropPermissionReviewEntries(p);
            let next = finalizeStreamingReasoning(base, thoughtRef.current);
            next = finalizeStreamingAssistant(next, finalText, { overrideText: finalText });
            return next;
          });
        } else {
          setEntries((p) => dropPermissionReviewEntries(p));
        }
        setIsStreaming(false);
        resetStreamState();
      }
    };
    const off = api.sideChat.onStream(handleSideStreamEvent);

    // E2E test seam — only exposed when LVIS_DEV=1 (same gate + rationale as the
    // main chat's `__lvisChatStream`). Playwright side-chat specs use this to
    // inject synthetic tool_start / tool_end / reasoning_delta frames onto the
    // DEDICATED side channel (no live LLM), proving the side transcript renders
    // through the shared TranscriptRenderer identically to the main transcript.
    // Inert in packaged production builds where the launcher never sets the flag.
    const w = window as unknown as {
      lvis?: { env?: { isDev?: boolean } };
      __lvisSideChatStream?: { _emit: typeof handleSideStreamEvent };
    };
    if (w.lvis?.env?.isDev === true) {
      w.__lvisSideChatStream = { _emit: handleSideStreamEvent };
    }

    return () => {
      off();
      if (w.__lvisSideChatStream && w.__lvisSideChatStream._emit === handleSideStreamEvent) {
        delete w.__lvisSideChatStream;
      }
    };
  }, [api, resetStreamState]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming || !api.sideChat) return;
      // Re-arm the stale-frame guard + clear accumulators: the next turn's first
      // frame adopts its freshly-allocated streamId (see activeStreamIdRef doc).
      resetStreamState();
      setEntries((prev) => [...prev, { kind: "user", text: trimmed, createdAt: Date.now() }]);
      setIsStreaming(true);
      // The main-window webContents receives the stream frames; the invoke
      // resolves with the final TurnResult (unused here — the transcript is built
      // from the stream). A rejected/failed result surfaces as an error entry so
      // the transcript never hangs on a permanent spinner.
      try {
        const result = await api.sideChat.send(trimmed);
        if (!result.ok) {
          setEntries((p) =>
            setAssistantError(dropPermissionReviewEntries(p), result.error, thoughtRef.current, "stream-error"),
          );
          setIsStreaming(false);
          resetStreamState();
        }
      } catch (err) {
        setEntries((p) =>
          setAssistantError(
            dropPermissionReviewEntries(p),
            (err as Error).message,
            thoughtRef.current,
            "stream-error",
          ),
        );
        setIsStreaming(false);
        resetStreamState();
      }
    },
    [api, isStreaming, resetStreamState],
  );

  const newSession = useCallback(async () => {
    if (!api.sideChat) return;
    const res = await api.sideChat.new();
    setEntries([]);
    setIsStreaming(false);
    resetStreamState();
    if (res.ok) setSessionId(res.sessionId);
  }, [api, resetStreamState]);

  const loadSession = useCallback(
    async (id: string) => {
      if (!api.sideChat) return;
      const res = await api.sideChat.load(id);
      setIsStreaming(false);
      resetStreamState();
      if (res.ok) {
        // Reconstruct the full ChatEntry[] from persisted history — the side loop
        // is a real ConversationLoop writing the same GenericMessage meta, so
        // historyToEntries rebuilds tool groups / turn summaries / checkpoints
        // verbatim, identical to the main session-load path.
        setEntries(historyToEntries(res.messages));
        setSessionId(res.sessionId);
      }
    },
    [api, resetStreamState],
  );

  const listSessions = useCallback(async () => {
    if (!api.sideChat) return { current: null, sessions: [] as SideChatSessionSummary[] };
    return api.sideChat.list();
  }, [api]);

  const abort = useCallback(async () => {
    if (!api.sideChat) return;
    await api.sideChat.abort();
    setEntries((p) => finalizeStreamingReasoning(dropPendingStreamingAssistant(p), thoughtRef.current));
    setIsStreaming(false);
    resetStreamState();
  }, [api, resetStreamState]);

  // Per-turn provider-usage lookup keyed by turn-start index — same derivation
  // as ChatView so the shared TranscriptRenderer's WorkGroup step-count /
  // TurnActionBar cost badge show the SIDE loop's own token/cost totals.
  const turnSummaryByTurnStart = useMemo(() => {
    const map = new Map<number, TurnSummary>();
    let curTurnStart = -1;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (!e) continue;
      if (isTurnStartEntry(e)) curTurnStart = i;
      else if (e.kind === "turn_summary" && curTurnStart >= 0) {
        map.set(curTurnStart, {
          turnDurationMs: e.turnDurationMs,
          toolCount: e.toolCount,
          cumulativeToolMs: e.cumulativeToolMs,
          tokensIn: e.tokensIn,
          freshInputTokens: e.freshInputTokens,
          tokensOut: e.tokensOut,
          ...(e.cacheReadTokens !== undefined ? { cacheReadTokens: e.cacheReadTokens } : {}),
          ...(e.cacheWriteTokens !== undefined ? { cacheWriteTokens: e.cacheWriteTokens } : {}),
          ...(e.vendorProvider !== undefined ? { vendorProvider: e.vendorProvider } : {}),
          ...(e.vendorModel !== undefined ? { vendorModel: e.vendorModel } : {}),
          ...(e.usageByModel !== undefined ? { usageByModel: e.usageByModel } : {}),
        });
      }
    }
    return map;
  }, [entries]);

  return { entries, turnSummaryByTurnStart, isStreaming, sessionId, send, newSession, loadSession, listSessions, abort };
}

function visibleText(text: string): string {
  return text.trim().length > 0 ? text : "";
}

// Drop a trailing still-streaming assistant entry on abort so it doesn't hang
// with a spinner (finalizeStreamingReasoning/Assistant then settle any thought).
function dropPendingStreamingAssistant(entries: ChatEntry[]): ChatEntry[] {
  const last = entries[entries.length - 1];
  if (last && last.kind === "assistant" && last.streaming === true && last.text.length === 0) {
    return entries.slice(0, -1);
  }
  return entries;
}

function parseTurnSummaryEvent(ev: StreamEvent): Pick<
  Extract<ChatEntry, { kind: "turn_summary" }>,
  | "turnDurationMs"
  | "toolCount"
  | "cumulativeToolMs"
  | "tokensIn"
  | "freshInputTokens"
  | "tokensOut"
  | "vendorProvider"
  | "vendorModel"
> | null {
  const e = ev;
  if (
    !isFiniteNonNegative(e.turnDurationMs) ||
    !isFiniteNonNegative(e.toolCount) ||
    !isFiniteNonNegative(e.cumulativeToolMs) ||
    !isFiniteNonNegative(e.tokensIn) ||
    !isFiniteNonNegative(e.freshInputTokens) ||
    !isFiniteNonNegative(e.tokensOut)
  ) {
    return null;
  }
  return {
    turnDurationMs: e.turnDurationMs,
    toolCount: e.toolCount,
    cumulativeToolMs: e.cumulativeToolMs,
    tokensIn: e.tokensIn,
    freshInputTokens: e.freshInputTokens,
    tokensOut: e.tokensOut,
    ...(isLLMVendor(e.vendorProvider) ? { vendorProvider: e.vendorProvider } : {}),
    ...(typeof e.vendorModel === "string" && e.vendorModel.length > 0 ? { vendorModel: e.vendorModel } : {}),
  };
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

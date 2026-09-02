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
 * INPUT PARITY: `send` follows the main composer's rule for a send that lands
 * while a turn is running — a user gesture interrupts (abort, then send); the
 * end-of-turn queue drain does not. The queue itself, and the keys that feed it
 * (Enter, ⌘⏎, Esc), are the shared `useMessageQueue` hook, not this one.
 *
 * RENDER PARITY: the side channel already emits the full frame set
 * (`reasoning_delta` / `permission_review` / `tool_start` / `tool_end` /
 * `turn_summary` / `compact_notice` / `assistant_round` / `done`) via the shared
 * `runStreamedTurn`. This hook applies the main chat's frame reducer
 * (`applyTranscriptFrame` / `applyReasoningDelta` in `lib/chat-stream-state`)
 * so tool calls, thinking, and permission-review status cards render
 * identically to the main transcript. Backend is unchanged.
 *
 * ISOLATION: it subscribes to the DEDICATED `api.sideChat.onStream` channel —
 * NEVER `onChatStream` — so main-chat frames can never leak into this transcript
 * (and vice versa). The stale-frame guard (monotonic streamId adoption + drop of
 * superseded turns) and the unmount abort are preserved verbatim from the prior
 * lightweight hook; they gate on `event.streamId` (a number) BEFORE any reducer
 * runs, so they are orthogonal to the entry shape.
 *
 * Tool APPROVAL is NOT handled here: the side loop shares the host's global
 * ApprovalGate, which broadcasts on the app-global `lvis:approval:request`
 * channel into the window's one queue (App.tsx `useApproval`). SideChatView
 * claims this loop's `sessionId` there and draws the card inside its own
 * panel. Only the informational `permission_review` STATUS card flows through
 * this transcript.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../../i18n/runtime.js";
import {
  applyReasoningDelta,
  applyTranscriptFrame,
  finalizeStreamingAssistant,
  finalizeStreamingReasoning,
  isTranscriptFrame,
  markTurnAssistantInterrupted,
  setAssistantError,
  upsertStreamingAssistant,
  type ChatEntry,
  type ChatStreamEvent,
} from "../../../lib/chat-stream-state.js";
import { detectFromStream } from "../../../lib/stream-markers.js";
import type { UserContentPart } from "../../../engine/llm/types.js";
import { formatIpcError } from "../format-ipc-error.js";
import { historyToEntries } from "../utils/history.js";
import { isTurnStartEntry } from "../utils/classify-turn-entries.js";
import type { TurnSummary } from "../components/TranscriptRenderer.js";
import type { LvisApi } from "../types.js";
import { errorMessage } from "../../../shared/error-message.js";

export interface SideChatSessionSummary {
  id: string;
  modifiedAt: string;
  title: string;
}

interface SideChatSendOptions {
  /** Vision / resource parts composed from the composer's attachments. */
  attachments?: UserContentPart[];
  /** Badge on the user bubble: a drained queue row, or an interrupting send. */
  injectHint?: "queue" | "interrupt";
  /**
   * `queue-auto` is the end-of-turn queue drain: it follows the turn that just
   * closed and must not stop anything. Every other send is the user's own
   * gesture (Enter when idle, ⌘⏎, Esc-inject, a row's "send now") and, when a
   * turn is still running, interrupts it first — the main composer's rule.
   */
  inputOrigin?: "queue-auto";
}

export interface UseSideChat {
  entries: ChatEntry[];
  turnSummaryByTurnStart: Map<number, TurnSummary>;
  isStreaming: boolean;
  sessionId: string | null;
  send: (text: string, opts?: SideChatSendOptions) => Promise<void>;
  newSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  listSessions: () => Promise<{ current: string | null; sessions: SideChatSessionSummary[] }>;
  abort: () => Promise<void>;
  /**
   * Stale-frame verdict for one side-chat stream frame, shared with every other
   * subscriber on this channel (the message queue) so they agree on which turn
   * a frame belongs to. Calling it ADOPTS the streamId of a turn's first frame,
   * which is idempotent for a given frame however many subscribers ask.
   */
  isCurrentTurnEvent: (event: ChatStreamEvent) => boolean;
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
  // whose streamId differs is from a superseded turn and is dropped.
  // `send` / `abort` / `newSession` / `loadSession` re-arm `activeStreamIdRef`
  // to null so the next turn's first frame adopts the new id. `done` and
  // `error` deliberately do NOT: a frame's verdict has to read the same for
  // every subscriber that asks about it during one dispatch, and the next
  // `send` re-arms before another turn can exist.
  const activeStreamIdRef = useRef<number | null>(null);
  // Highest streamId ever adopted. Because main allocates ids monotonically, a
  // straggler frame from a JUST-FINISHED turn carries a LOWER id than the next
  // turn's — after a re-arm we must adopt only a strictly-greater id so such a
  // straggler can never be mistaken for the new turn's first frame.
  const maxStreamIdRef = useRef<number>(-1);
  // Mirror of `isStreaming` for the unmount teardown and for `send`'s
  // interrupt check, neither of which can read the latest state directly. The
  // mirror used to be assigned during RENDER, which left it stale for every
  // reader that ran between a state change and the next commit — the window in
  // which a send that should interrupt decides it has nothing to interrupt.
  // `setStreaming` is the only writer of both, so they cannot diverge.
  const isStreamingRef = useRef(false);
  const setStreaming = useCallback((next: boolean) => {
    isStreamingRef.current = next;
    setIsStreaming(next);
  }, []);

  // Empty the stream accumulators. Says nothing about which turn is current —
  // frame handlers use this so that judging a frame stays a pure read of the
  // guard (see `isCurrentTurnEvent`).
  const resetStreamAccumulators = useCallback(() => {
    streamRef.current = "";
    thoughtRef.current = "";
    finalAssistantRoundClosedRef.current = false;
  }, []);

  // …and abandon the turn on top of that: the guard is re-armed so the NEXT
  // turn's first frame adopts its own streamId. Only the deliberate transitions
  // do this — starting a turn, stopping one, swapping sessions — never a frame
  // handler.
  const resetStreamState = useCallback(() => {
    resetStreamAccumulators();
    activeStreamIdRef.current = null;
  }, [resetStreamAccumulators]);

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

  // The stale-frame rule, and the SINGLE place a turn's streamId is adopted.
  // Returned from this hook so the shared message queue drains against the SAME
  // verdict: a second, independent copy of this rule would let a superseded
  // turn's trailing `done` (an aborted turn still emits one — `runStreamedTurn`
  // sends `turn.completed` on every return) drain a queued row into a fresh
  // send while the surviving turn is still running.
  //
  // Every subscriber on this channel asks about the same frame, one after the
  // other, and they must get the same answer. Two things make that hold:
  // adoption is the only mutation a frame can cause, and it is idempotent for a
  // frame that has already been adopted; and no FRAME HANDLER re-arms the guard
  // (`done` resets the accumulators only) — the deliberate transitions do, and
  // those never run inside a dispatch. Caching the answer by frame identity
  // would NOT work: the context bridge hands each subscriber its own copy.
  const isCurrentTurnEvent = useCallback(
    (event: ChatStreamEvent): boolean =>
      judgeStreamFrame(event, activeStreamIdRef, maxStreamIdRef),
    [],
  );

  // Subscribe to the DEDICATED side-chat stream. Frames reduce through the
  // reducer the main chat uses, so tool / reasoning / permission-review render
  // identically. The stale-frame guard runs FIRST, before any reducer, so it
  // stays orthogonal to the richer frame set.
  useEffect(() => {
    if (!api.sideChat) return;
    const handleSideStreamEvent = (event: ChatStreamEvent) => {
      if (!isCurrentTurnEvent(event)) return;

      const ev = event;
      if (ev.type === "text_delta" && ev.text) {
        if (finalAssistantRoundClosedRef.current) return;
        const delta = ev.text;
        streamRef.current += delta;
        setEntries((p) => upsertStreamingAssistant(p, streamRef.current));
      } else if (ev.type === "reasoning_delta" && ev.text) {
        if (finalAssistantRoundClosedRef.current) return;
        thoughtRef.current += ev.text;
        const thought = thoughtRef.current;
        setEntries((p) => applyReasoningDelta(p, thought));
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
      } else if (isTranscriptFrame(ev)) {
        setEntries((p) => applyTranscriptFrame(p, ev));
      } else if (ev.type === "error") {
        // Read the accumulated thought HERE, not inside the updater: React runs
        // the updater at flush time, by which point the synchronous
        // `resetStreamAccumulators()` below has already emptied the ref.
        const thought = thoughtRef.current;
        setEntries((p) =>
          setAssistantError(
            p,
            t("useChatState.errorPrefix", { error: ev.error || t("useChatState.unknownError") }),
            thought,
            ev.systemNotice,
          ),
        );
        setStreaming(false);
        resetStreamAccumulators();
      } else if (ev.type === "done") {
        if (!finalAssistantRoundClosedRef.current && (streamRef.current || thoughtRef.current)) {
          const detected = detectFromStream(streamRef.current);
          const finalText = visibleText(detected.cleanedText);
          const thought = thoughtRef.current;
          setEntries((p) => {
            let next = finalizeStreamingReasoning(p, thought);
            next = finalizeStreamingAssistant(next, finalText, { overrideText: finalText });
            return next;
          });
        }
        setStreaming(false);
        resetStreamAccumulators();
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
  }, [api, resetStreamAccumulators, isCurrentTurnEvent, setStreaming, t]);

  const abort = useCallback(async () => {
    if (!api.sideChat) return;
    // Abandon the turn BEFORE the round trip, not after it. The host settles the
    // turn while this call is in flight, and an aborted turn still emits a
    // trailing `done` — `runStreamedTurn` sends `turn.completed` on every
    // return — so that frame lands DURING the await. Re-arming the guard
    // afterwards left a window in which the frame still read as the current
    // turn's, and the message queue drained a row into a new turn on top of the
    // one the interrupt was about to start.
    //
    // The answer that was cut short keeps what it streamed and wears the
    // interrupted badge, exactly as the main transcript marks a stopped turn; an
    // answer that had not produced a byte yet is dropped rather than left as an
    // empty bubble with a spinner. The thought is read here, not inside the
    // updater, because the reset empties the ref synchronously while React
    // flushes the updater later.
    const thought = thoughtRef.current;
    resetStreamState();
    setStreaming(false);
    setEntries((p) =>
      markTurnAssistantInterrupted(
        finalizeStreamingReasoning(dropPendingStreamingAssistant(p), thought),
      ),
    );
    // Awaited last: an interrupting send goes out immediately after this
    // resolves, and the host refuses a send while its turn is still in flight.
    //
    // Reported, not thrown. By this point the interrupt is committed on both
    // sides — the composer cleared the draft before calling and the transcript
    // already marks the answer stopped — so letting a transport failure escape
    // would destroy the text the user typed and strand the host turn, still
    // streaming into frames this hook now drops. The send goes out either way;
    // if the host really is still busy it refuses that send with its own
    // message.
    try {
      await api.sideChat.abort();
    } catch (err) {
      setEntries((p) => setAssistantError(p, errorMessage(err), "", "stream-error"));
    }
  }, [api, resetStreamState, setStreaming]);

  const send = useCallback(
    async (text: string, opts?: SideChatSendOptions) => {
      const trimmed = text.trim();
      if (!api.sideChat) return;
      if (!trimmed && !(opts?.attachments && opts.attachments.length > 0)) return;
      // A user gesture while a turn is running is an interrupt: stop the running
      // turn and wait for it to settle before the new one goes out, so its
      // closing frames cannot land on the new turn's transcript. The side channel
      // has no `interrupt` flag on send, so the abort is its own round trip.
      if (isStreamingRef.current && opts?.inputOrigin !== "queue-auto") {
        await abort();
      }
      // What the stream state held before this send re-armed it. A send the
      // host REFUSES creates no turn, so the re-arm has to be undone: whatever
      // turn was streaming is still streaming there, and a guard left re-armed
      // drops the rest of its frames for good — their ids are no longer above
      // the high-water mark, so they can never be adopted again.
      const streamStateBeforeSend = {
        activeStreamId: activeStreamIdRef.current,
        stream: streamRef.current,
        thought: thoughtRef.current,
        finalAssistantRoundClosed: finalAssistantRoundClosedRef.current,
      };
      // Re-arm the stale-frame guard + clear accumulators: the next turn's first
      // frame adopts its freshly-allocated streamId (see activeStreamIdRef doc).
      resetStreamState();
      setEntries((prev) => [
        ...prev,
        {
          kind: "user",
          text: trimmed,
          createdAt: Date.now(),
          ...(opts?.injectHint ? { injectHint: opts.injectHint } : {}),
        },
      ]);
      setStreaming(true);
      // The main-window webContents receives the stream frames; the invoke
      // resolves with the final TurnResult (unused here — the transcript is built
      // from the stream). A rejected/failed result surfaces as an error entry so
      // the transcript never hangs on a permanent spinner.
      try {
        const result = await api.sideChat.send(trimmed, opts?.attachments);
        if (!result.ok) {
          // Localized, not the raw code: this hook used to put the kebab-case string
          // straight in the transcript, so a Korean user tripping a bound read
          // `too-many-resource-attachments`. Main chat already resolves codes through
          // the same map; side chat is the same transcript to the person reading it.
          const thought = thoughtRef.current;
          setEntries((p) =>
            setAssistantError(
              p,
              formatIpcError(result.error, undefined),
              thought,
              "stream-error",
            ),
          );
          setStreaming(false);
          // The handler returned a verdict, so we know no turn was started.
          activeStreamIdRef.current = streamStateBeforeSend.activeStreamId;
          streamRef.current = streamStateBeforeSend.stream;
          thoughtRef.current = streamStateBeforeSend.thought;
          finalAssistantRoundClosedRef.current = streamStateBeforeSend.finalAssistantRoundClosed;
        }
      } catch (err) {
        // Left raw on purpose: this branch is a transport failure, not a handler code
        // (the handler returns `{ ok: false, error }` above for those), so there is
        // nothing to look up and the message is the only diagnostic.
        const thought = thoughtRef.current;
        setEntries((p) =>
          setAssistantError(
            p,
            errorMessage(err),
            thought,
            "stream-error",
          ),
        );
        setStreaming(false);
        // Left re-armed on purpose, unlike the refusal above: the invoke never
        // returned a verdict, so the host may well have started a turn, and its
        // first frame needs a guard that can adopt it.
        resetStreamState();
      }
    },
    [api, abort, resetStreamState, setStreaming],
  );

  const newSession = useCallback(async () => {
    if (!api.sideChat) return;
    // Same window as `abort`: the host stops its in-flight turn during this
    // call, and that turn's trailing frames must not be read as belonging to the
    // session about to be opened.
    resetStreamState();
    setStreaming(false);
    setEntries([]);
    const res = await api.sideChat.new();
    if (res.ok) setSessionId(res.sessionId);
  }, [api, resetStreamState, setStreaming]);

  const loadSession = useCallback(
    async (id: string) => {
      if (!api.sideChat) return;
      // Same window as `new`.
      resetStreamState();
      setStreaming(false);
      const res = await api.sideChat.load(id);
      if (res.ok) {
        // Reconstruct the full ChatEntry[] from persisted history — the side loop
        // is a real ConversationLoop writing the same GenericMessage meta, so
        // historyToEntries rebuilds tool groups / turn summaries / checkpoints
        // verbatim, identical to the main session-load path.
        setEntries(historyToEntries(res.messages));
        setSessionId(res.sessionId);
      }
    },
    [api, resetStreamState, setStreaming],
  );

  const listSessions = useCallback(async () => {
    if (!api.sideChat) return { current: null, sessions: [] as SideChatSessionSummary[] };
    return api.sideChat.list();
  }, [api]);

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

  return {
    entries,
    turnSummaryByTurnStart,
    isStreaming,
    sessionId,
    send,
    newSession,
    loadSession,
    listSessions,
    abort,
    isCurrentTurnEvent,
  };
}

/**
 * Does this frame belong to the turn currently on screen? Adopting is part of
 * the answer: the main process allocates side-chat stream ids monotonically and
 * the renderer cannot know a turn's id at `send` time (the invoke resolves only
 * when the turn ENDS), so a turn's FIRST frame is what establishes it.
 */
function judgeStreamFrame(
  event: ChatStreamEvent,
  activeStreamId: { current: number | null },
  maxStreamId: { current: number },
): boolean {
  const streamId = typeof event.streamId === "number" ? event.streamId : null;
  if (streamId === null) return true;
  if (activeStreamId.current === null) {
    // Between turns: adopt this frame's streamId ONLY if it is newer than any
    // id we have already seen. A lower/equal id is a straggler from a finished
    // turn and is dropped (never adopted as the "new" turn).
    if (streamId <= maxStreamId.current) return false;
    activeStreamId.current = streamId;
    maxStreamId.current = streamId;
    return true;
  }
  // A frame from a superseded turn (aborted / replaced) is dropped.
  return streamId === activeStreamId.current;
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

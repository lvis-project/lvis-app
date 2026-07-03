/**
 * use-side-chat — a LIGHTWEIGHT side-chat controller hook.
 *
 * Deliberately NOT built on the heavy main-chat ChatContext (~40 fields,
 * checkpoint/compact/fork/star machinery). Side chat is a compact second session
 * in the workspace rail, so this hook keeps ONLY what a minimal transcript needs:
 * a local `messages` list, a `send`, a `newSession`, `isStreaming`, and `abort`.
 *
 * It subscribes to the DEDICATED `api.sideChat.onStream` channel — NEVER
 * `onChatStream` — so main-chat frames can never leak into this transcript (and
 * vice versa). The reducer here handles only the frame kinds a plain transcript
 * needs (`text_delta`, `assistant_round`, `error`, `done`); it does not share the
 * main chat's module-singleton scroll store.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatEntry, StreamEvent } from "../../../lib/chat-stream-state.js";
import type { LvisApi } from "../types.js";

export type SideChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming?: boolean; systemNotice?: "context-error" | "stream-error" };

/**
 * Map a lightweight SideChatEntry to the ChatEntry shape AssistantCard consumes.
 * Only assistant entries flow through AssistantCard; user entries render as a
 * plain bubble in the view.
 */
export function toAssistantChatEntry(
  entry: Extract<SideChatEntry, { kind: "assistant" }>,
): Extract<ChatEntry, { kind: "assistant" }> {
  return {
    kind: "assistant",
    text: entry.text,
    ...(entry.streaming ? { streaming: true } : {}),
    ...(entry.systemNotice ? { systemNotice: entry.systemNotice } : {}),
  };
}

export interface UseSideChat {
  messages: SideChatEntry[];
  isStreaming: boolean;
  sessionId: string | null;
  send: (text: string) => Promise<void>;
  newSession: () => Promise<void>;
  abort: () => Promise<void>;
}

export function useSideChat(api: LvisApi): UseSideChat {
  const [messages, setMessages] = useState<SideChatEntry[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  // Guards the reducer against stale frames after abort / new-session: only the
  // in-flight streamId is applied to the transcript. The main process allocates
  // the streamId monotonically (`++nextSideStreamId`), so the renderer cannot
  // know it at `send` time (the send invoke resolves only when the turn ENDS).
  // Instead the FIRST frame of a turn ADOPTS its streamId here; any later frame
  // whose streamId differs is from a superseded turn and is dropped. `send`
  // re-arms `activeStreamIdRef` to null so the next turn's first frame adopts the
  // new id; `done`/`error`/`abort`/`newSession` clear it back to null.
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

  // Subscribe to the DEDICATED side-chat stream. Reducer appends/updates the
  // trailing streaming assistant entry.
  useEffect(() => {
    if (!api.sideChat) return;
    const off = api.sideChat.onStream((event: StreamEvent) => {
      if (typeof event.streamId === "number") {
        if (activeStreamIdRef.current === null) {
          // Between turns: adopt this frame's streamId ONLY if it is newer than
          // any id we've already seen. A lower/equal id is a straggler from a
          // finished turn and is dropped (never adopted as the "new" turn).
          if (event.streamId <= maxStreamIdRef.current) return;
          activeStreamIdRef.current = event.streamId;
          maxStreamIdRef.current = event.streamId;
        } else if (event.streamId !== activeStreamIdRef.current) {
          // A frame from a superseded turn (aborted / replaced) is dropped.
          return;
        }
      }
      if (event.type === "text_delta" && typeof event.text === "string") {
        const delta = event.text;
        setMessages((prev) => appendAssistantDelta(prev, delta));
        return;
      }
      if (event.type === "error") {
        const text = typeof event.error === "string" ? event.error : "stream-error";
        setMessages((prev) => finalizeAssistant(prev, text, event.systemNotice ?? "stream-error"));
        setIsStreaming(false);
        activeStreamIdRef.current = null;
        return;
      }
      if (event.type === "done") {
        setMessages((prev) => stopStreaming(prev));
        setIsStreaming(false);
        activeStreamIdRef.current = null;
      }
    });
    return off;
  }, [api]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming || !api.sideChat) return;
      // Re-arm the stale-frame guard: the next turn's first frame adopts its
      // freshly-allocated streamId (see activeStreamIdRef doc).
      activeStreamIdRef.current = null;
      setMessages((prev) => [
        ...prev,
        { kind: "user", text: trimmed },
        { kind: "assistant", text: "", streaming: true },
      ]);
      setIsStreaming(true);
      // The main-window webContents receives the stream frames; the invoke
      // resolves with the final TurnResult (unused here — the transcript is
      // built from the stream). A rejected/failed result surfaces as an error
      // entry so the transcript never hangs on a permanent spinner.
      try {
        const result = await api.sideChat.send(trimmed);
        if (!result.ok) {
          setMessages((prev) => finalizeAssistant(prev, result.error, "stream-error"));
          setIsStreaming(false);
          activeStreamIdRef.current = null;
        }
      } catch (err) {
        setMessages((prev) =>
          finalizeAssistant(prev, (err as Error).message, "stream-error"),
        );
        setIsStreaming(false);
        activeStreamIdRef.current = null;
      }
    },
    [api, isStreaming],
  );

  const newSession = useCallback(async () => {
    if (!api.sideChat) return;
    const res = await api.sideChat.new();
    setMessages([]);
    setIsStreaming(false);
    activeStreamIdRef.current = null;
    if (res.ok) setSessionId(res.sessionId);
  }, [api]);

  const abort = useCallback(async () => {
    if (!api.sideChat) return;
    await api.sideChat.abort();
    setMessages((prev) => stopStreaming(prev));
    setIsStreaming(false);
    activeStreamIdRef.current = null;
  }, [api]);

  return { messages, isStreaming, sessionId, send, newSession, abort };
}

function appendAssistantDelta(prev: SideChatEntry[], delta: string): SideChatEntry[] {
  const last = prev[prev.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [
      ...prev.slice(0, -1),
      { ...last, text: last.text + delta },
    ];
  }
  return [...prev, { kind: "assistant", text: delta, streaming: true }];
}

function stopStreaming(prev: SideChatEntry[]): SideChatEntry[] {
  const last = prev[prev.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [...prev.slice(0, -1), { ...last, streaming: false }];
  }
  return prev;
}

function finalizeAssistant(
  prev: SideChatEntry[],
  text: string,
  systemNotice: "context-error" | "stream-error",
): SideChatEntry[] {
  const last = prev[prev.length - 1];
  if (last && last.kind === "assistant" && last.streaming) {
    return [
      ...prev.slice(0, -1),
      { kind: "assistant", text: last.text || text, streaming: false, systemNotice },
    ];
  }
  return [...prev, { kind: "assistant", text, streaming: false, systemNotice }];
}

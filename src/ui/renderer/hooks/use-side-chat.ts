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
  // in-flight streamId is applied to the transcript.
  const activeStreamIdRef = useRef<number | null>(null);

  // Subscribe to the DEDICATED side-chat stream. Reducer appends/updates the
  // trailing streaming assistant entry.
  useEffect(() => {
    if (!api.sideChat) return;
    const off = api.sideChat.onStream((event: StreamEvent) => {
      // A frame from a superseded turn (aborted / replaced) is dropped.
      if (
        activeStreamIdRef.current !== null &&
        typeof event.streamId === "number" &&
        event.streamId !== activeStreamIdRef.current
      ) {
        return;
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

// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useCallback, useRef, useState } from "react";
import { useMessageQueue } from "../use-message-queue.js";
import { useSideChat } from "../use-side-chat.js";
import type { ComposerHandle } from "../../components/Composer.js";
import type { Attachment } from "../../types/attachments.js";
import type { StreamEvent } from "../../../../lib/chat-stream-state.js";
import type { UserKeyboardIntentSnapshot } from "../../../../shared/chat-origin.js";
import type { LvisApi } from "../../types.js";

/**
 * The queue's end-of-turn drain, on a surface whose stream carries a turn id.
 *
 * `runStreamedTurn` emits `turn.completed` on every return, an aborted turn
 * included, so an interrupt produces a trailing `done` that arrives AFTER the
 * replacement turn has started. The drain that frame triggers sends with
 * `inputOrigin: "queue-auto"`, which deliberately does not interrupt — so it
 * would land on top of the live turn, two turns on one ConversationLoop.
 *
 * These tests wire the side chat's real hooks together the way SideChatView
 * does, and assert the drain follows the SURFACE's own stale-frame verdict.
 */

/**
 * A side-chat preload double that supports SEVERAL subscribers on one channel —
 * the transcript and the queue both listen, and the single-slot double the
 * transcript's own suite uses would let the second overwrite the first.
 */
function makeApi(options: { reverseDispatch?: boolean } = {}) {
  const handlers = new Set<(e: StreamEvent) => void>();
  const dispatch = (e: StreamEvent) => {
    // Each subscriber gets its OWN copy of the frame: the context bridge builds
    // a fresh object per listener, so a verdict cached by frame identity would
    // not survive the crossing.
    //
    // The ORDER is a parameter because nothing in the contract fixes it. Today
    // the transcript subscribes first because its hook is called first, and
    // that must not be what makes the drain correct.
    const ordered = [...handlers];
    if (options.reverseDispatch) ordered.reverse();
    for (const h of ordered) h({ ...e });
  };
  /** Frames the host emits while the abort round trip is still in flight. */
  let framesDuringAbort: StreamEvent[] = [];
  const abort = vi.fn(async () => {
    for (const e of framesDuringAbort) dispatch(e);
    framesDuringAbort = [];
    return { ok: true as const };
  });
  const send = vi.fn(async () => ({ ok: true as const, result: {} }));
  const api = {
    sideChat: {
      send,
      new: vi.fn(async () => ({ ok: true as const, sessionId: "side-2" })),
      load: vi.fn(async () => ({ ok: true as const, sessionId: "side-3", messages: [] })),
      list: vi.fn(async () => ({ current: "side-1", sessions: [] })),
      abort,
      onStream: (h: (e: StreamEvent) => void) => {
        handlers.add(h);
        return () => {
          handlers.delete(h);
        };
      },
      onFallback: () => () => {},
    },
  } as unknown as LvisApi;
  return {
    api,
    subscriberCount: () => handlers.size,
    /** One dispatch to every subscriber, as the stream channel does. */
    emit: async (e: StreamEvent) => {
      await act(async () => {
        dispatch(e);
      });
    },
    /**
     * Queue a frame for the host to publish WHILE `abort` is in flight. That is
     * the real timing of an interrupted turn's trailing `done`: the host settles
     * the turn before the abort invoke resolves.
     */
    emitDuringAbort: (e: StreamEvent) => {
      framesDuringAbort.push(e);
    },
    spies: { send, abort },
  };
}

/** The composition SideChatView builds: transcript hook + shared queue hook. */
function useSideSurface(api: LvisApi) {
  const side = useSideChat(api);
  const composerRef = useRef<ComposerHandle | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const { send, isCurrentTurnEvent, abort } = side;

  const onAsk = useCallback(
    (
      text: string,
      _intent?: UserKeyboardIntentSnapshot,
      opts?: { injectHint?: "queue" | "interrupt"; inputOrigin?: "queue-auto" },
    ) => {
      if (opts?.inputOrigin === "queue-auto") {
        return send(text, { injectHint: opts.injectHint, inputOrigin: "queue-auto" });
      }
      return send(text, opts?.injectHint ? { injectHint: opts.injectHint } : {});
    },
    [send],
  );

  const queue = useMessageQueue({
    surface: "side",
    subscribeStream: api.sideChat!.onStream,
    composerRef,
    currentSessionId: side.sessionId ?? "",
    question: draft,
    attachments,
    streaming: side.isStreaming,
    setQuestion: setDraft,
    setAttachments,
    onAsk,
    onAbort: abort,
    isCurrentTurnEvent,
  });

  return { side, queue, setDraft };
}

type Surface = ReturnType<typeof useSideSurface>;

/** Type the draft and press plain Enter — queues while a turn is running. */
async function typeAndSubmit(result: { current: Surface }, text: string) {
  await act(async () => {
    result.current.setDraft(text);
  });
  await act(async () => {
    result.current.queue.handleComposerSend({ inputOrigin: "user-keyboard", token: "" });
  });
}

describe("useMessageQueue end-of-turn drain (side chat)", () => {
  it("drains on the current turn's done", async () => {
    const { api, emit, spies } = makeApi();
    const { result } = renderHook(() => useSideSurface(api));

    await act(async () => {
      await result.current.side.send("first");
    });
    expect(spies.send).toHaveBeenCalledTimes(1);
    // The turn's first frame establishes its stream id.
    await emit({ type: "text_delta", text: "a", streamId: 1 });

    await typeAndSubmit(result, "later");
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(1);

    await emit({ type: "done", streamId: 1 });

    expect(spies.send).toHaveBeenCalledTimes(2);
    const [drainedText] = spies.send.mock.calls[1] as unknown as [string];
    expect(drainedText).toContain("later");
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(0);
  });

  it("does not drain on the trailing done that arrives DURING an interrupt", async () => {
    const { api, emit, emitDuringAbort, spies } = makeApi();
    const { result } = renderHook(() => useSideSurface(api));

    await act(async () => {
      await result.current.side.send("first");
    });
    await emit({ type: "text_delta", text: "a", streamId: 1 });

    await typeAndSubmit(result, "later");
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(1);

    // The host settles the aborted turn BEFORE the abort invoke resolves, so its
    // `turn.completed` lands in the middle of the interrupt — the exact timing
    // the real app produces.
    emitDuringAbort({ type: "done", streamId: 1 });
    await act(async () => {
      await result.current.side.abort();
    });
    expect(spies.abort).toHaveBeenCalledTimes(1);

    // The row is still the user's — no `queue-auto` send went out on top of the
    // turn that replaces the aborted one.
    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(1);
  });

  it("does not drain on a trailing done that arrives after the interrupt", async () => {
    const { api, emit, spies } = makeApi();
    const { result } = renderHook(() => useSideSurface(api));

    await act(async () => {
      await result.current.side.send("first");
    });
    await emit({ type: "text_delta", text: "a", streamId: 1 });
    await typeAndSubmit(result, "later");

    await act(async () => {
      await result.current.side.abort();
    });
    await emit({ type: "done", streamId: 1 });

    expect(spies.send).toHaveBeenCalledTimes(1);
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(1);
  });

  // The drain's send re-arms the surface's stale-frame guard synchronously. If
  // it ran inside the dispatch, a subscriber that had not judged the frame yet
  // would read it as superseded — and the transcript, judging last, would drop
  // its own `done` and leave the answer streaming forever.
  it("drains and closes the answer whichever subscriber judges the frame first", async () => {
    const { api, emit, spies } = makeApi({ reverseDispatch: true });
    const { result } = renderHook(() => useSideSurface(api));

    await act(async () => {
      await result.current.side.send("first");
    });
    await emit({ type: "text_delta", text: "hello", streamId: 1 });
    await typeAndSubmit(result, "later");

    await emit({ type: "done", streamId: 1 });
    // The drain is deferred by a microtask; let it run.
    await act(async () => {
      await Promise.resolve();
    });

    const stuck = result.current.side.entries.filter(
      (e) => e.kind === "assistant" && e.streaming === true,
    );
    expect(stuck).toHaveLength(0);
    expect(spies.send).toHaveBeenCalledTimes(2);
    expect(result.current.queue.messageQueueStore.getPending()).toHaveLength(0);
  });

  it("gives every subscriber the same verdict for one frame", async () => {
    const { api, emit, subscriberCount } = makeApi();
    const { result } = renderHook(() => useSideSurface(api));
    // The transcript and the queue are BOTH on the channel, each holding its own
    // copy of the frame. Whoever asks second must not be told "superseded" about
    // the very frame the first asker just accepted.
    expect(subscriberCount()).toBe(2);

    await act(async () => {
      await result.current.side.send("first");
    });
    await emit({ type: "text_delta", text: "hello", streamId: 1 });
    await emit({ type: "done", streamId: 1 });

    // The transcript accepted it — streaming ended…
    expect(result.current.side.isStreaming).toBe(false);
    // …and a later asker holding a separate copy is told the same.
    expect(result.current.side.isCurrentTurnEvent({ type: "done", streamId: 1 })).toBe(true);
  });
});

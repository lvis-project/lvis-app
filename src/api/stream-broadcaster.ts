/**
 * stream-broadcaster.ts — legacy frame fan-out for isolated A2A flows.
 *
 * A tiny synchronous multiplexer for the remaining consumers that still own
 * their legacy `(channel, payload)` frames (currently the isolated A2A
 * receiver). Main-conversation Electron and loopback SSE traffic use
 * `PlatformConversationTimeline` plus its one-way compatibility adapter;
 * this module is not a second conversation-event source.
 *
 * Semantics:
 *   - `sink(channel, payload)` forwards synchronously to every CURRENT
 *     subscriber. Subscribers are display-side (SSE writes, emitters); a
 *     throwing subscriber must NOT prevent the others from receiving the frame,
 *     so each call is isolated with try/catch and the error is swallowed (there
 *     is no meaningful recovery for a broken display sink).
 *   - `subscribe(fn)` returns an idempotent unsubscribe. Subscribing or
 *     unsubscribing DURING a broadcast is safe: `sink` iterates over a snapshot
 *     of the subscriber set taken at the start of the fan-out.
 */
import type { LegacyChatStreamSink } from "../engine/conversation-platform-protocol.js";

type ChatStreamSink = LegacyChatStreamSink;

/** A legacy `(channel, payload)` event source, including existing SSE transports. */
export interface StreamEventSource {
  subscribe(fn: LegacyChatStreamSink): () => void;
  subscriberCount(): number;
}

/** A fan-out over chat stream frames — one inbound sink, N display subscribers. */
export interface StreamBroadcaster {
  /** The single sink the streaming core publishes to; fans out to subscribers. */
  sink: ChatStreamSink;
  /** Register a display-side subscriber; returns an idempotent unsubscribe fn. */
  subscribe(fn: ChatStreamSink): () => void;
  /** How many subscribers are currently registered. */
  subscriberCount(): number;
}

/** Build a fresh, empty broadcaster. */
export function createStreamBroadcaster(): StreamBroadcaster {
  const subscribers = new Set<ChatStreamSink>();

  const sink: ChatStreamSink = (channel, payload) => {
    // Snapshot so subscribe/unsubscribe during the fan-out cannot mutate the
    // set mid-iteration (a subscriber may unsubscribe itself on a `done` frame).
    for (const fn of [...subscribers]) {
      try {
        fn(channel, payload);
      } catch {
        // Display-side sinks are best-effort; one broken sink must not stop the
        // others and there is no recovery path — swallow.
      }
    }
  };

  function subscribe(fn: ChatStreamSink): () => void {
    subscribers.add(fn);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(fn);
    };
  }

  function subscriberCount(): number {
    return subscribers.size;
  }

  return { sink, subscribe, subscriberCount };
}

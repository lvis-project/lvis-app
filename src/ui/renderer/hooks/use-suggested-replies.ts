// Renderer-side consumer of the `suggested_replies` IPC event emitted by
// `src/ipc/domains/chat.ts` (turn-end). Backend already parses and filters
// the `<suggested_replies>` block from the LLM stream — this hook owns the
// module-level store + IPC subscription so any view can read the current
// suggestion snapshot via `useSyncExternalStore`.
//
// Spec: `docs/architecture/proposals/suggested-replies-ghost-text.md` §6.1.
//
// PR-D additions:
//   • Slash-command prefix filter (`/`, `!`, `$`) — security guard so a
//     malicious / hallucinated suggestion cannot ride straight into a host
//     command (proposal §10 follow-up).
//   • Turn-scoped dismiss memory — once the user dismisses, subsequent pushes
//     within the same turn keep `isDismissed: true`. A *new user message*
//     calls `clearDismissedReplies()` to reset the latch so the next turn's
//     suggestions render fresh.
//   • Telemetry — `shown / accepted-best / accepted-chip / dismissed /
//     ignored` counters routed through `telemetry/suggested-replies-counter`.
import { useEffect, useSyncExternalStore } from "react";
import { getApi } from "../api-client.js";
import {
  recordSuggestedRepliesEvent,
} from "../../../telemetry/suggested-replies-counter.js";

export interface SuggestedRepliesSnapshot {
  best: string | null;
  alternates: string[];
  isDismissed: boolean;
}

const EMPTY_SNAPSHOT: SuggestedRepliesSnapshot = {
  best: null,
  alternates: [],
  isDismissed: false,
};

// Suggestions whose leading character is one of these prefixes are filtered
// out before they reach the store. Slash + bang + dollar map to the host's
// command-style entrypoints (e.g. `/admin`, `/clear`, `!shell`, `$env`); we
// never want an LLM-generated suggestion to silently inject one of those.
// Defined here (and not in the engine) because the same string could be a
// legitimate token in a future channel — the renderer is the right place to
// enforce a UI-policy filter for *suggestion* surfacing.
const SLASH_COMMAND_PATTERN = /^[/!$]/;

// Module-level store — single source of truth for all subscribers. Reset to
// `EMPTY_SNAPSHOT` on every new replies push so React's `Object.is` snapshot
// check correctly skips renders when nothing changed (object identity stable
// across pushes that yield 0 replies).
let snapshot: SuggestedRepliesSnapshot = EMPTY_SNAPSHOT;
const subscribers = new Set<() => void>();

// PR-D dismiss-memory: when the user hits Escape, we latch a flag so any
// subsequent push *within the same turn* (rare but possible — e.g. a plugin
// re-emit) keeps the snapshot dismissed. `clearDismissedReplies()` is called
// by the Composer when the user sends a new message, releasing the latch so
// the next turn's suggestions render fresh.
let dismissLatch = false;

// PR-D ignored telemetry: when a new non-empty push arrives while the prior
// snapshot was *active and unaccepted* (best != null, not dismissed), we
// record an `ignored` event before overwriting. Tracking the active flag as
// a separate scalar keeps the bookkeeping outside `snapshot` so it doesn't
// pollute the public snapshot identity.
let priorActiveUnused = false;

function notify(): void {
  for (const cb of subscribers) cb();
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

function getSnapshot(): SuggestedRepliesSnapshot {
  return snapshot;
}

export function pushSuggestedReplies(replies: string[]): void {
  // Slash-command filter runs *before* the empty-check so a list whose only
  // entries are command-prefixed correctly collapses to "no suggestions".
  const filtered = replies.filter(
    (r) => typeof r === "string" && r.length > 0 && !SLASH_COMMAND_PATTERN.test(r.trim()),
  );

  // Telemetry: if the previous snapshot was still active + unaccepted when a
  // new push arrives, the user effectively ignored it. Record before we
  // overwrite (and only on a *fresh* non-empty arrival — an empty push
  // means "clear" which isn't a user-driven ignore).
  if (priorActiveUnused && filtered.length > 0) {
    recordSuggestedRepliesEvent("ignored");
  }

  if (filtered.length === 0) {
    priorActiveUnused = false;
    if (snapshot === EMPTY_SNAPSHOT) return;
    snapshot = EMPTY_SNAPSHOT;
    notify();
    return;
  }

  // Dismiss-memory: if the latch is set, the new push remains dismissed so
  // the user's prior Escape decision is honored across the (rare) intra-turn
  // re-push. `clearDismissedReplies()` releases the latch.
  snapshot = {
    best: filtered[0]!,
    alternates: filtered.slice(1),
    isDismissed: dismissLatch,
  };
  // Only count as "shown" when the snapshot is actually visible (not latched
  // into dismissed state).
  if (!dismissLatch) {
    recordSuggestedRepliesEvent("shown");
    priorActiveUnused = true;
  } else {
    priorActiveUnused = false;
  }
  notify();
}

export function dismissSuggestedReplies(): void {
  if (snapshot.isDismissed) return;
  if (snapshot.best === null && snapshot.alternates.length === 0) return;
  snapshot = { ...snapshot, isDismissed: true };
  dismissLatch = true;
  priorActiveUnused = false;
  recordSuggestedRepliesEvent("dismissed");
  notify();
}

/**
 * Reset the dismiss latch + telemetry "active" flag. Called by the Composer
 * when the user sends a new message — at that point the prior turn is over
 * and the next push (next turn) should render fresh.
 *
 * Idempotent. Safe to call when nothing is dismissed.
 */
export function clearDismissedReplies(): void {
  dismissLatch = false;
  // Also clear `priorActiveUnused` — sending the message means the user
  // engaged with the turn, so any prior suggestion that's about to be
  // replaced shouldn't count as "ignored".
  priorActiveUnused = false;
}

export function acceptSuggestedReply(
  _text: string,
  source: "best" | "chip" = "best",
): void {
  // Composer 가 채워 넣은 후 호출. 추천은 1회성이므로 store 비움.
  if (snapshot === EMPTY_SNAPSHOT) return;
  recordSuggestedRepliesEvent(source === "best" ? "accepted-best" : "accepted-chip");
  snapshot = EMPTY_SNAPSHOT;
  // Accept also releases the dismiss latch — the snapshot was consumed, so
  // the next push should render fresh regardless of any prior Escape.
  dismissLatch = false;
  priorActiveUnused = false;
  notify();
}

// Test-only: reset between cases.
export function __resetSuggestedRepliesStoreForTests(): void {
  snapshot = EMPTY_SNAPSHOT;
  dismissLatch = false;
  priorActiveUnused = false;
  // 구독자는 비우지 않음 — 활성 컴포넌트가 다시 subscribe 하므로.
}

let ipcWired = false;
let ipcUnsub: (() => void) | null = null;

/**
 * Wire renderer IPC listener exactly once per process. Idempotent — multiple
 * `useSuggestedReplies` consumers share the same subscription, and the
 * subscription is never torn down because the store outlives any individual
 * view (Composer remount during chat session change must not lose replies).
 */
function ensureIpcWired(): void {
  if (ipcWired) return;
  try {
    const api = getApi();
    ipcUnsub = api.onChatStream((ev) => {
      if (ev.type !== "suggested_replies") return;
      const replies = (ev as { replies?: unknown }).replies;
      if (!Array.isArray(replies)) {
        pushSuggestedReplies([]);
        return;
      }
      const cleaned = replies.filter((r): r is string => typeof r === "string");
      pushSuggestedReplies(cleaned);
    });
    // Only mark wired after successful subscription — if getApi() / onChatStream
    // throws, leave `ipcWired = false` so the next consumer can retry once the
    // bridge is available (e.g. SSR-then-hydrate, or test that wires the stub
    // after first render).
    ipcWired = true;
  } catch {
    ipcUnsub = null;
  }
}

// Test-only: detach the IPC listener and re-arm for the next ensure call.
export function __teardownSuggestedRepliesIpcForTests(): void {
  if (ipcUnsub) {
    ipcUnsub();
    ipcUnsub = null;
  }
  ipcWired = false;
}

export function useSuggestedReplies(): SuggestedRepliesSnapshot {
  useEffect(() => {
    ensureIpcWired();
  }, []);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// HMR cleanup (dev only). Without this, Vite hot-replacing this module leaves
// the previous IPC subscription dangling — both old + new closures fire on
// every `suggested_replies` event, doubling `pushSuggestedReplies` calls and
// freezing the store at whichever closure ran last. Disposing on dispose
// ensures the next module instance re-arms cleanly.
//
// `import.meta.hot` is a Vite-injected runtime feature; the project does not
// pull in `vite/client` globally so we narrow it via a local structural type
// instead of polluting tsconfig with a wider type bundle.
const hot = (import.meta as { hot?: { dispose: (cb: () => void) => void } }).hot;
if (hot) {
  hot.dispose(() => {
    __teardownSuggestedRepliesIpcForTests();
  });
}

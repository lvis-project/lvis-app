// Renderer-side consumer of the `suggested_replies` IPC event emitted by
// `src/ipc/domains/chat.ts` (turn-end). Backend already parses and filters
// the `<suggested_replies>` block from the LLM stream — this hook owns the
// module-level store + IPC subscription so any view can read the current
// suggestion snapshot via `useSyncExternalStore`.
//
// Spec: `docs/architecture/proposals/suggested-replies-ghost-text.md` §6.1.
//
// PR-B scope. PR-D will add dismiss memory / animation / telemetry.
import { useEffect, useSyncExternalStore } from "react";
import { getApi } from "../api-client.js";

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

// Module-level store — single source of truth for all subscribers. Reset to
// `EMPTY_SNAPSHOT` on every new replies push so React's `Object.is` snapshot
// check correctly skips renders when nothing changed (object identity stable
// across pushes that yield 0 replies).
let snapshot: SuggestedRepliesSnapshot = EMPTY_SNAPSHOT;
const subscribers = new Set<() => void>();

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
  if (replies.length === 0) {
    if (snapshot === EMPTY_SNAPSHOT) return;
    snapshot = EMPTY_SNAPSHOT;
    notify();
    return;
  }
  snapshot = {
    best: replies[0]!,
    alternates: replies.slice(1),
    isDismissed: false,
  };
  notify();
}

export function dismissSuggestedReplies(): void {
  if (snapshot.isDismissed) return;
  if (snapshot.best === null && snapshot.alternates.length === 0) return;
  snapshot = { ...snapshot, isDismissed: true };
  notify();
}

export function acceptSuggestedReply(_text: string): void {
  // Composer 가 채워 넣은 후 호출. 추천은 1회성이므로 store 비움.
  // _text 는 telemetry (PR-D) 에서 사용 예정 — 현 시점에서는 reset 만.
  if (snapshot === EMPTY_SNAPSHOT) return;
  snapshot = EMPTY_SNAPSHOT;
  notify();
}

// Test-only: reset between cases.
export function __resetSuggestedRepliesStoreForTests(): void {
  snapshot = EMPTY_SNAPSHOT;
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

/**
 * Side-chat domain IPC handlers (workspace rail) — a SECOND, independently-
 * streaming chat session that never touches the main chat's ConversationLoop.
 *
 * Channels (ALL INTERNAL — never in PUBLIC_CHANNELS / EXTERNAL_MUTATION_CHANNELS):
 *   `lvis:sidechat:send`  invoke  renderer→main → TurnResult | { ok:false, error }
 *   `lvis:sidechat:new`   invoke  → { ok, sessionId }
 *   `lvis:sidechat:load`  invoke  (sessionId) → { ok, sessionId, messages }
 *   `lvis:sidechat:list`  invoke  → { current, sessions }
 *   `lvis:sidechat:abort` invoke  → { ok }
 *   `lvis:sidechat:stream`   event  main→renderer  { streamId, ...frame }
 *   `lvis:sidechat:fallback` event  main→renderer  { from, to }
 *
 * ISOLATION (No-Fallback): this module NEVER imports or touches the main
 * `conversationLoop`. It drives `deps.sideChatConversationLoop` — a distinct
 * ConversationLoop with its own history/sessionId and an isolated MemoryManager
 * rooted at `~/.lvis/side-chat/`. It owns its OWN `activeSideStreamTurn` /
 * `nextSideStreamId` module state so a main-chat abort never cancels a side turn
 * (and vice versa). It reuses the transport-agnostic `runStreamedTurn` but
 * passes the DEDICATED `CHANNELS.sidechat.*` channel pair, so the main
 * renderer's `onChatStream` subscriber never receives a side-chat frame — the
 * two streams are isolated by wire channel, not by a session discriminator on a
 * shared channel.
 *
 * TRUST BOUNDARY: side chat runs arbitrary tools like the main chat, so every
 * invoke gates on {@link validateSender} and the channels are absent from
 * PUBLIC_CHANNELS (fail-closed `isPublicChannel`). Error contract: kebab-case
 * English `error` (project CLAUDE.md — IPC English / UI Korean).
 */
import { ipcMain } from "electron";
import type { WebContents } from "electron";
import { CHANNELS } from "../../contract/app-contract.js";
import { validateSender, UNAUTHORIZED_FRAME, auditUnauthorized } from "../gated.js";
import { sendToWebContents } from "../safe-send.js";
import { createLogger } from "../../lib/logger.js";
import type { GenericMessage } from "../../engine/llm/types.js";
import type { TurnResult } from "../../engine/conversation-loop.js";
import { serializeHistoryMessage } from "../../shared/chat-history.js";
import {
  runStreamedTurn,
  STREAM_TURN_OPTIONS,
  type ChatStreamSink,
} from "../handlers/chat-stream.js";
import { isSafeSessionId, validateUserContentParts } from "../handlers/chat.js";
import type { IpcDeps } from "../types.js";

const log = createLogger("sidechat");

const SIDECHAT_CHANNELS = {
  stream: CHANNELS.sidechat.stream,
  fallback: CHANNELS.sidechat.fallback,
} as const;

export function registerSideChatHandlers(deps: IpcDeps): void {
  const { sideChatConversationLoop, auditLogger, getMainWindow } = deps;

  // A side-chat loop is only wired in production boot. When absent (test
  // fixtures that boot only the main loop), every handler fails closed with a
  // stable `error` so the renderer surface degrades to a disabled state rather
  // than throwing.
  if (!sideChatConversationLoop) {
    const unavailable = () => ({ ok: false as const, error: "side-chat-unavailable" });
    ipcMain.handle(CHANNELS.sidechat.send, (e) => {
      if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.send, e); return UNAUTHORIZED_FRAME; }
      return unavailable();
    });
    ipcMain.handle(CHANNELS.sidechat.new, (e) => {
      if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.new, e); return UNAUTHORIZED_FRAME; }
      return unavailable();
    });
    ipcMain.handle(CHANNELS.sidechat.load, (e) => {
      if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.load, e); return UNAUTHORIZED_FRAME; }
      return { ok: false as const, error: "side-chat-unavailable", messages: [] };
    });
    ipcMain.handle(CHANNELS.sidechat.list, (e) => {
      if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.list, e); return UNAUTHORIZED_FRAME; }
      return { current: null, sessions: [] };
    });
    ipcMain.handle(CHANNELS.sidechat.abort, (e) => {
      if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.abort, e); return UNAUTHORIZED_FRAME; }
      return unavailable();
    });
    return;
  }

  const loop = sideChatConversationLoop;

  // Side-chat-OWNED stream-turn tracking — deliberately NOT shared with the main
  // chat's `activeStreamTurn`. A main abort must never cancel a side turn.
  let activeSideStreamTurn: Promise<TurnResult> | null = null;
  let nextSideStreamId = 0;

  const buildSink = (wc: WebContents | undefined): ChatStreamSink =>
    (channel, payload) => sendToWebContents(wc, channel, payload, log);

  // Abort + await any in-flight side turn before mutating the shared side loop
  // (new / load). Without this, `newConversation()` / `loadSession()` would run
  // while a prior turn is still streaming into the SAME loop, and that turn's
  // remaining frames would leak into the fresh/loaded transcript (cross-session
  // leak). Mirrors the abort handler below and the main chat.ts abort pattern.
  const abortActiveSideTurn = async (): Promise<void> => {
    // Always signal the loop (idempotent when idle); await the tracked promise
    // only when a turn is actually in flight so callers see it fully settled.
    loop.abortCurrentTurn();
    if (!activeSideStreamTurn) return;
    try {
      await activeSideStreamTurn;
    } catch {
      // expected: interrupted turns may reject
    }
  };

  ipcMain.handle(CHANNELS.sidechat.send, async (e, payload: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.send, e); return UNAUTHORIZED_FRAME; }
    const p = (payload ?? {}) as { input?: unknown; attachments?: unknown };
    if (typeof p.input !== "string" || p.input.trim().length === 0) {
      return { ok: false as const, error: "empty-text" };
    }
    const attachments = validateUserContentParts(p.attachments);
    const win = getMainWindow();
    const sink = buildSink(win?.webContents);
    const streamId = ++nextSideStreamId;
    const turnPromise = (async () => {
      return runStreamedTurn(
        loop,
        p.input as string,
        sink,
        streamId,
        {
          ...STREAM_TURN_OPTIONS,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        },
        SIDECHAT_CHANNELS,
      );
    })().finally(() => {
      if (activeSideStreamTurn === turnPromise) activeSideStreamTurn = null;
    });
    activeSideStreamTurn = turnPromise;
    try {
      const result = await turnPromise;
      return { ok: true as const, result };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.sidechat.new, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.new, e); return UNAUTHORIZED_FRAME; }
    // Abort any in-flight turn first so its remaining frames never leak into the
    // fresh session (mirrors abort handler; contrast the prior unguarded call).
    await abortActiveSideTurn();
    loop.newConversation();
    return { ok: true as const, sessionId: loop.getSessionId() };
  });

  ipcMain.handle(CHANNELS.sidechat.load, async (e, sessionId: unknown) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.load, e); return { ok: false as const, error: "unauthorized-frame", messages: [] }; }
    if (!isSafeSessionId(sessionId)) {
      return { ok: false as const, error: "invalid-session-id", messages: [] };
    }
    // Abort any in-flight turn first so its remaining frames never leak into the
    // loaded session's transcript (same concurrency hazard as `new`).
    await abortActiveSideTurn();
    const loaded = loop.loadSession(sessionId);
    if (!loaded) {
      return { ok: false as const, error: "session-not-found", messages: [] };
    }
    const messages = loop.getHistory().getMessages() as GenericMessage[];
    return {
      ok: true as const,
      sessionId: loop.getSessionId(),
      messages: messages.map(serializeHistoryMessage),
    };
  });

  ipcMain.handle(CHANNELS.sidechat.list, (e) => {
    if (!validateSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.sidechat.list, e);
      // Fail closed: an unauthorized frame gets NO data — not even the real
      // current session id (info disclosure). Same empty shape as the
      // loop-absent branch above.
      return { current: null, sessions: [] };
    }
    // The side-chat MemoryManager's session store is isolated to
    // `~/.lvis/side-chat/` — listSessions here never returns a main-chat
    // session (and the main `chat.sessions` never returns a side-chat one).
    const sessions = loop.listSessions().map((s) => ({
      id: s.id,
      modifiedAt: s.modifiedAt.toISOString(),
      title: s.title,
    }));
    return { current: loop.getSessionId(), sessions };
  });

  ipcMain.handle(CHANNELS.sidechat.abort, async (e) => {
    if (!validateSender(e)) { auditUnauthorized(auditLogger, CHANNELS.sidechat.abort, e); return UNAUTHORIZED_FRAME; }
    await abortActiveSideTurn();
    return { ok: true as const };
  });
}

// public-surface.ts — the externally-parity-safe portion of `window.lvisApi`
// (#1409 + #1411 C11): chat/session interaction + starred, plugin-status +
// marketplace list reads, and usage observability. Chat send mints/consumes the
// SHARED gesture token via ./gesture-intent; this surface never touches the
// gesture-gated mutating permission/policy family (that lives in the internal
// surface). Channel names come from the contract SOT (no inline literals).
import { ipcRenderer } from "electron";
import { CHANNELS, MAIN_CHAT_GROUP_ID } from "../contract/app-contract.js";
import {
  captureUserKeyboardIntent,
  consumeUserKeyboardIntent,
} from "./gesture-intent.js";
import type {
  ChatSendInputOrigin,
  UserKeyboardIntentSnapshot,
} from "../shared/chat-origin.js";
import type { SerializedHistoryMessage } from "../shared/chat-history.js";
import type { SessionFamily, SessionListKindFilter, SessionListRow } from "../shared/session-lookup.js";
import type { ChatStreamEvent } from "../lib/chat-stream-state.js";
// Type-only: this builder implements part of the renderer-declared surface.
import type { LvisApi } from "../ui/renderer/types.js";

/**
 * The chat channels that address ONE conversation.
 *
 * Every one of them names its group on the wire. A tile gets its own surface
 * through `chatGroup(id)`; the default surface is the primary group, which is
 * what a window with a single conversation has always been.
 *
 * See docs/design/tiled-chat-groups.md.
 */
/**
 * Subscribe to a main->renderer push that carries a group label.
 *
 * Every group's frames arrive on the same channel, so a surface only forwards
 * the ones addressed to ITS group. Dropping the check would put another tile's
 * tokens in this tile's transcript, and another tile's provider swap in this
 * tile's banner.
 *
 * Fail-closed on the label, not fan-out. These channels have exactly one
 * producer and it stamps the group on every frame it sends (see the labelling
 * subscriber in `ipc/domains/chat.ts`), so an unlabelled frame is a producer
 * bug rather than a broadcast. Handing it to every surface would answer that
 * bug by showing one conversation's tokens in all of them — the loudest
 * possible wrong answer, and the one hardest to trace back.
 */
function subscribeForChatGroup<T>(
  channel: string,
  chatGroupId: string,
  handler: (payload: T) => void,
): () => void {
  const listener = (_event: unknown, payload: T) => {
    const frameGroup = (payload as { chatGroupId?: unknown }).chatGroupId;
    if (frameGroup !== chatGroupId) return;
    handler(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

function buildSurfaceForChatGroup(chatGroupId: string) {
  return {
  // ─── Chat (ConversationLoop) ─────────────────────
  chatHasProvider: async () => ipcRenderer.invoke(CHANNELS.chat.hasProvider, chatGroupId) as Promise<boolean>,
  chatGroupRelease: async () =>
    ipcRenderer.invoke(CHANNELS.chat.groupRelease, chatGroupId) as Promise<{ ok: boolean; released?: boolean; error?: string }>,
  captureUserKeyboardIntent,
  chatSend: async (
    input: string,
    attachments: unknown[] | undefined,
    inputOrigin: ChatSendInputOrigin,
    userIntent?: UserKeyboardIntentSnapshot,
    personaPromptId?: string,
    options?: { interrupt?: boolean },
  ) =>
    ipcRenderer.invoke(CHANNELS.chat.send, {
      input,
      attachments,
      inputOrigin,
      ...(personaPromptId ? { personaPromptId } : {}),
      // The user's Enter while a turn is running is one gesture: the host
      // aborts the running turn inside this same call, so the keyboard intent
      // consumed just below is the one that authorises the send.
      ...(options?.interrupt === true ? { interrupt: true } : {}),
      ...(inputOrigin === "user-keyboard"
        ? { userActivation: consumeUserKeyboardIntent(userIntent) }
        : {}),
    }, chatGroupId),
  chatGuide: async (input: string) => ipcRenderer.invoke(CHANNELS.chat.guide, input, chatGroupId),
  chatNew: async (opts?: { projectRoot?: string; projectName?: string }) => ipcRenderer.invoke(CHANNELS.chat.new, opts, chatGroupId),
  // The row shape is the shared list contract, not a copy of it: the bridge
  // forwards what main assembled, so re-spelling it here could only drift.
  chatSessions: async (opts?: { kind?: SessionListKindFilter; families?: SessionFamily[]; routineId?: string; projectRoot?: string; limit?: number; before?: string; beforeId?: string; after?: string }) =>
    ipcRenderer.invoke(CHANNELS.chat.sessions, opts) as Promise<{
      current: string;
      sessions: SessionListRow[];
    }>,
  // Conversation UX
  chatGetHistory: async () =>
    ipcRenderer.invoke(CHANNELS.chat.getHistory, chatGroupId) as Promise<{
      sessionId: string;
      sessionTitle?: string;
      sessionKind: "main" | "routine";
      routineId?: string;
      routineTitle?: string;
      projectRoot?: string;
      projectName?: string;
      /** True when projectRoot/projectName reflect the ambient default
       *  directory binding rather than an explicit project selection. */
      projectIsDefault?: boolean;
      /** Sub-agent rows rebuilt from persisted metadata; empty when none. The
       *  panel's live event stream does not survive an app restart. */
      restoredSubAgents?: Array<{
        spawnId: string;
        childSessionId: string;
        title: string;
        modifiedAt: string;
        taskState?: string;
        toolUseId?: string;
      }>;
      messages: SerializedHistoryMessage[];
    }>,
  chatMainActiveState: async () =>
    ipcRenderer.invoke(CHANNELS.chat.mainActiveState) as Promise<{
      mainActiveSessionId: string | null;
      mainActiveMode: "resume" | "fresh";
      updatedAt: string;
    } | null>,
  chatSessionHistory: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.sessionHistory, sessionId) as Promise<{
      ok: boolean;
      sessionTitle?: string;
      sessionKind?: "main" | "routine";
      routineId?: string;
      routineTitle?: string;
      routineFiredAt?: string;
      projectRoot?: string;
      projectName?: string;
      /** Sub-agent rows rebuilt from persisted metadata; empty when none. The
       *  panel's live event stream does not survive an app restart. */
      restoredSubAgents?: Array<{
        spawnId: string;
        childSessionId: string;
        title: string;
        modifiedAt: string;
        taskState?: string;
        toolUseId?: string;
      }>;
      messages: SerializedHistoryMessage[];
      /** Chars in the rolling summary preamble applied to this session. 0 = no preamble. */
      preambleChars?: number;
    }>,
  chatEditResend: async (messageId: string, newText: string) =>
    ipcRenderer.invoke(CHANNELS.chat.editResend, messageId, newText, chatGroupId),
  chatRewindTo: async (messageId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.rewindTo, messageId, chatGroupId) as Promise<
      | { ok: true; text: string; personaPromptId?: string }
      | { ok: false; error: string }
    >,
  chatFork: async (messageId?: string) => ipcRenderer.invoke(CHANNELS.chat.fork, messageId, chatGroupId),
  chatContinueLastUser: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.continueLastUser, { sessionId }, chatGroupId) as Promise<{ ok: boolean; error?: string }>,
  chatRetryEffort: async (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) =>
    ipcRenderer.invoke(CHANNELS.chat.retryEffort, opts, chatGroupId),
  // `sessionId` targets a conversation other than the loaded one — that is
  // what lets a sidebar row share itself. Omit it for the loaded conversation.
  chatExport: async (format: "markdown" | "json", sessionId?: string) =>
    ipcRenderer.invoke(CHANNELS.chat.export, format, sessionId),
  // Row-level conversation edits. Internal channels (mutating).
  chatSessionUpdate: async (payload: {
    sessionId: string;
    title?: string;
    archived?: boolean;
    unread?: boolean;
  }) =>
    ipcRenderer.invoke(CHANNELS.chat.sessionUpdate, payload) as Promise<
      { ok: true } | { ok: false; error?: string }
    >,
  chatSessionDelete: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.sessionDelete, { sessionId }) as Promise<
      { ok: true; wasLoaded: boolean } | { ok: false; error?: string }
    >,
  // #1500 (E3) — reverse of chatExport. Channel is internal (not in
  // PUBLIC_CHANNELS) even though the bridge lives alongside chatExport here.
  chatImport: async () =>
    ipcRenderer.invoke(CHANNELS.chat.import) as Promise<
      { ok: true; sessionId: string; messageCount: number } | { ok: false; error?: string; canceled?: boolean }
    >,
  chatCompact: async () => ipcRenderer.invoke(CHANNELS.chat.compact, chatGroupId),
  chatSessionResume: async (sessionId: string) => ipcRenderer.invoke(CHANNELS.chat.sessionResume, sessionId, chatGroupId),
  // Checkpoint view and explicit branch actions.
  chatEnterCheckpointView: async (sessionId: string, compactNum: number) =>
    ipcRenderer.invoke(CHANNELS.chat.enterCheckpointView, { sessionId, compactNum }, chatGroupId) as Promise<
      { messageIndexAtCreation: number } | { error: string }
    >,
  chatExitCheckpointView: async () =>
    ipcRenderer.invoke(CHANNELS.chat.exitCheckpointView, chatGroupId) as Promise<{ ok: boolean }>,
  chatBranchFromCheckpoint: async (sessionId: string, compactNum: number) =>
    ipcRenderer.invoke(CHANNELS.chat.branchFromCheckpoint, { sessionId, compactNum }, chatGroupId) as Promise<
      {
        newSessionId: string;
        lastMessageRole: "user" | "assistant" | "tool_result" | null;
        shouldAutoContinue: boolean;
      } | { error: string }
    >,
  chatAbort: async () => ipcRenderer.invoke(CHANNELS.chat.abort, chatGroupId) as Promise<{ ok: boolean }>,
  // Lazy-load verbatim tool_result content (in-session only).
  chatGetVerbatimToolResult: async (sessionId: string, toolUseId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.getVerbatimToolResult, { sessionId, toolUseId }, chatGroupId) as Promise<
      { content: string; lineCount: number } | null
    >,
  chatGetSubAgentTranscript: async (opts: {
    originSessionId: string;
    childSessionId: string;
  }) =>
    ipcRenderer.invoke(CHANNELS.chat.getSubAgentTranscript, opts, chatGroupId) as Promise<
      | {
          ok: true;
          childSessionId: string;
          messages: SerializedHistoryMessage[];
          title?: string;
          spawnId?: string;
          originToolUseId?: string;
        }
      | { ok: false; error?: string }
    >,
  // Issue #749: lazy-load full write_file diff when content exceeds preview limit
  chatGetWriteDiff: async (sessionId: string, toolUseId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.getWriteDiff, { sessionId, toolUseId }) as Promise<
      { before: string; after: string } | null
    >,
  starredList: async () => ipcRenderer.invoke(CHANNELS.starred.list),
  starredAdd: async (entry: { sessionId?: string; messageIndex: number; role: string; text: string }) =>
    ipcRenderer.invoke(CHANNELS.starred.add, entry),
  starredRemove: async (opts: { id?: string; sessionId?: string; messageIndex?: number }) =>
    ipcRenderer.invoke(CHANNELS.starred.remove, opts),
  onChatStream: (handler: (event: ChatStreamEvent) => void) =>
    subscribeForChatGroup<ChatStreamEvent>(CHANNELS.chat.stream, chatGroupId, handler),
  // The fallback rides the same labelled adapter as the stream, so it answers
  // the same question: a provider swap happened in ONE conversation, and an
  // unfiltered banner would announce it in every open tile at once.
  onChatFallback: (handler: (payload: { from: string; to: string }) => void) =>
    subscribeForChatGroup(CHANNELS.chat.fallback, chatGroupId, handler),
  listMarketplacePlugins: async () => ipcRenderer.invoke(CHANNELS.plugins.marketplaceList),
  listPluginCards: async () => ipcRenderer.invoke(CHANNELS.plugins.cards),
  // ─── Plugin Performance (Observability) ──────────
  plugins: {
    getPerfStats: async () => ipcRenderer.invoke(CHANNELS.plugins.perfStats),
  },

  // ─── Usage Observability ─────────────────────────
  getUsageSummary: async (days?: number) => ipcRenderer.invoke(CHANNELS.usage.summary, days),
  getUsageRange: async (opts: { dateFrom: string; dateTo: string }) => ipcRenderer.invoke(CHANNELS.usage.range, opts),
  exportUsageCsv: async (rows: Array<Record<string, string | number>>) => ipcRenderer.invoke(CHANNELS.usage.exportCsv, rows),
  };
}

export function buildPublicSurface() {
  const surface = buildSurfaceForChatGroup(MAIN_CHAT_GROUP_ID);
  return {
    ...surface,
    /**
     * One tile's view of the per-conversation channels.
     *
     * A tile passes this where it would otherwise pass `lvisApi`, so nothing
     * downstream has to learn about groups — every call it makes already names
     * the right conversation.
     */
    chatGroup: (chatGroupId: string) => buildSurfaceForChatGroup(chatGroupId),
  } satisfies Partial<LvisApi>;
}

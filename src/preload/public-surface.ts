// public-surface.ts — the externally-parity-safe portion of `window.lvisApi`
// (#1409 + #1411 C11): chat/session interaction + starred, plugin-status +
// marketplace list reads, and usage observability. Chat send mints/consumes the
// SHARED gesture token via ./gesture-intent; this surface never touches the
// gesture-gated mutating permission/policy family (that lives in the internal
// surface). Channel names come from the contract SOT (no inline literals).
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  captureUserKeyboardIntent,
  consumeUserKeyboardIntent,
} from "./gesture-intent.js";
import type {
  ChatSendInputOrigin,
  UserKeyboardIntentSnapshot,
} from "../shared/chat-origin.js";
import type { SerializedHistoryMessage } from "../shared/chat-history.js";
import type { StreamEvent } from "../lib/chat-stream-state.js";

export function buildPublicSurface() {
  return {
  // ─── Chat (ConversationLoop) ─────────────────────
  chatHasProvider: async () => ipcRenderer.invoke(CHANNELS.chat.hasProvider) as Promise<boolean>,
  captureUserKeyboardIntent,
  chatSend: async (
    input: string,
    attachments: unknown[] | undefined,
    inputOrigin: ChatSendInputOrigin,
    userIntent?: UserKeyboardIntentSnapshot,
    personaPromptId?: string,
  ) =>
    ipcRenderer.invoke(CHANNELS.chat.send, {
      input,
      attachments,
      inputOrigin,
      ...(personaPromptId ? { personaPromptId } : {}),
      ...(inputOrigin === "user-keyboard"
        ? { userActivation: consumeUserKeyboardIntent(userIntent) }
        : {}),
    }),
  chatGuide: async (input: string) => ipcRenderer.invoke(CHANNELS.chat.guide, input),
  chatNew: async (opts?: { projectRoot?: string; projectName?: string }) => ipcRenderer.invoke(CHANNELS.chat.new, opts),
  chatSessions: async (opts?: { kind?: "main" | "routine" | "all"; routineId?: string; projectRoot?: string; limit?: number; before?: string; beforeId?: string; after?: string }) =>
    ipcRenderer.invoke(CHANNELS.chat.sessions, opts) as Promise<{
      current: string;
      sessions: Array<{
        id: string;
        modifiedAt: string;
        title: string;
        sessionKind: "main" | "routine";
        routineId?: string;
        routineTitle?: string;
        routineFiredAt?: string;
        projectRoot?: string;
        projectName?: string;
        branchedFromCompactNum?: number;
        branchedAt?: string;
      }>;
    }>,
  // Conversation UX
  chatGetHistory: async () =>
    ipcRenderer.invoke(CHANNELS.chat.getHistory) as Promise<{
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
      messages: SerializedHistoryMessage[];
      /** Chars in the rolling summary preamble applied to this session. 0 = no preamble. */
      preambleChars?: number;
    }>,
  chatEditResend: async (messageIndex: number, newText: string) =>
    ipcRenderer.invoke(CHANNELS.chat.editResend, messageIndex, newText),
  chatFork: async (messageIndex: number) => ipcRenderer.invoke(CHANNELS.chat.fork, messageIndex),
  chatContinueLastUser: async (sessionId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.continueLastUser, { sessionId }) as Promise<{ ok: boolean; error?: string }>,
  chatRetryEffort: async (opts?: { thinkingBudgetTokens?: number; enableThinking?: boolean }) =>
    ipcRenderer.invoke(CHANNELS.chat.retryEffort, opts),
  chatExport: async (format: "markdown" | "json") => ipcRenderer.invoke(CHANNELS.chat.export, format),
  // #1500 (E3) — reverse of chatExport. Channel is internal (not in
  // PUBLIC_CHANNELS) even though the bridge lives alongside chatExport here.
  chatImport: async () =>
    ipcRenderer.invoke(CHANNELS.chat.import) as Promise<
      { ok: true; sessionId: string; messageCount: number } | { ok: false; error?: string; canceled?: boolean }
    >,
  chatCompact: async () => ipcRenderer.invoke(CHANNELS.chat.compact),
  chatSessionResume: async (sessionId: string) => ipcRenderer.invoke(CHANNELS.chat.sessionResume, sessionId),
  // Checkpoint view and explicit branch actions.
  chatEnterCheckpointView: async (sessionId: string, compactNum: number) =>
    ipcRenderer.invoke(CHANNELS.chat.enterCheckpointView, { sessionId, compactNum }) as Promise<
      { messageIndexAtCreation: number } | { error: string }
    >,
  chatExitCheckpointView: async () =>
    ipcRenderer.invoke(CHANNELS.chat.exitCheckpointView) as Promise<{ ok: boolean }>,
  chatBranchFromCheckpoint: async (sessionId: string, compactNum: number) =>
    ipcRenderer.invoke(CHANNELS.chat.branchFromCheckpoint, { sessionId, compactNum }) as Promise<
      {
        newSessionId: string;
        lastMessageRole: "user" | "assistant" | "tool_result" | null;
        shouldAutoContinue: boolean;
      } | { error: string }
    >,
  chatAbort: async () => ipcRenderer.invoke(CHANNELS.chat.abort) as Promise<{ ok: boolean }>,
  // Lazy-load verbatim tool_result content (in-session only).
  chatGetVerbatimToolResult: async (sessionId: string, toolUseId: string) =>
    ipcRenderer.invoke(CHANNELS.chat.getVerbatimToolResult, { sessionId, toolUseId }) as Promise<
      { content: string; lineCount: number } | null
    >,
  chatGetSubAgentTranscript: async (opts: {
    originSessionId: string;
    childSessionId: string;
  }) =>
    ipcRenderer.invoke(CHANNELS.chat.getSubAgentTranscript, opts) as Promise<
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
  onChatStream: (handler: (event: StreamEvent) => void) => {
    const listener = (_event: unknown, payload: StreamEvent) => handler(payload);
    ipcRenderer.on(CHANNELS.chat.stream, listener);
    return () => ipcRenderer.removeListener(CHANNELS.chat.stream, listener);
  },
  onChatFallback: (handler: (payload: { from: string; to: string }) => void) => {
    const listener = (_event: unknown, payload: Parameters<typeof handler>[0]) => handler(payload);
    ipcRenderer.on(CHANNELS.chat.fallback, listener);
    return () => ipcRenderer.removeListener(CHANNELS.chat.fallback, listener);
  },
  listMarketplacePlugins: async () => ipcRenderer.invoke(CHANNELS.plugins.marketplaceList),
  listPluginCards: async () => ipcRenderer.invoke(CHANNELS.plugins.cards),
  listPluginContributionTrust: async (pluginId?: string) =>
    ipcRenderer.invoke(CHANNELS.plugins.contributionTrustList, pluginId),
  setPluginContributionTrust: async (input: {
    pluginId: string;
    localId: string;
    kind: "hook" | "mcpServer";
    approved: boolean;
  }) => ipcRenderer.invoke(CHANNELS.plugins.contributionTrustSet, input),
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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { ChatContextProvider, type ChatContextValue } from "../context/ChatContext.js";
import { ChatView } from "../ChatView.js";
import { chatGroupApi } from "./ChatGroupFrame.js";
import {
  tileDrawsSession,
  useRegisterChatGroupSession,
  type ChatGroupSessionRegistry,
} from "./chat-group-session-registry.js";
import { useChatState } from "../hooks/use-chat-state.js";
import { useChatStatusIndicators } from "../hooks/use-chat-status-indicators.js";
import { useContextBudget } from "../hooks/use-context-budget.js";
import { useCostEstimate } from "../hooks/use-cost-estimate.js";
import { useCurrentSession } from "../hooks/use-sessions.js";
import { MAIN_CHAT_GROUP_ID } from "../../../contract/app-contract.js";
import { useSendMessage } from "../hooks/use-send-message.js";
import type { useStatusBar } from "../hooks/use-status-bar.js";
import { useWorkflowTools } from "../hooks/use-workflow-tools.js";
import { buildChatGroupActions } from "./ChatGroupFrame.js";
import { composeOutgoing as composeOutgoingUtil, type ComposedOutgoing } from "../utils/compose.js";
import { estimateOutgoingUserMessageTokens } from "../../../shared/multimodal-token-estimate.js";
import { formatIpcError } from "../format-ipc-error.js";
import { lookupBillablePricingOptional } from "../../../shared/pricing-data.js";
import { McpPromptArgsDialog } from "../dialogs/McpPromptArgsDialog.js";
import type { Attachment } from "../types/attachments.js";
import type { LvisApi } from "../types.js";
import type { McpPromptEntry } from "./slash-picker-data.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";
import type { SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";
import type { ChatEntry } from "../../../lib/chat-stream-state.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";

/**
 * Everything a tile needs that is NOT its own conversation.
 *
 * These describe the window — which model is configured, which plugins are
 * installed, which project is open, what the session list holds — and are the
 * same for every tile. They arrive as one object rather than fifty props
 * because a tile is rendered in a loop: threading them individually would put
 * fifty lines at every call site and make adding one a change in two places.
 */
export interface ChatGroupEnvironment {
  // model + readiness
  llmVendor: LLMVendor;
  llmModel: string;
  settingsLoaded: boolean;
  subscriptionRuntimeSelected: boolean;
  subscriptionRuntimePolicy: SubscriptionRuntimeUiPolicy;
  subscriptionImageAttachmentProvider: ChatContextValue["subscriptionImageAttachmentProvider"];
  subscriptionFileAttachmentProvider: ChatContextValue["subscriptionFileAttachmentProvider"];
  subscriptionUnavailableProvider: ChatContextValue["subscriptionUnavailableProvider"];
  subscriptionPendingProvider: ChatContextValue["subscriptionPendingProvider"];
  apiUsageProjectionAvailable: boolean;
  chatReasoningAvailable: boolean;
  effectiveLlmReady: boolean | null;
  chatReadyWithoutApiKey: boolean;
  checkApiKey: () => Promise<boolean>;
  onOpenSettings: (tab?: string) => void;
  maxOutputTokens: number;

  // composer configuration
  rolePresets: ChatContextValue["rolePresets"];
  activePreset: ChatContextValue["activePreset"];
  activePresetId: ChatContextValue["activePresetId"];
  setActivePresetId: ChatContextValue["setActivePresetId"];
  enableThinkingChat: boolean;
  toggleThinking: ChatContextValue["toggleThinking"];

  // the window's conversation list and stars
  refreshSessions: () => void | Promise<void>;
  /** Bring a chat group forward, including one chat mode has folded away. Returns whether focus moved. */
  focusChatGroup: (chatGroupId: string) => boolean;
  sessions: readonly { id: string; title: string }[];
  isSessionStarred: (sessionId: string) => boolean;
  handleToggleSessionStar: (sessionId: string, title?: string) => Promise<void>;
  starredIsEntry: (
    entryIdx: number,
    sessionId: string,
    entryIndexToHistoryIndex: Map<number, number>,
  ) => string | null;
  starredToggle: (
    entryIdx: number,
    entries: ChatEntry[],
    sessionId: string,
    entryIndexToHistoryIndex: Map<number, number>,
  ) => void;

  // the window's status surface. Toasts about a project error or an update are
  // the WINDOW's news, not one conversation's, so the bar is shared and the
  // tile only pushes to it.
  statusBar: React.ComponentProps<typeof ChatView>["statusBar"];
  statusPushToast: ReturnType<typeof useStatusBar>["pushToast"];
  statusUpsertPersistent: ReturnType<typeof useStatusBar>["upsertPersistent"];
  statusRemovePersistent: ReturnType<typeof useStatusBar>["removePersistent"];

  // search lives in the window because the panel does; it reads the FOCUSED
  // tile's transcript, which is the one on screen.
  search: Pick<ChatContextValue,
    | "searchOpen" | "searchQuery" | "searchCase" | "searchMatches" | "searchMatchSet"
    | "searchIdx" | "searchHighlight" | "searchChangeQuery" | "searchToggleCase"
    | "searchNext" | "searchPrev" | "searchCloseOverlay" | "searchToggleOverlay">;

  /** Export takes an explicit session id, so it is the window's to own. */
  onExport: (format: "markdown" | "json", sessionId?: string) => Promise<void>;
  onImport: () => Promise<string | null>;

  // window chrome the tile hands work back to
  plugins: React.ComponentProps<typeof ChatView>["plugins"];
  onSelectPlugin: (key: string) => void;
  appMode: "chat" | "work";
  onOpenApprovalQueue: () => void;
  commandActions: React.ComponentProps<typeof ChatView>["commandActions"];
  commandPopoverOpen: boolean;
  onCommandPopoverOpenChange: Dispatch<SetStateAction<boolean>>;
  onPluginPrimaryAction: (id: string) => void;
  onRoutineAcknowledge: React.ComponentProps<typeof ChatView>["onRoutineAcknowledge"];
  approvalSentenceInterceptSubmit: React.ComponentProps<typeof ChatView>["approvalSentenceInterceptSubmit"];

  // project binding
  activeProject: React.ComponentProps<typeof ChatView>["activeProject"];
  workspaceProjects: React.ComponentProps<typeof ChatView>["workspaceProjects"];
  onNewChatForProject: React.ComponentProps<typeof ChatView>["onNewChatForProject"];
  onRefreshProjects: React.ComponentProps<typeof ChatView>["onRefreshProjects"];
  onProjectError: React.ComponentProps<typeof ChatView>["onProjectError"];
}

export interface ChatGroupSessionProps {
  chatGroupId: string;
  /** The window's api. The tile binds its own group view of it. */
  api: LvisApi;
  registry: ChatGroupSessionRegistry;
  env: ChatGroupEnvironment;
  /** The frame chrome this tile renders inside, given the tile's own actions. */
  children: (frame: {
    actions: ReturnType<typeof buildChatGroupActions>;
    content: ReactNode;
    /** This tile's session — the frame titles itself by its OWN conversation,
     *  not the focused one, or four tiles would all wear the same name. */
    currentSessionId: string;
  }) => ReactNode;
  panelOpen: boolean;
  /** Is this the tile the window is focused on? It adopts cards no tile holds. */
  focused: boolean;
  onSidePanelOpenChange: (open: boolean) => void;
}

/**
 * ONE tile's conversation.
 *
 * Every hook here is keyed on the tile's group-bound api, so mounting this
 * twice gives two conversations that stream at the same time without either
 * seeing the other's transcript. That is the whole reason the chat state moved
 * out of App: App is the window, and a window cannot hold four transcripts in
 * one set of variables.
 */
export function ChatGroupSession({
  chatGroupId, api: windowApi, registry, env, children, panelOpen, focused, onSidePanelOpenChange,
}: ChatGroupSessionProps) {
  const { t } = useTranslation();

  const api = useMemo(() => chatGroupApi(windowApi, chatGroupId), [windowApi, chatGroupId]);
  // Stable identity: the hook re-hydrates when this changes, and the default
  // (unscoped) project is no project at all.
  const freshTileProject = useMemo(
    () => (env.activeProject && !env.activeProject.isDefault
      ? { projectRoot: env.activeProject.projectRoot, projectName: env.activeProject.projectName }
      : undefined),
    [env.activeProject],
  );

  // The tile's conversation, readable by the sub-agent frame filter before
  // useCurrentSession (below) has run this render.
  const currentSessionIdRef = useRef("");
  // Sessions of the sub-agents THIS tile spawned. A child runs its own session,
  // so anything it sends window-wide (a question card, its own frames) names an
  // id that is not the tile's — without this the child's card belongs to no
  // tile and is dropped by every one of them.
  const ownedChildSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const ownsSession = useCallback(
    (sessionId: string) =>
      sessionId === currentSessionIdRef.current || ownedChildSessionIdsRef.current.has(sessionId),
    [],
  );
  const focusedRef = useRef(focused);
  // A window-wide card whose session no tile is showing — a routine's, a side
  // chat's, a background agent's after its parent tile moved on — is adopted
  // here rather than dropped by every tile at once. `readTiles` is read at
  // delivery time, not subscribed to: the answer must reflect the window as it
  // is when the card arrives, and this predicate must stay referentially
  // stable or the channel resubscribes and loses in-flight events.
  const drawsSession = useCallback(
    (sessionId: string) => tileDrawsSession({
      tiles: registry.readTiles(),
      sessionId,
      owned: ownsSession(sessionId),
      focused: focusedRef.current,
    }),
    [registry, ownsSession],
  );
  const {
    askQuestions, subAgentSpawns, loadedSkills,
    dismissAskQuestion, resetForNewSession, restoreSubAgentSpawns,
  } = useWorkflowTools(api, { ownsSession, drawsSession });
  useLayoutEffect(() => {
    focusedRef.current = focused;
  }, [focused]);
  // Same commit-time discipline as the session id below: the listener reads the
  // ref from an IPC callback, so it must never see a render that was discarded.
  useLayoutEffect(() => {
    ownedChildSessionIdsRef.current = new Set(
      subAgentSpawns
        .map((spawn) => spawn.childSessionId)
        .filter((childSessionId): childSessionId is string => Boolean(childSessionId)),
    );
  }, [subAgentSpawns]);

  const {
    entries, streaming, isCompacting, compactTriggerSource, isRecoveryExhausted,
    beginStreamingRequest, finishStreamingRequest, markLastAssistantInterrupted, unmarkLastAssistantInterrupted,
    editingEntryIdx, setEditingEntryIdx, editBusy,
    entryIndexToHistoryIndex, handleEditSave, handleRetryEffort, handleContinueFromLastUser,
    resetStreamAccumulators, setErrorWithThought, handleCompactCommand,
    clearForNewChat, appendUserEntry, dropUserEntry, appendSystemEntry,
    applyInitialSession, applyLoadedSession, truncateToEntry,
    insertImportedTriggerEntry, fallbackToast,
  } = useChatState(api);

  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const attachmentNCounter = useRef(0);
  const [actionPanelOpen, setActionPanelOpen] = useState(false);

  // Forward-ref cycle bridge — the TILE owns this ref: use-send-message writes
  // it each render and this tile's MCP-prompt path reads it. Keeping it per
  // tile is what stops an unfocused tile's prompt from starting a turn in the
  // focused tile's conversation.
  const handleAskRef = useRef<(
    q: string,
    mode?: "default" | "trigger-import" | "app-message" | "mcp-prompt",
    userIntent?: UserKeyboardIntentSnapshot,
  ) => Promise<void>>(
    async () => { /* populated below */ },
  );

  const {
    currentSessionId, currentSessionKind, currentSessionTitle, currentSessionProject,
    refreshSessionId, handleLoadSession: sessionLoad, handleFork: sessionFork,
  } = useCurrentSession(api, {
    applyInitialSession,
    onLoadedSession: resetForNewSession,
    restoreSubAgents: restoreSubAgentSpawns,
    onSessionsChanged: env.refreshSessions,
    resumeWindowActiveSession: chatGroupId === MAIN_CHAT_GROUP_ID,
    freshProject: freshTileProject,
    focusSessionHolder: env.focusChatGroup,
  });
  // Written at commit, not in render: a render may be thrown away, and the
  // frame listener (subscribed in an effect) must not read a session this
  // tile never showed. Layout timing keeps it ahead of any IPC callback.
  useLayoutEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // A composer draft belongs to the conversation it was typed into. Switching
  // this tile to another session has to drop it, or the next session opens
  // holding attachments the user staged for a different one.
  const attachmentSessionScopeRef = useRef<{ initialized: boolean; sessionId?: string }>({
    initialized: false,
    sessionId: undefined,
  });

  useEffect(() => {
    const scope = attachmentSessionScopeRef.current;
    if (!scope.initialized) {
      scope.initialized = true;
      scope.sessionId = currentSessionId;
      return;
    }
    if (scope.sessionId === currentSessionId) return;
    scope.sessionId = currentSessionId;
    setAttachments([]);
  }, [currentSessionId]);

  const composeOutgoing = useCallback(
    (raw: string) => composeOutgoingUtil({ raw, activePreset: env.activePreset, attachments }),
    [env.activePreset, attachments],
  );
  // This is the same trimmed draft the send path composes. Both pre-send
  // surfaces consume it, so pasted text, file paths, resource text parts, and
  // images cannot drift from the actual user payload.
  const composedDraft = useMemo<ComposedOutgoing>(() => {
    const trimmedQuestion = question.trim();
    return trimmedQuestion.length > 0
      ? composeOutgoing(trimmedQuestion)
      : { text: "", attachments: [] };
  }, [question, composeOutgoing]);
  const draftTokenEstimate = useMemo(
    () => estimateOutgoingUserMessageTokens(composedDraft.text, composedDraft.attachments),
    [composedDraft],
  );

  const { usedTokens, contextBudget, effectiveBudget, contextOverflowPct, tpmLimit, tpmPct, isTpmOverflow } =
    useContextBudget({
      entries,
      llmVendor: env.subscriptionRuntimeSelected ? undefined : env.llmVendor,
      llmModel: env.subscriptionRuntimeSelected ? undefined : env.llmModel,
      draftTokenEstimate,
      enabled: env.apiUsageProjectionAvailable,
    });

  const { costEstimate, costBadgeClass } = useCostEstimate({
    entries,
    draft: composedDraft,
    llmVendor: env.subscriptionRuntimeSelected ? undefined : env.llmVendor,
    llmModel: env.subscriptionRuntimeSelected ? undefined : env.llmModel,
    maxOutputTokens: env.maxOutputTokens,
    enabled: env.apiUsageProjectionAvailable,
  });
  // Strict variant — `undefined` means "model not in catalog" so the cost
  // toggle in TokenCostBadge stays disabled rather than showing $0 from
  // FALLBACK_PRICING.
  const activePricing = useMemo(
    () => env.apiUsageProjectionAvailable
      ? lookupBillablePricingOptional(env.llmVendor, env.llmModel)
      : undefined,
    [env.apiUsageProjectionAvailable, env.llmVendor, env.llmModel],
  );

  const { handleAsk } = useSendMessage({
    api, t, streaming, checkApiKey: env.checkApiKey, composeOutgoing,
    appendUserEntry, dropUserEntry, resetStreamAccumulators,
    beginStreamingRequest, finishStreamingRequest, markLastAssistantInterrupted, unmarkLastAssistantInterrupted,
    appendSystemEntry, setErrorWithThought, handleCompactCommand, sessionLoad, applyLoadedSession,
    refreshSessionId, refreshSessions: env.refreshSessions, attachments, setAttachments,
    llmVendor: env.llmVendor, llmModel: env.llmModel,
    llmReadyWithoutApiKey: env.chatReadyWithoutApiKey,
    settingsReady: env.settingsLoaded,
    subscriptionRuntimePolicy: env.subscriptionRuntimePolicy,
    onOpenSettings: env.onOpenSettings, setQuestion, handleAskRef,
  });

  useChatStatusIndicators({
    t, isCompacting, compactTriggerSource, isRecoveryExhausted,
    statusUpsertPersistent: env.statusUpsertPersistent,
    statusRemovePersistent: env.statusRemovePersistent,
  });

  // ── conversation actions ───────────────────────────────────────────────────

  const handleLoadSession = useCallback(
    (sessionId: string) => sessionLoad(sessionId, streaming, applyLoadedSession),
    [sessionLoad, streaming, applyLoadedSession],
  );

  const handleLoadSessionAndRefresh = useCallback(async (sessionId: string) => {
    const loaded = await handleLoadSession(sessionId);
    if (loaded !== false) await env.refreshSessions();
    return loaded;
  }, [handleLoadSession, env]);

  const isEntryStarred = useCallback(
    (entryIdx: number): string | null =>
      env.starredIsEntry(entryIdx, currentSessionId, entryIndexToHistoryIndex),
    [env, currentSessionId, entryIndexToHistoryIndex],
  );

  const handleFork = useCallback(async (entryIdx: number) => {
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return;
    await sessionFork(histIdx, entryIdx, truncateToEntry);
  }, [entryIndexToHistoryIndex, sessionFork, truncateToEntry]);

  const handleToggleStar = useCallback(
    (entryIdx: number) =>
      env.starredToggle(entryIdx, entries, currentSessionId, entryIndexToHistoryIndex),
    [env, entries, currentSessionId, entryIndexToHistoryIndex],
  );

  const handleAbort = useCallback(async () => {
    // chatAbort resolves only after the turn settles as interrupted, so the
    // badge lands exactly when the stream stops — the initiator marks it, not
    // a "[중단됨]" literal pushed through the delta stream by the engine.
    try { await api.chatAbort(); } catch { /* no-op */ }
    markLastAssistantInterrupted();
  }, [api, markLastAssistantInterrupted]);

  const handleGuide = useCallback(async (
    text: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> => {
    if (text.trim().length === 0) return { ok: false, error: "empty-text" };
    try {
      const result = await api.chatGuide(text);
      // Main-process handler returns `{ ok: boolean, error?: string }`.
      // Type-narrow defensively since the IPC boundary is `Promise<unknown>`.
      if (result && typeof result === "object" && "ok" in result) {
        const r = result as { ok: boolean; error?: string };
        if (r.ok) return { ok: true };
        return { ok: false, error: r.error ?? "unknown-error" };
      }
      return { ok: false, error: "invalid-response" };
    } catch (err) {
      return { ok: false, error: (err as Error)?.message ?? "ipc-error" };
    }
  }, [api]);

  const handleFeedback = useCallback(
    async (messageIdx: number, rating: "up" | "down", reason?: string) => {
      if (!api.submitFeedback) return;
      try {
        await api.submitFeedback({
          sessionId: currentSessionId, messageIndex: messageIdx, rating, reason,
        });
      } catch { /* no-op */ }
    },
    [api, currentSessionId],
  );

  const handleImportAndLoad = useCallback(async () => {
    const sessionId = await env.onImport();
    if (!sessionId) return;
    await handleLoadSessionAndRefresh(sessionId);
  }, [env, handleLoadSessionAndRefresh]);

  const startNewChat = useCallback(
    async (project?: { projectRoot?: string; projectName?: string }) => {
      if (streaming) { console.warn("new chat blocked during streaming"); return; }
      await api.chatNew(project);
      clearForNewChat();
      resetForNewSession();
      await refreshSessionId();
      await env.refreshSessions();
    },
    [api, streaming, clearForNewChat, resetForNewSession, refreshSessionId, env],
  );

  const handleAttachmentWarning = useCallback((message: string) => {
    env.statusPushToast({ severity: "warning", message, ttlMs: 8000 });
  }, [env]);

  // ── MCP prompts ────────────────────────────────────────────────────────────
  // Arguments are collected by HOST chrome (McpPromptArgsDialog) — the renderer
  // has no `window.prompt`, and a composer draft would re-enter as
  // `user-keyboard`. An argument-less prompt skips the form entirely.
  const [mcpPromptAwaitingArgs, setMcpPromptAwaitingArgs] = useState<McpPromptEntry | null>(null);

  const runMcpPrompt = useCallback(
    async (prompt: McpPromptEntry, args: Record<string, string>) => {
      // The prompt NAME is server-authored, so it is bounded before it goes near
      // host chrome (React escapes it; this is about layout, and about the toast
      // staying readable).
      const label = prompt.name.slice(0, 64);
      const fail = (error?: string) => {
        // The handler distinguishes rate-limited from empty-prompt from
        // prompt-failed. Collapsing them into one string is what makes "it just
        // doesn't work" undiagnosable — `formatIpcError` already owns the wording
        // for each code, and falls back to the generic line for an unknown one.
        env.statusPushToast({
          severity: "error",
          message: formatIpcError(error, undefined, {
            fallbackContext: t("app.mcpPromptFailed", { name: label }),
          }),
          ttlMs: 10000,
        });
      };
      // One catch for the whole path: an IPC rejection, a missing bridge, or a
      // send-gate refusal all surface as a toast rather than an unhandled
      // rejection the user never sees.
      try {
        const outcome = await window.lvis?.mcp?.getPrompt?.(prompt.serverId, prompt.name, args);
        if (!outcome || outcome.ok !== true) {
          fail(outcome?.ok === false ? outcome.error : undefined);
          return;
        }
        // The host clipped what the server returned. Saying so is the difference
        // between a prompt that looks complete and one the user knows is partial.
        if (outcome.truncated || (outcome.omittedBlocks ?? 0) > 0) {
          env.statusPushToast({
            severity: "warning",
            message: t("app.mcpPromptClipped", { name: label }),
            ttlMs: 8000,
          });
        }
        await handleAskRef.current?.(outcome.envelope, "mcp-prompt");
      } catch {
        fail();
      }
    },
    [handleAskRef, env, t],
  );

  const handleRunMcpPrompt = useCallback((prompt: McpPromptEntry) => {
    if (prompt.arguments.length > 0) {
      setMcpPromptAwaitingArgs(prompt);
      return;
    }
    void runMcpPrompt(prompt, {});
  }, [runMcpPrompt]);

  const handleMcpPromptArgsSubmit = useCallback(
    (prompt: McpPromptEntry, args: Record<string, string>) => {
      setMcpPromptAwaitingArgs(null);
      void runMcpPrompt(prompt, args);
    },
    [runMcpPrompt],
  );

  // ── what this tile tells the window ────────────────────────────────────────

  useRegisterChatGroupSession(registry, chatGroupId, {
    entries, streaming,
    applyLoadedSession, applyInitialSession, clearForNewChat,
    resetForNewSession, restoreSubAgentSpawns,
    ask: handleAsk,
    insertImportedTriggerEntry,
    currentSessionId,
    currentSessionProject,
    loadSession: async (sessionId: string) => (await handleLoadSessionAndRefresh(sessionId)) !== false,
    fallbackToast,
    prefillComposer: setQuestion,
    appendSystemEntry,
    startNewChat,
  });

  // ── the frame's own actions ────────────────────────────────────────────────

  const actions = useMemo(
    () => buildChatGroupActions({
      t,
      pinned: Boolean(currentSessionId && env.isSessionStarred(currentSessionId)),
      onTogglePin: () =>
        currentSessionId
          ? env.handleToggleSessionStar(
              currentSessionId,
              env.sessions.find((s) => s.id === currentSessionId)?.title,
            )
          : Promise.resolve(),
      onExport: env.onExport,
      onImport: handleImportAndLoad,
    }),
    [t, currentSessionId, env, handleImportAndLoad],
  );

  const chatContextValue = useMemo<ChatContextValue>(() => ({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, currentSessionId,
    hasApiKey: env.effectiveLlmReady, settingsLoaded: env.settingsLoaded,
    onOpenSettings: env.onOpenSettings,
    ...env.search,
    contextOverflowPct, usedTokens, contextBudget, effectiveBudget,
    tpmLimit, tpmPct, isTpmOverflow,
    usageAvailable: env.apiUsageProjectionAvailable,
    rolePresets: env.rolePresets, activePreset: env.activePreset,
    activePresetId: env.activePresetId, setActivePresetId: env.setActivePresetId,
    subscriptionRuntimePolicy: env.subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider: env.subscriptionImageAttachmentProvider,
    subscriptionFileAttachmentProvider: env.subscriptionFileAttachmentProvider,
    subscriptionUnavailableProvider: env.subscriptionUnavailableProvider,
    subscriptionPendingProvider: env.subscriptionPendingProvider,
    attachments, setAttachments, attachmentNCounter,
    enableThinkingChat: env.enableThinkingChat,
    reasoningAvailable: env.chatReasoningAvailable,
    toggleThinking: env.toggleThinking, costEstimate, costBadgeClass,
    activePricing,
    activeVendor: env.apiUsageProjectionAvailable ? env.llmVendor : undefined,
  }), [
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, currentSessionId, env,
    contextOverflowPct, usedTokens, contextBudget, effectiveBudget,
    tpmLimit, tpmPct, isTpmOverflow,
    attachments, costEstimate, costBadgeClass, activePricing,
  ]);

  const content = (
    <ChatContextProvider value={chatContextValue}>
      <ChatView
        api={api}
        onAsk={(q, intent, opts) => handleAsk(q, "default", intent, opts)}
        /* opts 의 inputOrigin / injectHint 가 그대로 handleAsk 4번째
           인자로 전달 — queue-auto inject path 활성. */
        onRunMcpPrompt={handleRunMcpPrompt}
        onEditSave={handleEditSave}
        onFork={handleFork}
        onToggleStar={handleToggleStar}
        onRetryEffort={handleRetryEffort}
        onContinueFromLastUser={handleContinueFromLastUser}
        isEntryStarred={isEntryStarred}
        onAbort={handleAbort}
        onGuide={handleGuide}
        onGuideError={(msg) => appendSystemEntry(t("app.guideErrorMessage", { msg }))}
        onFeedback={handleFeedback}
        subAgentSpawns={subAgentSpawns}
        loadedSkills={loadedSkills}
        hasAskQuestions={askQuestions.length > 0}
        askQuestions={askQuestions}
        onResolveAskQuestion={dismissAskQuestion}
        approvalSentenceInterceptSubmit={env.approvalSentenceInterceptSubmit}
        plugins={env.plugins}
        onSelectPlugin={env.onSelectPlugin}
        appMode={env.appMode}
        onOpenApprovalQueue={env.onOpenApprovalQueue}
        currentSessionKind={currentSessionKind}
        currentSessionTitle={currentSessionTitle}
        onLoadSession={handleLoadSessionAndRefresh}
        commandActions={env.commandActions}
        commandPopoverOpen={env.commandPopoverOpen}
        onCommandPopoverOpenChange={env.onCommandPopoverOpenChange}
        onPluginPrimaryAction={env.onPluginPrimaryAction}
        onRoutineAcknowledge={env.onRoutineAcknowledge}
        statusBar={env.statusBar}
        onAttachmentWarning={handleAttachmentWarning}
        actionPanelOpen={actionPanelOpen}
        onActionPanelOpenChange={setActionPanelOpen}
        sidePanelOpen={panelOpen}
        onSidePanelOpenChange={onSidePanelOpenChange}
        blogLayout={env.appMode === "work"}
        activeProject={env.activeProject}
        workspaceProjects={env.workspaceProjects}
        onNewChatForProject={env.onNewChatForProject}
        onRefreshProjects={env.onRefreshProjects}
        onProjectError={env.onProjectError}
      />
      {/* The arguments form belongs to the tile that asked for the prompt:
          a window-level dialog would send the result to whichever tile
          happened to be focused when the user finished typing. */}
      <McpPromptArgsDialog
        prompt={mcpPromptAwaitingArgs}
        onCancel={() => setMcpPromptAwaitingArgs(null)}
        onSubmit={handleMcpPromptArgsSubmit}
      />
    </ChatContextProvider>
  );

  return <>{children({ actions, content, currentSessionId })}</>;
}

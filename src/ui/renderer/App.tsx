import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { composeOutgoing as composeOutgoingUtil } from "./utils/compose.js";
import { vendorSupportsThinking as vendorSupportsThinkingShared } from "../../shared/vendor-capabilities.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";

// ─── Phase 2 split: types / constants / helpers / components / tabs ──
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { ApprovalQueueStatus } from "./components/ApprovalQueueStatus.js";
import { CommandPaletteDialog } from "./dialogs/CommandPaletteDialog.js";
import { MainToolbar } from "./MainToolbar.js";
import { MainContent } from "./MainContent.js";
import { Sidebar } from "./Sidebar.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { useSettings } from "./hooks/use-settings.js";
import { useChatState } from "./hooks/use-chat-state.js";
import { useBriefing } from "./hooks/use-briefing.js";
import { useApproval } from "./hooks/use-approval.js";
import { useSearch } from "./hooks/use-search.js";
import { useContextBudget } from "./hooks/use-context-budget.js";
import { useCostEstimate } from "./hooks/use-cost-estimate.js";
import { useStarred } from "./hooks/use-starred.js";
import { useSessions } from "./hooks/use-sessions.js";
import { useMarketplaceUpdates } from "./hooks/use-marketplace-updates.js";
import { MarketplaceUpdateBanner } from "./components/MarketplaceUpdateBanner.js";
import { DropZoneOverlay } from "./components/DropZoneOverlay.js";
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { useIndexedDocs } from "./hooks/use-indexed-docs.js";
import { useRolePresets } from "./hooks/use-role-presets.js";
import { useAppBootstrap } from "./hooks/use-app-bootstrap.js";
import { useChatActions } from "./hooks/use-chat-actions.js";
import { useChatContextValue } from "./hooks/use-chat-context-value.js";

// Phase 1 tests import `BriefingCard` from this module; preserve the export.
export { BriefingCard } from "./components/BriefingCard.js";

// ─── App ────────────────────────────────────────────

export function App() {
  const api = useMemo(() => getApi(), []);

  // Chat state + stream lifecycle (useChatState is the sole owner of entries).
  const {
    entries, streaming, setStreaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    entryIndexToHistoryIndex, handleEditSave, handleRetryEffort,
    resetStreamAccumulators, setErrorWithThought, handleCompactCommand,
    seedBriefing, clearForNewChat, appendUserEntry, applyLoadedSession, truncateToEntry,
    fallbackToast,
  } = useChatState(api);
  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // App state
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeView, setActiveView] = useState("home");
  const [commandOpen, setCommandOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { briefing, dismiss: dismissBriefing, snooze: snoozeBriefing } = useBriefing(api);
  const { updates: marketplaceUpdates, dismiss: dismissMarketplaceUpdates } = useMarketplaceUpdates(api);
  const { queue: approvalQueue, decide: handleApprovalDecide, decideAll: handleApprovalDecideAll } = useApproval();

  // Marketplace + plugin UI extensions
  const {
    pluginViews,
    refreshViews, refreshMarketplace,
  } = usePluginMarketplace(api);

  // Sprint B — role preset, cost preview, attached docs, language lock
  const { rolePresets, activePreset, activePresetId, setActivePresetId } = useRolePresets();
  const [attachedDocs, setAttachedDocs] = useState<Array<{ id: string; name: string }>>([]);
  const [docPopoverOpen, setDocPopoverOpen] = useState(false);
  const { indexedDocs, docsLoading, refreshIndexedDocs } = useIndexedDocs(api);
  const [langLock, setLangLock] = useState<"off" | "ko" | "en">("off");
  const [maxOutputTokens] = useState<number>(4096);

  // Search / starred / sessions
  const {
    open: searchOpen, query: searchQuery, caseSensitive: searchCase,
    matches: searchMatches, matchSet: searchMatchSet, matchIdx: searchIdx, highlight: searchHighlight,
    changeQuery: searchChangeQuery, toggleCase: searchToggleCase,
    toggleOverlay: searchToggleOverlay, closeOverlay: searchCloseOverlay,
    nextMatch: searchNext, prevMatch: searchPrev,
  } = useSearch(entries);
  const { starred, refreshStarred, isEntryStarred: starredIsEntry, handleToggleStar: starredToggle } = useStarred(api);
  const {
    currentSessionId, sessions, refreshSessionId, refreshSessions,
    handleLoadSession: sessionLoad, handleFork: sessionFork,
  } = useSessions(api);

  // Small adapter callbacks that bridge hook outputs to ChatView / MainToolbar.
  const {
    handleLoadSession, isEntryStarred, handleFork, handleToggleStar,
    handleAbort, handleFeedback, handleExport,
  } = useChatActions({
    api, streaming, currentSessionId, entries, entryIndexToHistoryIndex,
    applyLoadedSession, truncateToEntry, sessionLoad, sessionFork,
    starredIsEntry, starredToggle,
  });

  // LLM settings + context budget (single source of truth: src/shared/pricing-data.ts)
  const { llmVendor, llmModel, enableThinkingChat, refresh: refreshLlmSettings, toggleThinking } = useSettings(api);
  const { usedTokens, contextBudget, contextPercent, contextColor, contextOverflowPct } =
    useContextBudget({ entries, llmVendor, llmModel });

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);
  const vendorSupportsThinking = useMemo(() => vendorSupportsThinkingShared(llmVendor, llmModel), [llmVendor, llmModel]);
  const composeOutgoing = useCallback(
    (raw: string): string => composeOutgoingUtil({ raw, activePreset, attachedDocs, langLock }),
    [activePreset, attachedDocs, langLock],
  );

  const handleAsk = useCallback(async (q: string) => {
    const t = q.trim(); if (!t || streaming) return;
    if (await handleCompactCommand(t)) return;
    if (!(await checkApiKey())) { setSettingsOpen(true); return; }
    setQuestion("");
    const outgoing = composeOutgoing(t);
    appendUserEntry(t);
    resetStreamAccumulators();
    setStreaming(true);
    try {
      await api.chatSend(outgoing);
      // Final state set by stream events + done
    } catch (err) {
      setErrorWithThought(`오류: ${(err as Error).message}`);
    } finally { setStreaming(false); }
  }, [api, streaming, checkApiKey, composeOutgoing, appendUserEntry, resetStreamAccumulators, setStreaming, setErrorWithThought, handleCompactCommand]);

  const { costEstimate, costBadgeClass } =
    useCostEstimate({ entries, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing });

  const handleNewChat = useCallback(async () => {
    if (streaming) { console.warn("new chat blocked during streaming"); return; }
    await api.chatNew(); clearForNewChat(); void refreshSessionId();
  }, [api, streaming, refreshSessionId, clearForNewChat]);

  // ─── Effects ──────────────────────────────────
  useAppBootstrap({
    api, refreshMarketplace, refreshViews, checkApiKey,
    seedBriefing, setActiveView,
    openCommandPalette: () => setCommandOpen(true),
  });
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [entries]);

  // Refresh plugin views + marketplace catalog when a lvis:// deep-link
  // install completes in the main process, so new sidebar tabs appear
  // (and uninstalled ones disappear) without requiring an app restart.
  useEffect(() => {
    if (typeof api.onPluginInstallResult !== "function") return;
    const unsubscribe = api.onPluginInstallResult(({ success }) => {
      if (!success) return;
      void refreshViews();
      void refreshMarketplace();
    });
    return unsubscribe;
  }, [api, refreshViews, refreshMarketplace]);

  const commandActions = useMemo(() => [
    { id: "home", label: "홈으로 이동", run: () => setActiveView("home") },
    { id: "tasks", label: "태스크 보기", run: () => setActiveView("tasks") },
    { id: "settings", label: "설정 열기", run: () => setSettingsOpen(true) },
    { id: "new-chat", label: "새 대화 시작", run: () => void handleNewChat() },
    ...pluginViews.map((i) => ({ id: `v:${toViewKey(i)}`, label: `${getPluginViewLabel(i)} 열기`, run: () => setActiveView(toViewKey(i)) })),
  ], [pluginViews, handleNewChat]);

  const onOpenSettings = useCallback(() => setSettingsOpen(true), []);

  // ChatView context bundle — avoids drilling ~40 props through the tree.
  const chatContextValue = useChatContextValue({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, hasApiKey, onOpenSettings,
    briefing, onDismissBriefing: dismissBriefing, onSnoozeBriefing: snoozeBriefing,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay,
    contextOverflowPct, usedTokens, contextBudget, contextPercent, contextColor,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachedDocs, setAttachedDocs, docPopoverOpen, setDocPopoverOpen,
    indexedDocs, docsLoading, refreshIndexedDocs, langLock, setLangLock,
    vendorSupportsThinking, enableThinkingChat, toggleThinking, costEstimate, costBadgeClass,
  });

  // ─── Render ───────────────────────────────────
  return (
    <ErrorBoundary fallback="앱 오류가 발생했습니다">
    <TooltipProvider>
      <div className="flex h-screen">
        <Sidebar
          pluginViews={pluginViews}
          setActiveView={setActiveView}
        />

        <main className="flex min-h-0 flex-col flex-1">
          <MarketplaceUpdateBanner updates={marketplaceUpdates} onDismiss={dismissMarketplaceUpdates} />
          {fallbackToast && (
            <div className="bg-yellow-100 text-yellow-800 text-xs px-4 py-2 border-b border-yellow-200">
              {fallbackToast}
            </div>
          )}
          <MainToolbar
            activeView={activeView}
            setActiveView={setActiveView}
            pluginViews={pluginViews}
            starredCount={starred.length}
            streaming={streaming}
            hasApiKey={hasApiKey}
            sessions={sessions}
            currentSessionId={currentSessionId}
            sheetOpen={sheetOpen}
            setSheetOpen={setSheetOpen}
            onNewChat={() => void handleNewChat()}
            onRefreshSessions={refreshSessions}
            onLoadSession={handleLoadSession}
            onExport={handleExport}
            onSearchToggle={searchToggleOverlay}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenCommand={() => setCommandOpen(true)}
          />

          <MainContent
            activeView={activeView}
            api={api}
            starred={starred}
            currentSessionId={currentSessionId}
            refreshStarred={refreshStarred}
            onActivateHome={() => setActiveView("home")}
            onJumpToSession={handleLoadSession}
            chatContextValue={chatContextValue}
            onAsk={handleAsk}
            onEditSave={handleEditSave}
            onFork={handleFork}
            onToggleStar={handleToggleStar}
            onRetryEffort={handleRetryEffort}
            isEntryStarred={isEntryStarred}
            onAbort={handleAbort}
            onFeedback={handleFeedback}
            activePluginView={activePluginView ?? null}
          />
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} api={api} onSaved={() => { void checkApiKey(); void refreshLlmSettings(); }} />
      <ApprovalDialog queue={approvalQueue} onDecide={handleApprovalDecide} onDecideAll={handleApprovalDecideAll} />
      <ApprovalQueueStatus queue={approvalQueue} />
      <CommandPaletteDialog open={commandOpen} onOpenChange={setCommandOpen} actions={commandActions} />
      <DropZoneOverlay />
    </TooltipProvider>
    </ErrorBoundary>
  );
}

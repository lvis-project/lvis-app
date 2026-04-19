import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { composeOutgoing as composeOutgoingUtil } from "./utils/compose.js";
import { vendorSupportsThinking as vendorSupportsThinkingShared } from "../../shared/vendor-capabilities.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { PluginUiHostView } from "../../plugin-ui-host.js";

// ─── Phase 2 split: types / constants / helpers / components / tabs ──
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { PluginInstallDialog } from "./dialogs/PluginInstallDialog.js";
import { PluginUninstallDialog } from "./dialogs/PluginUninstallDialog.js";
import { CommandPaletteDialog } from "./dialogs/CommandPaletteDialog.js";
import { TaskView } from "./components/TaskView.js";
import { StarredView } from "./components/StarredView.js";
import { MainToolbar } from "./MainToolbar.js";
import { ChatView } from "./ChatView.js";
import { ChatContextProvider, type ChatContextValue } from "./context/ChatContext.js";
import { Sidebar } from "./Sidebar.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { RolesTab } from "./tabs/RolesTab.js";
import { PermissionsTab } from "./tabs/PermissionsTab.js";
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
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { useIndexedDocs } from "./hooks/use-indexed-docs.js";
import { useRolePresets } from "./hooks/use-role-presets.js";
import { useAppBootstrap } from "./hooks/use-app-bootstrap.js";

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
  const { queue: approvalQueue, decide: handleApprovalDecide } = useApproval();

  // Marketplace + plugin UI extensions
  const {
    marketplace, pluginViews, marketStatus, working,
    refreshViews, refreshMarketplace, installPlugin, uninstallPlugin,
  } = usePluginMarketplace(api);
  type MarketplaceItem = (typeof marketplace)[number];
  const [installTarget, setInstallTarget] = useState<MarketplaceItem | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<MarketplaceItem | null>(null);

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

  const handleLoadSession = useCallback(
    (sessionId: string) => sessionLoad(sessionId, streaming, applyLoadedSession),
    [sessionLoad, streaming, applyLoadedSession],
  );

  const isEntryStarred = useCallback(
    (entryIdx: number): string | null => starredIsEntry(entryIdx, currentSessionId, entryIndexToHistoryIndex),
    [starredIsEntry, currentSessionId, entryIndexToHistoryIndex],
  );

  const handleFork = useCallback(async (entryIdx: number) => {
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return;
    await sessionFork(histIdx, entryIdx, truncateToEntry);
  }, [entryIndexToHistoryIndex, sessionFork, truncateToEntry]);

  const handleToggleStar = useCallback(
    (entryIdx: number) => starredToggle(entryIdx, entries, currentSessionId, entryIndexToHistoryIndex),
    [starredToggle, entries, currentSessionId, entryIndexToHistoryIndex],
  );

  const handleAbort = useCallback(async () => {
    try { await api.chatAbort(); } catch { /* no-op */ }
  }, [api]);

  const handleExport = useCallback(async (format: "markdown" | "json") => {
    try { await api.chatExport(format); } catch (err) { console.warn("[lvis] export failed:", (err as Error).message); }
  }, [api]);

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

  const commandActions = useMemo(() => [
    { id: "home", label: "홈으로 이동", run: () => setActiveView("home") },
    { id: "tasks", label: "태스크 보기", run: () => setActiveView("tasks") },
    { id: "settings", label: "설정 열기", run: () => setSettingsOpen(true) },
    { id: "new-chat", label: "새 대화 시작", run: () => void handleNewChat() },
    ...pluginViews.map((i) => ({ id: `v:${toViewKey(i)}`, label: `${getPluginViewLabel(i)} 열기`, run: () => setActiveView(toViewKey(i)) })),
  ], [pluginViews, handleNewChat]);

  const onOpenSettings = useCallback(() => setSettingsOpen(true), []);

  // ChatView context bundle — avoids drilling ~40 props through the tree.
  const chatContextValue = useMemo<ChatContextValue>(() => ({
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, hasApiKey,
    onOpenSettings,
    briefing, onDismissBriefing: dismissBriefing, onSnoozeBriefing: snoozeBriefing,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay,
    contextOverflowPct, usedTokens, contextBudget, contextPercent, contextColor,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachedDocs, setAttachedDocs, docPopoverOpen, setDocPopoverOpen,
    indexedDocs, docsLoading, refreshIndexedDocs, langLock, setLangLock,
    vendorSupportsThinking, enableThinkingChat, toggleThinking, costEstimate, costBadgeClass,
  }), [
    entries, streaming, editingEntryIdx, setEditingEntryIdx, editBusy,
    question, setQuestion, chatEndRef, hasApiKey,
    onOpenSettings,
    briefing, dismissBriefing, snoozeBriefing,
    searchOpen, searchQuery, searchCase, searchMatches, searchMatchSet, searchIdx, searchHighlight,
    searchChangeQuery, searchToggleCase, searchNext, searchPrev, searchCloseOverlay,
    contextOverflowPct, usedTokens, contextBudget, contextPercent, contextColor,
    rolePresets, activePreset, activePresetId, setActivePresetId,
    attachedDocs, setAttachedDocs, docPopoverOpen, setDocPopoverOpen,
    indexedDocs, docsLoading, refreshIndexedDocs, langLock, setLangLock,
    vendorSupportsThinking, enableThinkingChat, toggleThinking, costEstimate, costBadgeClass,
  ]);

  // ─── Render ───────────────────────────────────
  return (
    <TooltipProvider>
      <div className="grid h-screen grid-cols-[320px_1fr]">
        {/* Sidebar */}
        <Sidebar
          marketStatus={marketStatus}
          marketplace={marketplace}
          pluginViews={pluginViews}
          working={working}
          setInstallTarget={setInstallTarget}
          setUninstallTarget={setUninstallTarget}
          setActiveView={setActiveView}
        />

        {/* Main */}
        <main className="flex min-h-0 flex-col">
          <MarketplaceUpdateBanner updates={marketplaceUpdates} onDismiss={dismissMarketplaceUpdates} />
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

          {/* Content */}
          {activeView === "tasks" ? <TaskView api={api} /> : activeView === "starred" ? (
            <StarredView
              api={api}
              starred={starred}
              currentSessionId={currentSessionId}
              refreshStarred={refreshStarred}
              onJumpToSession={handleLoadSession}
              onActivateHome={() => setActiveView("home")}
            />
          ) : activeView === "home" ? (
            <ChatContextProvider value={chatContextValue}>
              <ChatView
                onAsk={handleAsk}
                onEditSave={handleEditSave}
                onFork={handleFork}
                onToggleStar={handleToggleStar}
                onRetryEffort={handleRetryEffort}
                isEntryStarred={isEntryStarred}
                onAbort={handleAbort}
              />
            </ChatContextProvider>
          ) : (
            <PluginUiHostView view={activePluginView ?? null} callPluginMethod={(m, p) => api.callPluginMethod(m, p)} onAskInHomeChat={async (q) => { setActiveView("home"); await handleAsk(q); }} onAddTask={(t) => api.addTask(t)} />
          )}
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} api={api} onSaved={() => { void checkApiKey(); void refreshLlmSettings(); }} />
      <ApprovalDialog queue={approvalQueue} onDecide={handleApprovalDecide} />
      <PluginInstallDialog target={installTarget} onClose={() => setInstallTarget(null)} onConfirm={installPlugin} working={working} />
      <CommandPaletteDialog open={commandOpen} onOpenChange={setCommandOpen} actions={commandActions} />
      <PluginUninstallDialog target={uninstallTarget} onClose={() => setUninstallTarget(null)} onConfirm={uninstallPlugin} working={working} />
    </TooltipProvider>
  );
}


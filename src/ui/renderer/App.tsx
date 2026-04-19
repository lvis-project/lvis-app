import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import {
  DEFAULT_ROLE_PRESETS,
  ROLE_PRESETS_CHANGED_EVENT,
  loadRolePresets,
  type RolePreset,
} from "../../data/role-presets.js";
import { composeOutgoing as composeOutgoingUtil } from "./utils/compose.js";
import { vendorSupportsThinking as vendorSupportsThinkingShared } from "../../shared/vendor-capabilities.js";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../components/ui/command.js";
import { PluginUiHostView } from "../../plugin-ui-host.js";

// ─── Phase 2 split: types / constants / helpers / components / tabs ──
import type {
  MarketplaceItem,
  PluginUiExtension,
} from "./types.js";
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { PluginInstallDialog } from "./dialogs/PluginInstallDialog.js";
import { PluginUninstallDialog } from "./dialogs/PluginUninstallDialog.js";
import { TaskView } from "./components/TaskView.js";
import { StarredView } from "./components/StarredView.js";
import { MainToolbar } from "./MainToolbar.js";
import { ChatView } from "./ChatView.js";
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

// Phase 1 tests import `BriefingCard` from this module; preserve the export.
export { BriefingCard } from "./components/BriefingCard.js";

// ─── App ────────────────────────────────────────────

export function App() {
  const api = useMemo(() => getApi(), []);

  // Chat state — Phase 3.2 hook
  const {
    entries,
    streaming,
    setStreaming,
    editingEntryIdx,
    setEditingEntryIdx,
    editBusy,
    entryIndexToHistoryIndex,
    handleEditSave,
    handleRetryEffort,
    resetStreamAccumulators,
    setErrorWithThought,
    seedBriefing,
    clearForNewChat,
    appendUserEntry,
    applyLoadedSession,
    truncateToEntry,
  } = useChatState(api);
  const [question, setQuestion] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);

  // App state
  const [hasApiKey, setHasApiKey] = useState<boolean | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [marketplace, setMarketplace] = useState<MarketplaceItem[]>([]);
  const [pluginViews, setPluginViews] = useState<PluginUiExtension[]>([]);
  const [activeView, setActiveView] = useState("home");
  const [marketStatus, setMarketStatus] = useState("로딩 중...");
  const [installTarget, setInstallTarget] = useState<MarketplaceItem | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<MarketplaceItem | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const { briefing, dismiss: dismissBriefing, snooze: snoozeBriefing } = useBriefing(api);
  const { queue: approvalQueue, decide: handleApprovalDecide } = useApproval();

  // Sprint B — role preset, cost preview, attached docs, language lock
  const [rolePresets, setRolePresets] = useState<RolePreset[]>(() => DEFAULT_ROLE_PRESETS);
  useEffect(() => {
    setRolePresets(loadRolePresets());
    // Keep the App-level preset list in sync with edits made in the Settings
    // "역할" tab — saveRolePresets / resetRolePresets dispatch this event so
    // the chat preset dropdown reflects edits without requiring a restart.
    const onChanged = () => setRolePresets(loadRolePresets());
    window.addEventListener(ROLE_PRESETS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ROLE_PRESETS_CHANGED_EVENT, onChanged);
  }, []);
  const [activePresetId, setActivePresetId] = useState<string>("default");
  const activePreset = useMemo(
    () => rolePresets.find((p) => p.id === activePresetId) ?? rolePresets[0] ?? null,
    [rolePresets, activePresetId],
  );
  const [attachedDocs, setAttachedDocs] = useState<Array<{ id: string; name: string }>>([]);
  const [docPopoverOpen, setDocPopoverOpen] = useState(false);
  const [indexedDocs, setIndexedDocs] = useState<Array<{ id: string; name: string }>>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [langLock, setLangLock] = useState<"off" | "ko" | "en">("off");
  const [maxOutputTokens] = useState<number>(4096);

  // Sprint 4.C — conversation UX state (editingEntryIdx / editBusy now in useChatState)
  const {
    open: searchOpen,
    query: searchQuery,
    caseSensitive: searchCase,
    matches: searchMatches,
    matchSet: searchMatchSet,
    matchIdx: searchIdx,
    highlight: searchHighlight,
    changeQuery: searchChangeQuery,
    toggleCase: searchToggleCase,
    toggleOverlay: searchToggleOverlay,
    closeOverlay: searchCloseOverlay,
    nextMatch: searchNext,
    prevMatch: searchPrev,
  } = useSearch(entries);
  const { starred, refreshStarred, isEntryStarred: starredIsEntry, handleToggleStar: starredToggle } = useStarred(api);
  const {
    currentSessionId,
    sessions,
    refreshSessionId,
    refreshSessions,
    handleLoadSession: sessionLoad,
    handleFork: sessionFork,
  } = useSessions(api);

  const handleLoadSession = useCallback(
    (sessionId: string) => sessionLoad(sessionId, streaming, applyLoadedSession),
    [sessionLoad, streaming, applyLoadedSession],
  );

  const isEntryStarred = useCallback(
    (entryIdx: number): string | null => starredIsEntry(entryIdx, currentSessionId, entryIndexToHistoryIndex),
    [starredIsEntry, currentSessionId, entryIndexToHistoryIndex],
  );

  // ─── Search (Ctrl/Cmd+F) — provided by useSearch hook ─────

  // ─── Fork (Phase 5 hook) ──────────────────────────────────────
  const handleFork = useCallback(
    async (entryIdx: number) => {
      const histIdx = entryIndexToHistoryIndex.get(entryIdx);
      if (histIdx === undefined) return;
      await sessionFork(histIdx, entryIdx, truncateToEntry);
    },
    [entryIndexToHistoryIndex, sessionFork, truncateToEntry],
  );

  // ─── Retry with deeper thinking — provided by useChatState ─────

  // ─── Star toggle (Phase 5 hook) ───────────────────────────────
  const handleToggleStar = useCallback(
    (entryIdx: number) => starredToggle(entryIdx, entries, currentSessionId, entryIndexToHistoryIndex),
    [starredToggle, entries, currentSessionId, entryIndexToHistoryIndex],
  );

  // ─── Export ────────────────────────────────────
  const handleExport = useCallback(async (format: "markdown" | "json") => {
    try { await api.chatExport(format); } catch (err) { console.warn("[lvis] export failed:", (err as Error).message); }
  }, [api]);

  // Sprint 4.B — context overflow tracking + LLM settings cache (Phase 3.1 hook)
  const {
    llmVendor,
    llmModel,
    enableThinkingChat,
    refresh: refreshLlmSettings,
    toggleThinking,
  } = useSettings(api);

  // Context window, overflow %, usedTokens, and badge color — Phase 5 hook.
  // Single source of truth for context-window values is `src/shared/pricing-data.ts`.
  const {
    usedTokens,
    contextBudget,
    contextPercent,
    contextColor,
    contextOverflowPct,
  } = useContextBudget({ entries, llmVendor, llmModel });

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);

  const vendorSupportsThinking = useMemo(
    () => vendorSupportsThinkingShared(llmVendor, llmModel),
    [llmVendor, llmModel],
  );
  // ─── Sprint B: compose outgoing message with preset + language + attached docs ──
  const composeOutgoing = useCallback(
    (raw: string): string => composeOutgoingUtil({ raw, activePreset, attachedDocs, langLock }),
    [activePreset, attachedDocs, langLock],
  );

  // ─── Chat ─────────────────────────────────────
  const handleAsk = useCallback(async (q: string) => {
    const t = q.trim(); if (!t || streaming) return;
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
  }, [api, streaming, checkApiKey, composeOutgoing, appendUserEntry, resetStreamAccumulators, setStreaming, setErrorWithThought]);

  // ─── Sprint B: PageIndex document list loader ───────────────
  const refreshIndexedDocs = useCallback(async () => {
    setDocsLoading(true);
    try {
      const cards = await api.listPluginCards();
      const indexPlugin = cards.find((c) => c.capabilities.includes("knowledge-index"));
      const listTool = indexPlugin?.tools.find((t) => /list.*document/i.test(t));
      let result: unknown = null;
      if (listTool) {
        try { result = await api.callPluginMethod(listTool, {}); } catch { /* no-op */ }
      }
      const list = Array.isArray(result) ? result : (result as any)?.documents ?? (result as any)?.items ?? [];
      const normalized: Array<{ id: string; name: string }> = (list as any[])
        .map((d) => ({ id: String(d.id ?? d.docId ?? d.path ?? ""), name: String(d.name ?? d.title ?? d.filename ?? d.path ?? d.id ?? "") }))
        .filter((d) => d.id && d.name);
      setIndexedDocs(normalized);
    } catch {
      setIndexedDocs([]);
    } finally {
      setDocsLoading(false);
    }
  }, [api]);

  // ─── Sprint B: pre-send cost estimate (Phase 5 hook) ─────────────
  const { costEstimate, costBadgeClass } = useCostEstimate({
    entries,
    question,
    llmVendor,
    llmModel,
    maxOutputTokens,
    composeOutgoing,
  });

  const handleNewChat = useCallback(async () => { await api.chatNew(); clearForNewChat(); void refreshSessionId(); }, [api, refreshSessionId, clearForNewChat]);

  // ─── Plugin actions ───────────────────────────
  const refreshViews = async () => { const v = (await api.listPluginUiExtensions()).filter((i) => i.extension.slot === "sidebar"); setPluginViews(v); return v; };
  const refreshMarketplace = async () => { try { setMarketStatus("로딩 중..."); const l = await api.listMarketplacePlugins(); setMarketplace(l); setMarketStatus(`플러그인 ${l.length}개`); } catch (e) { setMarketStatus(`실패: ${(e as Error).message}`); } };
  const installPlugin = async (id: string) => { setWorking(true); try { await api.installMarketplacePlugin(id); await refreshMarketplace(); await refreshViews(); setMarketStatus(`설치 완료: ${id}`); } catch (e) { setMarketStatus(`설치 실패: ${(e as Error).message}`); } finally { setWorking(false); } };
  const uninstallPlugin = async (id: string) => { setWorking(true); try { await api.uninstallMarketplacePlugin(id); await refreshMarketplace(); await refreshViews(); setMarketStatus(`제거 완료: ${id}`); } catch (e) { setMarketStatus(`제거 실패: ${(e as Error).message}`); } finally { setWorking(false); } };

  // ─── Effects ──────────────────────────────────
  // PR#44 HIGH: guard setBriefing against late/async callbacks firing after
  // this component unmounts. The IPC unsubscribe (db()) runs in cleanup, but
  // the bridge may still invoke our handler once between the unmount and the
  // renderer hearing the IPC off. Keep a mounted flag we can check.
  const isMountedRef = useRef(true);
  useEffect(() => {
    void refreshMarketplace(); void refreshViews(); void checkApiKey();

    // 앱 시작 시 데일리 브리핑을 채팅 메시지로 전달
    api.getBriefing().then((text) => {
      if (text && isMountedRef.current) seedBriefing([{ kind: "assistant", text }]);
    }).catch(() => {});
    const dv = api.onViewActivate((k) => { if (isMountedRef.current) setActiveView(k); });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandOpen(true); }
      // Sprint 4.C: Ctrl/Cmd+F handled by useSearch hook
    };
    window.addEventListener("keydown", onKey);
    return () => {
      isMountedRef.current = false;
      dv();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [entries]);

  const commandActions = useMemo(() => [
    { id: "home", label: "홈으로 이동", run: () => setActiveView("home") },
    { id: "tasks", label: "태스크 보기", run: () => setActiveView("tasks") },
    { id: "settings", label: "설정 열기", run: () => setSettingsOpen(true) },
    { id: "new-chat", label: "새 대화 시작", run: () => void handleNewChat() },
    ...pluginViews.map((i) => ({ id: `v:${toViewKey(i)}`, label: `${getPluginViewLabel(i)} 열기`, run: () => setActiveView(toViewKey(i)) })),
  ], [pluginViews, handleNewChat]);

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
            <ChatView
              entries={entries}
              streaming={streaming}
              editingEntryIdx={editingEntryIdx}
              setEditingEntryIdx={setEditingEntryIdx}
              editBusy={editBusy}
              question={question}
              setQuestion={setQuestion}
              chatEndRef={chatEndRef}
              hasApiKey={hasApiKey}
              onOpenSettings={() => setSettingsOpen(true)}
              briefing={briefing}
              onDismissBriefing={dismissBriefing}
              onSnoozeBriefing={snoozeBriefing}
              searchOpen={searchOpen}
              searchQuery={searchQuery}
              searchCase={searchCase}
              searchMatches={searchMatches}
              searchMatchSet={searchMatchSet}
              searchIdx={searchIdx}
              searchHighlight={searchHighlight}
              searchChangeQuery={searchChangeQuery}
              searchToggleCase={searchToggleCase}
              searchNext={searchNext}
              searchPrev={searchPrev}
              searchCloseOverlay={searchCloseOverlay}
              contextOverflowPct={contextOverflowPct}
              usedTokens={usedTokens}
              contextBudget={contextBudget}
              contextPercent={contextPercent}
              contextColor={contextColor}
              rolePresets={rolePresets}
              activePreset={activePreset}
              activePresetId={activePresetId}
              setActivePresetId={setActivePresetId}
              attachedDocs={attachedDocs}
              setAttachedDocs={setAttachedDocs}
              docPopoverOpen={docPopoverOpen}
              setDocPopoverOpen={setDocPopoverOpen}
              indexedDocs={indexedDocs}
              docsLoading={docsLoading}
              refreshIndexedDocs={refreshIndexedDocs}
              langLock={langLock}
              setLangLock={setLangLock}
              vendorSupportsThinking={vendorSupportsThinking}
              enableThinkingChat={enableThinkingChat}
              toggleThinking={toggleThinking}
              costEstimate={costEstimate}
              costBadgeClass={costBadgeClass}
              onAsk={handleAsk}
              onEditSave={handleEditSave}
              onFork={handleFork}
              onToggleStar={handleToggleStar}
              onRetryEffort={handleRetryEffort}
              isEntryStarred={isEntryStarred}
            />
          ) : (
            <PluginUiHostView view={activePluginView ?? null} callPluginMethod={(m, p) => api.callPluginMethod(m, p)} onAskInHomeChat={async (q) => { setActiveView("home"); await handleAsk(q); }} onAddTask={(t) => api.addTask(t)} />
          )}
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} api={api} onSaved={() => { void checkApiKey(); void refreshLlmSettings(); }} />
      <ApprovalDialog queue={approvalQueue} onDecide={handleApprovalDecide} />
      <PluginInstallDialog target={installTarget} onClose={() => setInstallTarget(null)} onConfirm={installPlugin} working={working} />
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}><DialogContent><DialogHeader><DialogTitle>Command</DialogTitle><DialogDescription>빠른 실행</DialogDescription></DialogHeader><Command><CommandInput placeholder="검색..." value={commandQuery} onValueChange={setCommandQuery} /><CommandList><CommandEmpty>결과 없음</CommandEmpty><CommandGroup heading="Actions">{commandActions.filter((a) => !commandQuery || a.label.toLowerCase().includes(commandQuery.toLowerCase())).map((a) => <CommandItem key={a.id} onSelect={() => { setCommandOpen(false); setCommandQuery(""); void a.run(); }}><Search className="mr-2 h-4 w-4" />{a.label}</CommandItem>)}</CommandGroup></CommandList></Command></DialogContent></Dialog>
      <PluginUninstallDialog target={uninstallTarget} onClose={() => setUninstallTarget(null)} onConfirm={uninstallPlugin} working={working} />
    </TooltipProvider>
  );
}


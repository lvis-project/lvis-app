import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Search, MoreHorizontal, Command as CommandIcon, KeyRound, Plus, Loader2, PanelsTopLeft, ChevronDown, Star, Download, Pencil, GitBranch, X as XIcon, Paperclip, Globe, User, History } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import {
  DEFAULT_ROLE_PRESETS,
  ROLE_PRESETS_CHANGED_EVENT,
  buildPresetPrefix,
  loadRolePresets,
  type RolePreset,
} from "./data/role-presets.js";
import { costTier, estimateTurnCost, formatCostBadge } from "./lib/cost-estimator.js";
import { lookupPricing } from "./shared/pricing-data.js";
import { vendorSupportsThinking as vendorSupportsThinkingShared } from "./shared/vendor-capabilities.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Badge } from "./components/ui/badge.js";
import { Input } from "./components/ui/input.js";
import { Textarea } from "./components/ui/textarea.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./components/ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip.js";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./components/ui/command.js";
import { ScrollArea } from "./components/ui/scroll-area.js";
import { Separator } from "./components/ui/separator.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "./components/ui/sheet.js";
import { PluginUiHostView } from "./plugin-ui-host.js";
import {
  appendUserEntry,
  applyToolEnd,
  applyToolStart,
  finalizeStreamingReasoning,
  finalizeStreamingAssistant,
  setAssistantError,
  type ChatEntry,
  upsertStreamingReasoning,
  upsertStreamingAssistant,
} from "./lib/chat-stream-state.js";

// ─── Phase 2 split: types / constants / helpers / components / tabs ──
import type {
  LvisApi,
  MarketplaceItem,
  PluginCardSummary,
  PluginUiExtension,
  Task,
} from "./ui/renderer/types.js";
import {
  PRIORITY_CLASS,
  REASONING_EFFORT_STEPS,
  VENDORS,
  WEB_PROVIDERS,
  budgetToEffortIndex,
  formatTaskSource,
} from "./ui/renderer/constants.js";
import { getApi, getPluginViewLabel, toViewKey } from "./ui/renderer/api-client.js";
import { highlightText } from "./ui/renderer/utils/html-preview.js";
import { historyToEntries } from "./ui/renderer/utils/history.js";
import { BriefingCard } from "./ui/renderer/components/BriefingCard.js";
import { ToolApprovalDialog } from "./ui/renderer/components/ToolApprovalDialog.js";
import { UsageDashboard } from "./ui/renderer/components/UsageDashboard.js";
import { ChatView } from "./ui/renderer/ChatView.js";
import { Sidebar } from "./ui/renderer/Sidebar.js";
import { SettingsDialog } from "./ui/renderer/SettingsDialog.js";
import { RolesTab } from "./ui/renderer/tabs/RolesTab.js";
import { PermissionsTab } from "./ui/renderer/tabs/PermissionsTab.js";
import { useSettings } from "./ui/renderer/hooks/use-settings.js";
import { useChatState } from "./ui/renderer/hooks/use-chat-state.js";
import { useBriefing } from "./ui/renderer/hooks/use-briefing.js";
import { useApproval } from "./ui/renderer/hooks/use-approval.js";
import { useSearch } from "./ui/renderer/hooks/use-search.js";

// Phase 1 tests import `BriefingCard` from this module; preserve the export.
export { BriefingCard } from "./ui/renderer/components/BriefingCard.js";

// ─── TaskView ───────────────────────────────────────

function TaskView({ api }: { api: LvisApi }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<"pending"|"today"|"overdue"|"done">("pending");
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      let r: Task[];
      if (filter === "today") r = await api.getTodayTasks();
      else if (filter === "overdue") r = await api.getOverdueTasks();
      else if (filter === "done") r = await api.queryTasks({ status: "done" });
      else r = await api.queryTasks({ status: "pending" });
      setTasks(r);
    } catch { setTasks([]); } finally { setLoading(false); }
  }, [filter, api]);
  useEffect(() => { void load(); }, [load]);
  const isDone = filter === "done";
  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <Card className="flex h-full min-h-0 flex-col">
        <CardHeader>
          <div className="flex items-center justify-between"><CardTitle>태스크</CardTitle><Button size="sm" variant="outline" onClick={() => void load()}>새로고침</Button></div>
          <CardDescription>이메일·미팅에서 수집된 할 일 목록</CardDescription>
        </CardHeader>
        <CardContent className="flex min-h-0 flex-1 flex-col gap-3">
          <Tabs value={filter} onValueChange={(v) => setFilter(v as typeof filter)}>
            <TabsList className="w-full">
              <TabsTrigger value="pending" className="flex-1">진행중</TabsTrigger>
              <TabsTrigger value="today" className="flex-1">오늘 마감</TabsTrigger>
              <TabsTrigger value="overdue" className="flex-1">기한 초과</TabsTrigger>
              <TabsTrigger value="done" className="flex-1">완료됨</TabsTrigger>
            </TabsList>
          </Tabs>
          <ScrollArea className="flex-1">
            {loading ? <div className="py-8 text-center text-sm text-muted-foreground">로딩 중...</div> : tasks.length === 0 ? <div className="py-8 text-center text-sm text-muted-foreground">태스크가 없습니다.</div> : (
              <div className="space-y-2 pr-2">
                {tasks.map((t) => (
                  <div key={t.id} className={`flex items-start gap-2 rounded-md border p-3 ${isDone ? "opacity-60" : ""}`}>
                    <button className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded border ${isDone ? "border-primary bg-primary" : "border-muted-foreground hover:border-primary"}`}
                      onClick={() => void api.updateTask(t.id, { status: isDone ? "pending" : "done" }).then(() => load())}>
                      {isDone ? <span className="flex h-full w-full items-center justify-center text-[8px] text-primary-foreground">✓</span> : null}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`text-sm font-medium ${isDone ? "line-through" : ""}`}>{t.title}</span>
                        <Badge variant="outline" className="text-[10px]">{formatTaskSource(t.source)}</Badge>
                        <span className={`text-[10px] font-semibold ${PRIORITY_CLASS[t.priority]}`}>{t.priority}</span>
                      </div>
                      {t.description ? <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{t.description}</p> : null}
                    </div>
                    <button className="flex-shrink-0 text-[10px] text-muted-foreground hover:text-destructive" onClick={() => void api.deleteTask(t.id).then(() => load())}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}

// ─── App ────────────────────────────────────────────

export function App() {
  const api = useMemo(() => getApi(), []);

  // Chat state — Phase 3.2 hook
  const {
    entries,
    setEntries,
    streaming,
    setStreaming,
    streamRef,
    thoughtRef,
    editingEntryIdx,
    setEditingEntryIdx,
    editBusy,
    handleEditSave: chatHandleEditSave,
    handleRetryEffort,
    finalizeLeftoverStream,
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
  const [starred, setStarred] = useState<Array<{ id: string; sessionId: string; messageIndex: number; role: string; text: string; starredAt: string }>>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<Array<{ id: string; modifiedAt: string }>>([]);

  const refreshStarred = useCallback(async () => {
    try { const list = await api.starredList(); setStarred(list); } catch { /* ignore */ }
  }, [api]);
  const refreshSessionId = useCallback(async () => {
    try { const h = await api.chatGetHistory(); setCurrentSessionId(h.sessionId); } catch { /* ignore */ }
  }, [api]);
  const refreshSessions = useCallback(async () => {
    try {
      const r = await api.chatSessions();
      setSessions(r.sessions);
      setCurrentSessionId(r.current);
    } catch { /* ignore */ }
  }, [api]);
  const handleLoadSession = useCallback(async (sessionId: string) => {
    // Don't swap sessions mid-stream — ConversationLoop.runTurn() has no
    // concurrency guard, so replacing history while a turn is writing to it
    // would race. The "기록" button is also disabled during streaming, but
    // keep this guard here too for programmatic callers (e.g. starred jump).
    if (streaming) return;
    try {
      const res = await api.chatLoadSession(sessionId);
      if (!res?.ok) return;
      const h = await api.chatGetHistory();
      setEntries(historyToEntries(h.messages));
      setCurrentSessionId(h.sessionId);
    } catch { /* ignore */ }
  }, [api, streaming]);

  // Map renderer `entries` (which include reasoning/tool_group/system) to
  // backend history indices which only track user + assistant messages.
  // This lets edit/fork/star carry the correct `messageIndex`.
  const entryIndexToHistoryIndex = useMemo(() => {
    const map = new Map<number, number>();
    let backend = 0;
    entries.forEach((e, i) => {
      if (e.kind === "user" || e.kind === "assistant") {
        map.set(i, backend);
        backend += 1;
      }
    });
    return map;
  }, [entries]);

  const isEntryStarred = useCallback((entryIdx: number): string | null => {
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return null;
    const match = starred.find((s) => s.sessionId === currentSessionId && s.messageIndex === histIdx);
    return match?.id ?? null;
  }, [starred, currentSessionId, entryIndexToHistoryIndex]);

  // ─── Search (Ctrl/Cmd+F) — provided by useSearch hook ─────

  // ─── Edit & resend (delegates to useChatState) ─────────────
  const handleEditSave = useCallback(
    (entryIdx: number, newText: string) =>
      chatHandleEditSave(entryIdx, newText, entryIndexToHistoryIndex),
    [chatHandleEditSave, entryIndexToHistoryIndex],
  );

  // ─── Fork ──────────────────────────────────────
  const handleFork = useCallback(async (entryIdx: number) => {
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return;
    const res = await api.chatFork(histIdx);
    if (res.ok) {
      setEntries((p) => p.slice(0, entryIdx + 1));
      await refreshSessionId();
    }
  }, [api, entryIndexToHistoryIndex, refreshSessionId]);

  // ─── Retry with deeper thinking — provided by useChatState ─────

  // ─── Star toggle ───────────────────────────────
  const handleToggleStar = useCallback(async (entryIdx: number) => {
    const entry = entries[entryIdx];
    if (!entry || (entry.kind !== "user" && entry.kind !== "assistant")) return;
    const histIdx = entryIndexToHistoryIndex.get(entryIdx);
    if (histIdx === undefined) return;
    const existingId = isEntryStarred(entryIdx);
    if (existingId) {
      await api.starredRemove({ id: existingId });
    } else {
      await api.starredAdd({ sessionId: currentSessionId, messageIndex: histIdx, role: entry.kind, text: entry.text });
    }
    await refreshStarred();
  }, [entries, entryIndexToHistoryIndex, isEntryStarred, api, currentSessionId, refreshStarred]);

  // ─── Export ────────────────────────────────────
  const handleExport = useCallback(async (format: "markdown" | "json") => {
    try { await api.chatExport(format); } catch (err) { console.warn("[lvis] export failed:", (err as Error).message); }
  }, [api]);

  // Sprint 4.B — context overflow tracking + LLM settings cache (Phase 3.1 hook)
  const {
    llmVendor,
    llmModel,
    enableThinkingChat,
    currentLlmSettings,
    refresh: refreshLlmSettings,
    toggleThinking,
  } = useSettings(api);

  const contextOverflowPct = useMemo(() => {
    const CONTEXT_WINDOWS: Record<string, number> = {
      "claude-sonnet-4-6": 1_000_000, "claude-opus-4-6": 1_000_000,
      "claude-sonnet-4-5": 200_000, "claude-opus-4-5": 200_000,
      "gpt-5.4": 1_050_000, "gpt-5.4-mini": 1_050_000,
      "gpt-5": 400_000, "gpt-4.1": 1_000_000, "gpt-4.1-mini": 1_000_000,
      "gemini-2.5-flash": 1_000_000, "gemini-2.5-pro": 2_000_000,
    };
    const model = currentLlmSettings?.model ?? "";
    const contextWindow = CONTEXT_WINDOWS[model] ?? 128_000;
    const estimatedTokens = entries.reduce((sum, e) => {
      if (e.kind === "user" || e.kind === "assistant") return sum + Math.ceil(e.text.length / 4);
      return sum;
    }, 0);
    return estimatedTokens / contextWindow;
  }, [entries, currentLlmSettings]);

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);

  // Rough per-model context budget (input+output tokens) used to show % filled.
  // NOTE: we currently assume the default 200k for all Claude models. The
  // Anthropic 1M-context beta for Sonnet 4.6 requires an opt-in beta header
  // that the renderer doesn't know about; treat this as 200k until/unless
  // we wire model-ID detection. (The separate `contextOverflowPct` memo
  // uses exact per-model values for overflow warnings.)
  const contextBudget = useMemo(() => {
    const m = (llmModel || "").toLowerCase();
    if (m.includes("claude")) return 200_000;
    if (m.includes("gpt-5") || m.includes("gpt-4.1")) return 1_000_000;
    if (m.includes("gpt-4o") || m.includes("gpt-4")) return 128_000;
    if (m.includes("gemini")) return 1_000_000;
    if (m.includes("o1") || m.includes("o3") || m.includes("o4")) return 200_000;
    return 128_000;
  }, [llmModel]);

  // Estimated tokens — mirrors engine-side serializeMessageForEstimation heuristic
  // (see src/engine/llm/types.ts:85): per-message `Math.ceil(serializedLength / 4) + 1`.
  const usedTokens = useMemo(() => {
    let total = 0;
    for (const e of entries) {
      let serialized = "";
      if (e.kind === "user" || e.kind === "assistant" || e.kind === "reasoning" || e.kind === "system") {
        serialized = JSON.stringify({ kind: e.kind, text: e.text ?? "" });
      } else if (e.kind === "tool_group") {
        serialized = JSON.stringify({
          kind: "tool_group",
          tools: (e.tools ?? []).map((t: any) => ({
            input: t.input ?? {},
            result: t.result ?? "",
          })),
        });
      }
      if (serialized) total += Math.ceil(serialized.length / 4) + 1;
    }
    return total;
  }, [entries]);
  const contextPercent = Math.min(100, Math.round((usedTokens / contextBudget) * 100));
  const contextColor =
    contextPercent < 50 ? "text-emerald-500" :
    contextPercent < 80 ? "text-amber-500" : "text-red-500";
  const vendorSupportsThinking = useMemo(
    () => vendorSupportsThinkingShared(llmVendor, llmModel),
    [llmVendor, llmModel],
  );
  // ─── Sprint B: compose outgoing message with preset + language + attached docs ──
  const composeOutgoing = useCallback((raw: string): string => {
    const parts: string[] = [];
    const presetPrefix = buildPresetPrefix(activePreset);
    if (presetPrefix) parts.push(presetPrefix.trimEnd());
    if (attachedDocs.length > 0) {
      const lines = attachedDocs.map((d) => `- ${d.name} (id: ${d.id})`).join("\n");
      parts.push(`[Attached documents — use knowledge_search / document_structure to read them]\n${lines}`);
    }
    if (langLock === "ko") parts.push("Respond in Korean only.");
    else if (langLock === "en") parts.push("Respond in English only.");
    parts.push(raw);
    return parts.join("\n\n");
  }, [activePreset, attachedDocs, langLock]);

  // ─── Chat ─────────────────────────────────────
  const handleAsk = useCallback(async (q: string) => {
    const t = q.trim(); if (!t || streaming) return;
    if (!(await checkApiKey())) { setSettingsOpen(true); return; }
    setQuestion("");
    const outgoing = composeOutgoing(t);
    setEntries((p) => appendUserEntry(p, t));
    streamRef.current = "";
    thoughtRef.current = "";
    setStreaming(true);
    try {
      await api.chatSend(outgoing);
      // Final state set by stream events + done
    } catch (err) {
      setEntries((p) => setAssistantError(p, `오류: ${(err as Error).message}`, thoughtRef.current));
      streamRef.current = "";
      thoughtRef.current = "";
    } finally { setStreaming(false); }
  }, [api, streaming, checkApiKey, composeOutgoing]);

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

  // ─── Sprint B: pre-send cost estimate ─────────────
  // Keystrokes in the input box re-run the cost memo via `question`, but the
  // expensive JSON.stringify over every prior entry only depends on `entries`.
  // Memoize it separately, keyed on length + last-entry identity, so typing a
  // draft in long sessions doesn't re-serialize the whole conversation.
  const historySerialized = useMemo(() => {
    return entries.map((e) => {
      if (e.kind === "user" || e.kind === "assistant" || e.kind === "reasoning" || e.kind === "system") {
        return JSON.stringify({ kind: e.kind, text: (e as any).text ?? "" });
      }
      if (e.kind === "tool_group") {
        return JSON.stringify({
          kind: "tool_group",
          tools: (e.tools ?? []).map((t: any) => ({ input: t.input ?? {}, result: t.result ?? "" })),
        });
      }
      return "";
    }).filter(Boolean);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries.length, entries[entries.length - 1]]);
  const costEstimate = useMemo(() => {
    const pricing = lookupPricing(llmVendor, llmModel);
    const draft = question ? composeOutgoing(question) : "";
    return estimateTurnCost({ historySerialized, draft, maxOutputTokens, pricing });
  }, [historySerialized, question, llmVendor, llmModel, maxOutputTokens, composeOutgoing]);
  const costBadgeClass = (() => {
    const t = costTier(costEstimate.total);
    if (t === "trivial") return "text-muted-foreground";
    if (t === "low") return "text-emerald-500";
    if (t === "medium") return "text-amber-500";
    return "text-red-500";
  })();

  const handleNewChat = useCallback(async () => { await api.chatNew(); setEntries([]); void refreshSessionId(); }, [api, refreshSessionId]);

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
    void refreshStarred(); void refreshSessionId();

    // 앱 시작 시 데일리 브리핑을 채팅 메시지로 전달
    api.getBriefing().then((text) => {
      if (text && isMountedRef.current) setEntries([{ kind: "assistant", text }]);
    }).catch(() => {});
    const dv = api.onViewActivate((k) => { if (isMountedRef.current) setActiveView(k); });
    const ds = api.onChatStream((ev) => {
      if (process.env.NODE_ENV !== "production") console.log("[lvis:chat:stream]", ev);
      if (ev.type === "text_delta" && ev.text) {
        streamRef.current += ev.text;
        setEntries((p) => upsertStreamingAssistant(p, streamRef.current));
      } else if (ev.type === "reasoning_delta" && ev.text) {
        thoughtRef.current += ev.text;
        setEntries((p) => upsertStreamingReasoning(p, thoughtRef.current));
      } else if (ev.type === "assistant_round") {
        setEntries((p) => {
          let next = finalizeStreamingReasoning(p, ev.thought ?? thoughtRef.current);
          next = finalizeStreamingAssistant(next, ev.text ?? streamRef.current);
          return next;
        });
        streamRef.current = "";
        thoughtRef.current = "";
      } else if (ev.type === "tool_start" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, displayOrder = 0, name, input } = ev;
        setEntries((p) => applyToolStart(p, { groupId, toolUseId, displayOrder, name, input }));
      } else if (ev.type === "tool_end" && ev.name && ev.groupId && ev.toolUseId !== undefined) {
        const { groupId, toolUseId, result, isError } = ev;
        setEntries((p) => applyToolEnd(p, { groupId, toolUseId, result, isError }));
      } else if (ev.type === "error") {
        setEntries((p) => setAssistantError(p, `오류: ${ev.error || "알 수 없는 오류"}`, thoughtRef.current));
        streamRef.current = "";
        thoughtRef.current = "";
      } else if (ev.type === "redact_notice") {
        // Sprint E §3 — user draft 에서 PII 가 리댁트되었음을 알리는 시스템 배지.
        const count = (ev as unknown as { count?: number }).count ?? 0;
        const byKind = (ev as unknown as { byKind?: Record<string, number> }).byKind ?? {};
        const kindLabel = Object.entries(byKind)
          .map(([k, v]) => `${k}:${v}`)
          .join(", ");
        setEntries((p) => [
          ...p,
          { kind: "system", text: `🔒 전송 전 PII ${count}건 리댁트됨${kindLabel ? ` (${kindLabel})` : ""}` },
        ]);
      } else if (ev.type === "compact_notice") {
        const n = ev.removedMessages ?? 0;
        setEntries((p) => [...p, { kind: "system", text: `💾 이전 ${n}개 대화를 요약했습니다 (목표·결정사항 보존)` }]);
      } else if (ev.type === "done") {
        finalizeLeftoverStream();
      }
    });
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandOpen(true); }
      // Sprint 4.C: Ctrl/Cmd+F handled by useSearch hook
    };
    window.addEventListener("keydown", onKey);
    return () => {
      isMountedRef.current = false;
      dv(); ds();
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
          <div className="border-b bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <Tabs value={activeView} onValueChange={setActiveView}><TabsList>
                <TabsTrigger value="home">홈</TabsTrigger><TabsTrigger value="tasks">태스크</TabsTrigger>
                <TabsTrigger value="starred">즐겨찾기{starred.length > 0 ? <span className="ml-1 text-[10px] text-muted-foreground">({starred.length})</span> : null}</TabsTrigger>
                {pluginViews.map((i) => <TabsTrigger key={toViewKey(i)} value={toViewKey(i)}>{getPluginViewLabel(i)}</TabsTrigger>)}
              </TabsList></Tabs>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void handleNewChat()}><Plus className="mr-1 h-4 w-4" />새 대화</Button>
                <DropdownMenu onOpenChange={(open) => { if (open) void refreshSessions(); }}>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={streaming}
                      title={streaming ? "응답 생성 중에는 세션을 바꿀 수 없습니다" : "대화 기록 불러오기"}
                    ><History className="mr-1 h-4 w-4" />기록</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="max-h-[480px] w-[300px] overflow-y-auto">
                    {sessions.length === 0 ? (
                      <DropdownMenuItem disabled className="text-xs text-muted-foreground">
                        저장된 대화가 없습니다.
                      </DropdownMenuItem>
                    ) : (
                      sessions.map((s) => {
                        const isCurrent = s.id === currentSessionId;
                        return (
                          <DropdownMenuItem
                            key={s.id}
                            onClick={() => void handleLoadSession(s.id)}
                            className={isCurrent ? "bg-muted/50" : ""}
                          >
                            <div className="flex w-full flex-col">
                              <span className="text-xs tabular-nums">
                                {new Date(s.modifiedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                              </span>
                              <span className="font-mono text-[10px] opacity-60">#{s.id.slice(0, 8)}{isCurrent ? " · 현재" : ""}</span>
                            </div>
                          </DropdownMenuItem>
                        );
                      })
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" title="내보내기"><Download className="mr-1 h-4 w-4" />내보내기</Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => void handleExport("markdown")}>Markdown (.md)</DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void handleExport("json")}>JSON (.json)</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button variant="outline" size="sm" onClick={searchToggleOverlay} title="대화 검색 (Ctrl/Cmd+F)"><Search className="mr-1 h-4 w-4" />찾기</Button>
                <Sheet open={sheetOpen} onOpenChange={setSheetOpen}><SheetTrigger asChild><Button variant="outline" size="sm"><PanelsTopLeft className="mr-1 h-4 w-4" />뷰</Button></SheetTrigger>
                  <SheetContent side="right"><SheetHeader><SheetTitle>뷰 관리</SheetTitle><SheetDescription>빠른 이동</SheetDescription></SheetHeader><Separator className="my-4" />
                    <div className="space-y-2">
                      <Button variant={activeView === "home" ? "default" : "secondary"} className="w-full justify-start" onClick={() => { setActiveView("home"); setSheetOpen(false); }}>홈</Button>
                      <Button variant={activeView === "tasks" ? "default" : "secondary"} className="w-full justify-start" onClick={() => { setActiveView("tasks"); setSheetOpen(false); }}>태스크</Button>
                      {pluginViews.map((i) => { const k = toViewKey(i); return <Button key={k} variant={activeView === k ? "default" : "secondary"} className="w-full justify-start" onClick={() => { setActiveView(k); setSheetOpen(false); }}>{getPluginViewLabel(i)}</Button>; })}
                    </div>
                  </SheetContent>
                </Sheet>
                <Tooltip><TooltipTrigger asChild><Button variant={hasApiKey === false ? "destructive" : "outline"} size="sm" onClick={() => setSettingsOpen(true)}><KeyRound className="mr-1 h-4 w-4" />설정</Button></TooltipTrigger><TooltipContent>{hasApiKey ? "LLM 설정" : "API 키를 설정해 주세요"}</TooltipContent></Tooltip>
                <Tooltip><TooltipTrigger asChild><Button variant="outline" size="sm" onClick={() => setCommandOpen(true)}><CommandIcon className="mr-1 h-4 w-4" />Cmd</Button></TooltipTrigger><TooltipContent>Ctrl/Cmd + K</TooltipContent></Tooltip>
              </div>
            </div>
          </div>

          {/* Content */}
          {activeView === "tasks" ? <TaskView api={api} /> : activeView === "starred" ? (
            <div className="flex min-h-0 flex-1 flex-col p-4">
              <Card className="flex h-full min-h-0 flex-col">
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>즐겨찾기</CardTitle>
                    <Button size="sm" variant="outline" onClick={() => void refreshStarred()}>새로고침</Button>
                  </div>
                  <CardDescription>별표한 메시지는 전체 대화에서 모아볼 수 있습니다.</CardDescription>
                </CardHeader>
                <CardContent className="flex min-h-0 flex-1 flex-col">
                  <ScrollArea className="flex-1">
                    {starred.length === 0 ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">즐겨찾기한 메시지가 없습니다.</div>
                    ) : (
                      <div className="space-y-2 pr-2">
                        {starred.map((s) => (
                          <div key={s.id} className="rounded-md border p-3 text-sm">
                            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                              <Badge variant="outline" className="text-[10px]">{s.role}</Badge>
                              <span>{new Date(s.starredAt).toLocaleString("ko-KR")}</span>
                              <span className="font-mono opacity-60">#{s.sessionId.slice(0, 8)}</span>
                              <button className="ml-auto rounded p-0.5 hover:bg-muted" title="해제" onClick={() => { void api.starredRemove({ id: s.id }).then(() => refreshStarred()); }}>
                                <XIcon className="h-3 w-3" />
                              </button>
                            </div>
                            <button
                              className="w-full whitespace-pre-wrap break-words text-left text-sm hover:opacity-80"
                              onClick={async () => {
                                if (s.sessionId !== currentSessionId) {
                                  await handleLoadSession(s.sessionId);
                                }
                                setActiveView("home");
                              }}
                            >{s.text.slice(0, 300)}{s.text.length > 300 ? "…" : ""}</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </ScrollArea>
                </CardContent>
              </Card>
            </div>
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
      <ToolApprovalDialog
        open={approvalQueue.length > 0}
        request={approvalQueue[0] ?? null}
        pendingCount={approvalQueue.length}
        onDecide={(choice, pattern) => void handleApprovalDecide(choice, pattern)}
      />
      <Dialog open={!!installTarget} onOpenChange={(o) => !o && setInstallTarget(null)}><DialogContent><DialogHeader><DialogTitle>플러그인 설치</DialogTitle><DialogDescription>{installTarget ? `'${installTarget.name}' 설치?` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setInstallTarget(null)}>취소</Button><Button onClick={async () => { if (!installTarget) return; const id = installTarget.id; setInstallTarget(null); await installPlugin(id); }} disabled={working}>설치</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}><DialogContent><DialogHeader><DialogTitle>Command</DialogTitle><DialogDescription>빠른 실행</DialogDescription></DialogHeader><Command><CommandInput placeholder="검색..." value={commandQuery} onValueChange={setCommandQuery} /><CommandList><CommandEmpty>결과 없음</CommandEmpty><CommandGroup heading="Actions">{commandActions.filter((a) => !commandQuery || a.label.toLowerCase().includes(commandQuery.toLowerCase())).map((a) => <CommandItem key={a.id} onSelect={() => { setCommandOpen(false); setCommandQuery(""); void a.run(); }}><Search className="mr-2 h-4 w-4" />{a.label}</CommandItem>)}</CommandGroup></CommandList></Command></DialogContent></Dialog>
      <Dialog open={!!uninstallTarget} onOpenChange={(o) => !o && setUninstallTarget(null)}><DialogContent><DialogHeader><DialogTitle>플러그인 제거</DialogTitle><DialogDescription>{uninstallTarget ? `'${uninstallTarget.name}' 제거?` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setUninstallTarget(null)}>취소</Button><Button variant="destructive" onClick={async () => { if (!uninstallTarget) return; const id = uninstallTarget.id; setUninstallTarget(null); await uninstallPlugin(id); }} disabled={working}>제거</Button></DialogFooter></DialogContent></Dialog>
    </TooltipProvider>
  );
}

// ─── Bootstrap ──────────────────────────────────────
// Guard with `typeof document` so importing <App /> from a jsdom test
// harness (no #root) doesn't double-mount or throw.
if (typeof document !== "undefined") {
  const root = document.getElementById("root");
  if (root) createRoot(root).render(<App />);
}

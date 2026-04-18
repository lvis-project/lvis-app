import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import {
  DEFAULT_ROLE_PRESETS,
  ROLE_PRESETS_CHANGED_EVENT,
  buildPresetPrefix,
  loadRolePresets,
  type RolePreset,
} from "../../data/role-presets.js";
import { costTier, estimateTurnCost, formatCostBadge } from "../../lib/cost-estimator.js";
import { lookupPricing } from "../../shared/pricing-data.js";
import { vendorSupportsThinking as vendorSupportsThinkingShared } from "../../shared/vendor-capabilities.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Badge } from "../../components/ui/badge.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "../../components/ui/command.js";
import { ScrollArea } from "../../components/ui/scroll-area.js";
import { PluginUiHostView } from "../../plugin-ui-host.js";
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
} from "../../lib/chat-stream-state.js";

// ─── Phase 2 split: types / constants / helpers / components / tabs ──
import type {
  LvisApi,
  MarketplaceItem,
  PluginCardSummary,
  PluginUiExtension,
  Task,
} from "./types.js";
import {
  PRIORITY_CLASS,
  REASONING_EFFORT_STEPS,
  VENDORS,
  WEB_PROVIDERS,
  budgetToEffortIndex,
  formatTaskSource,
} from "./constants.js";
import { getApi, getPluginViewLabel, toViewKey } from "./api-client.js";
import { highlightText } from "./utils/html-preview.js";
import { historyToEntries } from "./utils/history.js";
import { BriefingCard } from "./components/BriefingCard.js";
import { ApprovalDialog } from "./dialogs/ApprovalDialog.js";
import { UsageDashboard } from "./components/UsageDashboard.js";
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

// Phase 1 tests import `BriefingCard` from this module; preserve the export.
export { BriefingCard } from "./components/BriefingCard.js";

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
      <Dialog open={!!installTarget} onOpenChange={(o) => !o && setInstallTarget(null)}><DialogContent><DialogHeader><DialogTitle>플러그인 설치</DialogTitle><DialogDescription>{installTarget ? `'${installTarget.name}' 설치?` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setInstallTarget(null)}>취소</Button><Button onClick={async () => { if (!installTarget) return; const id = installTarget.id; setInstallTarget(null); await installPlugin(id); }} disabled={working}>설치</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}><DialogContent><DialogHeader><DialogTitle>Command</DialogTitle><DialogDescription>빠른 실행</DialogDescription></DialogHeader><Command><CommandInput placeholder="검색..." value={commandQuery} onValueChange={setCommandQuery} /><CommandList><CommandEmpty>결과 없음</CommandEmpty><CommandGroup heading="Actions">{commandActions.filter((a) => !commandQuery || a.label.toLowerCase().includes(commandQuery.toLowerCase())).map((a) => <CommandItem key={a.id} onSelect={() => { setCommandOpen(false); setCommandQuery(""); void a.run(); }}><Search className="mr-2 h-4 w-4" />{a.label}</CommandItem>)}</CommandGroup></CommandList></Command></DialogContent></Dialog>
      <Dialog open={!!uninstallTarget} onOpenChange={(o) => !o && setUninstallTarget(null)}><DialogContent><DialogHeader><DialogTitle>플러그인 제거</DialogTitle><DialogDescription>{uninstallTarget ? `'${uninstallTarget.name}' 제거?` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setUninstallTarget(null)}>취소</Button><Button variant="destructive" onClick={async () => { if (!uninstallTarget) return; const id = uninstallTarget.id; setUninstallTarget(null); await uninstallPlugin(id); }} disabled={working}>제거</Button></DialogFooter></DialogContent></Dialog>
    </TooltipProvider>
  );
}


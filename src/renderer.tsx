import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Search, MoreHorizontal, Command as CommandIcon, KeyRound, Plus, Loader2, Wrench, PanelsTopLeft } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Badge } from "./components/ui/badge.js";
import { Input } from "./components/ui/input.js";
import { Textarea } from "./components/ui/textarea.js";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip.js";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "./components/ui/command.js";
import { ScrollArea } from "./components/ui/scroll-area.js";
import { Separator } from "./components/ui/separator.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "./components/ui/sheet.js";
import { PluginUiHostView, type PluginUiExtensionView } from "./plugin-ui-host.js";

// ─── Types ──────────────────────────────────────────

type MarketplaceItem = { id: string; name: string; description: string; packageSpec: string; installed: boolean; enabled: boolean };
type PluginUiExtension = PluginUiExtensionView;
type Task = { id: string; title: string; description?: string; source: "email"|"meeting"|"calendar"|"teams"|"manual"; priority: "high"|"medium"|"low"; status: "pending"|"done"|"snoozed"; dueAt?: string; createdAt: string; updatedAt: string };
type AppSettings = { llm: { provider: string; model: string }; chat: { systemPrompt: string } };
type StreamEvent = { type: string; text?: string; name?: string; error?: string; result?: string; isError?: boolean };

type ChatEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "tool"; name: string; status: "running" | "done" | "error"; result?: string };

type LvisApi = {
  getSettings: () => Promise<AppSettings>;
  updateSettings: (p: Partial<AppSettings>) => Promise<AppSettings>;
  setApiKey: (vendor: string, k: string) => Promise<{ ok: true }>;
  hasApiKey: (vendor?: string) => Promise<boolean>;
  deleteApiKey: (vendor: string) => Promise<{ ok: true }>;
  chatHasProvider: () => Promise<boolean>;
  chatSend: (input: string) => Promise<unknown>;
  chatNew: () => Promise<{ ok: true }>;
  onChatStream: (h: (e: StreamEvent) => void) => () => void;
  memoryListNotes: () => Promise<Array<{ filename: string; title: string; content: string }>>;
  memorySaveNote: (t: string, c: string) => Promise<unknown>;
  memoryDeleteNote: (f: string) => Promise<void>;
  listMarketplacePlugins: () => Promise<MarketplaceItem[]>;
  installMarketplacePlugin: (id: string) => Promise<unknown>;
  uninstallMarketplacePlugin: (id: string) => Promise<unknown>;
  listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
  callPluginMethod: (m: string, p?: unknown) => Promise<unknown>;
  addTask: (t: unknown) => Promise<Task>;
  queryTasks: (f?: unknown) => Promise<Task[]>;
  updateTask: (id: string, p: unknown) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  getTodayTasks: () => Promise<Task[]>;
  getOverdueTasks: () => Promise<Task[]>;
  onViewActivate: (h: (k: string) => void) => () => void;
};

declare global { interface Window { lvisApi: LvisApi } }

// ─── Constants ──────────────────────────────────────

const PRIORITY_CLASS: Record<Task["priority"], string> = { high: "text-red-400", medium: "text-amber-400", low: "text-slate-400" };
const SOURCE_LABEL: Record<Task["source"], string> = { email: "메일", meeting: "미팅", calendar: "일정", teams: "Teams", manual: "직접" };

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
                        <Badge variant="outline" className="text-[10px]">{SOURCE_LABEL[t.source]}</Badge>
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

// ─── SettingsDialog ─────────────────────────────────

const VENDORS = [
  { id: "claude", label: "Anthropic Claude", placeholder: "sk-ant-...", defaultModel: "claude-sonnet-4-20250514" },
  { id: "openai", label: "OpenAI", placeholder: "sk-...", defaultModel: "gpt-4o" },
  { id: "gemini", label: "Google Gemini", placeholder: "AIza...", defaultModel: "gemini-2.0-flash" },
  { id: "copilot", label: "GitHub Copilot", placeholder: "ghp_...", defaultModel: "gpt-4o" },
] as const;

function SettingsDialog({ open, onOpenChange, api, onSaved }: { open: boolean; onOpenChange: (o: boolean) => void; api: LvisApi; onSaved: () => void }) {
  const [vendor, setVendor] = useState("claude");
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);

  const vendorInfo = VENDORS.find((v) => v.id === vendor) ?? VENDORS[0];

  useEffect(() => {
    if (!open) return;
    void (async () => {
      const s = await api.getSettings();
      setVendor(s.llm.provider);
      setModel(s.llm.model);
      setHasKey(await api.hasApiKey(s.llm.provider));
    })();
  }, [open, api]);

  // 벤더 변경 시 해당 벤더의 키 상태 확인
  useEffect(() => {
    if (!open) return;
    const v = VENDORS.find((x) => x.id === vendor);
    if (v) { setModel(v.defaultModel); void api.hasApiKey(vendor).then(setHasKey); }
  }, [vendor, open, api]);

  const save = async () => {
    setSaving(true);
    try {
      if (keyInput.trim()) { await api.setApiKey(vendor, keyInput.trim()); setKeyInput(""); setHasKey(true); }
      await api.updateSettings({ llm: { provider: vendor as AppSettings["llm"]["provider"], model: model.trim() || vendorInfo.defaultModel } });
      onSaved(); onOpenChange(false);
    } finally { setSaving(false); }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>LLM 설정</DialogTitle><DialogDescription>벤더를 선택하고 API 키를 설정합니다.</DialogDescription></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">벤더</label>
            <div className="grid grid-cols-2 gap-2">
              {VENDORS.map((v) => (
                <Button key={v.id} size="sm" variant={vendor === v.id ? "default" : "outline"} className="justify-start text-xs" onClick={() => setVendor(v.id)}>
                  {v.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-medium">{vendorInfo.label} API 키</label>
            {hasKey
              ? <div className="flex items-center gap-2"><Badge variant="default" className="text-xs">설정됨</Badge><Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={() => void api.deleteApiKey(vendor).then(() => { setHasKey(false); onSaved(); })}>삭제</Button></div>
              : <Badge variant="secondary" className="text-xs">미설정</Badge>}
            <Input type="password" placeholder={hasKey ? "새 키로 교체" : vendorInfo.placeholder} value={keyInput} onChange={(e) => setKeyInput(e.target.value)} />
          </div>
          <div className="space-y-2"><label className="text-sm font-medium">모델</label><Input value={model} onChange={(e) => setModel(e.target.value)} placeholder={vendorInfo.defaultModel} /></div>
        </div>
        <DialogFooter><Button variant="secondary" onClick={() => onOpenChange(false)}>취소</Button><Button onClick={() => void save()} disabled={saving}>{saving ? "저장 중..." : "저장"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Helpers ────────────────────────────────────────

function getApi(): LvisApi { if (!window.lvisApi) throw new Error("lvisApi not initialized"); return window.lvisApi; }
function findLastIdx<T>(arr: T[], pred: (v: T) => boolean): number { for (let i = arr.length - 1; i >= 0; i--) { if (pred(arr[i])) return i; } return -1; }
function toViewKey(item: PluginUiExtension) { return `plugin:${item.pluginId}:${item.extension.id}`; }
function getPluginViewLabel(item: PluginUiExtension) { return item.extension.displayName?.trim() || item.extension.title || item.pluginId; }

// ─── App ────────────────────────────────────────────

function App() {
  const api = useMemo(() => getApi(), []);

  // Chat state
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const streamRef = useRef("");
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

  const activePluginView = useMemo(() => pluginViews.find((i) => toViewKey(i) === activeView), [pluginViews, activeView]);
  const checkApiKey = useCallback(async () => { const h = await api.hasApiKey(); setHasApiKey(h); return h; }, [api]);

  // ─── Chat ─────────────────────────────────────
  const handleAsk = useCallback(async (q: string) => {
    const t = q.trim(); if (!t || streaming) return;
    if (!(await checkApiKey())) { setSettingsOpen(true); return; }
    setQuestion("");
    // User entry
    setEntries((p) => [...p, { kind: "user", text: t }]);
    // Streaming assistant entry
    streamRef.current = "";
    setEntries((p) => [...p, { kind: "assistant", text: "", streaming: true }]);
    setStreaming(true);
    try {
      await api.chatSend(t);
      // Final state set by stream events + done
    } catch (err) {
      setEntries((p) => {
        const copy = [...p];
        const last = findLastIdx(copy, (e: ChatEntry) => e.kind === "assistant");
        if (last >= 0) copy[last] = { kind: "assistant", text: `오류: ${(err as Error).message}`, streaming: false };
        return copy;
      });
    } finally { setStreaming(false); }
  }, [api, streaming, checkApiKey]);

  const handleNewChat = useCallback(async () => { await api.chatNew(); setEntries([]); }, [api]);

  // ─── Plugin actions ───────────────────────────
  const refreshViews = async () => { const v = (await api.listPluginUiExtensions()).filter((i) => i.extension.slot === "sidebar"); setPluginViews(v); return v; };
  const refreshMarketplace = async () => { try { setMarketStatus("로딩 중..."); const l = await api.listMarketplacePlugins(); setMarketplace(l); setMarketStatus(`플러그인 ${l.length}개`); } catch (e) { setMarketStatus(`실패: ${(e as Error).message}`); } };
  const installPlugin = async (id: string) => { setWorking(true); try { await api.installMarketplacePlugin(id); await refreshMarketplace(); await refreshViews(); } finally { setWorking(false); } };
  const uninstallPlugin = async (id: string) => { setWorking(true); try { await api.uninstallMarketplacePlugin(id); await refreshMarketplace(); await refreshViews(); } finally { setWorking(false); } };

  // ─── Effects ──────────────────────────────────
  useEffect(() => {
    void refreshMarketplace(); void refreshViews(); void checkApiKey();
    const dv = api.onViewActivate((k) => setActiveView(k));
    const ds = api.onChatStream((ev) => {
      if (ev.type === "text_delta" && ev.text) {
        streamRef.current += ev.text;
        const cur = streamRef.current;
        setEntries((p) => { const c = [...p]; const i = findLastIdx(c, (e: ChatEntry) => e.kind === "assistant" && "streaming" in e && e.streaming); if (i >= 0) c[i] = { kind: "assistant", text: cur, streaming: true }; return c; });
      } else if (ev.type === "tool_start" && ev.name) {
        setEntries((p) => [...p, { kind: "tool", name: ev.name!, status: "running" as const }]);
      } else if (ev.type === "tool_end" && ev.name) {
        setEntries((p) => { const c = [...p]; const i = findLastIdx(c, (e: ChatEntry) => e.kind === "tool" && e.name === ev.name && e.status === "running"); if (i >= 0) c[i] = { kind: "tool", name: ev.name!, status: ev.isError ? "error" : "done", result: ev.result }; return c; });
      } else if (ev.type === "done") {
        setEntries((p) => { const c = [...p]; const i = findLastIdx(c, (e: ChatEntry) => e.kind === "assistant" && "streaming" in e && e.streaming); if (i >= 0) c[i] = { ...c[i], streaming: false } as ChatEntry; return c; });
      }
    });
    const onKey = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setCommandOpen(true); } };
    window.addEventListener("keydown", onKey);
    return () => { dv(); ds(); window.removeEventListener("keydown", onKey); };
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
        <aside className="border-r bg-background p-4">
          <Card className="h-full"><CardHeader><CardTitle>LVIS Plugins</CardTitle><CardDescription>마켓플레이스</CardDescription></CardHeader>
            <CardContent className="space-y-3"><div className="text-xs text-muted-foreground">{marketStatus}</div>
              <ScrollArea className="h-[calc(100vh-180px)] pr-2"><div className="space-y-2">
                {marketplace.map((pl) => (
                  <Card key={pl.id} className="border-muted"><CardContent className="space-y-2 p-3">
                    <div className="flex items-center justify-between"><div className="font-medium">{pl.name}</div><Badge variant={pl.installed ? "default" : "secondary"}>{pl.installed ? "설치됨" : "미설치"}</Badge></div>
                    <p className="text-xs text-muted-foreground">{pl.description}</p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" onClick={() => setInstallTarget(pl)} disabled={working} className="h-8">{pl.installed ? "재설치" : "설치"}</Button>
                      {pl.installed ? <Button size="sm" variant="destructive" onClick={() => setUninstallTarget(pl)} disabled={working} className="h-8">제거</Button> : null}
                      <DropdownMenu><DropdownMenuTrigger asChild><Button size="icon" variant="outline" className="h-8 w-8"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => { const t = pluginViews.find((x) => x.pluginId === pl.id); if (t) setActiveView(toViewKey(t)); }}>UI 열기</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </CardContent></Card>
                ))}
              </div></ScrollArea>
            </CardContent>
          </Card>
        </aside>

        {/* Main */}
        <main className="flex min-h-0 flex-col">
          <div className="border-b bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <Tabs value={activeView} onValueChange={setActiveView}><TabsList>
                <TabsTrigger value="home">홈</TabsTrigger><TabsTrigger value="tasks">태스크</TabsTrigger>
                {pluginViews.map((i) => <TabsTrigger key={toViewKey(i)} value={toViewKey(i)}>{getPluginViewLabel(i)}</TabsTrigger>)}
              </TabsList></Tabs>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => void handleNewChat()}><Plus className="mr-1 h-4 w-4" />새 대화</Button>
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
          {activeView === "tasks" ? <TaskView api={api} /> : activeView === "home" ? (
            <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto]">
              {hasApiKey === false && (
                <div className="absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2">
                  <Card className="w-[400px]"><CardHeader className="text-center"><KeyRound className="mx-auto mb-2 h-10 w-10 text-muted-foreground" /><CardTitle>API 키 설정 필요</CardTitle><CardDescription>채팅을 시작하려면 Claude API 키를 설정해 주세요.</CardDescription></CardHeader>
                    <CardContent className="flex justify-center"><Button onClick={() => setSettingsOpen(true)}><KeyRound className="mr-2 h-4 w-4" />설정 열기</Button></CardContent>
                  </Card>
                </div>
              )}
              <ScrollArea className="h-full p-4"><div className="space-y-3">
                {entries.length === 0 && hasApiKey !== false && <div className="py-12 text-center text-sm text-muted-foreground">LVIS 에이전트가 준비되었습니다. 질문을 입력하거나 /command를 사용하세요.</div>}
                {entries.map((entry, idx) => {
                  if (entry.kind === "user") return <div key={idx} className="ml-auto max-w-[85%] rounded-md border bg-primary px-3 py-2 text-sm text-primary-foreground"><div className="mb-1 text-[11px] text-muted-foreground">나</div><div className="whitespace-pre-wrap">{entry.text}</div></div>;
                  if (entry.kind === "tool") return (
                    <div key={idx} className="mx-4 flex items-center gap-2 rounded border border-dashed px-3 py-1.5 text-xs text-muted-foreground">
                      <Wrench className="h-3 w-3" />
                      <span className="font-mono">{entry.name}</span>
                      {entry.status === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Badge variant={entry.status === "error" ? "secondary" : "default"} className={`text-[10px] ${entry.status === "error" ? "text-red-400" : ""}`}>{entry.status === "error" ? "실패" : "완료"}</Badge>}
                    </div>
                  );
                  // assistant
                  return (
                    <div key={idx} className="max-w-[85%] rounded-md border bg-card px-3 py-2 text-sm">
                      <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">LVIS{entry.streaming ? <Loader2 className="h-3 w-3 animate-spin" /> : null}</div>
                      <div className="whitespace-pre-wrap">{entry.text || (entry.streaming ? "생각 중..." : "")}</div>
                    </div>
                  );
                })}
                <div ref={chatEndRef} />
              </div></ScrollArea>
              <div className="grid grid-cols-[1fr_auto] gap-2 border-t bg-card p-3">
                <Textarea value={question} onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void handleAsk(question); } }}
                  placeholder={hasApiKey === false ? "API 키를 먼저 설정해 주세요..." : "질문 입력 (Enter 전송 / Shift+Enter 줄바꿈) · /command 사용 가능"}
                  className="min-h-[76px]" disabled={streaming} />
                <Button onClick={() => void handleAsk(question)} disabled={streaming || !question.trim()}>{streaming ? <Loader2 className="h-4 w-4 animate-spin" /> : "전송"}</Button>
              </div>
            </div>
          ) : (
            <PluginUiHostView view={activePluginView ?? null} callPluginMethod={(m, p) => api.callPluginMethod(m, p)} onAskInHomeChat={async (q) => { setActiveView("home"); await handleAsk(q); }} onAddTask={(t) => api.addTask(t)} />
          )}
        </main>
      </div>

      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} api={api} onSaved={() => void checkApiKey()} />
      <Dialog open={!!installTarget} onOpenChange={(o) => !o && setInstallTarget(null)}><DialogContent><DialogHeader><DialogTitle>플러그인 설치</DialogTitle><DialogDescription>{installTarget ? `'${installTarget.name}' 설치?` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setInstallTarget(null)}>취소</Button><Button onClick={async () => { if (!installTarget) return; const id = installTarget.id; setInstallTarget(null); await installPlugin(id); }} disabled={working}>설치</Button></DialogFooter></DialogContent></Dialog>
      <Dialog open={commandOpen} onOpenChange={setCommandOpen}><DialogContent><DialogHeader><DialogTitle>Command</DialogTitle><DialogDescription>빠른 실행</DialogDescription></DialogHeader><Command><CommandInput placeholder="검색..." value={commandQuery} onValueChange={setCommandQuery} /><CommandList><CommandEmpty>결과 없음</CommandEmpty><CommandGroup heading="Actions">{commandActions.filter((a) => !commandQuery || a.label.toLowerCase().includes(commandQuery.toLowerCase())).map((a) => <CommandItem key={a.id} onSelect={() => { setCommandOpen(false); setCommandQuery(""); void a.run(); }}><Search className="mr-2 h-4 w-4" />{a.label}</CommandItem>)}</CommandGroup></CommandList></Command></DialogContent></Dialog>
      <Dialog open={!!uninstallTarget} onOpenChange={(o) => !o && setUninstallTarget(null)}><DialogContent><DialogHeader><DialogTitle>플러그인 제거</DialogTitle><DialogDescription>{uninstallTarget ? `'${uninstallTarget.name}' 제거?` : ""}</DialogDescription></DialogHeader><DialogFooter><Button variant="secondary" onClick={() => setUninstallTarget(null)}>취소</Button><Button variant="destructive" onClick={async () => { if (!uninstallTarget) return; const id = uninstallTarget.id; setUninstallTarget(null); await uninstallPlugin(id); }} disabled={working}>제거</Button></DialogFooter></DialogContent></Dialog>
    </TooltipProvider>
  );
}

// ─── Bootstrap ──────────────────────────────────────
const root = document.getElementById("root");
if (!root) throw new Error("root not found");
createRoot(root).render(<App />);

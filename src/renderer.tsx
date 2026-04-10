import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Search, MoreHorizontal, Command as CommandIcon, Settings2, PanelsTopLeft } from "lucide-react";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Badge } from "./components/ui/badge.js";
import { Input } from "./components/ui/input.js";
import { Textarea } from "./components/ui/textarea.js";
import { Tabs, TabsList, TabsTrigger } from "./components/ui/tabs.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./components/ui/tooltip.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "./components/ui/command.js";
import { ScrollArea } from "./components/ui/scroll-area.js";
import { Separator } from "./components/ui/separator.js";
import { Popover, PopoverContent, PopoverTrigger } from "./components/ui/popover.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "./components/ui/sheet.js";
import { PluginUiHostView, type PluginUiExtensionView } from "./plugin-ui-host.js";

type PreviewResult = {
  question: string;
  documentCount: number;
  documentName?: string;
  preview: string;
};

type MarketplaceItem = {
  id: string;
  name: string;
  description: string;
  packageSpec: string;
  installed: boolean;
  enabled: boolean;
};

type PluginUiExtension = PluginUiExtensionView;

type Message = { role: "user" | "assistant"; text: string };

type Task = {
  id: string;
  title: string;
  description?: string;
  source: "email" | "meeting" | "calendar" | "teams" | "manual";
  sourceRef?: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "done" | "snoozed";
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
};

type LvisApi = {
  chatPreview: (question: string) => Promise<PreviewResult>;
  listMarketplacePlugins: () => Promise<MarketplaceItem[]>;
  installMarketplacePlugin: (pluginId: string) => Promise<{ pluginId: string; installed: true }>;
  uninstallMarketplacePlugin: (pluginId: string) => Promise<{ pluginId: string; uninstalled: true }>;
  listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
  callPluginMethod: (method: string, payload?: unknown) => Promise<unknown>;
  addTask: (task: unknown) => Promise<Task>;
  queryTasks: (filter?: unknown) => Promise<Task[]>;
  updateTask: (id: string, patch: unknown) => Promise<Task>;
  deleteTask: (id: string) => Promise<void>;
  getTodayTasks: () => Promise<Task[]>;
  getOverdueTasks: () => Promise<Task[]>;
  onViewActivate: (handler: (viewKey: string) => void) => () => void;
};

declare global {
  interface Window {
    lvisApi: LvisApi;
  }
}

const PRIORITY_CLASS: Record<Task["priority"], string> = {
  high: "text-red-400",
  medium: "text-amber-400",
  low: "text-slate-400",
};

const SOURCE_LABEL: Record<Task["source"], string> = {
  email: "메일",
  meeting: "미팅",
  calendar: "일정",
  teams: "Teams",
  manual: "직접",
};

function TaskView({ api }: { api: LvisApi }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [filter, setFilter] = useState<"pending" | "today" | "overdue" | "done">("pending");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      let result: Task[];
      if (filter === "today") result = await api.getTodayTasks();
      else if (filter === "overdue") result = await api.getOverdueTasks();
      else if (filter === "done") result = await api.queryTasks({ status: "done" });
      else result = await api.queryTasks({ status: "pending" });
      setTasks(result);
    } catch {
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [filter, api]);

  useEffect(() => { void load(); }, [load]);

  const markDone = (id: string) => {
    void api.updateTask(id, { status: "done" }).then(() => load());
  };

  const markPending = (id: string) => {
    void api.updateTask(id, { status: "pending" }).then(() => load());
  };

  const remove = (id: string) => {
    void api.deleteTask(id).then(() => load());
  };

  const isDone = filter === "done";

  return (
    <div className="flex min-h-0 flex-1 flex-col p-4">
      <Card className="flex h-full min-h-0 flex-col">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle>태스크</CardTitle>
            <Button size="sm" variant="outline" onClick={() => void load()}>새로고침</Button>
          </div>
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
            {loading ? (
              <div className="py-8 text-center text-sm text-muted-foreground">로딩 중...</div>
            ) : tasks.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">태스크가 없습니다.</div>
            ) : (
              <div className="space-y-2 pr-2">
                {tasks.map((task) => (
                  <div key={task.id} className={`flex items-start gap-2 rounded-md border p-3 ${isDone ? "opacity-60" : ""}`}>
                    <button
                      className={`mt-0.5 h-4 w-4 flex-shrink-0 rounded border ${isDone ? "border-primary bg-primary" : "border-muted-foreground hover:border-primary"}`}
                      title={isDone ? "진행중으로 되돌리기" : "완료로 표시"}
                      onClick={() => isDone ? markPending(task.id) : markDone(task.id)}
                    >
                      {isDone ? <span className="flex h-full w-full items-center justify-center text-[8px] text-primary-foreground">✓</span> : null}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`text-sm font-medium ${isDone ? "line-through" : ""}`}>{task.title}</span>
                        <Badge variant="outline" className="text-[10px]">{SOURCE_LABEL[task.source]}</Badge>
                        <span className={`text-[10px] font-semibold ${PRIORITY_CLASS[task.priority]}`}>
                          {task.priority}
                        </span>
                      </div>
                      {task.description ? (
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{task.description}</p>
                      ) : null}
                      <div className="mt-1 flex items-center gap-1">
                        <span className="text-[10px] text-muted-foreground">마감:</span>
                        <input
                          type="date"
                          className="rounded border border-transparent bg-transparent px-1 text-[10px] text-muted-foreground hover:border-muted focus:border-primary focus:outline-none"
                          value={task.dueAt ? task.dueAt.slice(0, 10) : ""}
                          onChange={(e) => {
                            const val = e.target.value;
                            void api.updateTask(task.id, { dueAt: val ? new Date(val).toISOString() : undefined }).then(() => load());
                          }}
                        />
                      </div>
                    </div>
                    <button
                      className="flex-shrink-0 text-[10px] text-muted-foreground hover:text-destructive"
                      title="삭제"
                      onClick={() => remove(task.id)}
                    >
                      ✕
                    </button>
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

function getApi() {
  if (!window.lvisApi) throw new Error("IPC bridge(lvisApi)가 초기화되지 않았습니다.");
  return window.lvisApi;
}

function toViewKey(item: PluginUiExtension): string {
  return `plugin:${item.pluginId}:${item.extension.id}`;
}

function getPluginViewLabel(item: PluginUiExtension): string {
  return item.extension.displayName?.trim() || item.extension.title || item.pluginId;
}

function App() {
  const api = useMemo<LvisApi>(() => getApi(), []);
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: "LVIS 로컬 지식 채팅 UI가 준비되었습니다. 질문을 입력해 주세요." },
  ]);
  const [question, setQuestion] = useState("");
  const [marketplace, setMarketplace] = useState<MarketplaceItem[]>([]);
  const [pluginViews, setPluginViews] = useState<PluginUiExtension[]>([]);
  const [activeView, setActiveView] = useState("home");
  const [marketStatus, setMarketStatus] = useState("목록 로딩 중...");
  const [installTarget, setInstallTarget] = useState<MarketplaceItem | null>(null);
  const [uninstallTarget, setUninstallTarget] = useState<MarketplaceItem | null>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [working, setWorking] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [quickQuestion, setQuickQuestion] = useState("");

  const activePluginView = useMemo(
    () => pluginViews.find((item) => toViewKey(item) === activeView),
    [pluginViews, activeView],
  );

  const handleAddTask = useCallback((task: unknown) => api.addTask(task), [api]);

  const commandActions = useMemo(() => {
    const base = [
      { id: "home", label: "홈으로 이동", run: () => setActiveView("home") },
      { id: "tasks", label: "태스크 보기", run: () => setActiveView("tasks") },
      {
        id: "ask",
        label: "최근 질문 다시 실행",
        run: async () => {
          const lastUser = [...messages].reverse().find((m) => m.role === "user");
          if (lastUser) await handleAsk(lastUser.text);
        },
      },
    ];
    const views = pluginViews.map((item) => ({
      id: `view:${toViewKey(item)}`,
      label: `${getPluginViewLabel(item)} 열기`,
      run: () => setActiveView(toViewKey(item)),
    }));
    const installs = marketplace.map((item) => ({
      id: `install:${item.id}`,
      label: `${item.name} ${item.installed ? "재설치" : "설치"}`,
      run: async () => {
        await installPlugin(item.id);
      },
    }));
    const uninstalls = marketplace
      .filter((item) => item.installed)
      .map((item) => ({
        id: `uninstall:${item.id}`,
        label: `${item.name} 제거`,
        run: async () => {
          await uninstallPlugin(item.id);
        },
      }));
    return [...base, ...views, ...installs, ...uninstalls];
  }, [pluginViews, marketplace, messages]);

  const filteredActions = useMemo(() => {
    const q = commandQuery.trim().toLowerCase();
    if (!q) return commandActions;
    return commandActions.filter((item) => item.label.toLowerCase().includes(q));
  }, [commandActions, commandQuery]);

  const refreshViews = async () => {
    const views = (await api.listPluginUiExtensions()).filter((item) => item.extension.slot === "sidebar");
    setPluginViews(views);
    setActiveView((prev) => (prev === "home" || prev === "tasks" || views.some((item) => toViewKey(item) === prev) ? prev : "home"));
    return views;
  };

  const refreshMarketplace = async () => {
    try {
      setMarketStatus("목록 로딩 중...");
      const list = await api.listMarketplacePlugins();
      setMarketplace(list);
      setMarketStatus(`플러그인 ${list.length}개`);
    } catch (error) {
      setMarketStatus(`목록 로딩 실패: ${(error as Error).message}`);
    }
  };

  const handleAsk = useCallback(async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setQuestion("");
    setMessages((prev) => [...prev, { role: "user", text: trimmed }]);
    try {
      const answer = await api.chatPreview(trimmed);
      const text = answer.documentCount
        ? `[문서: ${answer.documentName ?? "unknown"}]\n${answer.preview || "(미리보기 없음)"}`
        : answer.preview;
      setMessages((prev) => [...prev, { role: "assistant", text }]);
    } catch (error) {
      setMessages((prev) => [...prev, { role: "assistant", text: `오류: ${(error as Error).message}` }]);
    }
  }, [api]);

  const callPluginMethod = useCallback(
    (method: string, payload?: unknown) => api.callPluginMethod(method, payload),
    [api],
  );

  const handlePluginAskInHome = useCallback(async (question: string) => {
    const trimmed = question.trim();
    if (!trimmed) return;
    setActiveView("home");
    await handleAsk(trimmed);
  }, [handleAsk]);

  const installPlugin = async (pluginId: string) => {
    const target = marketplace.find((item) => item.id === pluginId);
    setWorking(true);
    try {
      setMarketStatus(`${target?.name ?? pluginId} 설치 중...`);
      await api.installMarketplacePlugin(pluginId);
      await refreshMarketplace();
      const views = await refreshViews();
      const view = views.find((item) => item.pluginId === pluginId);
      if (view) setActiveView(toViewKey(view));
      setMarketStatus(`${target?.name ?? pluginId} 설치 완료`);
    } catch (error) {
      setMarketStatus(`${target?.name ?? pluginId} 설치 실패: ${(error as Error).message}`);
    } finally {
      setWorking(false);
    }
  };

  const uninstallPlugin = async (pluginId: string) => {
    const target = marketplace.find((item) => item.id === pluginId);
    if (!target?.installed) return;
    setWorking(true);
    try {
      setMarketStatus(`${target.name} 제거 중...`);
      await api.uninstallMarketplacePlugin(pluginId);
      await refreshMarketplace();
      await refreshViews();
      setMarketStatus(`${target.name} 제거 완료`);
    } catch (error) {
      setMarketStatus(`${target.name} 제거 실패: ${(error as Error).message}`);
    } finally {
      setWorking(false);
    }
  };

  useEffect(() => {
    void refreshMarketplace();
    void refreshViews();
    const dispose = api.onViewActivate((viewKey) => setActiveView(viewKey));
    const onKeydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener("keydown", onKeydown);
    return () => {
      dispose();
      window.removeEventListener("keydown", onKeydown);
    };
  }, []);


  return (
    <TooltipProvider>
      <div className="grid h-screen grid-cols-[320px_1fr]">
        <aside className="border-r bg-background p-4">
          <Card className="h-full">
            <CardHeader>
              <CardTitle>LVIS Plugins</CardTitle>
              <CardDescription>마켓플레이스에서 설치하고 탭으로 전환해 사용합니다.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-xs text-muted-foreground">{marketStatus}</div>
              <ScrollArea className="h-[calc(100vh-180px)] pr-2">
                <div className="space-y-2">
                  {marketplace.map((plugin) => (
                    <Card key={plugin.id} className="border-muted">
                      <CardContent className="space-y-2 p-3">
                        <div className="flex items-center justify-between">
                          <div className="font-medium">{plugin.name}</div>
                          <Badge variant={plugin.installed ? "default" : "secondary"}>
                            {plugin.installed ? "설치됨" : "미설치"}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">{plugin.description}</p>
                        <p className="text-xs text-muted-foreground">{plugin.packageSpec}</p>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            onClick={() => setInstallTarget(plugin)}
                            disabled={working}
                            className="h-8"
                          >
                            {plugin.installed ? "재설치" : "설치"}
                          </Button>
                          {plugin.installed ? (
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => setUninstallTarget(plugin)}
                              disabled={working}
                              className="h-8"
                            >
                              제거
                            </Button>
                          ) : null}
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="icon" variant="outline" className="h-8 w-8">
                                <MoreHorizontal className="h-4 w-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => {
                                  const target = pluginViews.find((x) => x.pluginId === plugin.id);
                                  if (target) setActiveView(toViewKey(target));
                                }}
                              >
                                UI 열기
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setInstallTarget(plugin)}>
                                {plugin.installed ? "재설치" : "설치"}
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setUninstallTarget(plugin)}
                                disabled={!plugin.installed || working}
                              >
                                제거
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </aside>
        <main className="flex min-h-0 flex-col">
          <div className="border-b bg-card px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <Tabs value={activeView} onValueChange={setActiveView}>
                <TabsList>
                  <TabsTrigger value="home">홈</TabsTrigger>
                  <TabsTrigger value="tasks">태스크</TabsTrigger>
                  {pluginViews.map((item) => (
                    <TabsTrigger key={toViewKey(item)} value={toViewKey(item)}>
                      {getPluginViewLabel(item)}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <div className="flex items-center gap-2">
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" size="sm">
                      <Settings2 className="mr-2 h-4 w-4" />
                      빠른 동작
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" className="space-y-3">
                    <div className="space-y-1">
                      <div className="text-sm font-medium">질문 바로 전송</div>
                      <p className="text-xs text-muted-foreground">짧은 질문을 입력하고 바로 채팅으로 보냅니다.</p>
                    </div>
                    <Input
                      value={quickQuestion}
                      onChange={(event) => setQuickQuestion(event.target.value)}
                      placeholder="예: 오늘 회의 요약해줘"
                    />
                    <Button
                      className="w-full"
                      onClick={() => {
                        void handleAsk(quickQuestion);
                        setQuickQuestion("");
                      }}
                      disabled={!quickQuestion.trim()}
                    >
                      전송
                    </Button>
                  </PopoverContent>
                </Popover>
                <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                  <SheetTrigger asChild>
                    <Button variant="outline" size="sm">
                      <PanelsTopLeft className="mr-2 h-4 w-4" />
                      뷰 관리
                    </Button>
                  </SheetTrigger>
                  <SheetContent side="right">
                    <SheetHeader>
                      <SheetTitle>플러그인 뷰 관리</SheetTitle>
                      <SheetDescription>설치된 플러그인 화면으로 빠르게 이동합니다.</SheetDescription>
                    </SheetHeader>
                    <Separator className="my-4" />
                    <div className="space-y-2">
                      <Button
                        variant={activeView === "home" ? "default" : "secondary"}
                        className="w-full justify-start"
                        onClick={() => { setActiveView("home"); setSheetOpen(false); }}
                      >
                        홈
                      </Button>
                      <Button
                        variant={activeView === "tasks" ? "default" : "secondary"}
                        className="w-full justify-start"
                        onClick={() => { setActiveView("tasks"); setSheetOpen(false); }}
                      >
                        태스크
                      </Button>
                      {pluginViews.map((item) => {
                        const key = toViewKey(item);
                        return (
                          <Button
                            key={key}
                            variant={activeView === key ? "default" : "secondary"}
                            className="w-full justify-start"
                            onClick={() => {
                              setActiveView(key);
                              setSheetOpen(false);
                            }}
                          >
                            {getPluginViewLabel(item)}
                          </Button>
                        );
                      })}
                    </div>
                  </SheetContent>
                </Sheet>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="sm" onClick={() => setCommandOpen(true)}>
                      <CommandIcon className="mr-2 h-4 w-4" />
                      Command
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Ctrl/Cmd + K</TooltipContent>
                </Tooltip>
              </div>
            </div>
          </div>

          {activeView === "tasks" ? (
            <TaskView api={api} />
          ) : activeView === "home" ? (
            <div className="grid min-h-0 flex-1 grid-rows-[1fr_auto]">
              <ScrollArea className="h-full p-4">
                <div className="space-y-3">
                  {messages.map((message, index) => (
                    <div key={`${message.role}-${index}`} className="space-y-3">
                      <div
                        className={`max-w-[85%] rounded-md border px-3 py-2 text-sm ${message.role === "user" ? "ml-auto bg-primary text-primary-foreground" : "bg-card"}`}
                      >
                        <div className="mb-1 text-[11px] text-muted-foreground">{message.role === "user" ? "나" : "LVIS"}</div>
                        <div className="whitespace-pre-wrap">{message.text}</div>
                      </div>
                      {index < messages.length - 1 ? <Separator /> : null}
                    </div>
                  ))}
                </div>
              </ScrollArea>
              <div className="grid grid-cols-[1fr_auto] gap-2 border-t bg-card p-3">
                <Textarea
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void handleAsk(question);
                    }
                  }}
                  placeholder="문서 기반으로 질문을 입력하세요. (Enter 전송 / Shift+Enter 줄바꿈)"
                  className="min-h-[76px]"
                />
                <Button onClick={() => void handleAsk(question)}>전송</Button>
              </div>
            </div>
          ) : (
            <PluginUiHostView
              view={activePluginView ?? null}
              callPluginMethod={callPluginMethod}
              onAskInHomeChat={handlePluginAskInHome}
              onAddTask={handleAddTask}
            />
          )}
        </main>
      </div>

      <Dialog open={!!installTarget} onOpenChange={(open) => !open && setInstallTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>플러그인 설치</DialogTitle>
            <DialogDescription>
              {installTarget
                ? `'${installTarget.name}' 플러그인을 ${installTarget.installed ? "재설치" : "설치"}하시겠습니까?`
                : "플러그인 설치를 진행하시겠습니까?"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setInstallTarget(null)}>
              취소
            </Button>
            <Button
              onClick={async () => {
                if (!installTarget) return;
                const id = installTarget.id;
                setInstallTarget(null);
                await installPlugin(id);
              }}
              disabled={working}
            >
              설치
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={commandOpen} onOpenChange={setCommandOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Command</DialogTitle>
            <DialogDescription>뷰 전환과 설치/제거 작업을 빠르게 실행합니다.</DialogDescription>
          </DialogHeader>
          <Command>
            <CommandInput
              placeholder="명령 검색..."
              value={commandQuery}
              onValueChange={setCommandQuery}
            />
            <CommandList>
              <CommandEmpty>결과가 없습니다.</CommandEmpty>
              <CommandGroup heading="Actions">
                {filteredActions.map((action) => (
                  <CommandItem
                    key={action.id}
                    onSelect={() => {
                      setCommandOpen(false);
                      setCommandQuery("");
                      void action.run();
                    }}
                  >
                    <Search className="mr-2 h-4 w-4" />
                    {action.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>

      <Dialog open={!!uninstallTarget} onOpenChange={(open) => !open && setUninstallTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>플러그인 제거</DialogTitle>
            <DialogDescription>
              {uninstallTarget
                ? `'${uninstallTarget.name}' 플러그인을 제거하시겠습니까?`
                : "플러그인 제거를 진행하시겠습니까?"}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setUninstallTarget(null)}>
              취소
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                if (!uninstallTarget) return;
                const id = uninstallTarget.id;
                setUninstallTarget(null);
                await uninstallPlugin(id);
              }}
              disabled={working}
            >
              제거
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </TooltipProvider>
  );
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("root element not found");
}
createRoot(rootElement).render(<App />);

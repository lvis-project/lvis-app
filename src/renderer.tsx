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

declare global {
  interface Window {
    lvisApi: {
      chatPreview: (question: string) => Promise<PreviewResult>;
      listMarketplacePlugins: () => Promise<MarketplaceItem[]>;
      installMarketplacePlugin: (pluginId: string) => Promise<{ pluginId: string; installed: true }>;
      uninstallMarketplacePlugin: (pluginId: string) => Promise<{ pluginId: string; uninstalled: true }>;
      listPluginUiExtensions: () => Promise<PluginUiExtension[]>;
      callPluginMethod: (method: string, payload?: unknown) => Promise<unknown>;
      onViewActivate: (handler: (viewKey: string) => void) => () => void;
    };
  }
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
  const api = useMemo(() => getApi(), []);
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

  const commandActions = useMemo(() => {
    const base = [
      { id: "home", label: "홈으로 이동", run: () => setActiveView("home") },
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
    setActiveView((prev) => (prev === "home" || views.some((item) => toViewKey(item) === prev) ? prev : "home"));
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
                        onClick={() => {
                          setActiveView("home");
                          setSheetOpen(false);
                        }}
                      >
                        홈
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

          {activeView === "home" ? (
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

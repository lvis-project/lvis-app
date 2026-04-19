import { Search, Command as CommandIcon, KeyRound, Plus, PanelsTopLeft, Download, History, BookOpen } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription, SheetTrigger } from "../../components/ui/sheet.js";
import { Separator } from "../../components/ui/separator.js";
import { getPluginViewLabel, toViewKey } from "./api-client.js";
import type { PluginUiExtension } from "./types.js";

export interface MainToolbarProps {
  activeView: string;
  setActiveView: (v: string) => void;
  pluginViews: PluginUiExtension[];
  starredCount: number;
  streaming: boolean;
  hasApiKey: boolean | null;
  sessions: Array<{ id: string; modifiedAt: string }>;
  currentSessionId: string;
  sheetOpen: boolean;
  setSheetOpen: (b: boolean) => void;
  onNewChat: () => void;
  onRefreshSessions: () => void | Promise<void>;
  onLoadSession: (sessionId: string) => void | Promise<void>;
  onExport: (format: "markdown" | "json") => void | Promise<void>;
  onSearchToggle: () => void;
  onOpenSettings: () => void;
  onOpenCommand: () => void;
}

export function MainToolbar({
  activeView,
  setActiveView,
  pluginViews,
  starredCount,
  streaming,
  hasApiKey,
  sessions,
  currentSessionId,
  sheetOpen,
  setSheetOpen,
  onNewChat,
  onRefreshSessions,
  onLoadSession,
  onExport,
  onSearchToggle,
  onOpenSettings,
  onOpenCommand,
}: MainToolbarProps) {
  return (
    <div className="border-b bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <Tabs value={activeView} onValueChange={setActiveView}><TabsList>
          <TabsTrigger value="home">홈</TabsTrigger><TabsTrigger value="tasks">태스크</TabsTrigger>
          <TabsTrigger value="starred">즐겨찾기{starredCount > 0 ? <span className="ml-1 text-[10px] text-muted-foreground">({starredCount})</span> : null}</TabsTrigger>
          <TabsTrigger value="memory"><BookOpen className="mr-1 h-3 w-3" />메모리</TabsTrigger>
          {pluginViews.map((i) => <TabsTrigger key={toViewKey(i)} value={toViewKey(i)}>{getPluginViewLabel(i)}</TabsTrigger>)}
        </TabsList></Tabs>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onNewChat}><Plus className="mr-1 h-4 w-4" />새 대화</Button>
          <DropdownMenu onOpenChange={(open) => { if (open) void onRefreshSessions(); }}>
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
                      onClick={() => void onLoadSession(s.id)}
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
              <DropdownMenuItem onClick={() => void onExport("markdown")}>Markdown (.md)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void onExport("json")}>JSON (.json)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button variant="outline" size="sm" onClick={onSearchToggle} title="대화 검색 (Ctrl/Cmd+F)"><Search className="mr-1 h-4 w-4" />찾기</Button>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}><SheetTrigger asChild><Button variant="outline" size="sm"><PanelsTopLeft className="mr-1 h-4 w-4" />뷰</Button></SheetTrigger>
            <SheetContent side="right"><SheetHeader><SheetTitle>뷰 관리</SheetTitle><SheetDescription>빠른 이동</SheetDescription></SheetHeader><Separator className="my-4" />
              <div className="space-y-2">
                <Button variant={activeView === "home" ? "default" : "secondary"} className="w-full justify-start" onClick={() => { setActiveView("home"); setSheetOpen(false); }}>홈</Button>
                <Button variant={activeView === "tasks" ? "default" : "secondary"} className="w-full justify-start" onClick={() => { setActiveView("tasks"); setSheetOpen(false); }}>태스크</Button>
                {pluginViews.map((i) => { const k = toViewKey(i); return <Button key={k} variant={activeView === k ? "default" : "secondary"} className="w-full justify-start" onClick={() => { setActiveView(k); setSheetOpen(false); }}>{getPluginViewLabel(i)}</Button>; })}
              </div>
            </SheetContent>
          </Sheet>
          <Tooltip><TooltipTrigger asChild><Button variant={hasApiKey === false ? "destructive" : "outline"} size="sm" onClick={onOpenSettings}><KeyRound className="mr-1 h-4 w-4" />설정</Button></TooltipTrigger><TooltipContent>{hasApiKey ? "LLM 설정" : "API 키를 설정해 주세요"}</TooltipContent></Tooltip>
          <Tooltip><TooltipTrigger asChild><Button variant="outline" size="sm" onClick={onOpenCommand}><CommandIcon className="mr-1 h-4 w-4" />Cmd</Button></TooltipTrigger><TooltipContent>Ctrl/Cmd + K</TooltipContent></Tooltip>
        </div>
      </div>
    </div>
  );
}

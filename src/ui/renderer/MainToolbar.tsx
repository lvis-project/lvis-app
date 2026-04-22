import { Search, Command as CommandIcon, KeyRound, Plus, Download, History, Star } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";

export interface MainToolbarProps {
  streaming: boolean;
  hasApiKey: boolean | null;
  sessions: Array<{ id: string; modifiedAt: string; title: string }>;
  currentSessionId: string;
  isCurrentSessionStarred: boolean;
  onNewChat: () => void;
  onRefreshSessions: () => void | Promise<void>;
  onRefreshStarred?: () => void | Promise<void>;
  onLoadSession: (sessionId: string) => void | Promise<void>;
  onToggleCurrentSessionStar: () => void | Promise<void>;
  onToggleSessionStar: (sessionId: string, title: string) => void | Promise<void>;
  isSessionStarred: (sessionId: string) => boolean;
  onExport: (format: "markdown" | "json") => void | Promise<void>;
  onSearchToggle: () => void;
  onOpenSettings: () => void;
  onOpenCommand: () => void;
}

export function MainToolbar({
  streaming,
  hasApiKey,
  sessions,
  currentSessionId,
  isCurrentSessionStarred,
  onNewChat,
  onRefreshSessions,
  onRefreshStarred,
  onLoadSession,
  onToggleCurrentSessionStar,
  onToggleSessionStar,
  isSessionStarred,
  onExport,
  onSearchToggle,
  onOpenSettings,
  onOpenCommand,
}: MainToolbarProps) {
  return (
    <div className="border-b bg-card px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onNewChat}><Plus className="mr-1 h-4 w-4" />새 대화</Button>
        <DropdownMenu onOpenChange={(open) => { if (open) { void onRefreshSessions(); void onRefreshStarred?.(); } }}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              title={streaming ? "응답 생성 중에도 기록은 확인할 수 있습니다" : "대화 기록 불러오기"}
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
                const starred = isSessionStarred(s.id);
                return (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => {
                      if (!isCurrent) void onLoadSession(s.id);
                    }}
                    className={isCurrent ? "bg-muted/50" : ""}
                  >
                    <div className="flex w-full items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-xs">{s.title || "제목 없는 세션"}</div>
                        <div className="text-[10px] text-muted-foreground">
                          {new Date(s.modifiedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}
                          {isCurrent ? " · 현재" : ""}
                        </div>
                      </div>
                      <button
                        type="button"
                        className={`rounded p-1 hover:bg-muted ${starred ? "text-yellow-400" : "text-muted-foreground"}`}
                        onPointerDown={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                        }}
                        onClick={(event) => {
                          event.stopPropagation();
                          void onToggleSessionStar(s.id, s.title);
                        }}
                        title={starred ? "세션 즐겨찾기 해제" : "세션 즐겨찾기"}
                      >
                        <Star className={`h-3.5 w-3.5 ${starred ? "fill-current" : ""}`} />
                      </button>
                    </div>
                  </DropdownMenuItem>
                );
              })
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant={isCurrentSessionStarred ? "secondary" : "outline"} size="sm" onClick={onToggleCurrentSessionStar}>
              <Star className={`mr-1 h-4 w-4 ${isCurrentSessionStarred ? "fill-current" : ""}`} />
              세션
            </Button>
          </TooltipTrigger>
          <TooltipContent>현재 세션 즐겨찾기</TooltipContent>
        </Tooltip>
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
        <Tooltip><TooltipTrigger asChild><Button variant={hasApiKey === false ? "destructive" : "outline"} size="sm" onClick={onOpenSettings}><KeyRound className="mr-1 h-4 w-4" />설정</Button></TooltipTrigger><TooltipContent>{hasApiKey ? "LLM 설정" : "API 키를 설정해 주세요"}</TooltipContent></Tooltip>
        <Tooltip><TooltipTrigger asChild><Button variant="outline" size="sm" onClick={onOpenCommand}><CommandIcon className="mr-1 h-4 w-4" />Cmd</Button></TooltipTrigger><TooltipContent>Ctrl/Cmd + K</TooltipContent></Tooltip>
      </div>
    </div>
  );
}

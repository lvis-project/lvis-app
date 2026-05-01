import { Command as CommandIcon, Download, KeyRound, Menu, Plus, Search, Star } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
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
  onOpenSettings: () => void;
  onOpenCommand: () => void;
  onOpenGlobalSearch: () => void;
  onOpenStarredView: () => void;
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
  onOpenSettings,
  onOpenCommand,
  onOpenGlobalSearch,
  onOpenStarredView,
}: MainToolbarProps) {
  return (
    <div className="border-b bg-card px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {/* ── Command palette button ─────────────────────────────────── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onOpenCommand} title="명령 팔레트 (Ctrl/Cmd+K)">
              <CommandIcon className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Ctrl/Cmd + K</TooltipContent>
        </Tooltip>

        {/* ── Spacer pushes remaining items to the right ─────────────── */}
        <div className="flex-1" />

        {/* ── New chat — stays outside hamburger (frequent action) ─────── */}
        <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px]" onClick={onNewChat}>
          <Plus className="h-3.5 w-3.5" />새 대화
        </Button>

        {/* ── Global search — opens GlobalSearchDialog ─────────────────── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onOpenGlobalSearch} title="전체 검색 (메모리·세션·즐겨찾기)">
              <Search className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>전체 검색 (메모리·세션·즐겨찾기)</TooltipContent>
        </Tooltip>

        {/* ── Hamburger — wraps infrequent actions ────────────────────── */}
        <DropdownMenu
          onOpenChange={(open) => {
            if (open) {
              void onRefreshSessions();
              void onRefreshStarred?.();
            }
          }}
        >
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="더 많은 메뉴">
              <Menu className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[280px]">
            {/* ── Settings ── */}
            <DropdownMenuItem onClick={onOpenSettings}>
              <KeyRound className="mr-2 h-3.5 w-3.5" />
              <span className={hasApiKey === false ? "text-destructive" : ""}>설정</span>
              {hasApiKey === false && (
                <span className="ml-auto text-[10px] text-destructive">API 키 필요</span>
              )}
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* ── Star current session ── */}
            <DropdownMenuItem onClick={() => void onToggleCurrentSessionStar()}>
              <Star className={`mr-2 h-3.5 w-3.5 ${isCurrentSessionStarred ? "fill-yellow-400 text-yellow-400" : ""}`} />
              <span>{isCurrentSessionStarred ? "현재 세션 즐겨찾기 해제" : "현재 세션 즐겨찾기"}</span>
            </DropdownMenuItem>

            {/* ── Starred view ── */}
            <DropdownMenuItem onClick={onOpenStarredView}>
              <Star className="mr-2 h-3.5 w-3.5" />
              <span>즐겨찾기 보기</span>
            </DropdownMenuItem>

            {/* ── Export submenu ── */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Download className="mr-2 h-3.5 w-3.5" />
                <span>내보내기</span>
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onClick={() => void onExport("markdown")}>Markdown (.md)</DropdownMenuItem>
                <DropdownMenuItem onClick={() => void onExport("json")}>JSON (.json)</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            {/* ── Session history ── */}
            <div className="max-h-[320px] overflow-y-auto">
              <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">대화 기록</div>
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
                      disabled={streaming && !isCurrent}
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
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

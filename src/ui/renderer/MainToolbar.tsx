import { Database, Download, ExternalLink, Home, KeyRound, Menu, Plus, Repeat2, Search, Star, Wrench } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";

/**
 * Dev mode 감지 — preload (`src/preload.ts`) 가 `window.__lvisDevMode` 를
 * runtime 에 set. main process 가 `scripts/run-electron.mjs` 에서
 * NODE_ENV=development 설정한 결과를 reads. webpack build-time 치환에 의존
 * 안 함 (renderer build 가 default production 모드라서 build-time literal
 * 은 항상 false 가 됨).
 */
function isDevMode(): boolean {
  return (window as unknown as { __lvisDevMode?: boolean }).__lvisDevMode === true;
}

export interface MainToolbarProps {
  activeView: string;
  streaming: boolean;
  hasApiKey: boolean | null;
  isCurrentSessionStarred: boolean;
  onNewChat: () => void;
  onToggleCurrentSessionStar: () => void | Promise<void>;
  onExport: (format: "markdown" | "json") => void | Promise<void>;
  onOpenHome: () => void;
  onOpenRoutinesView: () => void;
  onOpenMemoryView: () => void;
  onOpenSettings: () => void;
  onOpenUnifiedSearch: () => void;
  onOpenStarredView: () => void;
  onOpenDetachedView: (viewKey: "routines" | "memory" | "starred") => void | Promise<void>;
  /** Dev mode 만 사용 — clicking the wrench opens the floating DevToolsPanel. */
  onOpenDevTools?: () => void;
}

export function MainToolbar({
  activeView,
  streaming,
  hasApiKey,
  isCurrentSessionStarred,
  onNewChat,
  onToggleCurrentSessionStar,
  onExport,
  onOpenHome,
  onOpenRoutinesView,
  onOpenMemoryView,
  onOpenSettings,
  onOpenUnifiedSearch,
  onOpenStarredView,
  onOpenDetachedView,
  onOpenDevTools,
}: MainToolbarProps) {
  return (
    <div data-testid="main-toolbar" className="border-b bg-card px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        {/* ── Home anchors the primary chat view ─────────────────────── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant={activeView === "home" ? "secondary" : "ghost"}
              size="sm"
              className="h-7 w-7 p-0"
              onClick={onOpenHome}
              title="홈"
              aria-label="홈"
            >
              <Home className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>홈</TooltipContent>
        </Tooltip>

        {/* ── Dev tools indicator — only visible in non-production. */}
        {isDevMode() && onOpenDevTools !== undefined && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-[10.5px] font-mono text-warning"
                onClick={onOpenDevTools}
                title="Dev Tools (Cmd/Ctrl+Shift+D)"
                aria-label="Dev Tools (Cmd/Ctrl+Shift+D)"
                data-testid="dev-tools-toggle"
              >
                <Wrench className="h-3 w-3" />
                <span>Dev</span>
                <kbd className="rounded border border-warning/40 bg-warning/10 px-1 text-[9.5px]">⇧⌘D</kbd>
              </Button>
            </TooltipTrigger>
            <TooltipContent>Dev Tools — Preflight 임계 조절 (Cmd/Ctrl+Shift+D)</TooltipContent>
          </Tooltip>
        )}

        {/* ── Spacer pushes remaining items to the right ─────────────── */}
        <div className="flex-1" />

        {/* ── Unified search — opens the top-attached search panel ─────── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onOpenUnifiedSearch} title="통합 검색 (Cmd/Ctrl+F)" aria-label="통합 검색 (Cmd/Ctrl+F)">
              <Search className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>통합 검색 (Cmd/Ctrl+F)</TooltipContent>
        </Tooltip>

        {/* ── Current session star — immediate session-level action ───── */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              onClick={() => void onToggleCurrentSessionStar()}
              title={isCurrentSessionStarred ? "현재 세션 즐겨찾기 해제" : "현재 세션 즐겨찾기"}
              aria-label={isCurrentSessionStarred ? "현재 세션 즐겨찾기 해제" : "현재 세션 즐겨찾기"}
              aria-pressed={isCurrentSessionStarred}
            >
              <Star key={isCurrentSessionStarred ? "on" : "off"} className={`h-3.5 w-3.5 ${isCurrentSessionStarred ? "fill-emphasis text-emphasis lvis-anim-star" : ""}`} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{isCurrentSessionStarred ? "현재 세션 즐겨찾기 해제" : "현재 세션 즐겨찾기"}</TooltipContent>
        </Tooltip>

        {/* ── Hamburger — wraps infrequent actions ────────────────────── */}
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  title="더 많은 메뉴"
                  aria-label="더 많은 메뉴"
                >
                  <Menu className="h-3.5 w-3.5" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent>더 많은 메뉴</TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-[280px]">
            {/* ── New chat ── */}
            <DropdownMenuItem disabled={streaming} onClick={onNewChat}>
              <Plus className="mr-2 h-3.5 w-3.5" />
              <span>새 대화</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* ── Built-in secondary views ── */}
            <DropdownMenuItem onClick={onOpenRoutinesView}>
              <Repeat2 className="mr-2 h-3.5 w-3.5" />
              <span>루틴</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenMemoryView}>
              <Database className="mr-2 h-3.5 w-3.5" />
              <span>메모리</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenStarredView}>
              <Star className="mr-2 h-3.5 w-3.5" />
              <span>즐겨찾기</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

            {/* ── Detached built-in views ── */}
            <DropdownMenuItem data-testid="toolbar-detach-routines" onClick={() => void onOpenDetachedView("routines")}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              <span>루틴 새 창으로 열기</span>
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="toolbar-detach-memory" onClick={() => void onOpenDetachedView("memory")}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              <span>메모리 새 창으로 열기</span>
            </DropdownMenuItem>
            <DropdownMenuItem data-testid="toolbar-detach-starred" onClick={() => void onOpenDetachedView("starred")}>
              <ExternalLink className="mr-2 h-3.5 w-3.5" />
              <span>즐겨찾기 새 창으로 열기</span>
            </DropdownMenuItem>

            <DropdownMenuSeparator />

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

            {/* ── Settings ── */}
            <DropdownMenuItem onClick={onOpenSettings}>
              <KeyRound className="mr-2 h-3.5 w-3.5" />
              <span className={hasApiKey === false ? "text-destructive" : ""}>설정</span>
              {hasApiKey === false && (
                <span className="ml-auto text-[10px] text-destructive">API 키 필요</span>
              )}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

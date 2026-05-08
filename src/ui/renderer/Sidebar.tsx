import { useCallback, useRef, useState } from "react";
import { Bell, Home, Repeat2, Star, Database, GitBranch } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.js";
import type { SessionSummary } from "./hooks/use-sessions.js";

export interface SidebarProps {
  activeView: string;
  setActiveView: (key: string) => void;
  starredCount: number;
  sessions?: SessionSummary[];
  onLoadSession?: (sessionId: string) => void;
}

// "home" is the chat view — not detachable (it is the primary anchor window).
const DETACHABLE_KEYS = new Set(["reminders", "routines", "memory", "starred"]);

interface ContextMenuState {
  x: number;
  y: number;
  viewKey: string;
}

export function Sidebar(props: SidebarProps) {
  const { activeView, setActiveView, starredCount, sessions, onLoadSession } = props;

  // Branch sessions: those with a parentSessionId are child forks
  const branchSessions = sessions?.filter((s) => s.parentSessionId) ?? [];

  // Context menu for "Open in new window" — built-in detachable views only.
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, key: string) => {
      // Only show "Open in new window" for built-in detachable views.
      // Plugin views are now accessed via the InputActionBar plugin grid.
      if (!DETACHABLE_KEYS.has(key)) return;
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, viewKey: key });
    },
    [],
  );

  const handleOpenInNewWindow = useCallback(async () => {
    if (!contextMenu) return;
    setContextMenu(null);
    const api = window.lvisApi;
    if (!api?.window?.openDetached) return;
    await api.window.openDetached(contextMenu.viewKey);
  }, [contextMenu]);

  const dismissContextMenu = useCallback(() => setContextMenu(null), []);

  // Built-in views only — plugins are now accessed via the InputActionBar plugin grid.
  // In-flight install progress lives there too (PluginGridButton's placeholder
  // cell + spinner-with-phase) so the sidebar stays clean.
  const navItems = [
    { key: "home", label: "홈", icon: Home },
    { key: "reminders", label: "리마인더", icon: Bell },
    { key: "routines", label: "루틴", icon: Repeat2 },
    { key: "starred", label: "즐겨찾기", icon: Star, badge: starredCount > 0 ? String(starredCount) : null },
    { key: "memory", label: "메모리", icon: Database },
  ];

  return (
    <aside
      data-testid="sidebar"
      className="flex min-h-0 w-14 shrink-0 flex-col items-center overflow-visible border-r bg-background px-2 py-3"
    >
      <TooltipProvider delayDuration={250}>
        <div className="flex flex-1 flex-col items-center gap-1 overflow-visible">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeView === item.key;
            const label = item.badge ? `${item.label} ${item.badge}` : item.label;
            const navTitle = `${label} 보기`;
            return (
              <Tooltip key={item.key}>
                <TooltipTrigger asChild>
                  <Button
                    variant={active ? "secondary" : "ghost"}
                    size="icon"
                    className="relative h-10 w-10 overflow-visible"
                    aria-label={label}
                    title={navTitle}
                    onClick={() => setActiveView(item.key)}
                    onContextMenu={(e) => handleContextMenu(e, item.key)}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="sr-only">{label}</span>
                    {item.badge ? (
                      <>
                        <span className="sr-only">({item.badge})</span>
                        <span className="absolute right-0 top-0 min-w-4 rounded-full bg-primary px-1 text-center text-[9px] leading-4 text-primary-foreground">
                          {item.badge}
                        </span>
                      </>
                    ) : null}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">{label}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>

      {/* Branch session tree — shown when forked sessions exist */}
      {branchSessions.length > 0 && (
        <div className="mt-2 w-full border-t pt-2">
          <TooltipProvider delayDuration={250}>
            <div className="flex flex-col items-start gap-1 px-1">
              {branchSessions.map((s) => (
                <Tooltip key={s.id}>
                  <TooltipTrigger asChild>
                    <button
                      data-testid={`branch-session-${s.id}`}
                      aria-label={`분기 세션: ${s.title}`}
                      className="branch-session-item flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs hover:bg-accent hover:text-accent-foreground"
                      onClick={() => onLoadSession?.(s.id)}
                    >
                      <GitBranch className="h-3 w-3 shrink-0 text-[hsl(var(--action-branch))]" />
                      <span className="branch-badge ml-0.5 rounded bg-[hsl(var(--action-branch)/0.15)] px-1 text-[9px] font-medium text-[hsl(var(--action-branch))]">
                        branch
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[9px] text-foreground/70">
                        {s.title}
                      </span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">
                    <span className="block max-w-[180px] truncate">{s.title}</span>
                    {s.branchedFromCompactNum !== undefined && (
                      <span className="block text-[10px] text-muted-foreground">
                        checkpoint #{s.branchedFromCompactNum} 에서 분기
                      </span>
                    )}
                  </TooltipContent>
                </Tooltip>
              ))}
            </div>
          </TooltipProvider>
        </div>
      )}

      {/* Right-click context menu */}
      {contextMenu && (
        <>
          {/* Click-away overlay */}
          <div
            className="fixed inset-0 z-40"
            aria-hidden="true"
            onClick={dismissContextMenu}
            onContextMenu={(e) => { e.preventDefault(); dismissContextMenu(); }}
          />
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 min-w-[160px] rounded-md border bg-popover py-1 shadow-md"
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              role="menuitem"
              className="flex w-full items-center px-3 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              onClick={handleOpenInNewWindow}
            >
              새 창으로 열기
            </button>
          </div>
        </>
      )}
    </aside>
  );
}

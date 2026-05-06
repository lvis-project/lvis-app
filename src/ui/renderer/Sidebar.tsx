import { useCallback, useRef, useState } from "react";
import { Bell, Home, Repeat2, Star, Database } from "lucide-react";
import { Button } from "../../components/ui/button.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../../components/ui/tooltip.js";

export interface SidebarProps {
  activeView: string;
  setActiveView: (key: string) => void;
  starredCount: number;
}

// "home" is the chat view — not detachable (it is the primary anchor window).
const DETACHABLE_KEYS = new Set(["reminders", "routines", "memory", "starred"]);

interface ContextMenuState {
  x: number;
  y: number;
  viewKey: string;
}

export function Sidebar(props: SidebarProps) {
  const { activeView, setActiveView, starredCount } = props;

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
      className="flex min-h-0 w-14 shrink-0 flex-col items-center border-r bg-background px-2 py-3"
    >
      <TooltipProvider delayDuration={250}>
        <div className="flex flex-1 flex-col items-center gap-1 overflow-y-auto">
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
                    className="relative h-10 w-10"
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
                        <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-primary px-1 text-[9px] leading-4 text-primary-foreground">
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

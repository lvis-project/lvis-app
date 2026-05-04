import { useCallback, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";

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
    { key: "home", label: "홈" },
    { key: "reminders", label: "리마인더" },
    { key: "routines", label: "루틴" },
    { key: "starred", label: "즐겨찾기", badge: starredCount > 0 ? `(${starredCount})` : null },
    { key: "memory", label: "메모리" },
  ];

  return (
    <aside
      data-testid="sidebar"
      className="flex min-h-0 w-32 shrink-0 flex-col border-r bg-background px-3 py-4"
    >
      <div className="mb-4 px-2 text-xs font-semibold tracking-wide text-muted-foreground">
        메뉴
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto pr-1">
        {navItems.map((item) => (
          <Button
            key={item.key}
            variant={activeView === item.key ? "secondary" : "ghost"}
            className="w-full min-w-0 justify-start gap-2 px-3"
            onClick={() => setActiveView(item.key)}
            onContextMenu={(e) => handleContextMenu(e, item.key)}
          >
            <span className="truncate">{item.label}</span>
            {item.badge ? <span className="shrink-0 text-[10px] text-muted-foreground">{item.badge}</span> : null}
          </Button>
        ))}
      </div>

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

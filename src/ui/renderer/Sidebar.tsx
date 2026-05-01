import { useCallback, useRef, useState } from "react";
import { Button } from "../../components/ui/button.js";
import type { InstallInFlight } from "./hooks/use-plugin-marketplace.js";
import type { PluginUiExtension } from "./types.js";

export interface SidebarProps {
  activeView: string;
  pluginViews: PluginUiExtension[];
  setActiveView: (key: string) => void;
  starredCount: number;
  installInFlight?: InstallInFlight;
}

const PHASE_LABEL: Record<string, string> = {
  installing: "설치 중…",
  restarting: "재시작 중…",
};

// "home" is the chat view — not detachable (it is the primary anchor window).
const DETACHABLE_KEYS = new Set(["tasks", "reminders", "routines", "memory", "starred"]);

interface ContextMenuState {
  x: number;
  y: number;
  viewKey: string;
}

export function Sidebar(props: SidebarProps) {
  const { activeView, pluginViews, setActiveView, starredCount, installInFlight } = props;

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

  // Surface in-flight installs as disabled skeleton rows so the user sees
  // their click registered immediately even before the main-process pipeline
  // (download → verify → register → restart) finishes. Slugs that already
  // resolved into a real `pluginViews` entry skip this — the real tab takes
  // over once the result event fires.
  const inFlightEntries = installInFlight
    ? Object.entries(installInFlight).filter(([slug]) => !pluginViews.some((v) => v.pluginId === slug))
    : [];

  // Built-in views only — plugins are now accessed via the InputActionBar plugin grid.
  const navItems = [
    { key: "home", label: "홈" },
    { key: "tasks", label: "태스크" },
    { key: "reminders", label: "리마인더" },
    { key: "routines", label: "루틴" },
    { key: "starred", label: "즐겨찾기", badge: starredCount > 0 ? `(${starredCount})` : null },
    { key: "memory", label: "메모리" },
  ];

  return (
    <aside className="flex min-h-0 w-32 shrink-0 flex-col border-r bg-background px-3 py-4">
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
        {inFlightEntries.map(([slug, phase]) => (
          <div
            key={`in-flight:${slug}`}
            className="flex w-full min-w-0 animate-pulse items-center gap-2 rounded-md border border-dashed border-muted px-3 py-2 text-sm text-muted-foreground"
            aria-label={`${slug} 설치 진행 중`}
            aria-live="polite"
          >
            <span
              className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent"
              aria-hidden="true"
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-xs">{slug}</span>
              <span className="truncate text-[10px] opacity-70">{PHASE_LABEL[phase] ?? "준비 중…"}</span>
            </span>
          </div>
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

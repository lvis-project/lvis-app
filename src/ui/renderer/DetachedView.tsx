/**
 * DetachedView — shell for a tab opened in a standalone BrowserWindow.
 *
 * Mounts when renderer.tsx detects `#detached/<viewKey>` in the URL fragment.
 * Renders a minimal shell: the B1 CustomTitleBar + the actual content view.
 *
 * Supported viewKeys:
 *   "reminders", "routines", "memory", "starred",
 *   "plugin:<pluginId>:<extensionId>"
 *
 * The snap-edge highlight (2px accent border on the main window) is handled
 * in a separate component <SnapEdgeHighlight /> which subscribes to the
 * lvis:window:snap-edge IPC event broadcast by WindowManager.
 */

import { useEffect, useMemo, useState } from "react";
import { ThemeProvider } from "./theme/index.js";
import { TooltipProvider } from "../../components/ui/tooltip.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { getApi, toViewKey } from "./api-client.js";
import { RoutinePanel } from "./components/RoutinePanel.js";
import { MemorySearchPanel } from "./components/MemorySearchPanel.js";
import { StarredView } from "./components/StarredView.js";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { useStarred } from "./hooks/use-starred.js";
import { CustomTitleBar } from "./components/CustomTitleBar.js";

// ─── Snap edge highlight overlay ─────────────────────────────────────────────

type SnapEdge = "n" | "s" | "e" | "w";

const EDGE_BORDER_CLASSES: Record<SnapEdge, string> = {
  n: "top-0 left-0 right-0 h-0.5",
  s: "bottom-0 left-0 right-0 h-0.5",
  w: "left-0 top-0 bottom-0 w-0.5",
  e: "right-0 top-0 bottom-0 w-0.5",
};

/**
 * Renders a 2px accent border on the corresponding edge of this window when
 * a child window enters the snap zone. Only meaningful in the main window.
 */
function SnapEdgeHighlight() {
  const [activeEdge, setActiveEdge] = useState<SnapEdge | null>(null);

  useEffect(() => {
    const api = window.lvisApi;
    if (!api?.window?.onSnapEdge) return;
    const unsub = api.window.onSnapEdge((edge) => setActiveEdge(edge));
    return unsub;
  }, []);

  if (!activeEdge) return null;

  return (
    <div
      className={`pointer-events-none fixed z-50 bg-primary/80 ${EDGE_BORDER_CLASSES[activeEdge]}`}
      aria-hidden="true"
    />
  );
}

// ─── Content dispatcher ───────────────────────────────────────────────────────

interface ContentProps {
  viewKey: string;
}

function DetachedContent({ viewKey }: ContentProps) {
  const api = useMemo(() => getApi(), []);
  const { pluginViews, refreshViews } = usePluginMarketplace(api);
  const { starred, refreshStarred } = useStarred(api);

  // Eagerly load plugin view list when this component mounts for a plugin key,
  // and whenever the viewKey changes to a plugin key. Without this call
  // pluginViews stays empty (the hook never auto-fetches) and PluginUiHostView
  // receives view=null → "플러그인 뷰를 찾을 수 없습니다." error.
  useEffect(() => {
    if (viewKey.startsWith("plugin:")) {
      void refreshViews();
    }
  }, [viewKey, refreshViews]);

  if (viewKey === "reminders" || viewKey === "routines") {
    return <RoutinePanel api={api} />;
  }

  if (viewKey === "memory") {
    return <MemorySearchPanel api={api} />;
  }

  if (viewKey === "starred") {
    return (
      <StarredView
        api={api}
        starred={starred}
        currentSessionId=""
        refreshStarred={refreshStarred}
        onJumpToSession={() => {
          // Cross-window session jump not yet implemented.
        }}
        onActivateHome={() => {
          void api.window?.closeDetached();
        }}
      />
    );
  }

  // Plugin view: viewKey = "plugin:<pluginId>:<extensionId>"
  // In detached mode, render without host chrome to avoid title duplication.
  if (viewKey.startsWith("plugin:")) {
    const activePluginView = pluginViews.find((v) => toViewKey(v) === viewKey) ?? null;
    return <PluginUiHostView view={activePluginView} showChrome={false} />;
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
      알 수 없는 뷰: {viewKey}
    </div>
  );
}

export function getDetachedShellClassName(viewKey: string): string {
  if (viewKey.startsWith("plugin:")) {
    return "flex h-screen flex-col overflow-hidden text-foreground";
  }
  return "flex h-screen flex-col overflow-hidden bg-background text-foreground";
}

export function getDetachedMainClassName(viewKey: string): string {
  // Plugin webviews own their detached-view canvas. Host padding/background leaks
  // the LVIS shell theme around translucent plugin panels, so keep them full-bleed.
  if (viewKey.startsWith("plugin:")) {
    return "flex min-h-0 flex-1 flex-col overflow-hidden";
  }
  return "flex min-h-0 flex-1 flex-col overflow-hidden p-4";
}

// ─── DetachedView ─────────────────────────────────────────────────────────────

export interface DetachedViewProps {
  viewKey: string;
}

export function DetachedView({ viewKey: initialViewKey }: DetachedViewProps) {
  const api = useMemo(() => getApi(), []);

  // Single-instance shell: WindowManager may send lvis:detached:navigate to
  // replace the displayed content without closing and reopening the window.
  const [viewKey, setViewKey] = useState(initialViewKey);

  useEffect(() => {
    const api = window.lvisApi;
    if (!api?.window?.onDetachedNavigate) return;
    const unsub = api.window.onDetachedNavigate((nextKey) => setViewKey(nextKey));
    return unsub;
  }, []);

  return (
    <ThemeProvider api={api}>
      <TooltipProvider>
        <div className={getDetachedShellClassName(viewKey)}>
          <CustomTitleBar />
          <main className={getDetachedMainClassName(viewKey)}>
            <ErrorBoundary>
              <DetachedContent viewKey={viewKey} />
            </ErrorBoundary>
          </main>
          {/* Snap edge highlight — only visible when a child window is near the main window edge */}
          <SnapEdgeHighlight />
        </div>
      </TooltipProvider>
    </ThemeProvider>
  );
}

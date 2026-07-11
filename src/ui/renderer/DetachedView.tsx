/**
 * DetachedView — shell for a tab opened in a standalone BrowserWindow.
 *
 * Mounts when renderer.tsx detects `#detached/<viewKey>` in the URL fragment.
 * Renders a minimal shell: the B1 CustomTitleBar + the actual content view.
 *
 * Supported viewKeys:
 *   "routines", "memory", "starred", "insights",
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
import { WorkBoardPanel } from "./components/WorkBoardPanel.js";
import { StarredView } from "./components/StarredView.js";
import { McpAppView } from "./components/McpAppView.js";
import type { McpUiPayload } from "../../mcp/types.js";
import { PluginUiHostView } from "../../plugin-ui-host.js";
import { usePluginMarketplace } from "./hooks/use-plugin-marketplace.js";
import { useStarred } from "./hooks/use-starred.js";
import { CustomTitleBar } from "./components/CustomTitleBar.js";
import { useTranslation } from "../../i18n/react.js";

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
      className={`pointer-events-none fixed z-50 bg-primary/(--opacity-intense) ${EDGE_BORDER_CLASSES[activeEdge]}`}
      aria-hidden="true"
    />
  );
}

// ─── Detached MCP-app (#885 b2) ────────────────────────────────────────────────

/**
 * Detached MCP-app card. Extracted as a NAMED component (not an inline branch
 * inside `DetachedContent`) so its hooks run unconditionally at the top level —
 * `DetachedContent` has early `return`s above, and adding `useState`/`useEffect`
 * inside a branch after them would violate the Rules of Hooks. The `McpUiPayload`
 * cannot ride the `#detached/<viewKey>` URL fragment (no `resourceUri`/`csp`), so
 * it is fetched from the host-owned WindowManager registry on mount. Keyed by
 * `viewKey` at the call site, so navigation remounts and re-fetches cleanly.
 */
function DetachedMcpApp({ viewKey }: { viewKey: string }) {
  const { t } = useTranslation();
  const [payload, setPayload] = useState<McpUiPayload | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void window.lvis.mcp
      .getDetachedPayload(viewKey)
      .then((p) => {
        if (cancelled) return;
        setPayload(p);
        setLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setPayload(null);
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [viewKey]);

  if (!loaded) return null;
  if (!payload) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
        {t("detachedView.unknownView", { viewKey })}
      </div>
    );
  }
  // The detached shell IS the host's `fullscreen` presentation (see
  // shared/mcp-app-display-mode.ts): a card mounted here starts in that mode, so its
  // host context reports `fullscreen` and an `inline` request from the app closes the
  // shell rather than re-opening one.
  return <McpAppView payload={payload} displayMode="fullscreen" />;
}

// ─── Content dispatcher ───────────────────────────────────────────────────────

interface ContentProps {
  viewKey: string;
}

function DetachedContent({ viewKey }: ContentProps) {
  const { t } = useTranslation();
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

  // Main broadcasts lvis:plugins:runtime-updated to ALL windows after a plugin
  // runtime restart/reload. Without this subscription a detached plugin window
  // keeps rendering the stale webview (old runtimeRevision) until it is closed
  // and reopened, while the main window already remounted the fresh bundle.
  useEffect(() => {
    if (!viewKey.startsWith("plugin:")) return;
    if (typeof api.onPluginRuntimeUpdated !== "function") return;
    const unsubscribe = api.onPluginRuntimeUpdated(() => {
      void refreshViews();
    });
    return unsubscribe;
  }, [viewKey, api, refreshViews]);

  if (viewKey === "work-board") {
    return <WorkBoardPanel api={api} />;
  }

  if (viewKey === "routines") {
    return <RoutinePanel api={api} />;
  }

  if (viewKey === "memory") {
    return (
      <MemorySearchPanel
        api={api}
        onOpenSession={async (sessionId) => {
          const result = await api.window?.loadSessionInMain(sessionId);
          if (!result?.ok) {
            console.warn("[detached] failed to load memory session in main window", result?.error);
            return false;
          }
          void api.window?.closeDetached();
          return true;
        }}
      />
    );
  }

  if (viewKey === "starred" || viewKey === "insights") {
    return (
      <StarredView
        api={api}
        starred={starred}
        currentSessionId=""
        refreshStarred={refreshStarred}
        onJumpToSession={async (sessionId) => {
          const result = await api.window?.loadSessionInMain(sessionId);
          if (!result?.ok) {
            console.warn("[detached] failed to load starred session in main window", result?.error);
            return false;
          }
          return true;
        }}
        onActivateHome={() => {
          void api.window?.closeDetached();
        }}
      />
    );
  }

  // #885 b2 — MCP-app card: branchless early dispatch BEFORE the plugin branch.
  // Hooks live inside DetachedMcpApp (keyed by viewKey) so they never run after
  // this component's early returns.
  if (viewKey.startsWith("mcp-app:")) {
    return <DetachedMcpApp key={viewKey} viewKey={viewKey} />;
  }

  // Plugin view: viewKey = "plugin:<pluginId>:<extensionId>"
  // In detached mode, render without host chrome to avoid title duplication.
  if (viewKey.startsWith("plugin:")) {
    const activePluginView = pluginViews.find((v) => toViewKey(v) === viewKey) ?? null;
    return <PluginUiHostView view={activePluginView} showChrome={false} />;
  }

  return (
    <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted-foreground">
      {t("detachedView.unknownView", { viewKey })}
    </div>
  );
}

export function getDetachedShellClassName(viewKey: string): string {
  if (viewKey.startsWith("plugin:") || viewKey.startsWith("mcp-app:")) {
    return "flex h-screen flex-col overflow-hidden text-foreground";
  }
  return "flex h-screen flex-col overflow-hidden bg-background text-foreground";
}

export function getDetachedMainClassName(viewKey: string): string {
  // Plugin + MCP-app webviews own their detached-view canvas. Host
  // padding/background leaks the LVIS shell theme around the sandboxed panel, so
  // keep them full-bleed.
  if (viewKey.startsWith("plugin:") || viewKey.startsWith("mcp-app:")) {
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

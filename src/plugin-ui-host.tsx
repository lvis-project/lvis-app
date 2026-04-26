/**
 * Plugin UI Host — #237 Option B
 *
 * Replaced the previous inline-import path (import(blobUrl) into the host
 * renderer's window) with an Electron <webview> that runs inside its own
 * renderer process and session partition.
 *
 * Security properties of the new approach:
 *   • Plugin code runs in a separate OS process with contextIsolation=true,
 *     nodeIntegration=false, sandbox=true.
 *   • window.lvisApi is NOT available inside the webview — only window.lvisPlugin
 *     (injected by plugin-preload.ts), which exposes callTool / emitEvent /
 *     onEvent only.
 *   • Each plugin gets its own session partition (persist:plugin:<slug>) so
 *     storage / cookies / cache are silo-ed between plugins.
 *   • Lifecycle events, runtime counts, marketplace ping — none reachable.
 *
 * Fallback: if the webview's entryUrl is not a file:// path (dev server case)
 * we still render the webview pointing at the dev URL so hot-reload keeps
 * working during development.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";

export type PluginUiExtensionView = {
  pluginId: string;
  extension: {
    id: string;
    slot: "sidebar";
    kind: "embedded-module" | "embedded-page" | "info-card";
    displayName?: string;
    title: string;
    description?: string;
    defaults?: Record<string, unknown>;
    entry?: string;
    exportName?: string;
    page?: string;
  };
  entryUrl?: string;
};

/**
 * PluginUiBridge — kept for backward-compat typing; the actual bridge is now
 * window.lvisPlugin inside the webview, not this renderer-side object.
 */
export type PluginUiBridge = {
  callPluginMethod: (method: string, payload?: unknown) => Promise<unknown>;
  askInHomeChat: (question: string) => Promise<void>;
  addTask: (task: { title: string; source: string; sourceRef?: string; priority?: string; description?: string; dueAt?: string }) => Promise<unknown>;
};

export type PluginUiMountContext = {
  root: HTMLElement;
  bridge: PluginUiBridge;
  extension: PluginUiExtensionView["extension"];
};

function getPluginViewLabel(item: PluginUiExtensionView): string {
  return item.extension.displayName?.trim() || item.extension.title || item.pluginId;
}

/**
 * Derive the <webview> src URL from the view's entryUrl.
 *
 * The plugin-ui-shell.html is shipped alongside index.html in dist/src/.
 * We derive its path by replacing the renderer's own URL's filename with
 * plugin-ui-shell.html and append ?pluginId=&entry= query params.
 *
 * In the packaged app the renderer loads from a file:// URL so we can
 * use the same origin for the shell.  In the Vite dev server we point at
 * the shell served from the same dev server (the Vite config copy-plugin
 * must copy plugin-ui-shell.html to the dev-server root for this to work).
 */
function buildWebviewSrc(view: PluginUiExtensionView): string | null {
  const entryUrl = view.entryUrl;
  if (!entryUrl) return null;

  // Determine shell base — same directory as the current document.
  let shellBase: string;
  try {
    shellBase = new URL("plugin-ui-shell.html", window.location.href).toString();
  } catch {
    // Fallback: relative path (works when window.location is a file:// URL).
    shellBase = "plugin-ui-shell.html";
  }

  const params = new URLSearchParams({
    pluginId: view.pluginId,
    entry: entryUrl,
  });
  return `${shellBase}?${params.toString()}`;
}

export function PluginUiHostView({
  view,
  callPluginMethod,
  onAskInHomeChat,
  onAddTask,
}: {
  view: PluginUiExtensionView | null;
  callPluginMethod: (method: string, payload?: unknown) => Promise<unknown>;
  onAskInHomeChat: (question: string) => Promise<void>;
  onAddTask: PluginUiBridge["addTask"];
}) {
  // Keep callPluginMethod etc. stable in refs so the webview ref callback
  // does not regenerate on every render.
  const callPluginMethodRef = useRef(callPluginMethod);
  callPluginMethodRef.current = callPluginMethod;
  const onAskInHomeChatRef = useRef(onAskInHomeChat);
  onAskInHomeChatRef.current = onAskInHomeChat;
  const onAddTaskRef = useRef(onAddTask);
  onAddTaskRef.current = onAddTask;

  const [errorText, setErrorText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // webviewRef tracks the DOM node for cleanup only — we don't call methods
  // on it directly in this implementation.
  const webviewRef = useRef<Electron.WebviewTag | null>(null);

  const handleWebviewRef = useCallback((node: Electron.WebviewTag | null) => {
    webviewRef.current = node;
  }, []);

  useEffect(() => {
    if (!view) {
      setErrorText("플러그인 뷰를 찾을 수 없습니다.");
      setLoading(false);
      return;
    }
    if (view.extension.kind === "embedded-page") {
      setErrorText("구형 iframe UI 형식은 지원되지 않습니다. entry 기반 모듈 UI를 사용하세요.");
      setLoading(false);
      return;
    }
    setErrorText(null);
    setLoading(true);
  }, [view]);

  // ─── Render ────────────────────────────────────────────────────────────────
  let content: React.ReactNode;

  if (errorText) {
    content = <div className="px-3 py-2 text-xs text-destructive">{errorText}</div>;
  } else if (!view || !view.entryUrl) {
    content = <div className="px-3 py-2 text-xs text-muted-foreground">UI 모듈 엔트리를 찾을 수 없습니다.</div>;
  } else {
    const webviewSrc = buildWebviewSrc(view);
    // Partition: persist:plugin:<slug> gives each plugin its own silo.
    // slugify the pluginId (replace dots/non-alnum with dashes) so the
    // partition name stays URL-safe.
    const slug = view.pluginId.replace(/[^a-z0-9]/gi, "-");
    const partition = `persist:plugin:${slug}`;

    if (!webviewSrc) {
      content = <div className="px-3 py-2 text-xs text-muted-foreground">Webview src를 계산할 수 없습니다.</div>;
    } else {
      content = (
        <webview
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={handleWebviewRef as any}
          src={webviewSrc}
          partition={partition}
          // Security: no node integration, context isolation enforced by
          // Electron for webviews when the host window has contextIsolation=true.
          // allowpopups is absent → popups blocked by default.
          // disablewebsecurity is absent → same-origin + CORS enforced.
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
          style={{ width: "100%", height: "100%", border: "none" }}
          onLoad={() => setLoading(false)}
          onError={() => {
            setLoading(false);
            setErrorText("Plugin webview 로딩 실패.");
          }}
        />
      );
    }
  }

  return (
    <Card className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden">
      <CardHeader>
        <CardTitle>{view ? getPluginViewLabel(view) : "플러그인 UI"}</CardTitle>
        <CardDescription>{view?.extension.description ?? "플러그인 화면을 로딩합니다."}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <div className="relative h-full w-full overflow-hidden rounded-md border bg-card">
          {loading ? (
            <div className="absolute inset-x-0 top-0 z-10 px-3 py-2 text-xs text-muted-foreground">
              로딩 중...
            </div>
          ) : null}
          <div className="h-full overflow-hidden">
            {content}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

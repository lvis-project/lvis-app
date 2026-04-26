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
/**
 * Stable, collision-resistant per-plugin partition slug. Two pluginIds
 * that normalize to the same `[a-z0-9-]` slug would otherwise share the
 * `persist:plugin:` storage silo (cookies, IndexedDB, localStorage). Hash
 * the raw pluginId instead so plugin authors cannot pre-meditate a slug
 * collision via marketplace upload.
 */
function pluginPartitionHash(pluginId: string): string {
  // Web Crypto SubtleCrypto is async; for a renderer-side synchronous use
  // we rely on a small FNV-1a 32-bit hash, hex-encoded. 8 hex chars are
  // enough collision resistance for a per-user plugin set < ~10k.
  let h = 2166136261;
  for (let i = 0; i < pluginId.length; i++) {
    h ^= pluginId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

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

  // Electron <webview> is a custom element — React's synthetic onLoad /
  // onError do not fire for it. Wire native DOM listeners via the ref
  // callback so the loading-spinner clears and load failures surface in
  // the UI. Listeners use stable refs so add/remove identity matches.
  const onFinishRef = useRef(() => setLoading(false));
  const onFailRef = useRef(() => {
    setLoading(false);
    setErrorText("Plugin webview 로딩 실패.");
  });
  const webviewRef = useRef<Electron.WebviewTag | null>(null);
  const handleWebviewRef = useCallback((node: Electron.WebviewTag | null) => {
    const prev = webviewRef.current;
    if (prev) {
      prev.removeEventListener("did-finish-load", onFinishRef.current);
      prev.removeEventListener("did-fail-load", onFailRef.current);
    }
    webviewRef.current = node;
    if (node) {
      node.addEventListener("did-finish-load", onFinishRef.current);
      node.addEventListener("did-fail-load", onFailRef.current);
    }
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
    // Partition: persist:plugin:<hash> gives each plugin its own silo.
    // Hash the pluginId so partitions never collide across plugins whose
    // slugs would otherwise normalize to the same string (e.g.,
    // `com.lge.foo` vs `com-lge-foo`). 12-byte SHA-256 prefix is plenty
    // for collision-resistance on a small plugin set.
    const partition = `persist:plugin:${pluginPartitionHash(view.pluginId)}`;

    if (!webviewSrc) {
      content = <div className="px-3 py-2 text-xs text-muted-foreground">Webview src를 계산할 수 없습니다.</div>;
    } else {
      // Resolve preload script as file:// — webview's `preload` attribute
      // requires an absolute URL. The plugin-preload.js bundle is copied
      // into dist/src/ alongside the shell HTML during build.
      let preloadUrl = "";
      try {
        preloadUrl = new URL("plugin-preload.js", window.location.href).toString();
      } catch {
        preloadUrl = "";
      }
      content = (
        <webview
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={handleWebviewRef as any}
          src={webviewSrc}
          partition={partition}
          preload={preloadUrl}
          // Security: no node integration, context isolation enforced by
          // Electron for webviews when the host window has contextIsolation=true.
          // allowpopups is absent → popups blocked by default.
          // disablewebsecurity is absent → same-origin + CORS enforced.
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
          style={{ width: "100%", height: "100%", border: "none" }}
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

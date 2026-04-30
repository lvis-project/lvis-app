/**
 * Plugin UI Host — #237 Option B
 *
 * Mounts a plugin's sidebar UI inside an Electron <webview> running in its
 * own renderer process + session partition. Security boundary:
 *   • contextIsolation=true, nodeIntegration=false, sandbox=true.
 *   • window.lvisApi is NOT exposed; only window.lvisPlugin from
 *     plugin-preload.ts (callTool / emitEvent / onEvent / getEntryUrl).
 *   • persist:plugin:<hash> partition silos cookies / IndexedDB / cache.
 *
 * pluginId is NOT carried in the webview src query string. Instead, the
 * host renderer registers (webContents.id → pluginId) with main on the
 * `dom-ready` event (not `did-attach` — Electron requires dom-ready before
 * getWebContentsId() is callable). Main
 * resolves pluginId from `event.sender.id` on every plugin IPC. This
 * removes the spoofing vector from history.pushState / re-navigation /
 * URL crafting and lets us drop `entry` from the URL entirely (the shell
 * fetches it via `lvisPlugin.getEntryUrl()`).
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
    /**
     * Window placement preference. When `defaultMode` is `"detached"` the
     * host opens the extension in a magnetic-snap BrowserWindow on sidebar
     * click rather than rendering it inline.
     */
    window?: {
      defaultMode?: "embedded" | "detached";
    };
  };
  entryUrl?: string;
};

export type PluginUiMountContext = {
  root: HTMLElement;
  /** The narrow lvisPlugin bridge — see plugin-preload.ts. */
  bridge: {
    callTool: (name: string, args?: unknown) => Promise<unknown>;
    emitEvent: (type: string, data?: unknown) => Promise<void>;
    onEvent: (type: string, handler: (data: unknown) => void) => () => void;
    getEntryUrl: () => Promise<string>;
  };
  extension: PluginUiExtensionView["extension"];
};

function getPluginViewLabel(item: PluginUiExtensionView): string {
  return item.extension.displayName?.trim() || item.extension.title || item.pluginId;
}

/**
 * Stable, collision-resistant per-plugin partition slug. Two pluginIds
 * that normalize to the same `[a-z0-9-]` slug would otherwise share the
 * `persist:plugin:` storage silo. Hash the raw pluginId so plugin authors
 * cannot pre-meditate a slug collision via marketplace upload.
 *
 * 32-bit FNV-1a → 8 hex chars. Synchronous (renderer can't use SubtleCrypto
 * inline) and good enough for collision resistance on a per-user plugin
 * set < ~10k.
 */
function pluginPartitionHash(pluginId: string): string {
  let h = 2166136261;
  for (let i = 0; i < pluginId.length; i++) {
    h ^= pluginId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Read the deterministic plugin shell + preload URLs from `window.lvisApi`.
 * These are computed in the host preload (`src/preload.ts`) from `__dirname`
 * which is reliably `dist/src/`. Avoids deriving from `window.location.href`,
 * which can be a `data:text/html;...` URL during splash-phase render and
 * thus produce a broken preload path that Electron silently skips.
 */
function readPluginAssetUrls(): { shellUrl: string; preloadUrl: string } {
  const api = (window as unknown as { lvisApi?: { pluginShellUrl?: unknown; pluginPreloadUrl?: unknown } }).lvisApi;
  const shellUrl = typeof api?.pluginShellUrl === "string" ? api.pluginShellUrl : "";
  const preloadUrl = typeof api?.pluginPreloadUrl === "string" ? api.pluginPreloadUrl : "";
  return { shellUrl, preloadUrl };
}

export function PluginUiHostView({ view }: { view: PluginUiExtensionView | null }) {
  const [errorText, setErrorText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Electron <webview> is a custom element — React's synthetic onLoad /
  // onError do not fire. Wire native DOM listeners via the ref callback
  // with stable refs so add/remove identity matches.
  const onFinishRef = useRef(() => setLoading(false));
  const onFailRef = useRef(() => {
    setLoading(false);
    setErrorText("Plugin webview 로딩 실패.");
  });

  // On dom-ready, register the (webContents.id → pluginId, entryUrl)
  // mapping with main. dom-ready is required — Electron throws if
  // getWebContentsId() is called before the guest renderer is fully
  // initialized (did-attach fires earlier and is insufficient).
  const onDomReadyRef = useRef<(() => void) | null>(null);
  const webviewRef = useRef<Electron.WebviewTag | null>(null);

  const handleWebviewRef = useCallback((node: Electron.WebviewTag | null) => {
    const prev = webviewRef.current;
    if (prev) {
      prev.removeEventListener("did-finish-load", onFinishRef.current);
      prev.removeEventListener("did-fail-load", onFailRef.current);
      const onDomReady = onDomReadyRef.current;
      if (onDomReady) prev.removeEventListener("dom-ready", onDomReady);
    }
    webviewRef.current = node;
    if (node) {
      node.addEventListener("did-finish-load", onFinishRef.current);
      node.addEventListener("did-fail-load", onFailRef.current);
      const onDomReady = () => {
        const wcId = node.getWebContentsId();
        const pluginId = view?.pluginId;
        const entryUrl = view?.entryUrl;
        if (typeof wcId !== "number" || !pluginId || !entryUrl) return;
        const api = (window as unknown as { lvisApi?: { registerPluginWebview?: (p: { webContentsId: number; pluginId: string; entryUrl: string }) => Promise<unknown> } }).lvisApi;
        void api?.registerPluginWebview?.({ webContentsId: wcId, pluginId, entryUrl });
      };
      onDomReadyRef.current = onDomReady;
      node.addEventListener("dom-ready", onDomReady);
    }
  }, [view?.pluginId, view?.entryUrl]);

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
    const { shellUrl, preloadUrl } = readPluginAssetUrls();
    if (!shellUrl || !preloadUrl) {
      content = (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          Plugin webview 자산 URL을 lvisApi에서 찾을 수 없습니다 (preload 미주입 또는 dist 누락).
        </div>
      );
    } else {
      const partition = `persist:plugin:${pluginPartitionHash(view.pluginId)}`;
      // `key={view.pluginId}` 가 결정적. Electron `<webview>` 는 처음
      // attach 시점에만 partition / src 를 바인딩하고 이후 prop 변경을
      // 완전히 적용하지 못한다 (mojo: "Message N rejected by interface
      // blink.mojom.WidgetHost" 형태로 떨어짐). 사이드바에서 다른
      // 플러그인 탭으로 전환하면 같은 React 컴포넌트 인스턴스가
      // partition/src 만 바꿔서 재사용되는데 이때부터 webview 가
      // half-loaded 상태로 남아 새 플러그인 UI 가 안 뜨고, 이전 탭으로
      // 돌아가도 동일 webview 가 깨진 채라 그것도 같이 안 보인다.
      // pluginId 를 key 로 주면 React 가 강제 unmount → mount 라
      // Electron 도 fresh attach 사이클을 받는다.
      // 같은 pluginId 의 다른 extension (예: ms-graph 의 email vs calendar) 으로
      // 전환 시 webview 가 reuse 되면서 이전 entry 의 IPC 매핑이 남거나
      // 이전 frame 이 잠시 보이는 문제 → key 를 extension.id 까지 포함시켜
      // extension 단위로 fresh attach 보장.
      content = (
        <webview
          key={`${view.pluginId}:${view.extension.id}`}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={handleWebviewRef as any}
          src={shellUrl}
          partition={partition}
          preload={preloadUrl}
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
          <div className="h-full overflow-hidden">
            {content}
          </div>
          {loading ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-card text-xs text-muted-foreground">
              로딩 중...
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

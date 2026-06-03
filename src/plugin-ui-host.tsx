/**
 * Plugin UI Host — #237 Option B
 *
 * Mounts a plugin UI inside an Electron <webview> running in its
 * own renderer process + session partition. Security boundary:
 *   • contextIsolation=true, nodeIntegration=false, sandbox=true.
 *   • window.lvisApi is NOT exposed; only window.lvisPlugin from
 *     plugin-preload.ts (callTool / emitEvent / onEvent / getEntryUrl).
 *   • persist:plugin:<hash> partition silos cookies / IndexedDB / cache.
 *
 * pluginId is NOT carried in the webview src query string. Instead, the
 * host renderer registers (webContents.id → pluginId) with main on the
 * `did-attach` event by calling `getWebContentsId()` on the webview tag.
 * The real shell URL must already be mounted at the first attach because
 * Electron only runs sandboxed <webview> preload at the initial guest attach.
 * Main's pending get-entry-url wait queue absorbs the small race between the
 * did-attach registration handshake and the shell's first entry-url lookup.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { t } from "./i18n/index.js";
import { pluginPartitionName } from "./shared/plugin-partition.js";

export type PluginUiExtensionView = {
  pluginId: string;
  /** Optional Lucide icon name declared in the plugin manifest. */
  icon?: string;
  /**
   * Optional short text (1-4 chars) used in place of a Lucide icon — e.g.
   * `"EP"`, `"MTG"`. Takes precedence over `icon` when both are declared.
   */
  iconText?: string;
  extension: {
    id: string;
    slot: "sidebar";
    kind: "embedded-module" | "embedded-page" | "info-card" | "action";
    displayName?: string;
    title: string;
    description?: string;
    defaults?: Record<string, unknown>;
    entry?: string;
    exportName?: string;
    page?: string;
    /** kind="action" 전용 dispatch target — host 가 api.callPluginMethod 로 호출. */
    tool?: string;
    /**
     * Detached window defaults. `defaultMode: "detached"` opens the extension
     * in a separate BrowserWindow rather than rendering it inline.
     */
    window?: {
      width?: number;
      height?: number;
      minWidth?: number;
      minHeight?: number;
      resizable?: boolean;
      alwaysOnTop?: boolean;
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
    /**
     * Per-plugin config field accessors (#B1). Backed by the same plugin
     * config record as PluginConfigTab; secret fields are stripped at the
     * IPC boundary. Cross-plugin writes are refused — pluginId is resolved
     * from `event.sender.id`.
     */
    config: {
      get: <T = unknown>(key: string) => Promise<T | undefined>;
      set: <T = unknown>(key: string, value: T) => Promise<void>;
    };
    /**
     * Per-plugin sandboxed key/value JSON store (#B1). Each key maps to
     * `<pluginDataDir>/ui-storage/<key>.json`; keys are restricted to
     * `[A-Za-z0-9._-]{1,128}`. Use for UI-side state that must survive a
     * webview reload.
     */
    storage: {
      get: <T = unknown>(key: string) => Promise<T | undefined>;
      set: <T = unknown>(key: string, value: T) => Promise<void>;
    };
  };
  extension: PluginUiExtensionView["extension"];
};

function getPluginViewLabel(item: PluginUiExtensionView): string {
  return item.extension.displayName?.trim() || item.extension.title || item.pluginId;
}

// Partition naming moved to `shared/plugin-partition.ts` so main + renderer
// stay byte-identical (#498). Drift between the two would silently route a
// webview to a partition the main process never policy-registered, killing
// the lvisPlugin contextBridge.

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

export function PluginUiHostView({
  view,
  showChrome = true,
}: {
  view: PluginUiExtensionView | null;
  showChrome?: boolean;
}) {
  const [errorText, setErrorText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Shell src is empty until did-attach + registration complete for the current
  // view. Derived at render time — "" for any view key that hasn't registered.
  const [shellSrcBinding, setShellSrcBinding] = useState<{ viewKey: string; url: string } | null>(null);
  const currentViewKey = view ? `${view.pluginId}:${view.extension.id}:${view.entryUrl ?? ""}` : "";
  const shellSrc = shellSrcBinding?.viewKey === currentViewKey ? shellSrcBinding.url : "";

  // Electron <webview> is a custom element — React's synthetic onLoad /
  // onError do not fire. Wire native DOM listeners via the ref callback
  // with stable refs so add/remove identity matches.
  const onFinishRef = useRef(() => setLoading(false));
  const onFailRef = useRef(() => {
    setLoading(false);
    setErrorText(t("be_pluginUiHost.webviewLoadFailed"));
  });

  const onDidAttachRef = useRef<((e: Event) => void) | null>(null);
  const onLifecycleRegisterRef = useRef<((e: Event) => void) | null>(null);
  const registerAttemptRef = useRef<{ key: string; status: "pending" | "done" } | null>(null);
  const webviewRef = useRef<Electron.WebviewTag | null>(null);

  const attemptRegisterWebview = useCallback((node: Electron.WebviewTag | null) => {
    if (!node || !view?.pluginId || !view?.entryUrl) return;
    if (typeof node.getWebContentsId !== "function") return;
    const wcId = node.getWebContentsId();
    if (!Number.isFinite(wcId)) return;
    const { shellUrl: url } = readPluginAssetUrls();
    if (!url) return;

    const capturedPluginId = view.pluginId;
    const capturedExtensionId = view.extension.id;
    const capturedEntryUrl = view.entryUrl;
    const viewKey = `${capturedPluginId}:${capturedExtensionId}:${capturedEntryUrl}`;
    const registerKey = `${viewKey}:${wcId}`;
    const previous = registerAttemptRef.current;
    if (previous?.key === registerKey && (previous.status === "pending" || previous.status === "done")) return;

    const api = (window as unknown as {
      lvisApi?: {
        registerPluginWebview?: (p: {
          webContentsId: number;
          pluginId: string;
          entryUrl: string;
        }) => Promise<{ ok: boolean; error?: string } | null | undefined>;
      };
    }).lvisApi;
    const registerPluginWebview = api?.registerPluginWebview;
    if (typeof registerPluginWebview !== "function") return;

    registerAttemptRef.current = { key: registerKey, status: "pending" };
    void (async () => {
      try {
        const result = await registerPluginWebview({
          webContentsId: wcId as number,
          pluginId: capturedPluginId,
          entryUrl: capturedEntryUrl,
        });
        if (result && (result as { ok: boolean }).ok === false) {
          if (registerAttemptRef.current?.key === registerKey) registerAttemptRef.current = null;
          setErrorText(t("be_pluginUiHost.webviewRegisterFailed", { error: (result as { error?: string }).error ?? "unknown" }));
          setLoading(false);
          return;
        }
      } catch (err) {
        if (registerAttemptRef.current?.key === registerKey) registerAttemptRef.current = null;
        setErrorText(t("be_pluginUiHost.webviewRegisterFailed", { error: (err as Error).message ?? "unknown" }));
        setLoading(false);
        return;
      }
      registerAttemptRef.current = { key: registerKey, status: "done" };
      setShellSrcBinding({ viewKey, url });
    })();
  }, [view?.pluginId, view?.entryUrl, view?.extension.id]);

  const handleWebviewRef = useCallback((node: Electron.WebviewTag | null) => {
    const prev = webviewRef.current;
    if (prev) {
      prev.removeEventListener("did-finish-load", onFinishRef.current);
      prev.removeEventListener("did-fail-load", onFailRef.current);
      const onDidAttach = onDidAttachRef.current;
      if (onDidAttach) prev.removeEventListener("did-attach", onDidAttach);
      const onLifecycleRegister = onLifecycleRegisterRef.current;
      if (onLifecycleRegister) {
        prev.removeEventListener("did-start-loading", onLifecycleRegister);
        prev.removeEventListener("dom-ready", onLifecycleRegister);
        prev.removeEventListener("did-finish-load", onLifecycleRegister);
      }
    }
    webviewRef.current = node;
    if (node) {
      node.addEventListener("did-finish-load", onFinishRef.current);
      node.addEventListener("did-fail-load", onFailRef.current);
      const onDidAttach = () => {
        // `did-attach` event has no documented payload — use the webview-tag
        // method `getWebContentsId()` (canonical Electron API) instead of
        // reading a non-standard `e.webContentsId` property which returns
        // undefined and silently aborts the registration handshake.
        attemptRegisterWebview(node);
      };
      const onLifecycleRegister = () => attemptRegisterWebview(node);
      onDidAttachRef.current = onDidAttach;
      onLifecycleRegisterRef.current = onLifecycleRegister;
      node.addEventListener("did-attach", onDidAttach);
      node.addEventListener("did-start-loading", onLifecycleRegister);
      node.addEventListener("dom-ready", onLifecycleRegister);
      node.addEventListener("did-finish-load", onLifecycleRegister);
      queueMicrotask(() => attemptRegisterWebview(node));
    }
  }, [attemptRegisterWebview]);

  useEffect(() => {
    setShellSrcBinding(null);
    registerAttemptRef.current = null;
    if (!view) {
      setErrorText(t("be_pluginUiHost.pluginViewNotFound"));
      setLoading(false);
      return;
    }
    if (view.extension.kind === "embedded-page") {
      setErrorText(t("be_pluginUiHost.legacyIframeNotSupported"));
      setLoading(false);
      return;
    }
    // action entries never produce a panel — App.tsx 의 handleViewSelect 가
    // 플러그인 패널 click 시 곧장 callPluginMethod 디스패치하고 active view 도
    // 안 바꾸므로 정상 경로에서는 여기 도달하지 않는다. 다만 다른 caller
    // (keyboard shortcut, command palette 등) 가 action view 를 잘못 전달했을
    // 때 panel chrome (Card 헤더 + border) 이 회귀로 뜨지 않도록 fail-safe.
    if (view.extension.kind === "action") {
      setErrorText(t("be_pluginUiHost.actionKindNoPanel"));
      setLoading(false);
      return;
    }
    // Only show the loading overlay when a webview will actually be rendered.
    // If entryUrl is missing or pluginShellUrl / pluginPreloadUrl are absent,
    // the render branch shows an inline error message — no webview, no
    // `did-finish-load` event, so `loading=true` would stick forever.
    const { shellUrl, preloadUrl } = readPluginAssetUrls();
    const willRenderWebview = !!view.entryUrl && !!shellUrl && !!preloadUrl;
    setErrorText(null);
    setLoading(willRenderWebview);
  }, [view]);

  // ─── Render ────────────────────────────────────────────────────────────────
  let content: React.ReactNode;

  if (errorText) {
    content = <div className="px-3 py-2 text-xs text-destructive">{errorText}</div>;
  } else if (!view || !view.entryUrl) {
    content = <div className="px-3 py-2 text-xs text-muted-foreground">{t("be_pluginUiHost.uiModuleEntryNotFound")}</div>;
  } else {
    const { shellUrl, preloadUrl } = readPluginAssetUrls();
    if (!shellUrl || !preloadUrl) {
      content = (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          {t("be_pluginUiHost.webviewAssetUrlNotFound")}
        </div>
      );
    } else {
      const partition = pluginPartitionName(view.pluginId);
      // `key={view.pluginId}` 가 결정적. Electron `<webview>` 는 처음
      // attach 시점에만 partition / src 를 바인딩하고 이후 prop 변경을
      // 완전히 적용하지 못한다 (mojo: "Message N rejected by interface
      // blink.mojom.WidgetHost" 형태로 떨어짐). 플러그인 패널에서 다른
      // 플러그인 탭으로 전환하면 같은 React 컴포넌트 인스턴스가
      // partition/src 만 바꿔서 재사용되는데 이때부터 webview 가
      // half-loaded 상태로 남아 새 플러그인 UI 가 안 뜨고, 이전 탭으로
      // 돌아가도 동일 webview 가 깨진 채라 그것도 같이 안 보인다.
      // pluginId 를 key 로 주면 React 가 강제 unmount → mount 라
      // Electron 도 fresh attach 사이클을 받는다.
      // 같은 pluginId 의 다른 extension 으로
      // 전환 시 webview 가 reuse 되면서 이전 entry 의 IPC 매핑이 남거나
      // 이전 frame 이 잠시 보이는 문제 → key 를 extension.id 까지 포함시켜
      // extension 단위로 fresh attach 보장.
      // `<webview preload>` runs ONLY at the first guest attach — subsequent
      // navigations (e.g. about:blank → file:///plugin-ui-shell.html) do
      // NOT re-execute preload, so the `lvisPlugin` contextBridge is gone in
      // the new main world and the shell aborts with "lvisPlugin bridge
      // missing".
      //
      // Therefore the initial `src` must already be the real shell URL so
      // preload runs once for the right origin. The race between the host's
      // did-attach → registerPluginWebview handshake and the shell's
      // immediate `getEntryUrl` call is absorbed by main's
      // `pendingEntryUrlResolvers` wait queue (5s deadline; restored
      // 2026-05-04 after PR #447 removed it on the assumption that
      // register-before-attach was airtight — which broke during the
      // plugin update lifecycle). The did-attach listener still populates
      // `shellSrcBinding` for parity with the old contract; `shellSrc` may
      // already equal `shellUrl` here, in which case it's a no-op.
      content = (
        <webview
          key={`${view.pluginId}:${view.extension.id}:${view.entryUrl ?? ""}`}
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ref={handleWebviewRef as any}
          src={shellSrc || shellUrl}
          partition={partition}
          preload={preloadUrl}
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
          style={{ width: "100%", height: "100%", border: "none" }}
        />
      );
    }
  }

  // When showChrome=false, render bare content without CardHeader (for detached views)
  if (!showChrome) {
    return (
      <div className="relative h-full w-full overflow-hidden">
        <div className="h-full overflow-hidden">
          {content}
        </div>
        {loading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-input-bar text-xs text-muted-foreground">
            {t("be_pluginUiHost.loading")}
          </div>
        ) : null}
      </div>
    );
  }

  // Default: render with Card chrome (for inline plugin views)
  return (
    <Card className="mx-auto flex min-h-0 min-w-0 flex-1 w-full max-w-6xl flex-col overflow-hidden">
      <CardHeader>
        <CardTitle>{view ? getPluginViewLabel(view) : t("be_pluginUiHost.pluginUiTitle")}</CardTitle>
        <CardDescription>{view?.extension.description ?? t("be_pluginUiHost.pluginUiLoadingDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col">
        <div className="relative h-full w-full overflow-hidden rounded-md border bg-input-bar">
          <div className="h-full overflow-hidden">
            {content}
          </div>
          {loading ? (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-input-bar text-xs text-muted-foreground">
              {t("be_pluginUiHost.loading")}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

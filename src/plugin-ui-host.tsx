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
import { t } from "./i18n/index.js";
import { pluginPartitionName } from "./shared/plugin-partition.js";
import { getPluginViewLabel } from "./shared/plugin-view-label.js";
import { PageShell } from "./ui/renderer/components/PageShell.js";

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
  /**
   * Monotonic host-runtime revision for this loaded plugin. Changes whenever
   * the host reloads/restarts the plugin so Electron remounts the webview even
   * when the manifest UI entry path itself stayed the same.
   */
  runtimeRevision?: number;
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

// Partition naming moved to `shared/plugin-partition.ts` so main + renderer
// stay byte-identical (#498). Drift between the two would silently route a
// webview to a partition the main process never policy-registered, killing
// the lvisPlugin contextBridge. The view label moved to
// `shared/plugin-view-label.ts` for the same reason — the main-window sidebar
// and this shell must not name the same extension differently.

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
  authError = null,
  preparing = false,
}: {
  view: PluginUiExtensionView | null;
  showChrome?: boolean;
  authError?: string | null;
  /**
   * The destination names a plugin whose runtime is still starting, so there is
   * no view to render yet. Distinct from `view == null` on its own, which means
   * the view does not exist: one is a wait, the other is a mistake, and saying
   * "not found" to the first is how a first-run panel looked broken.
   */
  preparing?: boolean;
}) {
  const [errorText, setErrorText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Shell src is empty until did-attach + registration complete for the current
  // view. Derived at render time — "" for any view key that hasn't registered.
  const [shellSrcBinding, setShellSrcBinding] = useState<{ viewKey: string; url: string } | null>(null);
  // The plugin id whose partition main has confirmed is policy-installed. The
  // `<webview>` is not rendered until this matches the view: a guest frame that
  // loads into a partition before its session policy is on binds a loader table
  // with no `lvis-plugin:` entry, and every asset request it makes for the rest
  // of its life fails before reaching any handler. Ordering it here — rather
  // than racing boot — is what makes that unreachable.
  const [partitionReadyFor, setPartitionReadyFor] = useState<string | null>(null);
  const currentViewKey = view ? `${view.pluginId}:${view.extension.id}:${view.entryUrl ?? ""}:${view.runtimeRevision ?? 0}` : "";
  const shellSrc = shellSrcBinding?.viewKey === currentViewKey ? shellSrcBinding.url : "";

  // Electron <webview> is a custom element — React's synthetic onLoad /
  // onError do not fire. Wire native DOM listeners via the ref callback
  // with stable refs so add/remove identity matches.
  const onFinishRef = useRef(() => setLoading(false));
  const onFailRef = useRef((event: Electron.DidFailLoadEvent) => {
    // A plugin UI may contain child frames. A failed navigation in one of
    // those frames must not retire the top-level guest webContents.
    if (!event.isMainFrame) return;
    setLoading(false);
    setErrorText(t("be_pluginUiHost.webviewLoadFailed"));
  });

  // `getWebContentsId()` THROWS on a <webview> that is not yet attached and
  // dom-ready. Only events that cannot fire before attachment may lead to it,
  // so record attachment rather than probing for it — Electron exposes no
  // predicate, and catching the throw would turn a lifecycle bug into a
  // swallowed one.
  const attachedRef = useRef(false);
  const onDidAttachRef = useRef<((e: Event) => void) | null>(null);
  const onLifecycleRegisterRef = useRef<((e: Event) => void) | null>(null);
  const registerAttemptRef = useRef<{ key: string; status: "pending" | "done" } | null>(null);
  const webviewRef = useRef<Electron.WebviewTag | null>(null);

  const attemptRegisterWebview = useCallback((node: Electron.WebviewTag | null) => {
    if (!node || !view?.pluginId || !view?.entryUrl) return;
    if (typeof node.getWebContentsId !== "function") return;
    if (!attachedRef.current) return;
    const wcId = node.getWebContentsId();
    if (!Number.isFinite(wcId)) return;
    const { shellUrl: url } = readPluginAssetUrls();
    if (!url) return;

    const capturedPluginId = view.pluginId;
    const capturedExtensionId = view.extension.id;
    const capturedEntryUrl = view.entryUrl;
    const viewKey = `${capturedPluginId}:${capturedExtensionId}:${capturedEntryUrl}:${view.runtimeRevision ?? 0}`;
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
  }, [view?.pluginId, view?.entryUrl, view?.extension.id, view?.runtimeRevision]);

  const handleWebviewRef = useCallback((node: Electron.WebviewTag | null) => {
    const prev = webviewRef.current;
    if (prev) {
      prev.removeEventListener("did-finish-load", onFinishRef.current);
      prev.removeEventListener("did-fail-load", onFailRef.current);
      const onDidAttach = onDidAttachRef.current;
      if (onDidAttach) prev.removeEventListener("did-attach", onDidAttach);
      const onLifecycleRegister = onLifecycleRegisterRef.current;
      if (onLifecycleRegister) {
        prev.removeEventListener("dom-ready", onLifecycleRegister);
        prev.removeEventListener("did-finish-load", onLifecycleRegister);
      }
    }
    attachedRef.current = false;
    webviewRef.current = node;
    if (node) {
      node.addEventListener("did-finish-load", onFinishRef.current);
      node.addEventListener("did-fail-load", onFailRef.current);
      const onDidAttach = () => {
        // `did-attach` event has no documented payload — use the webview-tag
        // method `getWebContentsId()` (canonical Electron API) instead of
        // reading a non-standard `e.webContentsId` property which returns
        // undefined and silently aborts the registration handshake.
        attachedRef.current = true;
        attemptRegisterWebview(node);
      };
      // `dom-ready` and `did-finish-load` are guest events: they cannot fire
      // before the guest is attached, so they are safe retries when the
      // `did-attach` listener was bound too late to observe it. `did-start-
      // loading` and an immediate microtask are NOT — both run before
      // attachment, and each one threw on every mount.
      const onLifecycleRegister = () => {
        attachedRef.current = true;
        attemptRegisterWebview(node);
      };
      onDidAttachRef.current = onDidAttach;
      onLifecycleRegisterRef.current = onLifecycleRegister;
      node.addEventListener("did-attach", onDidAttach);
      node.addEventListener("dom-ready", onLifecycleRegister);
      node.addEventListener("did-finish-load", onLifecycleRegister);
    }
  }, [attemptRegisterWebview]);

  // Keyed on the view's VALUE, not its object identity. `activePluginView`
  // is `pluginViews.find(...)`, so every upstream refresh hands this component
  // a fresh object with identical contents — and this effect tears the live
  // webview down (`setPartitionReadyFor(null)`) before re-running the
  // `ensurePluginPartition` round trip that puts it back. On identity churn
  // that becomes a mount/unmount cycle one round trip long, which is what a
  // cold boot showed: 39 webviews created and destroyed in 55s, ~0.7s each,
  // visible as flicker. The `key` below already derives from these same
  // fields for the same reason.
  const viewIdentity = view
    ? `${view.pluginId}:${view.extension.id}:${view.extension.kind}:${view.entryUrl ?? ""}:${view.runtimeRevision ?? 0}`
    : null;
  const viewRef = useRef(view);
  viewRef.current = view;

  useEffect(() => {
    const view = viewRef.current;
    setShellSrcBinding(null);
    setPartitionReadyFor(null);
    registerAttemptRef.current = null;
    if (!view) {
      // Still starting: hold the loading overlay rather than claiming the view
      // is missing. The effect re-runs when the view arrives.
      setErrorText(preparing ? null : t("be_pluginUiHost.pluginViewNotFound"));
      setLoading(preparing);
      return;
    }
    if (view.extension.kind === "embedded-page") {
      setErrorText(t("be_pluginUiHost.legacyIframeNotSupported"));
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
    if (!willRenderWebview) return;

    const pluginId = view.pluginId;
    const ensurePluginPartition = (window as unknown as {
      lvisApi?: { ensurePluginPartition?: (id: string) => Promise<{ ok: boolean; error?: string } | null | undefined> };
    }).lvisApi?.ensurePluginPartition;
    if (typeof ensurePluginPartition !== "function") {
      // Older preload surface — fall back to rendering immediately rather than
      // leaving the panel on a spinner it can never leave.
      setPartitionReadyFor(pluginId);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        await ensurePluginPartition(pluginId);
      } catch {
        // A failure here is not fatal on its own: boot may already have
        // installed the policy. Render and let the shell report if it did not.
      }
      if (!cancelled) setPartitionReadyFor(pluginId);
    })();
    return () => {
      cancelled = true;
    };
  }, [viewIdentity, preparing]);

  // ─── Render ────────────────────────────────────────────────────────────────
  let content: React.ReactNode;

  if (errorText) {
    content = <div className="px-3 py-2 text-xs text-destructive">{errorText}</div>;
  } else if (!view && preparing) {
    // The loading overlay below is the whole frame for this state.
    content = null;
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
    } else if (partitionReadyFor !== view.pluginId) {
      // Partition policy still being installed — the loading overlay is already
      // up. Rendering the <webview> now is the whole failure this avoids.
      content = null;
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
      // `pendingEntryUrlResolvers` wait queue (5s deadline). The queue is
      // required: register-before-attach is not airtight during the plugin
      // update lifecycle. The did-attach listener still populates
      // `shellSrcBinding` for parity with the old contract; `shellSrc` may
      // already equal `shellUrl` here, in which case it's a no-op.
      content = (
        <webview
          key={`${view.pluginId}:${view.extension.id}:${view.entryUrl ?? ""}:${view.runtimeRevision ?? 0}`}
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

  // When showChrome=false, render bare content without host page chrome (for detached views).
  if (!showChrome) {
    return (
      <div className="relative h-full w-full overflow-hidden">
        <div className="flex h-full flex-col overflow-hidden">
          {authError ? (
            <div className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {authError}
            </div>
          ) : null}
          <div className="min-h-0 flex-1 overflow-hidden">
            {content}
          </div>
        </div>
        {loading ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-input-bar text-xs text-muted-foreground">
            {t("be_pluginUiHost.loading")}
          </div>
        ) : null}
      </div>
    );
  }

  const authErrorBanner = authError ? (
    <div className="mb-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
      {authError}
    </div>
  ) : null;

  // Default: inline plugin views use the shared page shell. The webview is
  // already its own framed surface, so host-level Card/border chrome creates a
  // visible box-inside-box regression across every plugin view.
  //
  // `maxWidth="none"` hands the plugin the whole main pane. This used to be
  // "reading" (max-w-[58rem], ~928px), a clamp added because the plugin UIs
  // were authored for the ~800px detached window they opened in and stretched
  // at full pane width. That treated the symptom: the panel was pinned narrow
  // so nobody saw layouts that could not adapt, and widening the window past
  // ~1180px changed nothing on screen.
  //
  // The plugins now own their own measure (each caps its content column and
  // stays fluid below the cap), so the clamp has nothing left to hide and its
  // only remaining effect was to waste width. The contract is documented in
  // docs/guides/plugin-development.md: the host gives the panel the pane,
  // the plugin decides how much of it its content should use.
  return (
    <PageShell
      title={view ? getPluginViewLabel(view) : t("be_pluginUiHost.pluginUiTitle")}
      description={view?.extension.description ?? t("be_pluginUiHost.pluginUiLoadingDesc")}
      maxWidth="none"
      contentClassName="flex min-h-0 flex-1 flex-col px-2 pb-2"
      data-testid="plugin-page-shell"
    >
      {authErrorBanner}
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
    </PageShell>
  );
}

/**
 * McpAppView — MCP Apps spec §3 sandboxed UI renderer.
 *
 * Renders a `ui://` resource from an MCP server through the upstream
 * `@modelcontextprotocol/ext-apps` `AppBridge`, inside an Electron <webview> on a
 * dedicated per-server `lvis-mcp-app:<hex(serverId)>` partition (#885 b1 storage
 * isolation), with no nodeIntegration and contextIsolation=yes.
 *
 * ─── The double-iframe sandbox proxy ─────────────────────────────────────────
 * The <webview> does NOT load the app HTML directly. It loads a host-owned,
 * script-free **sandbox-proxy document** served from the privileged
 * `lvis-mcp-app://` scheme with a real CSP response header. The host-owned relay
 * preload running in that document then mounts the app HTML into an INNER
 * `<iframe sandbox="allow-scripts" srcdoc>`.
 *
 * That indirection is the whole point. An ext-apps guest connects with the default
 * `PostMessageTransport(window.parent, window.parent)`. A <webview> guest is a
 * TOP-LEVEL document, so `window.parent === window` and the app would post to
 * ITSELF — which is exactly why the previous hand-rolled bridge here was dead. In
 * the inner frame `window.parent` is the proxy: a real, different, opaque-origin
 * frame. So postMessage genuinely crosses and the app runs COMPLETELY UNMODIFIED.
 *
 * Message path:
 *   AppBridge ⇄ WebviewIpcTransport ⇄ <webview> ipc ⇄ relay preload ⇄ inner App
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiPayload, McpUiResourceBundle } from "../../../mcp/types.js";
import { Loader2, AlertCircle, PlugZap } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { mcpAppPartitionName } from "../../../shared/mcp-app-partition.js";
import { useOptionalTheme, findBundle, bundleToPluginTokens, DEFAULT_BUNDLE_ID } from "../theme/index.js";
// The host-side wiring lives in its own React-free module so the real-<webview> e2e
// gate can import and exercise THE SHIPPING WIRING rather than a look-alike copy.
import { createMcpAppBridge } from "./mcp-app-bridge.js";
// Standard ext-apps `McpUiHostContext` builder (theme/locale/timeZone → standard
// style-variable vocabulary). React-free so it stays importable by the e2e gate.
import { buildMcpAppHostContext } from "./mcp-app-host-context.js";
// The display-mode SoT: what the host advertises (`availableDisplayModes`) AND what
// the `onrequestdisplaymode` handler will accept — one module, so they cannot drift.
import {
  MCP_APP_DEFAULT_DISPLAY_MODE,
  type McpUiDisplayMode,
} from "../../../shared/mcp-app-display-mode.js";
import type { BridgeWebviewElement, WebviewIpcTransport } from "./webview-ipc-transport.js";
// `openExternalUrl` (the `onopenlink` egress path) lives on `window.lvisApi`, reached
// through the renderer's `getApi()` — NOT `window.lvis` (a curated subset without it).
import { getApi } from "../api-client.js";
// The card's ORIGIN chat session — the second binding `onmessage` needs (see below).
// Optional: this component also mounts outside the chat subtree.
import { useOptionalChatContext } from "../context/ChatContext.js";

/** Extract the `?t=<token>` proxy-session token from a `lvis-mcp-app://` URL. */
function tokenFromProxyUrl(proxyUrl: string): string | null {
  try {
    return new URL(proxyUrl).searchParams.get("t");
  } catch {
    return null;
  }
}

export function McpAppView({
  payload,
  /**
   * The mode this MOUNT presents the card in. A transcript card is `inline` (the
   * default); the DETACHED window is the host's `fullscreen` presentation and passes
   * it explicitly (DetachedView). Everything else about display mode — the advertised
   * set, the request check — is the shared SoT module.
   */
  displayMode: mountDisplayMode = MCP_APP_DEFAULT_DISPLAY_MODE,
}: {
  payload: McpUiPayload;
  displayMode?: McpUiDisplayMode;
}) {
  const { t, locale } = useTranslation();
  // Host theme sources for the standard `McpUiHostContext`: shell (light/dark) and
  // the active bundle id (drives the curated `--lvis-*` token map we translate to
  // the standard style-variable vocabulary — never leaking `--lvis-*` to the app).
  // `useOptionalTheme` (NOT `useTheme`): McpAppView is mounted from surfaces that may
  // lack a ThemeProvider ancestor (isolated card/preview test harnesses; and it keeps
  // the card robust in any detached mount). A throwing `useTheme()` here would crash
  // the whole render tree of any such host. With no provider it falls back to the
  // light default bundle — which only happens in isolation, since the app root always
  // mounts a real ThemeProvider.
  const themeCtx = useOptionalTheme();
  const resolved = themeCtx?.resolved ?? "light";
  const effectiveBundleId = themeCtx?.effectiveBundleId ?? DEFAULT_BUNDLE_ID;

  // ── The card's ORIGIN session — the `onmessage` session binding ───────────────
  // A card belongs to the chat session it was rendered in. We latch the FIRST session
  // id we see (not the live one) so the binding is the card's origin, and main can
  // compare it against the conversation loop's current session: a message from a card
  // whose session is no longer live must never be injected into the conversation the
  // user navigated to — it degrades to a notification (one rule, main-side).
  //
  // Surfaces with no chat session (detached window, isolated harness) leave this empty,
  // which is not a session id and therefore never matches — the same fail-safe branch.
  const chatCtx = useOptionalChatContext();
  const originSessionIdRef = useRef("");
  if (originSessionIdRef.current === "" && chatCtx?.currentSessionId) {
    originSessionIdRef.current = chatCtx.currentSessionId;
  }

  // ── The card's IDENTITY — the third `onupdatemodelcontext` binding ────────────
  // `ui/update-model-context` OVERWRITES one slot per card, so main needs to know WHICH
  // card is speaking. The id is minted HERE, in the trusted renderer, once per mount: the
  // app never sees it and cannot name one, so it can only ever overwrite its own slot.
  const cardIdRef = useRef("");
  if (cardIdRef.current === "") cardIdRef.current = crypto.randomUUID();
  const [bundle, setBundle] = useState<McpUiResourceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  // b3.3 — disable-in-place on server disconnect. Lives INSIDE McpAppView so
  // every mount site (inline preview rail + detached window) inherits it from
  // one source. Reconnect does NOT auto-re-enable (§3.4): the user re-invokes
  // the tool → a fresh McpUiPayload → a fresh card.
  const [disabled, setDisabled] = useState(false);
  const bridgeRef = useRef<{ bridge: AppBridge; transport: WebviewIpcTransport; token: string | null } | null>(null);

  // `payload.height` is only the INITIAL seed now (and the loading/disconnected
  // placeholder height). The live <webview> dimensions move to state so the app's
  // `ui/notifications/size-changed` (via the injected `onResize` adapter) can grow the
  // card with its content. `width` stays undefined → the webview keeps its responsive
  // `100%` default until the app declares a width.
  const initialHeight = payload.height ?? 300;
  const [size, setSize] = useState<{ width?: number; height: number }>({ height: initialHeight });

  // `onsizechange` adapter injected into the bridge: apply a content-driven resize,
  // preserving whichever dimension the notification omitted. Stable identity so the
  // ref-callback bridge lifecycle (keyed on [payload, bundle]) never re-creates the
  // bridge for a resize.
  const handleResize = useCallback((next: { width?: number; height?: number }) => {
    setSize((prev) => ({
      width: next.width ?? prev.width,
      height: next.height ?? prev.height,
    }));
  }, []);

  // ── `onrequestdisplaymode` — the card's APPLIED mode ──────────────────────────
  // State drives the host context we publish; the ref is what the bridge handler reads
  // at call time (a stale closure would answer with a mode the card has already left).
  const [displayMode, setDisplayMode] = useState<McpUiDisplayMode>(mountDisplayMode);
  const displayModeRef = useRef(displayMode);
  displayModeRef.current = displayMode;
  const getDisplayMode = useCallback(() => displayModeRef.current, []);

  // Apply a SUPPORTED mode (the handler filters the rest against the advertised SoT)
  // and resolve to the mode ACTUALLY applied — the previous one when the host declined.
  //
  // Both arms ride the EXISTING detached-shell seam; neither builds a window path:
  //   · fullscreen → `mcp.openDetached(payload, { maximize: true })`. The shell is
  //     single-instance by policy, so this navigates the one detached window rather
  //     than spawning another.
  //   · inline     → close that shell (`window.closeAllDetached`, the same sweep work
  //     mode uses). Under the single-instance policy it IS "close the detached shell",
  //     and it is the exact inverse of the fullscreen arm — reachable from the inline
  //     card and from inside the detached window alike (main closes every tracked
  //     detached tab regardless of sender, and auth windows are never tracked).
  const applyDisplayMode = useCallback(
    async (mode: McpUiDisplayMode): Promise<McpUiDisplayMode> => {
      const current = displayModeRef.current;
      if (mode === current) return current;

      if (mode === "fullscreen") {
        const result = await window.lvis.mcp.openDetached(payload, { maximize: true });
        // Host declined (invalid payload / window failure): the card did not move.
        if (!result?.ok) return current;
      } else {
        // Optional-chained like every other `api.window` call site: the surface is
        // absent in isolated harnesses, and "there is no detached shell" is exactly
        // the state an inline request wants anyway.
        await getApi().window?.closeAllDetached();
      }
      displayModeRef.current = mode;
      setDisplayMode(mode);
      return mode;
    },
    [payload],
  );

  // Host IANA time zone — stable for the app's lifetime; read once.
  const timeZone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    [],
  );

  // Build the STANDARD `McpUiHostContext` from the current host theme + locale +
  // time zone. `findBundle` may return undefined mid lazy-load — fall back to the
  // always-resident default bundle, and if even that is missing (never in practice)
  // emit no style variables rather than throw.
  const buildHostContext = useCallback(() => {
    const activeBundle = findBundle(effectiveBundleId) ?? findBundle(DEFAULT_BUNDLE_ID);
    const tokens: Record<string, string> = activeBundle ? { ...bundleToPluginTokens(activeBundle) } : {};

    // `bundleToPluginTokens` never carries `--lvis-font-family` — ThemeProvider
    // writes it directly onto `document.documentElement.style`, decoupled from the
    // bundle token map, only when the user picked a custom font (see
    // ThemeProvider's `applySettingsAppearance`). Read the LIVE computed value so
    // the `--font-sans` mapping reflects an actual user override instead of never
    // firing. Deliberately NOT the default HOST_FONT_STACK: apps with no override
    // should fall back to their own font, not inherit LVIS's default stack.
    if (typeof document !== "undefined") {
      const family = getComputedStyle(document.documentElement)
        .getPropertyValue("--lvis-font-family")
        .trim();
      if (family) tokens["--lvis-font-family"] = family;
    }

    return buildMcpAppHostContext({ shell: resolved, tokens, locale, timeZone, displayMode });
  }, [resolved, effectiveBundleId, locale, timeZone, displayMode]);

  // Hold the latest builder in a ref so the ref-callback bridge lifecycle
  // (`attachWebview`, keyed only on [payload, bundle]) can seed the initial context
  // at mount without re-subscribing on every theme/locale change.
  const buildHostContextRef = useRef(buildHostContext);
  buildHostContextRef.current = buildHostContext;

  // Fetch the ui:// resource via IPC on first render. Main installs the partition
  // policy (declared-origin network gate + sandbox-proxy protocol handler + relay
  // preload) and mints the proxy session BEFORE returning, so all three are in place
  // before the webview navigates.
  useEffect(() => {
    let cancelled = false;
    setBundle(null);
    setError(null);
    // A fresh payload (new card / re-invocation) starts enabled even if the
    // previous serverId had disconnected; the disconnect event only disables
    // the specific card that was live when it fired.
    setDisabled(false);
    // Re-seed the live card size from the new payload; the app will resize it again
    // via `ui/notifications/size-changed` once it renders.
    setSize({ height: payload.height ?? 300 });
    // A fresh payload is a fresh card: it presents in THIS mount's mode again, whatever
    // the previous card had talked the host into.
    displayModeRef.current = mountDisplayMode;
    setDisplayMode(mountDisplayMode);

    window.lvis.mcp.readUiResource(payload.serverId, payload.resourceUri)
      .then((next) => {
        if (cancelled) return;
        setBundle(next);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => { cancelled = true; };
  }, [payload, mountDisplayMode]);

  // b3 — subscribe to the main→renderer server-disconnected broadcast. When the
  // payload's own server is torn down, disable in place (webview unmounts via
  // the `disabled` render branch below; the transcript record is untouched).
  useEffect(() => {
    const onServerDisconnected = window.lvis?.mcp?.onServerDisconnected;
    if (typeof onServerDisconnected !== "function") return;
    const unsub = onServerDisconnected((serverId: string) => {
      if (serverId === payload.serverId) setDisabled(true);
    });
    return unsub;
  }, [payload.serverId]);

  // MAJOR-1 — attach the AppBridge via a ref callback keyed to the mounted node,
  // NOT a post-mount `setAttribute` effect. Electron binds `partition` only when
  // it is present BEFORE `src` loads, so the sandbox attributes are declared as
  // `createElement` props (below); the bridge lifecycle rides the ref callback so
  // it never races the conditional render.
  const attachWebview = useCallback((node: HTMLElement | null) => {
    if (bridgeRef.current) {
      void bridgeRef.current.transport.close();
      // Free the main-side sandbox-proxy session so its token isn't held until the
      // global LRU evicts it (which, on a long chat with many cards, could evict a
      // still-mounted card's token instead). Fire-and-forget; idempotent in main.
      // Optional-chained: teardown can race a torn-down bridge surface (unmount).
      const { token } = bridgeRef.current;
      if (token) window.lvis?.mcp?.disposeUiSession?.(token);
      bridgeRef.current = null;
    }
    if (node && bundle) {
      const { bridge, transport } = createMcpAppBridge(
        payload,
        bundle.html,
        node as unknown as BridgeWebviewElement,
        // Seed the initial standard host context. Read the latest builder via ref
        // so this callback stays keyed on [payload, bundle] (MAJOR-1 lifecycle).
        buildHostContextRef.current(),
        // React-owned adapters: resize drives card state; open-link reuses the host's
        // existing effect-gated egress (`window.lvisApi.openExternalUrl`); call-tool
        // is BOUND HERE to this card's `payload.serverId` — the app supplies only a
        // tool name + args and has no channel through which to name a server. Main
        // re-verifies ownership and runs the call through the host's risk/consent gate.
        {
          onResize: handleResize,
          openLink: (url) => getApi().openExternalUrl(url),
          callTool: (name, args) => window.lvis.mcp.callTool(payload.serverId, name, args),
          // `onmessage` is bound to BOTH the card's server and the card's origin
          // session. The app names neither, so it can neither impersonate another
          // server nor speak into a conversation the user has left.
          postMessage: (params) =>
            window.lvis.mcp.postUiMessage(payload.serverId, originSessionIdRef.current, params),
          // `onrequestdisplaymode` — the card's mode is McpAppView's state, and the
          // applier maps a mode onto the host's EXISTING window seams (see above).
          getDisplayMode,
          applyDisplayMode,
          // `ondownloadfile` is bound to the card's server (for the audit trail; the app
          // names none). Main decodes the inline bytes, refuses to fetch any URI the app
          // supplies, and the user's save dialog authorizes the write.
          downloadFile: (params) => window.lvis.mcp.downloadFile(payload.serverId, params),
          // `onupdatemodelcontext` is bound to the card's server, its origin session, AND
          // this card instance. The app names none of the three, so it can overwrite only
          // its OWN slot, only in the conversation it belongs to. Main reads that slot at
          // the next prompt build — nothing here can start a turn.
          updateModelContext: (params) =>
            window.lvis.mcp.postUiModelContext(
              payload.serverId,
              originSessionIdRef.current,
              cardIdRef.current,
              params,
            ),
        },
      );
      bridgeRef.current = { bridge, transport, token: tokenFromProxyUrl(bundle.proxyUrl) };
    }
  }, [payload, bundle, handleResize, getDisplayMode, applyDisplayMode]);

  // Push host-context updates to a mounted bridge when the theme shell, active
  // bundle, or locale changes. `setHostContext` auto-diffs and only notifies the
  // view of changed fields (no-op on the mount pass, which matches the seed).
  // `displayMode` rides the same push: after `applyDisplayMode` commits, the app is
  // told the mode that actually took effect — the notification half of the answer the
  // `onrequestdisplaymode` result already carried.
  useEffect(() => {
    const current = bridgeRef.current;
    if (!current) return;
    current.bridge.setHostContext(buildHostContextRef.current());
  }, [resolved, effectiveBundleId, locale, displayMode]);

  return (
    <div className="mt-2 overflow-hidden rounded border bg-background">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/(--opacity-muted) px-2 py-1 text-[11px] text-muted-foreground">
        <span className="truncate">{payload.title ?? "MCP App"}</span>
        <span className="text-[10px] opacity-60">
          {t("mcpAppView.sandboxBadge")}
        </span>
      </div>
      {disabled ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height: initialHeight }} data-testid="mcp-app-disconnected">
          <PlugZap className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{t("mcpAppView.serverDisconnected")}</span>
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : !bundle ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height: initialHeight }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t("mcpAppView.loading")}</span>
        </div>
      ) : (
        createElement("webview", {
          ref: attachWebview,
          src: bundle.proxyUrl,
          partition: mcpAppPartitionName(payload.serverId),
          allowpopups: "false",
          // No `preload` attribute — under `sandbox=yes` it is silently ignored, and
          // in the DETACHED window the will-attach-webview guard strips it too (the
          // inline/main-window attach handler ignores this partition, so it does not).
          // Either way the relay preload rides `session.setPreloads()` on the
          // partition, which is the only mechanism that actually loads it.
          webpreferences: "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
          disablewebsecurity: "false",
          style: {
            // Grow with the app's reported content size (basic-host's resize intent)
            // but never exceed the card container. Expressed as an explicit px size +
            // `max*: 100%` rather than `min(<content>px, 100%)`: a percentage inside
            // `min()` resolves to `auto` when the card's parent has an indefinite
            // height and collapses the webview, whereas a definite px size capped by
            // `max-height`/`max-width` grows safely and no-ops when unconstrained.
            // `width` stays a plain `100%` until the app declares one.
            width: size.width != null ? `${size.width}px` : "100%",
            maxWidth: "100%",
            height: `${size.height}px`,
            maxHeight: "100%",
            border: 0,
            display: "flex",
            background: "transparent",
          },
        })
      )}
    </div>
  );
}

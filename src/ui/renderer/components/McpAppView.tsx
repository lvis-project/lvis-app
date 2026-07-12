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
import { Loader2, AlertCircle, PlugZap, ExternalLink } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { mcpAppPartitionName } from "../../../shared/mcp-app-partition.js";
// The card-size bounds SoT. `ui/notifications/size-changed` and the payload's `height`
// seed are UNTRUSTED numbers, and CSS cannot bound them (the card's containing block has
// an indefinite height, so a percentage max-height resolves to `none`) — so they are
// clamped arithmetically, at the one sink that turns them into pixels.
import {
  clampMcpAppCardSize,
  mcpAppCardSeedHeight,
  type McpAppCardSize,
} from "../../../shared/mcp-app-card-size.js";
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
   * The mode this MOUNT presents the card in — and, because a mount NEVER changes it,
   * the mode it truthfully reports for its whole life. A transcript card is `inline`
   * (the default); the DETACHED window is the host's `fullscreen` presentation and
   * passes it explicitly (DetachedView).
   *
   * A display-mode change does not mutate this: it MOVES the card to the other mount
   * and the losing mount stops being a live app (see `applyDisplayMode`). That is what
   * makes the host context structurally honest — there is no state a mount could set to
   * claim a presentation it is not in.
   */
  displayMode: mountDisplayMode = MCP_APP_DEFAULT_DISPLAY_MODE,
  /**
   * The card's ORIGIN chat session, threaded in by a mount with no `ChatContext`
   * ancestor — i.e. the DETACHED window, whose React root has no ChatContextProvider.
   * The host stamped it into the detached record at detach time; without it a detached
   * card would post `sessionId: ""`, main would drop every `ui/message` /
   * `ui/update-model-context` on the session check, and the app (whose
   * `ui/update-model-context` has no error channel in the spec) would never find out.
   */
  originSessionId,
}: {
  payload: McpUiPayload;
  displayMode?: McpUiDisplayMode;
  originSessionId?: string;
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
  // The DETACHED window has no ChatContextProvider in its React root, so it cannot read
  // the session from context — it receives the host-stamped one as `originSessionId` and
  // that takes precedence here. Surfaces with neither (an isolated harness) leave this
  // empty, which is not a session id and therefore never matches — the fail-safe branch.
  const chatCtx = useOptionalChatContext();
  const originSessionIdRef = useRef("");
  if (originSessionIdRef.current === "") {
    originSessionIdRef.current = originSessionId ?? chatCtx?.currentSessionId ?? "";
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

  // `payload.height` is only the INITIAL seed now (and the loading/placeholder height).
  // The live <webview> dimensions move to state so the app's
  // `ui/notifications/size-changed` (via the injected `onResize` adapter) can grow the
  // card with its content. `width` stays undefined → the webview keeps its responsive
  // `100%` default until the app declares a width. Both the seed (server-declared, on
  // the tool result) and every live update (app-declared) go through the SAME bounds.
  const seedHeight = mcpAppCardSeedHeight(payload.height);
  const [size, setSize] = useState<McpAppCardSize>({ height: seedHeight });

  // `onsizechange` adapter injected into the bridge — THE ONE SINK that turns the app's
  // reported numbers into pixels, and therefore the one place they are bounded:
  // `clampMcpAppCardSize` rejects non-finite / ≤ 0 values (the dimension keeps its
  // previous value), preserves whichever dimension the notification omitted, and clamps
  // the rest into `MCP_APP_CARD_{MIN,MAX}_{WIDTH,HEIGHT}_PX`. CSS cannot do this job: the
  // card's containing block has an indefinite height, so `max-height: 100%` resolves to
  // `none` and a `height: 5_000_000` card would push the transcript out of reach.
  // Stable identity so the ref-callback bridge lifecycle (keyed on [payload, bundle])
  // never re-creates the bridge for a resize.
  const handleResize = useCallback((next: { width?: number; height?: number }) => {
    setSize((prev) => clampMcpAppCardSize(next, prev));
  }, []);

  // ── `onrequestdisplaymode` — the card MOVES, this mount does not ──────────────
  // This mount's mode is `mountDisplayMode` and never changes; the ref only exists so the
  // bridge handler reads the current prop rather than a stale closure.
  const displayModeRef = useRef(mountDisplayMode);
  displayModeRef.current = mountDisplayMode;
  const getDisplayMode = useCallback(() => displayModeRef.current, []);

  // ── The detached instance this card MOVED to (inline mounts only) ─────────────
  // Set to the host-minted viewKey when a fullscreen request succeeds. While it is set,
  // this mount renders a quiet host-owned placeholder INSTEAD of the <webview> — which
  // tears down its bridge + transport through the existing `attachWebview(null)` path.
  // That is the whole point: a card has exactly ONE live bridge at a time. Cleared by the
  // host's `detachedClosed` event (window closed by the user, by the app's `inline`
  // request, or navigated away in the single-instance shell), which brings the card back.
  const [detachedViewKey, setDetachedViewKey] = useState<string | null>(null);
  const detachedViewKeyRef = useRef<string | null>(null);
  detachedViewKeyRef.current = detachedViewKey;

  // Apply a SUPPORTED mode (the handler filters the rest against the advertised SoT) and
  // resolve to the mode the CARD is in afterwards — the mount's own mode when the host
  // declined, since nothing moved.
  //
  // REPLACE, NEVER CLONE. Both arms move the card between the two host presentations, and
  // in both the losing instance stops being a live app:
  //   · fullscreen → `mcp.openDetached(payload, { maximize: true, sessionId })` mounts the
  //     card in the detached shell, and THIS inline mount goes dormant (placeholder →
  //     bridge + webview torn down). Two live bridges for one card — one of them lying
  //     about its mode to a spec-conformant app inside a 300px box — is exactly what this
  //     avoids.
  //   · inline → close the detached window for THIS CARD'S SERVER (`mcp.closeDetached`,
  //     scoped). Main purges the record and broadcasts `detachedClosed`, which is what
  //     revives the dormant inline card. NOT `window.closeAllDetached`: that sweeps every
  //     detached window the user has open, and an untrusted card must not reach it.
  const applyDisplayMode = useCallback(
    async (mode: McpUiDisplayMode): Promise<McpUiDisplayMode> => {
      const current = displayModeRef.current;
      if (mode === current) return current;

      if (mode === "fullscreen") {
        const result = await window.lvis.mcp.openDetached(payload, {
          maximize: true,
          // The card's origin session, so the detached instance keeps a REAL binding for
          // `ui/message` / `ui/update-model-context`. The app never names it.
          sessionId: originSessionIdRef.current,
        });
        // Host declined (invalid payload / window failure): the card did not move, and
        // this mount stays the live one.
        if (!result?.ok) return current;
        setDetachedViewKey(result.viewKey);
        return "fullscreen";
      }

      // Optional-chained like every other preload call site: the surface is absent in
      // isolated harnesses, and "there is no detached window" is exactly the state an
      // inline request wants anyway.
      const closed = await window.lvis?.mcp?.closeDetached?.(payload.serverId);
      if (closed && !closed.ok) return current;
      return "inline";
    },
    [payload],
  );

  // The host's `detachedClosed` broadcast — the ONE signal that a detached instance is
  // gone. It fires for a user-closed window, the `inline` arm's scoped close, and the
  // single-instance shell navigating away, so the dormant inline card revives on all
  // three from one subscription (a fresh <webview> + bridge; the app state lived in the
  // window that just closed).
  useEffect(() => {
    const onDetachedClosed = window.lvis?.mcp?.onDetachedClosed;
    if (typeof onDetachedClosed !== "function") return;
    return onDetachedClosed((viewKey: string) => {
      if (viewKey === detachedViewKeyRef.current) setDetachedViewKey(null);
    });
  }, []);

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

    // `displayMode` is this MOUNT's mode, which never changes — a mount cannot report a
    // presentation it is not in (a mode change moves the card to the other mount instead).
    return buildMcpAppHostContext({
      shell: resolved,
      tokens,
      locale,
      timeZone,
      displayMode: mountDisplayMode,
    });
  }, [resolved, effectiveBundleId, locale, timeZone, mountDisplayMode]);

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
    // Re-seed the live card size from the new payload (bounded — the seed is untrusted
    // too); the app will resize it again via `ui/notifications/size-changed` once it
    // renders.
    setSize({ height: mcpAppCardSeedHeight(payload.height) });
    // A fresh payload is a fresh card: it is live in THIS mount again, whatever the
    // previous card had talked the host into detaching.
    setDetachedViewKey(null);

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
  }, [payload]);

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

  // Push host-context updates to a mounted bridge when the theme shell, active bundle,
  // or locale changes. `setHostContext` auto-diffs and only notifies the view of changed
  // fields (no-op on the mount pass, which matches the seed). `displayMode` is NOT in
  // here: this mount's mode is fixed for its lifetime, so there is no mode update to push
  // — a mode change moves the card to the OTHER mount, whose seed carries the new mode.
  useEffect(() => {
    const current = bridgeRef.current;
    if (!current) return;
    current.bridge.setHostContext(buildHostContextRef.current());
  }, [resolved, effectiveBundleId, locale]);

  return (
    <div className="mt-2 overflow-hidden rounded border bg-background">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/(--opacity-muted) px-2 py-1 text-[11px] text-muted-foreground">
        <span className="truncate">{payload.title ?? "MCP App"}</span>
        <span className="text-[10px] opacity-60">
          {t("mcpAppView.sandboxBadge")}
        </span>
      </div>
      {disabled ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height: seedHeight }} data-testid="mcp-app-disconnected">
          <PlugZap className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{t("mcpAppView.serverDisconnected")}</span>
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : detachedViewKey ? (
        // The card LIVES IN THE DETACHED WINDOW right now. This is a host-owned
        // placeholder, not an app: no <webview>, so no bridge, no app state, and nothing
        // here can claim a display mode. It reverts to a live card when the host says the
        // detached instance is gone (`onDetachedClosed`).
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height: seedHeight }} data-testid="mcp-app-detached">
          <ExternalLink className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{t("mcpAppView.openInWindow")}</span>
        </div>
      ) : !bundle ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height: seedHeight }}>
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
            // Grow with the app's reported content size (basic-host's resize intent).
            // `size` is ALREADY BOUNDED — `clampMcpAppCardSize` is the real cap, applied
            // where the numbers enter the host. There is deliberately no `maxHeight:
            // "100%"` here: the card's containing block has an indefinite height, so a
            // percentage max-height resolves to `none` and caps NOTHING — it would be a
            // comment-shaped bound, not a bound. `maxWidth: "100%"` does work (the
            // parent's width IS definite) and stays as the responsive-layout guard.
            // `width` stays a plain `100%` until the app declares one.
            width: size.width != null ? `${size.width}px` : "100%",
            maxWidth: "100%",
            height: `${size.height}px`,
            border: 0,
            display: "flex",
            background: "transparent",
          },
        })
      )}
    </div>
  );
}

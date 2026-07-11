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
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { McpUiPayload, McpUiResourceBundle } from "../../../mcp/types.js";
import { Loader2, AlertCircle, PlugZap } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { mcpAppPartitionName } from "../../../shared/mcp-app-partition.js";
// The host-side wiring lives in its own React-free module so the real-<webview> e2e
// gate can import and exercise THE SHIPPING WIRING rather than a look-alike copy.
import { createMcpAppBridge } from "./mcp-app-bridge.js";
import type { BridgeWebviewElement, WebviewIpcTransport } from "./webview-ipc-transport.js";

export function McpAppView({ payload }: { payload: McpUiPayload }) {
  const { t } = useTranslation();
  const [bundle, setBundle] = useState<McpUiResourceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  // b3.3 — disable-in-place on server disconnect. Lives INSIDE McpAppView so
  // every mount site (inline preview rail + detached window) inherits it from
  // one source. Reconnect does NOT auto-re-enable (§3.4): the user re-invokes
  // the tool → a fresh McpUiPayload → a fresh card.
  const [disabled, setDisabled] = useState(false);
  const bridgeRef = useRef<{ bridge: AppBridge; transport: WebviewIpcTransport } | null>(null);

  const height = payload.height ?? 300;

  // Fetch the ui:// resource via IPC on first render. Main installs the partition
  // policy (CDN gate + sandbox-proxy protocol handler + relay preload) and mints
  // the proxy session BEFORE returning, so all three are in place before the
  // webview navigates.
  useEffect(() => {
    let cancelled = false;
    setBundle(null);
    setError(null);
    // A fresh payload (new card / re-invocation) starts enabled even if the
    // previous serverId had disconnected; the disconnect event only disables
    // the specific card that was live when it fired.
    setDisabled(false);

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
      bridgeRef.current = null;
    }
    if (node && bundle) {
      const { bridge, transport } = createMcpAppBridge(
        payload,
        bundle.html,
        node as unknown as BridgeWebviewElement,
      );
      bridgeRef.current = { bridge, transport };
    }
  }, [payload, bundle]);

  return (
    <div className="mt-2 overflow-hidden rounded border bg-background">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/(--opacity-muted) px-2 py-1 text-[11px] text-muted-foreground">
        <span className="truncate">{payload.title ?? "MCP App"}</span>
        <span className="text-[10px] opacity-60">
          {t("mcpAppView.sandboxBadge")}
        </span>
      </div>
      {disabled ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height }} data-testid="mcp-app-disconnected">
          <PlugZap className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{t("mcpAppView.serverDisconnected")}</span>
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : !bundle ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t("mcpAppView.loading")}</span>
        </div>
      ) : (
        createElement("webview", {
          ref: attachWebview,
          src: bundle.proxyUrl,
          partition: mcpAppPartitionName(payload.serverId),
          allowpopups: "false",
          // No `preload` attribute — it is silently ignored under sandbox=yes and
          // is stripped by the will-attach-webview guards anyway. The relay preload
          // is installed on the PARTITION via session.setPreloads().
          webpreferences: "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
          disablewebsecurity: "false",
          style: {
            width: "100%",
            height: `${height}px`,
            border: 0,
            display: "flex",
            background: "transparent",
          },
        })
      )}
    </div>
  );
}

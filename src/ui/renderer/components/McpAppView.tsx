/**
 * McpAppView — MCP Apps spec §3 sandboxed UI renderer.
 *
 * Renders a `ui://` resource from an MCP server inside an Electron <webview>
 * (same sandboxing baseline as HtmlPreview, but in a dedicated per-server
 * `lvis-mcp-app:<hex(serverId)>` partition with no nodeIntegration and
 * contextIsolation=yes). The per-server partition (#885 b1) keeps each MCP
 * server's cookie/localStorage/IndexedDB jar isolated from every other server.
 *
 * AppBridge (§3.4): the webview ↔ host channel uses JSON-RPC 2.0 over the
 * embedder window message channel, with host responses injected back into the
 * guest via `webview.executeJavaScript()`.
 * Currently supported methods:
 *   - `mcp/ping` → `{ pong: true }`
 *   - `mcp/getContext` → `{ serverId, resourceUri, title }`
 *
 * The HTML is fetched lazily on first render via `lvis.mcp.readUiResource`.
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { McpUiPayload } from "../../../mcp/types.js";
import { Loader2, AlertCircle, PlugZap } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { wrapWithCsp } from "./mcp-app-csp.js";
import { mcpAppPartitionName } from "../../../shared/mcp-app-partition.js";

type BridgeMessage = { jsonrpc?: string; id?: number; method?: string; params?: unknown };
type BridgeEventSource = MessageEventSource | null | undefined;
type BridgeWebview = EventTarget & {
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  executeJavaScript?: (code: string) => Promise<unknown>;
  contentWindow?: BridgeEventSource;
};

// ─── AppBridge injection ─────────────────────────────

/**
 * Minimal AppBridge script injected into the MCP App's webview page.
 * Provides `window.McpBridge.request(method, params)` → Promise.
 * Host-side handler responds by executing `window.postMessage(...)` inside the
 * guest page so the bridge can resolve the pending request Promise.
 */
function buildBridgeScript(payload: McpUiPayload): string {
  const ctx = JSON.stringify({ serverId: payload.serverId, resourceUri: payload.resourceUri, title: payload.title ?? "" });
  return `
<script>
(function(){
  var _pending = {};
  var _id = 0;
  window.McpBridge = {
    context: ${ctx},
    request: function(method, params) {
      return new Promise(function(resolve, reject) {
        var id = ++_id;
        _pending[id] = { resolve: resolve, reject: reject };
        window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');
      });
    }
  };
  window.addEventListener('message', function(ev) {
    var msg = ev.data;
    if (!msg || msg.jsonrpc !== '2.0' || !msg.id) return;
    var p = _pending[msg.id];
    if (!p) return;
    delete _pending[msg.id];
    if (msg.error) p.reject(new Error(msg.error.message));
    else p.resolve(msg.result);
  });
})();
</script>`;
}

function injectBridge(html: string, payload: McpUiPayload): string {
  const bridgeScript = buildBridgeScript(payload);
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${bridgeScript}`);
  }
  return `<!doctype html><html><head>${bridgeScript}</head><body>${html}</body></html>`;
}

export function createMcpAppBridge(payload: McpUiPayload, el: BridgeWebview) {
  const sendBridgeResponse = (message: unknown) => {
    const json = JSON.stringify(message);
    void el.executeJavaScript?.(`window.postMessage(${json}, "*");`).catch(() => undefined);
  };

  const handleBridgeMessage = (msg: BridgeMessage) => {
    if (!msg?.id || !msg?.method) return;

    let result: unknown;
    switch (msg.method) {
      case "mcp/ping":
        result = { pong: true };
        break;
      case "mcp/getContext":
        result = { serverId: payload.serverId, resourceUri: payload.resourceUri, title: payload.title ?? "" };
        break;
      default:
        sendBridgeResponse({
          jsonrpc: "2.0",
          id: msg.id,
          error: { code: -32601, message: "Method not found" },
        });
        return;
    }

    sendBridgeResponse({ jsonrpc: "2.0", id: msg.id, result });
  };

  const handleWindowMessage = (event: MessageEvent) => {
    const guestWindow = el.contentWindow;
    if (!guestWindow || event.source !== guestWindow) return;
    handleBridgeMessage(event.data as BridgeMessage);
  };

  const handleIpcMessage = (ev: Event) => {
    const event = ev as CustomEvent & { channel?: string; args?: unknown[] };
    if (event.channel !== "mcp-bridge") return;
    handleBridgeMessage(event.args?.[0] as BridgeMessage);
  };

  const attach = () => {
    window.addEventListener("message", handleWindowMessage);
    el.addEventListener("ipc-message", handleIpcMessage);
  };

  const detach = () => {
    window.removeEventListener("message", handleWindowMessage);
    el.removeEventListener("ipc-message", handleIpcMessage);
  };

  return {
    attach,
    detach,
    handleWindowMessage,
    handleIpcMessage,
  };
}

// ─── Component ───────────────────────────────────────

export function McpAppView({ payload }: { payload: McpUiPayload }) {
  const { t } = useTranslation();
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // b3.3 — disable-in-place on server disconnect. Lives INSIDE McpAppView so
  // every mount site (inline preview rail + detached window) inherits it from
  // one source. Reconnect does NOT auto-re-enable (§3.4): the user re-invokes
  // the tool → a fresh McpUiPayload → a fresh card.
  const [disabled, setDisabled] = useState(false);
  const bridgeRef = useRef<ReturnType<typeof createMcpAppBridge> | null>(null);

  const height = payload.height ?? 300;

  // Fetch the ui:// resource via IPC on first render
  useEffect(() => {
    let cancelled = false;
    setHtmlContent(null);
    setError(null);
    // A fresh payload (new card / re-invocation) starts enabled even if the
    // previous serverId had disconnected; the disconnect event only disables
    // the specific card that was live when it fired.
    setDisabled(false);

    window.lvis.mcp.readUiResource(payload.serverId, payload.resourceUri)
      .then((html) => {
        if (cancelled) return;
        const withBridge = injectBridge(html, payload);
        setHtmlContent(wrapWithCsp(withBridge, payload.csp));
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
      bridgeRef.current.detach();
      bridgeRef.current = null;
    }
    if (node) {
      const bridge = createMcpAppBridge(payload, node as unknown as BridgeWebview);
      bridge.attach();
      bridgeRef.current = bridge;
    }
  }, [payload]);

  const dataUrl = useMemo(
    () => htmlContent
      ? `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`
      : null,
    [htmlContent],
  );

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
      ) : !dataUrl ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>{t("mcpAppView.loading")}</span>
        </div>
      ) : (
        createElement("webview", {
          ref: attachWebview,
          src: dataUrl,
          partition: mcpAppPartitionName(payload.serverId),
          allowpopups: "false",
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

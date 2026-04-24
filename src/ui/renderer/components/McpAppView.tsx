/**
 * McpAppView — MCP Apps spec §3 sandboxed UI renderer.
 *
 * Renders a `ui://` resource from an MCP server inside an Electron <webview>
 * (same sandboxing baseline as HtmlPreview, but in the dedicated
 * `lvis-mcp-app` partition with no nodeIntegration and contextIsolation=yes).
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
import { createElement, useEffect, useMemo, useRef, useState } from "react";
import type { McpUiPayload } from "../../../mcp/types.js";
import { Loader2, AlertCircle } from "lucide-react";

type BridgeMessage = { jsonrpc?: string; id?: number; method?: string; params?: unknown };
type BridgeEventSource = MessageEventSource | null | undefined;
type BridgeWebview = EventTarget & {
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  executeJavaScript?: (code: string) => Promise<unknown>;
  contentWindow?: BridgeEventSource;
};

// ─── CSP helper ─────────────────────────────────────
// MCP App 렌더러는 외부 CDN(jsdelivr, unpkg, cdnjs 등)에서
// Chart.js 같은 라이브러리를 로드할 수 있도록 허용합니다.

function buildMcpCsp(): string {
  const directives = [
    "default-src 'none'",
    "script-src 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com",
    "style-src 'unsafe-inline' data: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://fonts.googleapis.com",
    "img-src data: blob: https:",
    "font-src data: https://fonts.gstatic.com https://cdn.jsdelivr.net https://unpkg.com",
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return `<meta http-equiv="Content-Security-Policy" content="${directives}">`;
}

function wrapWithCsp(html: string): string {
  const cspMeta = buildMcpCsp();
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}${cspMeta}`);
  }
  return `<!doctype html><html><head>${cspMeta}</head><body>${html}</body></html>`;
}

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
  const [htmlContent, setHtmlContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const webviewRef = useRef<HTMLElement | null>(null);

  const height = payload.height ?? 300;

  // Fetch the ui:// resource via IPC on first render
  useEffect(() => {
    let cancelled = false;
    setHtmlContent(null);
    setError(null);

    window.lvis.mcp.readUiResource(payload.serverId, payload.resourceUri)
      .then((html) => {
        if (cancelled) return;
        const withBridge = injectBridge(html, payload);
        setHtmlContent(wrapWithCsp(withBridge));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      });

    return () => { cancelled = true; };
  }, [payload.serverId, payload.resourceUri]);

  // Wire up the webview sandbox attributes
  useEffect(() => {
    const el = webviewRef.current as BridgeWebview | null;
    if (!el) return;
    el.setAttribute("partition", "lvis-mcp-app");
    el.setAttribute("allowpopups", "false");
    el.setAttribute(
      "webpreferences",
      "contextIsolation=yes, sandbox=yes, nodeIntegration=no, javascript=yes",
    );
    el.setAttribute("disablewebsecurity", "false");

    const bridge = createMcpAppBridge(payload, el);
    bridge.attach();
    return () => {
      bridge.detach();
    };
  }, [payload]);

  const dataUrl = useMemo(
    () => htmlContent
      ? `data:text/html;charset=utf-8,${encodeURIComponent(htmlContent)}`
      : null,
    [htmlContent],
  );

  return (
    <div className="mt-2 overflow-hidden rounded border bg-background">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-2 py-1 text-[11px] text-muted-foreground">
        <span className="truncate">{payload.title ?? "MCP App"}</span>
        <span className="text-[10px] opacity-60">
          MCP · 격리된 프로세스 · 제한된 네트워크
        </span>
      </div>
      {error ? (
        <div className="flex items-center gap-2 px-3 py-3 text-[11px] text-red-400">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      ) : !dataUrl ? (
        <div className="flex items-center justify-center gap-2 px-3 py-4 text-[11px] text-muted-foreground" style={{ height }}>
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          <span>MCP App 로드 중...</span>
        </div>
      ) : (
        createElement("webview", {
          ref: webviewRef,
          src: dataUrl,
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

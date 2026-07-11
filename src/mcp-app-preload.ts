/**
 * MCP-App sandbox-proxy relay preload (host-owned).
 *
 * Runs in the isolated world of the sandbox-proxy document
 * (`lvis-mcp-app://<hex(serverId)>/proxy.html`) inside each MCP-app <webview>.
 * Installed via `session.setPreloads()` on the per-server partition — the
 * `preload=` ATTRIBUTE is silently ignored under `sandbox=yes` and is stripped by
 * the `will-attach-webview` guards anyway, so the session preload is the only
 * viable path. The path is host-resolved; an MCP server can never nominate one.
 *
 * ─── What it fixes ───────────────────────────────────────────────────────────
 * An ext-apps guest connects with the default `PostMessageTransport(window.parent,
 * window.parent)`. In a <webview> the guest would be the TOP-LEVEL document, where
 * `window.parent === window` — so it would post to ITSELF and the host would never
 * see a byte (the old, dead hand-rolled bridge). We therefore run the app in an
 * INNER `<iframe sandbox="allow-scripts" srcdoc>`, whose `window.parent` is this
 * proxy frame: a genuinely different frame AND a different (opaque) origin, so
 * postMessage really crosses — with the app's code completely UNMODIFIED.
 *
 * ─── Security posture ────────────────────────────────────────────────────────
 * NOTHING is exposed to any page: no `contextBridge`, no globals. This preload
 * only forwards opaque JSON-RPC frames. The proxy document is script-free and
 * host-owned; the only code the MCP server controls runs inside the inner
 * sandboxed iframe, which has no `allow-same-origin` (⇒ opaque origin, cannot
 * reach into the proxy) and no preload of its own (`nodeIntegrationInSubFrames`
 * is false, and the top-frame guard below is belt-and-braces).
 */
// Named import — `import electron from "electron"` breaks in sandboxed webview
// preload contexts (see the note in `plugin-preload.ts`).
import { ipcRenderer } from "electron";
import {
  INNER_SANDBOX_ATTR,
  MCP_APP_BRIDGE_CHANNEL,
  SANDBOX_PROXY_READY,
  SANDBOX_RESOURCE_READY,
} from "./shared/mcp-app-bridge-contract.js";

type JsonRpcFrame = { jsonrpc?: string; method?: string; params?: unknown; id?: unknown };

/**
 * Only ever act as the proxy's TOP frame, and only on our own scheme. If this
 * ever ran inside the untrusted inner app frame it would be a relay the app could
 * drive, so bail loudly rather than degrade.
 */
function isSandboxProxyFrame(): boolean {
  return window.parent === window && window.location.protocol === "lvis-mcp-app:";
}

/**
 * Build the inner app iframe. Exported and side-effect-free (creates a detached
 * element, no `window`) so the security-critical invariant below is unit-testable.
 *
 * The `sandbox` attribute is set to `INNER_SANDBOX_ATTR` UNCONDITIONALLY — the
 * preload OWNS it and never consumes a value from the wire. This is the same class
 * of trust boundary the CSP fix closed: the app HTML (and, before this fix, a
 * `sandbox` string) arrives via `sendSandboxResourceReady`, i.e. renderer-forwarded,
 * and a forged `allow-same-origin` here would collapse the opaque-origin containment
 * that keeps the untrusted app from reaching this proxy frame. So the wire cannot
 * influence it. (No live escalation exists today — the untrusted app cannot set this
 * field, and the main-derived CSP + network gate still bind the frame — but a
 * containment flag must not be renderer-governed, full stop.)
 */
export function createInnerAppFrame(doc: Document, html: string): HTMLIFrameElement {
  const frame = doc.createElement("iframe");
  frame.setAttribute("sandbox", INNER_SANDBOX_ATTR);
  frame.srcdoc = html;
  return frame;
}

if (isSandboxProxyFrame()) {
  let inner: HTMLIFrameElement | null = null;

  /** Host → inner app. Frames are opaque to us; we never inspect app traffic. */
  const forwardToInner = (frame: JsonRpcFrame): void => {
    inner?.contentWindow?.postMessage(frame, "*");
  };

  /** Mount the app HTML into the inner frame (see `createInnerAppFrame`). */
  const mountApp = (params: { html?: unknown }): void => {
    if (typeof params?.html !== "string") return;
    if (inner) inner.remove();
    inner = createInnerAppFrame(document, params.html);
    document.body.appendChild(inner);
  };

  // ── Host → guest ────────────────────────────────────────────────────────────
  ipcRenderer.on(MCP_APP_BRIDGE_CHANNEL, (_event, frame: JsonRpcFrame) => {
    if (!frame || typeof frame !== "object") return;
    // The sandbox-resource-ready notification is addressed to the PROXY, not the
    // app. Consume it; never forward it inward.
    if (frame.method === SANDBOX_RESOURCE_READY) {
      mountApp((frame.params ?? {}) as { html?: unknown });
      return;
    }
    forwardToInner(frame);
  });

  // ── Guest → host ────────────────────────────────────────────────────────────
  // Accept ONLY messages whose source really is the inner app frame; anything
  // else in this window is not part of the protocol.
  window.addEventListener("message", (event: MessageEvent) => {
    if (!inner?.contentWindow || event.source !== inner.contentWindow) return;
    const frame = event.data as JsonRpcFrame;
    if (!frame || typeof frame !== "object" || frame.jsonrpc !== "2.0") return;
    ipcRenderer.sendToHost(MCP_APP_BRIDGE_CHANNEL, frame);
  });

  // ── Handshake ───────────────────────────────────────────────────────────────
  // Tell the host we are ready for HTML. The host answers with
  // SANDBOX_RESOURCE_READY, which mounts the inner app frame above.
  const announceReady = (): void => {
    ipcRenderer.sendToHost(MCP_APP_BRIDGE_CHANNEL, {
      jsonrpc: "2.0",
      method: SANDBOX_PROXY_READY,
      params: {},
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", announceReady, { once: true });
  } else {
    announceReady();
  }
}

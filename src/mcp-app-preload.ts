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
 * INNER `<iframe sandbox="allow-scripts allow-same-origin" srcdoc>`, whose
 * `window.parent` is this proxy frame: a genuinely different FRAME, so postMessage
 * really crosses (a different frame is what postMessage needs — not a different origin)
 * — with the app's code completely UNMODIFIED.
 *
 * ─── Security posture ────────────────────────────────────────────────────────
 * NOTHING is exposed to any page: no `contextBridge`, no globals. This preload
 * only forwards opaque JSON-RPC frames. The proxy document is script-free and
 * host-owned; the only code the MCP server controls runs inside the inner
 * sandboxed iframe.
 *
 * That inner frame carries `allow-same-origin`, so it inherits the PROXY's per-server
 * origin (`lvis-mcp-app://<hex(serverId)>`) — the spec's requirement, and what lets a
 * declared `permissions` feature actually be delegated. Same-origin does NOT let it
 * reach this preload: `contextIsolation` is true, so this relay runs in an isolated
 * world that same-origin DOM access cannot cross, and `nodeIntegrationInSubFrames` is
 * false, so the inner frame has no preload of its own. The proxy top document the inner
 * frame can now read is host-generated and script-free — there is no code there to
 * hijack — and the `window.parent === window` guard below independently refuses to
 * relay from anywhere but the proxy top frame.
 */
// Named import — `import electron from "electron"` breaks in sandboxed webview
// preload contexts (see the note in `plugin-preload.ts`).
import { ipcRenderer } from "electron";
import {
  INNER_SANDBOX_ATTR,
  MCP_APP_ALLOW_META_NAME,
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
 * BOTH containment flags are host-owned and NEVER consumed from the wire:
 *  - `sandbox` is set to `INNER_SANDBOX_ATTR` UNCONDITIONALLY. It is a fixed constant
 *    (`allow-scripts allow-same-origin`, the spec's required pair — see the contract),
 *    so the app can never widen or narrow its own sandbox.
 *  - `allow` (Permissions Policy) is the HOST-COMPUTED string, read from the proxy
 *    document's meta tag (`readHostDeclaredAllow`) — main derived it from the resource's
 *    declaration and served it in the host-owned proxy document, so it too is out of the
 *    app's reach. An empty string ⇒ no `allow` attribute ⇒ no feature delegated.
 *
 * The trust rule is the same one the CSP fix established: the app HTML arrives via
 * `sendSandboxResourceReady`, i.e. renderer-forwarded, so nothing taken from that
 * channel may govern a containment flag. Both flags here come from host state instead.
 */
export function createInnerAppFrame(doc: Document, html: string, allow = ""): HTMLIFrameElement {
  const frame = doc.createElement("iframe");
  frame.setAttribute("sandbox", INNER_SANDBOX_ATTR);
  // The Permissions Policy delegated to the app frame. Host-computed (see
  // `readHostDeclaredAllow`) — an empty string means NO feature is delegated, which is
  // the fail-closed default for a card that declared nothing.
  if (allow) frame.setAttribute("allow", allow);
  frame.srcdoc = html;
  return frame;
}

/**
 * The host-computed `allow` attribute, read from THIS (host-owned, host-served)
 * document's meta tag — never from the bridge wire.
 *
 * The distinction is the whole point: app HTML arrives renderer-forwarded, so anything
 * taken from that channel is renderer-governed and must not be a containment flag. The
 * proxy document is generated in main and served over the privileged `lvis-mcp-app://`
 * scheme behind the token→authority check, so its meta tags are host state. Absent meta
 * ⇒ empty ⇒ no feature delegated.
 */
export function readHostDeclaredAllow(doc: Document): string {
  const meta = doc.querySelector(`meta[name="${MCP_APP_ALLOW_META_NAME}"]`);
  return meta?.getAttribute("content") ?? "";
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
    // HTML from the wire; `allow` from the host-owned document. Never the other way round.
    inner = createInnerAppFrame(document, params.html, readHostDeclaredAllow(document));
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

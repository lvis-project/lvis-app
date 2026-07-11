/**
 * MCP-App sandbox-proxy protocol — `lvis-mcp-app://<hex(serverId)>/proxy.html?t=<token>`.
 *
 * Serves the host-owned **sandbox proxy** document that every MCP App renders
 * inside. Mirrors the `plugin-asset-protocol.ts` pattern (registerSchemesAsPrivileged
 * + per-partition `protocol.handle`).
 *
 * ─── Why a real privileged scheme and not the old `data:` URL ────────────────
 * The app HTML no longer rides in the document URL at all. It is delivered over
 * the JSON-RPC channel (`ui/notifications/sandbox-resource-ready`) and mounted by
 * the relay preload into an inner `<iframe sandbox="allow-scripts" srcdoc>`. The
 * proxy document itself is small, static and host-owned, which buys us:
 *
 *  1. A real `Content-Security-Policy` **response header**. The inner `srcdoc`
 *     frame INHERITS it and can only narrow it — so the header is the effective
 *     envelope for the untrusted app. A `data:` document could only carry a
 *     `<meta>` CSP.
 *  2. A real, stable origin (`standard: true`) per server, instead of an opaque
 *     `data:` origin where `'self'` is meaningless.
 *  3. No ~2MB `data:`-URL cap: previously the ENTIRE app HTML was percent-encoded
 *     into a top-level `data:` URL, so a large app silently failed to load.
 *
 * ─── Trust ───────────────────────────────────────────────────────────────────
 * The CSP is computed HERE, in main, from the sanitized per-resource policy — the
 * renderer cannot hand us a policy string. The token is host-minted and bound to
 * a serverId; a URL whose authority does not match its token's serverId is
 * rejected (fail-closed), so one server's proxy origin cannot serve another's.
 */
import type { Session } from "electron";
import { randomUUID } from "node:crypto";
import type { McpUiCspPolicy } from "../mcp/types.js";
import { buildMcpCspHeader } from "../shared/mcp-app-csp.js";
import { encodeMcpServerId } from "../shared/mcp-app-partition.js";

export const MCP_APP_SCHEME = "lvis-mcp-app";

/** Must run before `app.ready` (see `early-boot-env.ts`). */
export function registerMcpAppProtocolScheme(
  protocolApi: Pick<Electron.Protocol, "registerSchemesAsPrivileged">,
): void {
  protocolApi.registerSchemesAsPrivileged([
    {
      scheme: MCP_APP_SCHEME,
      privileges: {
        standard: true, // real origin (not opaque) — required for header CSP + partition binding
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

type ProxySession = {
  serverId: string;
  /** Effective CSP header string. Computed in main; never supplied by the renderer. */
  csp: string;
};

const proxySessions = new Map<string, ProxySession>();

/**
 * A session is consumed within milliseconds — the webview navigates to the proxy
 * URL immediately after minting — so the live set is tiny. This bound keeps the
 * registry from growing without limit across a long chat (Map preserves insertion
 * order, so the oldest entry is the first key).
 */
const MAX_PROXY_SESSIONS = 64;

/**
 * Mint a proxy session for one card render and return the URL the `<webview>`
 * should load. The token selects the CSP the proxy document is served with.
 */
export function createMcpAppProxySession(serverId: string, policy?: McpUiCspPolicy): string {
  const authority = encodeMcpServerId(serverId); // fail-closed on empty/over-length
  const token = randomUUID();
  proxySessions.set(token, { serverId, csp: buildMcpCspHeader(policy) });
  while (proxySessions.size > MAX_PROXY_SESSIONS) {
    const oldest = proxySessions.keys().next().value;
    if (oldest === undefined) break;
    proxySessions.delete(oldest);
  }
  return `${MCP_APP_SCHEME}://${authority}/proxy.html?t=${token}`;
}

/** Drop a card's proxy session (webview unmounted). */
export function disposeMcpAppProxySession(token: string): void {
  proxySessions.delete(token);
}

/** Test seam. */
export function _resetMcpAppProxySessions(): void {
  proxySessions.clear();
}

/**
 * The sandbox-proxy document. Deliberately script-free: ALL relay logic lives in
 * the host-owned preload (`mcp-app-preload.ts`), which runs in an isolated world
 * and is therefore not subject to this document's CSP. Nothing the MCP server
 * controls ever executes in this frame — only inside the inner sandboxed iframe.
 */
function proxyDocument(): string {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>MCP App</title>
    <style>
      html, body { margin: 0; padding: 0; height: 100%; background: transparent; }
      iframe { display: block; border: 0; width: 100%; height: 100%; background: transparent; }
    </style>
  </head>
  <body></body>
</html>`;
}

const handledPartitions = new Set<string>();

/** Idempotent per partition. Registered by `installMcpAppPartitionPolicy`. */
export function installMcpAppProtocolHandler(partitionName: string, ses: Session): void {
  if (handledPartitions.has(partitionName)) return;
  handledPartitions.add(partitionName);

  ses.protocol.handle(MCP_APP_SCHEME, (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response("bad url", { status: 400 });
    }
    const token = url.searchParams.get("t");
    const session = token ? proxySessions.get(token) : undefined;
    if (!session) return new Response("unknown mcp app session", { status: 404 });

    // Fail-closed: the URL's authority MUST be the token's own serverId, so a
    // proxy origin can never serve another server's session.
    if (url.hostname !== encodeMcpServerId(session.serverId)) {
      return new Response("mcp app session/authority mismatch", { status: 403 });
    }

    return new Response(proxyDocument(), {
      status: 200,
      headers: {
        "Content-Type": "text/html;charset=utf-8",
        "Content-Security-Policy": session.csp,
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}

/** Test seam — lets a suite re-install the handler on a fresh fake session. */
export function _resetMcpAppProtocolHandlers(): void {
  handledPartitions.clear();
}

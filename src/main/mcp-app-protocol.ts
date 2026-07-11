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
import type { McpUiResourceCsp } from "../mcp/types.js";
import { buildMcpCspHeader, declaredOrigins } from "../shared/mcp-app-csp.js";
import { encodeMcpServerId, MCP_APP_SCHEME } from "../shared/mcp-app-partition.js";

export { MCP_APP_SCHEME };

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
 * serverId → every origin that server's resources have declared so far.
 *
 * The partition's `webRequest` gate consults this so the NETWORK layer grants exactly
 * what the CSP grants. It is a per-SERVER union because an Electron partition (and
 * thus its webRequest gate) is per-server, while the CSP is per-resource. Be precise
 * about what that costs: within ONE server, the union does let resource A's frame
 * reach a host only resource B declared — it is the per-frame CSP, not this gate,
 * that keeps them apart. What the gate strictly guarantees is server ISOLATION: it
 * is never a way for one server to reach ANOTHER SERVER's declared host, and it never
 * grants a host no resource declared. Tightening to strict per-resource network
 * gating would require per-resource partitions (follow-up).
 */
const declaredOriginsByServer = new Map<string, Set<string>>();

/** Does `origin` appear in any resource this server declared? (network gate) */
export function isDeclaredOriginForServer(serverId: string, origin: string): boolean {
  return declaredOriginsByServer.get(serverId)?.has(origin) ?? false;
}

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
export function createMcpAppProxySession(serverId: string, csp?: McpUiResourceCsp): string {
  const authority = encodeMcpServerId(serverId); // fail-closed on empty/over-length
  const token = randomUUID();
  proxySessions.set(token, { serverId, csp: buildMcpCspHeader(csp) });

  // Keep the network gate in lockstep with the CSP: whatever this resource declared
  // (and only that) becomes reachable at the webRequest layer too.
  const origins = declaredOriginsByServer.get(serverId) ?? new Set<string>();
  for (const origin of declaredOrigins(csp)) origins.add(origin);
  declaredOriginsByServer.set(serverId, origins);

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
  declaredOriginsByServer.clear();
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

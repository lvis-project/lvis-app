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
import type { McpUiResourceCsp, McpUiResourcePermissions } from "../mcp/types.js";
import { MCP_APP_ALLOW_META_NAME } from "../shared/mcp-app-bridge-contract.js";
import { buildMcpCspHeader, declaredOrigins } from "../shared/mcp-app-csp.js";
import { encodeMcpServerId, MCP_APP_SCHEME } from "../shared/mcp-app-partition.js";
import {
  buildMcpAppAllowAttr,
  isElectronPermissionGranted,
} from "../shared/mcp-app-permissions.js";

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
  /**
   * The RESOURCE's declared permissions. Kept in its structured form (not just the
   * serialized allow string) because the Electron session handlers need to answer
   * per-permission — including telling `camera` from `microphone`, which Electron
   * collapses into one `media` permission.
   */
  permissions?: McpUiResourcePermissions;
  /**
   * The `allow` attribute for the inner app frame. Computed in main from the closed
   * feature table; never supplied by the renderer or the app.
   */
  allow: string;
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
 * should load. The token selects the CSP the proxy document is served with, AND the
 * permissions that card was granted.
 *
 * `permissions` is the RESOURCE's own declaration — from the plugin MANIFEST, or from an
 * external server's `resources/read` `_meta.ui`. It is policy INPUT, not policy: main
 * derives the frame's `allow` attribute and the Electron grant set from it here.
 */
export function createMcpAppProxySession(
  serverId: string,
  csp?: McpUiResourceCsp,
  permissions?: McpUiResourcePermissions,
): string {
  const authority = encodeMcpServerId(serverId); // fail-closed on empty/over-length
  const token = randomUUID();
  proxySessions.set(token, {
    serverId,
    csp: buildMcpCspHeader(csp),
    permissions,
    allow: buildMcpAppAllowAttr(permissions),
  });

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
 * The token in a proxy URL — the only thing that identifies WHICH card (and therefore
 * which declaration) a webContents is running. Returns undefined for any URL that is
 * not one of ours, so a caller cannot accidentally key a decision off a foreign page.
 */
function proxySessionForUrl(url: string | undefined): ProxySession | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== `${MCP_APP_SCHEME}:`) return undefined;
  const token = parsed.searchParams.get("t");
  if (!token) return undefined;
  const session = proxySessions.get(token);
  if (!session) return undefined;
  // Same fail-closed authority check the protocol handler makes: a URL whose authority
  // is not its token's serverId is not a session we minted.
  if (parsed.hostname !== encodeMcpServerId(session.serverId)) return undefined;
  return session;
}

/**
 * The Electron permission decision for one MCP-app card — the SINGLE chokepoint, wired
 * to the per-server session by `installMcpAppPartitionPolicy`.
 *
 * `frameUrl` is the webContents' top-level URL, i.e. the sandbox-proxy URL carrying the
 * card's token. The token is what binds the running frame back to the DECLARATION the
 * host minted it with — the app cannot change it, and the renderer never supplies it.
 *
 * DENY-BY-DEFAULT, at every step: an unknown URL, a missing/expired token, an authority
 * that does not match the token, a card that declared nothing, and any feature that card
 * did not declare are ALL denied. A session with no declaration grants nothing.
 *
 * `mediaKinds` (from Electron's `details.mediaTypes`/`mediaType`) disambiguates the
 * camera/microphone collision — see `isElectronPermissionGranted`.
 */
export function isMcpAppPermissionGranted(
  frameUrl: string | undefined,
  permission: string,
  mediaKinds?: readonly ("video" | "audio")[],
): boolean {
  const session = proxySessionForUrl(frameUrl);
  if (!session) return false;
  return isElectronPermissionGranted(session.permissions, permission, mediaKinds);
}

/** Escape a host-computed attribute value. The input is a closed enum, so this is belt-and-braces. */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * The sandbox-proxy document. Deliberately script-free: ALL relay logic lives in
 * the host-owned preload (`mcp-app-preload.ts`), which runs in an isolated world
 * and is therefore not subject to this document's CSP. Nothing the MCP server
 * controls ever executes in this frame — only inside the inner sandboxed iframe.
 *
 * The `allow` meta is how main hands the preload the host-computed Permissions Policy
 * for the inner frame. It rides in THIS document — host-generated, host-served — and not
 * over the renderer-forwarded bridge, so the app can never influence its own allow-list.
 */
function proxyDocument(allow: string): string {
  const allowMeta = allow
    ? `<meta name="${MCP_APP_ALLOW_META_NAME}" content="${escapeAttr(allow)}">`
    : "";
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>MCP App</title>${allowMeta}
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

    return new Response(proxyDocument(session.allow), {
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

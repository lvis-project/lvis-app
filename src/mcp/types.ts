






import type { ToolSurface } from "../plugins/runtime/tool-visibility.js";

export interface McpGovernancePolicy {
  version: string;

  defaultPolicy: "deny";

  servers: McpServerApproval[];

  globalRules: McpGlobalRules;
}

export interface McpServerApproval {

  id: string;

  name: string;

  status: "approved" | "pending" | "revoked";

  approvedBy?: string;

  approvedAt?: string;
  revokedAt?: string;


  transport: McpTransport;

  allowedCommands?: string[];

  allowedUrls?: string[];



  requiredAuth: "sso" | "api-key" | "oauth" | "mtls" | "none";
  /**
   * For stdio API-key servers, the exact environment variable name that may
   * receive the user-supplied key at process launch.
   */
  apiKeyEnv?: string;
  /**
   * For HTTP API-key servers, the exact custom header name that may receive the
   * user-supplied key. Omit to allow the built-in Bearer Authorization path.
   */
  apiKeyHeader?: string;

  tlsRequired: boolean;



  allowedCapabilities: McpCapability[];

  maxTools: number;

  toolNamePrefix: string;




  toolPermissionMode: "default" | "strict" | "auto";



  connectionTimeoutMs: number;

  maxConcurrentRequests: number;

  /**
   * Admin gate for `allowPrivateNetworks` on the matching per-server config.
   * When the client config sets `allowPrivateNetworks: true` (escape hatch
   * for on-prem / loopback servers), governance requires EITHER this flag
   * OR `globalRules.allowPrivateNetworks` to be `true` as well. Defaults to
   * false — preventing a self-elevating config file from bypassing
   * NetworkGuard.
   */
  allowPrivateNetworks?: boolean;
}

export interface McpGlobalRules {

  maxServersTotal: number;

  blockedUrlPatterns: string[];

  allowedUrlPatterns: string[];

  policyRefreshIntervalMs: number;
  /**
   * Admin gate for per-server `allowPrivateNetworks`. If not `true`, any
   * `http` server config that opts into private-network access is rejected
   * at governance — preventing a self-elevating config file from bypassing
   * NetworkGuard. Defaults to false.
   */
  allowPrivateNetworks?: boolean;
}

// ─── MCP Protocol Types ────────────────────────────

/**
 * MCP transport types.
 *
 * - `stdio`    : local subprocess with Content-Length framed JSON-RPC on stdin/stdout.
 * - `http`     : MCP Streamable HTTP transport (spec revision 2025-03-26+).
 *                Single POST endpoint that returns either `application/json`
 *                for single responses or `text/event-stream` for streaming.
 * - `sse`      : legacy HTTP+SSE dual-endpoint transport. Governance layer only
 *                (validation path); runtime client is not implemented — prefer `http`.
 * - `websocket`: not implemented at the client layer — governance validation only.
 */
export type McpTransport = "stdio" | "http" | "sse" | "websocket";
export type McpCapability = "tools" | "resources" | "prompts";

// ─── Config: discriminated union on `transport` ────

interface McpServerConfigBase {
  id: string;

  auth?: "sso" | "api-key" | "oauth" | "none";

  apiKey?: string;
}

export interface McpOAuthConfig {
  /** RFC 8707 resource identifier for the target MCP server. */
  resource?: string;
  /** RFC 9728 protected resource metadata URL, when known before first 401. */
  resourceMetadataUrl?: string;
  authorizationServers?: string[];
  scopes?: string[];
  clientRegistration?: "client-id-metadata-document" | "dynamic" | "preregistration" | "manual";
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: "stdio";

  command: string;

  args?: string[];

  env?: Record<string, string>;
  /** Safe env var name that receives apiKey at process launch. */
  apiKeyEnv?: string;
  /**
   * HOST-POPULATED filesystem-jail root for the ASRT-wrapped worker spawn
   * When the OS-tool sandbox gate is ON, the stdio worker
   * is wrapped through {@link ../permissions/asrt-sandbox.js wrapWorkerCommand}
   * and this directory is the ONLY path the wrapped process may write — its
   * per-server sandbox root under `~/.lvis/mcp/<serverId>/`.
   *
   * TRUST: this field is populated EXCLUSIVELY by the host at connect time
   * (`McpManager.connectServer` derives it from {@link lvisHome}); it MUST NEVER
   * originate from plugin/renderer/marketplace/config-file input (those are
   * untrusted surfaces — a server-supplied write-jail root would defeat the
   * jail). It is therefore deliberately NOT persisted to `servers.json` and is
   * stripped from the renderer DTO. When ABSENT at wrap time the worker is
   * wrapped DENY-ALL-WRITES (fail-closed) — never a HOME-wide or cwd fallback.
   */
  sandboxRoot?: string;
  url?: never;
  headers?: never;
  apiKeyHeader?: never;
  allowPrivateNetworks?: never;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  /** Streamable HTTP endpoint URL (POST target). */
  url: string;
  /** OAuth discovery/login metadata. Contains no tokens or secrets. */
  oauth?: McpOAuthConfig;
  /** Optional additional request headers (e.g. `Authorization`). */
  headers?: Record<string, string>;
  /** Safe header name that receives apiKey on MCP HTTP requests. */
  apiKeyHeader?: string;
  /**
   * Opt-in escape hatch for on-prem / localhost deployments. When true,
   * NetworkGuard's private-IP check is skipped for this server — the governance
   * `allowedUrls` allowlist is still the primary gate. Defaults to false.
   * Mirrors the host-wide NetworkGuard SSRF-protection pattern.
   */
  allowPrivateNetworks?: boolean;
  command?: never;
  args?: never;
  env?: never;
  apiKeyEnv?: never;
}

/**
 * Legacy / not-yet-implemented transports. Kept on the discriminated union so
 * governance validation paths that branch on `config.transport === "sse"` or
 * `"websocket"` continue to type-check unchanged.
 */
export interface McpLegacyRemoteServerConfig extends McpServerConfigBase {
  transport: "sse" | "websocket";
  url: string;
  headers?: Record<string, string>;
  apiKeyHeader?: string;
  command?: never;
  args?: never;
  env?: never;
  apiKeyEnv?: never;
  allowPrivateNetworks?: never;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpLegacyRemoteServerConfig;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * Renderer-safe config DTO.
 *
 * Secret-bearing fields remain write-only in the main process and never cross
 * the IPC boundary back to the renderer.
 */
export type McpServerConfigDto = DistributiveOmit<
  McpServerConfig,
  "apiKey" | "headers" | "env" | "args" | "sandboxRoot"
>;

/**
 * MCP Apps spec `McpUiToolVisibility` — WHO may call a tool.
 * - `"model"`: the agent may call it.
 * - `"app"`: the tool's OWN app (this server's `ui://` card) may call it.
 *
 * ONE declaration: this is an alias of {@link ToolSurface} (`plugins/runtime/
 * tool-visibility.ts`, the host's single surface-visibility reader), which had the
 * identical `"model" | "app"` union. A type-only import, so the reverse edge
 * (tool-visibility.ts already imports this module's `Tool` type-only) is erased at
 * runtime — no cycle.
 */
export type McpUiToolVisibility = ToolSurface;

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * MCP Apps spec `_meta.ui` on a TOOL (`McpUiToolMeta`). Only `visibility` is
   * read by the host: it is the spec's gate on app→server `tools/call` — a host
   * MUST reject an app's call to a tool whose visibility does not include
   * `"app"`. Absent ⇒ the spec default `["model","app"]`, materialized ONCE at
   * ingestion in `mcp-tool-adapter.ts` (the external-server analog of
   * `parsePluginJson`'s U1 defaulting site) so no downstream reader defaults.
   */
  _meta?: {
    ui?: {
      visibility?: McpUiToolVisibility[];
    };
  };
}

export interface McpServerState {
  id: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  connectedAt?: string;
  lastError?: string;
  registeredTools: string[];
}

// ─── Validation Results ────────────────────────────

export type ValidationResult =
  | { valid: true }
  | { valid: false; reason: string; layer: number };

// ─── MCP Apps UI Payload (MCP Apps spec 2026-01-26) ─

/**
 * Slot in which the MCP App should be rendered.
 * - `"chat"` : inline in the chat message flow (below the tool card)
 * - `"sidebar"` : docked to the sidebar panel
 * - `"tool-result"` : embedded inside the ToolGroupCard result row
 */
export type McpUiSlot = "chat" | "sidebar" | "tool-result";

/**
 * A UI resource's declared CSP — the MCP Apps spec shape (`McpUiResourceCsp`).
 *
 * Deliberately **domain buckets, not CSP directive names**. The previous host type
 * was keyed by directive (`scriptSrc`/`connectSrc`/…), which meant a spec-conformant
 * server's `connectDomains` was silently dropped and its network access denied.
 *
 * Lives on the RESOURCE (`resources/read` content item `_meta.ui`), never on the
 * tool result — the tool's `_meta.ui` carries only `resourceUri` + rendering hints.
 *
 * Kept structurally identical to upstream `McpUiResourceCsp` rather than imported
 * from it: this type crosses the main/preload/renderer boundary, and ext-apps 1.7.4's
 * `.d.ts` files use extensionless relative imports that do not resolve under
 * `moduleResolution: NodeNext`. `__tests__/mcp-app-csp.test.ts` pins it against the
 * upstream type so a spec change fails the suite instead of drifting silently.
 */
export interface McpUiResourceCsp {
  /** Origins for network requests (fetch/XHR/WebSocket) → `connect-src`. */
  connectDomains?: string[];
  /** Origins for images, scripts, stylesheets, fonts, media → those five directives. */
  resourceDomains?: string[];
  /** Origins for nested iframes → `frame-src`. */
  frameDomains?: string[];
  /** Allowed base URIs for the document → `base-uri`. */
  baseUriDomains?: string[];
}

/**
 * The security-relevant `_meta.ui` a UI resource carries (spec `McpUiResourceMeta`).
 *
 * The spec also defines `permissions` (camera / microphone / geolocation /
 * clipboardWrite, each a Permission-Policy feature on the inner iframe). LVIS does
 * NOT model it: the inner frame is `sandbox="allow-scripts"` with no
 * `allow-same-origin`, so it runs on an OPAQUE origin, and a powerful feature cannot
 * be delegated to one. The field was declared here, threaded through the read model,
 * and then dropped at the proxy-session mint — a knob plugin authors could set and
 * nothing would honor. Absent ⇒ denied is the whole policy; a card gets no powerful
 * features. Re-introduce it only together with the frame plumbing that proves it works.
 */
export interface McpUiResourceMeta {
  csp?: McpUiResourceCsp;
}

/**
 * What `resources/read` yields for a UI resource: the HTML plus the resource's OWN
 * declared security metadata. `readResource` previously returned a bare string and
 * dropped `_meta` entirely, which is why the CSP had to be (wrongly) sourced from the
 * tool result. Main builds the sandbox-proxy CSP header from this.
 */
export interface McpUiResourceRead {
  html: string;
  csp?: McpUiResourceCsp;
}

/**
 * A first-party plugin's declaration of ONE `ui://` resource it serves — the
 * plugin→host serving contract for MCP App cards. This is the plugin-side analog
 * of an external MCP server's `resources/read` for a `ui://` resource, so BOTH
 * paths converge on the SAME {@link McpUiResourceRead} model (HTML + the
 * resource's OWN declared csp).
 *
 * "Declared POLICY, served CONTENT": the manifest declares the uri and the
 * resource's security policy; the CONTENT comes from the plugin itself
 * (`RuntimePlugin.readUiResource`), exactly as an external MCP server answers
 * `resources/read` with bytes. The host never resolves or reads a
 * plugin-declared disk path — the plugin IS the MCP server, the host relays.
 *
 * Why the csp stays in the MANIFEST and is NOT returned by the hook: it is security
 * POLICY — static, schema-validated, reviewable before any plugin code runs, and
 * covered by `manifestSha256`. A runtime-supplied policy could present a narrow CSP
 * at review and widen it at serve time.
 *
 * Security invariants (enforced fail-closed at serve time — see
 * `plugin-ui-resource-provider.ts`, the single chokepoint):
 *  - `uri` authority MUST equal the declaring plugin's id — a plugin can only
 *    serve its OWN `ui://` namespace (own-namespace-only). Load-bearing: the
 *    serverId keys the sandbox-proxy origin, its partition, and the network
 *    `declaredOriginsByServer` union, so a plugin must not police its own
 *    namespace.
 *  - the uri MUST be one this manifest declared (declared-only) — this is what
 *    binds served content to the csp the host computes the CSP header from.
 *  - `csp` is the resource's OWN declared policy. Main COMPUTES the sandbox-proxy
 *    CSP header from it; the plugin never supplies a policy HEADER STRING, and the
 *    renderer can never inject one.
 */
export interface PluginUiResourceDecl {
  /** `ui://<pluginId>/<path>` — authority MUST equal the declaring plugin's id. */
  uri: string;
  /** The resource's own declared CSP (spec `McpUiResourceCsp`). @optional */
  csp?: McpUiResourceCsp;
}

/**
 * The MCP Apps TOOL-RESULT `_meta.ui` extension (spec §3.2) — how a server says
 * "render this card with my result". These are the STANDARD `_meta.ui.*` keys, not
 * an `xyz.lvis/*` vendor extension, so both arms declare a card identically: an
 * external MCP server puts it on its `CallToolResult`, and a first-party plugin
 * puts it on its handler's return value (the loopback delegate lifts it onto the
 * wire, see `plugin-runtime-delegate.ts`).
 *
 * Deliberately NO `csp` — per spec that lives on the RESOURCE, and main derives the
 * header there ({@link McpUiResourceMeta}). A `csp` on a tool result is ignored.
 */
export interface McpUiToolMeta {
  /** `ui://<serverId>/<path>` — the card to render. */
  resourceUri: string;
  /** Preferred render slot — defaults to `"chat"` when omitted. @optional */
  slot?: McpUiSlot;
  /** Preferred height in pixels. @optional */
  height?: number;
  /** Human-readable title shown in the webview title bar. @optional */
  title?: string;
}

/**
 * Payload produced by an MCP tool that declares a UI extension.
 *
 * MCP Apps spec §3.2 — a tool response may carry `_meta.ui` to request
 * that the host render an interactive micro-app alongside the text reply.
 * The host fetches the resource at `resourceUri` (a `ui://` scheme URL
 * resolved against the connected MCP server) and renders it in a sandboxed
 * webview / iframe using the `AppBridge` postMessage JSON-RPC channel.
 */
export interface McpUiPayload {
  /** MCP server that owns this UI resource. */
  serverId: string;
  /**
   * `ui://` URI pointing to the HTML resource on the MCP server.
   * The main process resolves this via `resources/read` to fetch the HTML.
   */
  resourceUri: string;
  /** Preferred render slot — defaults to `"chat"` when omitted. */
  slot?: McpUiSlot;
  /** Preferred height in pixels — defaults to 300 when omitted. */
  height?: number;
  /** Human-readable title shown in the webview title bar. */
  title?: string;
  // NOTE: deliberately NO `csp` here. Per spec, `csp`/`permissions` live on the
  // RESOURCE (`resources/read` content item `_meta.ui`), not on the tool result, and
  // the CSP must never round-trip through the renderer — a compromised renderer
  // could forge a permissive policy and widen the envelope containing the untrusted
  // app. Main derives it from the resource it just fetched. A `csp` on a tool result
  // is ignored.
}

/**
 * What `lvis.mcp.readUiResource` returns — everything a card needs to render one
 * MCP App through the sandbox-proxy.
 *
 * It is a bundle rather than a bare HTML string because the two halves are now
 * delivered over different channels: the proxy DOCUMENT is navigated to (and
 * carries the CSP header the app inherits), while the app HTML travels over the
 * JSON-RPC bridge as `ui/notifications/sandbox-resource-ready`. Main mints both
 * together so they cannot drift.
 */
export interface McpUiResourceBundle {
  /**
   * `lvis-mcp-app://<hex(serverId)>/proxy.html?t=<token>` — the host-owned
   * sandbox-proxy document for this card. The token selects the CSP main serves
   * it with; it is host-minted and bound to the serverId.
   */
  proxyUrl: string;
  /** The app HTML, mounted into the inner sandboxed iframe by the relay preload. */
  html: string;
}

/**
 * Result of an MCP App's `tools/call` on its OWN server, as it crosses
 * main → preload → renderer (`CHANNELS.mcp.callTool`).
 *
 * Deliberately an OUTCOME, not a thrown error: every denial (cross-server,
 * app-visibility, permission/consent) and every tool failure comes back as
 * `{ ok: false }` with a kebab-case code + English message, which the bridge
 * handler turns into an MCP-style `{ isError: true, content: [...] }`
 * `CallToolResult` for the app. `result` is the host tool layer's raw value
 * (a rendered text string for external MCP tools; whatever the plugin method
 * returned on the loopback path).
 */
export type McpUiToolCallOutcome =
  | { ok: true; result: unknown }
  | { ok: false; error: string; message?: string };

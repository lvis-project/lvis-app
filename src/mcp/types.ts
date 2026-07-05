






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

export interface McpToolSchema {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
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

export interface McpUiCspPolicy {
  /**
   * Host-sanitized renderer CSP additions. Keys may be camelCase here; the
   * renderer also tolerates kebab-case wire keys from `_meta.ui.csp`.
   */
  scriptSrc?: string[];
  styleSrc?: string[];
  imgSrc?: string[];
  fontSrc?: string[];
  connectSrc?: string[];
  mediaSrc?: string[];
  frameSrc?: string[];
  workerSrc?: string[];
  [directive: string]: unknown;
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
  /** Optional `_meta.ui.csp` renderer policy. Sanitized by `McpAppView`. */
  csp?: McpUiCspPolicy;
}

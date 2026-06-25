/**
 * MCP Security Types — §9.5 + §14.2 Governance
 *
 * STRIDE 위협 모델 기반 Defense-in-Depth:
 *
 * Layer 0: Governance Policy (Pre-installation) — deny-by-default whitelist
 * Layer 1: Installation Validation — transport, URL 검증
 * Layer 2: Connection Security — TLS, auth, timeout
 * Layer 3: Capability Restriction — tool namespace, schema validation, shadowing 방지
 * Layer 4: Runtime Permission — PermissionManager 연동, strict mode 기본
 * Layer 5: Monitoring & Audit — 전체 연결/호출 로깅
 * Layer 6: Kill Switch — 즉시 revoke, 도구 해제, 연결 종료
 */

// ─── Governance Policy (IT Admin 배포) ─────────────

export interface McpGovernancePolicy {
  version: string;
  /** deny-by-default: 명시적 승인 없는 서버는 모두 차단 */
  defaultPolicy: "deny";
  /** 승인된 서버 목록 */
  servers: McpServerApproval[];
  /** 전역 규칙 */
  globalRules: McpGlobalRules;
}

export interface McpServerApproval {
  /** 서버 고유 ID */
  id: string;
  /** 표시 이름 */
  name: string;
  /** 승인 상태 */
  status: "approved" | "pending" | "revoked";
  /** 승인자 */
  approvedBy?: string;
  /** 승인/취소 일시 */
  approvedAt?: string;
  revokedAt?: string;

  // ─── Layer 1: Transport 제한 ───────────────────
  transport: McpTransport;
  /** stdio: 허용된 실행 명령 (정확한 바이너리 이름) */
  allowedCommands?: string[];
  /** SSE/WebSocket: 허용된 URL (exact match 또는 *.example.com 패턴) */
  allowedUrls?: string[];

  // ─── Layer 2: 연결 보안 ────────────────────────
  /** 인증 요구 수준 */
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
  /** TLS 강제 여부 (SSE/WebSocket) */
  tlsRequired: boolean;

  // ─── Layer 3: 능력 제한 ────────────────────────
  /** 허용된 MCP 능력 축 */
  allowedCapabilities: McpCapability[];
  /** 등록 가능한 최대 도구 수 */
  maxTools: number;
  /** 도구 이름 네임스페이스 접두사: mcp_{prefix}_{toolName} */
  toolNamePrefix: string;

  // ─── Layer 4: 런타임 권한 ──────────────────────
  /**
   * 이 서버의 도구에 적용할 권한 모드.
   *
   * NOTE:
   * - `strict` / `auto` are currently consumed as per-tool PermissionManager
   *   overrides after MCP tool registration.
   * - `default` falls back to the normal source/trust-based permission flow.
   */
  toolPermissionMode: "default" | "strict" | "auto";

  // ─── Layer 2: 연결 제한 ────────────────────────
  /** 연결 타임아웃 */
  connectionTimeoutMs: number;
  /** 동시 요청 제한 */
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
  /** 전체 MCP 서버 최대 수 */
  maxServersTotal: number;
  /** 차단 URL 패턴 (deny-list) */
  blockedUrlPatterns: string[];
  /** 허용 URL 패턴 (allow-list, 빈 배열 = 모두 차단) */
  allowedUrlPatterns: string[];
  /** 정책 갱신 주기 (밀리초) */
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
  /** 인증 방식 */
  auth?: "sso" | "api-key" | "oauth" | "none";
  /** API 키 (api-key auth 시) — stdio 서버에서도 env로 전달 가능 */
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
  /** stdio: 실행 명령 */
  command: string;
  /** stdio: 인수 */
  args?: string[];
  /** 환경 변수 */
  env?: Record<string, string>;
  /** Safe env var name that receives apiKey at process launch. */
  apiKeyEnv?: string;
  /**
   * HOST-POPULATED filesystem-jail root for the ASRT-wrapped worker spawn
   * (worker-egress PR1). When the OS-tool sandbox gate is ON, the stdio worker
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
}

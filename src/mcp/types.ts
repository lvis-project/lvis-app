/**
 * MCP Security Types — §9.5 + §14.2 Governance
 *
 * STRIDE 위협 모델 기반 6-Layer Defense-in-Depth:
 *
 * Layer 0: Governance Policy (Pre-installation) — deny-by-default whitelist
 * Layer 1: Installation Validation — checksum, transport, URL 검증
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
  /** 정책 파일 무결성 검증용 HMAC (향후 RSA 서명) */
  policySignature?: string;
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
  /** stdio: 허용된 인수 패턴 */
  allowedArgs?: string[];
  /** SSE/WebSocket: 허용된 URL (exact match 또는 *.lge.com 패턴) */
  allowedUrls?: string[];

  // ─── Layer 2: 연결 보안 ────────────────────────
  /** 인증 요구 수준 */
  requiredAuth: "sso" | "api-key" | "mtls" | "none";
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
  /** 이 서버의 도구에 적용할 권한 모드 */
  toolPermissionMode: "default" | "strict" | "auto";

  // ─── Layer 2: 연결 제한 ────────────────────────
  /** 응답 최대 크기 (바이트) */
  maxResponseSizeBytes: number;
  /** 연결 타임아웃 */
  connectionTimeoutMs: number;
  /** 동시 요청 제한 */
  maxConcurrentRequests: number;

  // ─── Data Scope ────────────────────────────────
  /** 파일 접근 허용 패턴 (stdio transport) */
  allowedFilePathPatterns?: string[];
  /** 파일 접근 차단 패턴 */
  blockedFilePathPatterns?: string[];

  // ─── Layer 1: 무결성 ──────────────────────────
  /** 바이너리 SHA-256 체크섬 (플랫폼별) */
  checksums?: Record<string, string>;
}

export interface McpGlobalRules {
  /** 전체 MCP 서버 최대 수 */
  maxServersTotal: number;
  /** 차단 URL 패턴 (deny-list) */
  blockedUrlPatterns: string[];
  /** 허용 URL 패턴 (allow-list, 빈 배열 = 모두 차단) */
  allowedUrlPatterns: string[];
  /** 감사 로깅 수준 */
  auditLevel: "full" | "summary" | "errors-only";
  /** 킬 스위치 활성화 */
  killSwitchEnabled: boolean;
  /** 정책 갱신 주기 (밀리초) */
  policyRefreshIntervalMs: number;
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
  auth?: "sso" | "api-key" | "none";
  /** API 키 (api-key auth 시) — stdio 서버에서도 env로 전달 가능 */
  apiKey?: string;
}

export interface McpStdioServerConfig extends McpServerConfigBase {
  transport: "stdio";
  /** stdio: 실행 명령 */
  command: string;
  /** stdio: 인수 */
  args?: string[];
  /** 환경 변수 */
  env?: Record<string, string>;
  url?: never;
  headers?: never;
  allowPrivateNetworks?: never;
}

export interface McpHttpServerConfig extends McpServerConfigBase {
  transport: "http";
  /** Streamable HTTP endpoint URL (POST target). */
  url: string;
  /** Optional additional request headers (e.g. `Authorization`). */
  headers?: Record<string, string>;
  /**
   * Opt-in escape hatch for on-prem / localhost deployments. When true,
   * NetworkGuard's private-IP check is skipped for this server — the governance
   * `allowedUrls` allowlist is still the primary gate. Defaults to false.
   * Mirrors the external-executor SSRF-protection pattern.
   */
  allowPrivateNetworks?: boolean;
  command?: never;
  args?: never;
  env?: never;
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
  command?: never;
  args?: never;
  env?: never;
  allowPrivateNetworks?: never;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpLegacyRemoteServerConfig;

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

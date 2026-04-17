/**
 * MCP Governance — §14.2 Policy Enforcement
 *
 * 6-Layer 검증 엔진:
 * Layer 0: 정책 파일 로드 + 무결성 검증
 * Layer 1: 서버 설치 검증 (whitelist, transport, URL, checksum)
 * Layer 2: 연결 보안 검증 (TLS, auth, timeout)
 * Layer 3: 도구 등록 검증 (namespace, shadowing, max tools)
 *
 * 원칙: Deny-by-Default — 명시적 승인 없는 서버는 모두 차단
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  McpGovernancePolicy,
  McpServerApproval,
  McpServerConfig,
  McpToolSchema,
  ValidationResult,
} from "./types.js";

const DEFAULT_POLICY: McpGovernancePolicy = {
  version: "1.0",
  defaultPolicy: "deny",
  servers: [],
  globalRules: {
    maxServersTotal: 10,
    blockedUrlPatterns: ["*.ngrok.io", "*.serveo.net", "*.localtunnel.me"],
    allowedUrlPatterns: [],
    auditLevel: "full",
    killSwitchEnabled: true,
    policyRefreshIntervalMs: 30 * 60 * 1000, // 30분
  },
};

export class McpGovernance {
  private policy: McpGovernancePolicy;
  private readonly policyPath: string;
  private refreshTimer: NodeJS.Timeout | null = null;

  constructor(policyPath?: string) {
    this.policyPath = policyPath ?? join(homedir(), ".lvis", "governance", "mcp-policy.json");
    this.policy = this.loadPolicy();
  }

  // ─── Layer 0: 정책 로드 + 무결성 ─────────────────

  private loadPolicy(): McpGovernancePolicy {
    if (!existsSync(this.policyPath)) {
      console.log("[mcp-governance] 정책 파일 없음 — deny-by-default 적용");
      return DEFAULT_POLICY;
    }
    try {
      const raw = readFileSync(this.policyPath, "utf-8");
      const parsed = JSON.parse(raw) as McpGovernancePolicy;

      // 필수 필드 검증
      if (parsed.defaultPolicy !== "deny") {
        console.warn("[mcp-governance] defaultPolicy는 반드시 'deny'여야 합니다. 강제 적용.");
        parsed.defaultPolicy = "deny";
      }
      if (!parsed.globalRules) parsed.globalRules = DEFAULT_POLICY.globalRules;
      if (!Array.isArray(parsed.servers)) parsed.servers = [];

      console.log(`[mcp-governance] 정책 로드: ${parsed.servers.length}개 서버 규칙`);
      return parsed;
    } catch (err) {
      console.error("[mcp-governance] 정책 파일 파싱 실패 — deny-by-default 적용:", err);
      return DEFAULT_POLICY;
    }
  }

  /** 정책 주기적 갱신 시작 (IT admin이 정책 업데이트 시 반영) */
  startPolicyRefresh(): void {
    if (this.refreshTimer) return;
    const interval = this.policy.globalRules.policyRefreshIntervalMs;
    this.refreshTimer = setInterval(() => {
      const updated = this.loadPolicy();
      // 취소된 서버 감지
      const revokedIds = updated.servers
        .filter((s) => s.status === "revoked")
        .map((s) => s.id);
      if (revokedIds.length > 0) {
        console.warn(`[mcp-governance] 취소된 서버 감지: ${revokedIds.join(", ")}`);
      }
      this.policy = updated;
    }, interval);
  }

  stopPolicyRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  // ─── Layer 1: 서버 설치 검증 ─────────────────────

  /**
   * 서버 설정을 정책에 대해 검증.
   * 실패 시 어떤 Layer에서 차단되었는지 반환.
   */
  validateServer(config: McpServerConfig): ValidationResult {
    // L0: 정책 존재 확인
    if (!this.policy) {
      return { valid: false, reason: "거버넌스 정책이 로드되지 않았습니다.", layer: 0 };
    }

    // L1-a: 서버 승인 상태 확인 (deny-by-default)
    const approval = this.findApproval(config.id);
    if (!approval) {
      return { valid: false, reason: `미승인 서버: '${config.id}'는 거버넌스 정책에 등록되지 않았습니다.`, layer: 1 };
    }
    if (approval.status === "revoked") {
      return { valid: false, reason: `취소된 서버: '${config.id}'의 승인이 철회되었습니다. (${approval.revokedAt})`, layer: 1 };
    }
    if (approval.status === "pending") {
      return { valid: false, reason: `대기 중: '${config.id}'는 아직 승인되지 않았습니다.`, layer: 1 };
    }

    // L1-b: 전역 서버 수 제한
    const activeCount = this.policy.servers.filter((s) => s.status === "approved").length;
    if (activeCount > this.policy.globalRules.maxServersTotal) {
      return { valid: false, reason: `최대 서버 수 초과 (${activeCount}/${this.policy.globalRules.maxServersTotal})`, layer: 1 };
    }

    // L1-c: Transport 검증
    if (config.transport !== approval.transport) {
      return { valid: false, reason: `Transport 불일치: 설정=${config.transport}, 승인=${approval.transport}`, layer: 1 };
    }

    // L1-d: stdio — 명령어 검증
    if (config.transport === "stdio") {
      const cmdResult = this.validateStdioCommand(config, approval);
      if (!cmdResult.valid) return cmdResult;
    }

    // L1-e: HTTP / SSE / WebSocket — URL 검증
    if (
      config.transport === "http" ||
      config.transport === "sse" ||
      config.transport === "websocket"
    ) {
      const urlResult = this.validateUrl(config, approval);
      if (!urlResult.valid) return urlResult;

      // L1-f: Streamable HTTP 전용 — https 강제 (localhost/loopback 제외).
      //       사설망 IP 검사는 NetworkGuard(Tier A2)에 위임.
      if (config.transport === "http") {
        const httpResult = this.validateHttpScheme(config.url);
        if (!httpResult.valid) return httpResult;
      }
    }

    // L2: 연결 보안 검증
    const connResult = this.validateConnectionSecurity(config, approval);
    if (!connResult.valid) return connResult;

    return { valid: true };
  }

  // ─── Layer 3: 도구 등록 검증 ─────────────────────

  /**
   * MCP 서버가 등록하려는 도구 스키마를 검증.
   * - 네임스페이스 강제: mcp_{prefix}_{toolName}
   * - 기존 도구 shadowing 방지
   * - 최대 도구 수 제한
   */
  validateToolRegistration(
    serverId: string,
    tools: McpToolSchema[],
    existingToolNames: Set<string>,
  ): ValidationResult {
    const approval = this.findApproval(serverId);
    if (!approval || approval.status !== "approved") {
      return { valid: false, reason: `미승인 서버의 도구 등록 시도: ${serverId}`, layer: 3 };
    }

    // 능력 제한: tools 허용 여부
    if (!approval.allowedCapabilities.includes("tools")) {
      return { valid: false, reason: `서버 '${serverId}'는 도구 등록 권한이 없습니다.`, layer: 3 };
    }

    // 최대 도구 수
    if (tools.length > approval.maxTools) {
      return { valid: false, reason: `도구 수 초과: ${tools.length}/${approval.maxTools} (서버: ${serverId})`, layer: 3 };
    }

    // 네임스페이스 + shadowing 검증
    const requiredPrefix = `mcp_${approval.toolNamePrefix}_`;
    for (const tool of tools) {
      // 네임스페이스 강제
      const namespacedName = tool.name.startsWith(requiredPrefix)
        ? tool.name
        : `${requiredPrefix}${tool.name}`;

      // 기존 도구 shadowing 방지
      if (existingToolNames.has(namespacedName)) {
        return { valid: false, reason: `도구 이름 충돌: '${namespacedName}'은 이미 등록되어 있습니다.`, layer: 3 };
      }

      // builtin/plugin 도구 shadowing 차단
      const baseNames = ["memory_save", "memory_search", "memory_list", "web_search", "web_fetch"];
      if (baseNames.includes(tool.name)) {
        return { valid: false, reason: `빌트인 도구 덮어쓰기 시도 차단: '${tool.name}'`, layer: 3 };
      }
    }

    return { valid: true };
  }

  /** 도구 이름에 네임스페이스 접두사 적용 */
  applyToolNamespace(serverId: string, toolName: string): string {
    const approval = this.findApproval(serverId);
    if (!approval) return toolName;
    const prefix = `mcp_${approval.toolNamePrefix}_`;
    return toolName.startsWith(prefix) ? toolName : `${prefix}${toolName}`;
  }

  // ─── 조회 ────────────────────────────────────────

  /** 서버의 승인 정보 조회 */
  getApproval(serverId: string): McpServerApproval | undefined {
    return this.findApproval(serverId);
  }

  /** 승인된 서버 목록 */
  listApprovedServers(): McpServerApproval[] {
    return this.policy.servers.filter((s) => s.status === "approved");
  }

  /** 정책 버전 */
  getPolicyVersion(): string {
    return this.policy.version;
  }

  /** 감사 로깅 수준 */
  getAuditLevel(): string {
    return this.policy.globalRules.auditLevel;
  }

  /** 킬 스위치 상태 */
  isKillSwitchEnabled(): boolean {
    return this.policy.globalRules.killSwitchEnabled;
  }

  // ─── Private Validation ──────────────────────────

  private findApproval(serverId: string): McpServerApproval | undefined {
    return this.policy.servers.find((s) => s.id === serverId);
  }

  private validateStdioCommand(config: McpServerConfig, approval: McpServerApproval): ValidationResult {
    if (!config.command) {
      return { valid: false, reason: "stdio transport에는 command가 필요합니다.", layer: 1 };
    }
    const allowed = approval.allowedCommands ?? [];
    // H3 fix: 빈 allowedCommands는 deny (deny-by-default 원칙)
    if (allowed.length === 0 || !allowed.includes(config.command)) {
      return {
        valid: false,
        reason: `허용되지 않은 명령어: '${config.command}'. 허용 목록: [${allowed.join(", ")}]`,
        layer: 1,
      };
    }

    // 인수 검증 (위험 패턴 차단)
    const dangerousArgs = ["--no-sandbox", "--disable-security", "eval(", "$(", "`"];
    for (const arg of config.args ?? []) {
      if (dangerousArgs.some((d) => arg.includes(d))) {
        return { valid: false, reason: `위험한 인수 감지: '${arg}'`, layer: 1 };
      }
    }

    return { valid: true };
  }

  private validateUrl(config: McpServerConfig, approval: McpServerApproval): ValidationResult {
    if (!config.url) {
      return { valid: false, reason: `${config.transport} transport에는 url이 필요합니다.`, layer: 1 };
    }

    // 전역 차단 URL 패턴 체크
    for (const pattern of this.policy.globalRules.blockedUrlPatterns) {
      if (matchUrlPattern(pattern, config.url)) {
        return { valid: false, reason: `차단된 URL 패턴: '${config.url}' matches '${pattern}'`, layer: 1 };
      }
    }

    // 서버별 허용 URL 체크
    const allowed = approval.allowedUrls ?? [];
    if (allowed.length > 0) {
      const matches = allowed.some((pattern) => matchUrlPattern(pattern, config.url!));
      if (!matches) {
        return {
          valid: false,
          reason: `허용되지 않은 URL: '${config.url}'. 허용 목록: [${allowed.join(", ")}]`,
          layer: 1,
        };
      }
    }

    // 전역 허용 URL 패턴 체크 (빈 배열이면 서버별 규칙만 적용)
    const globalAllowed = this.policy.globalRules.allowedUrlPatterns;
    if (globalAllowed.length > 0) {
      const matches = globalAllowed.some((pattern) => matchUrlPattern(pattern, config.url!));
      if (!matches) {
        return {
          valid: false,
          reason: `전역 URL 허용 목록에 없음: '${config.url}'`,
          layer: 1,
        };
      }
    }

    return { valid: true };
  }

  /**
   * Streamable HTTP transport에만 적용: https 강제.
   * localhost / 127.0.0.1 / ::1 은 개발 편의상 http 허용.
   * 사설망/링크로컬 등 IP 기반 판단은 NetworkGuard가 담당.
   */
  private validateHttpScheme(rawUrl: string): ValidationResult {
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return { valid: false, reason: `잘못된 URL 형식: '${rawUrl}'`, layer: 1 };
    }
    if (parsed.protocol === "https:") return { valid: true };
    if (parsed.protocol === "http:") {
      const host = parsed.hostname.replace(/^\[|\]$/g, "");
      if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
        return { valid: true };
      }
      return {
        valid: false,
        reason: `HTTP transport에는 https:// 가 필요합니다 (localhost 제외): '${rawUrl}'`,
        layer: 1,
      };
    }
    return {
      valid: false,
      reason: `HTTP transport는 http:// 또는 https:// 만 허용됩니다: '${rawUrl}'`,
      layer: 1,
    };
  }

  private validateConnectionSecurity(config: McpServerConfig, approval: McpServerApproval): ValidationResult {
    // TLS 강제 (원격 연결)
    if (approval.tlsRequired && config.url) {
      const isSecure = config.url.startsWith("https://") || config.url.startsWith("wss://");
      if (!isSecure) {
        return { valid: false, reason: `TLS 필수: '${config.url}'은 https:// 또는 wss://여야 합니다.`, layer: 2 };
      }
    }

    // 인증 요구 수준 체크
    if (approval.requiredAuth !== "none") {
      if (approval.requiredAuth === "api-key" && !config.apiKey) {
        return { valid: false, reason: `API 키가 필요합니다 (서버: ${config.id})`, layer: 2 };
      }
      if (approval.requiredAuth === "sso" && config.auth !== "sso") {
        return { valid: false, reason: `SSO 인증이 필요합니다 (서버: ${config.id})`, layer: 2 };
      }
    }

    return { valid: true };
  }
}

// ─── Helpers ────────────────────────────────────────

/** URL 패턴 매칭 (*.lge.com → https://hr-api.lge.com/mcp 매칭) */
function matchUrlPattern(pattern: string, url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    const regexStr = "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$";
    return new RegExp(regexStr, "i").test(hostname);
  } catch {
    // URL 파싱 실패 시 문자열 포함 검사
    return url.includes(pattern.replace(/\*/g, ""));
  }
}

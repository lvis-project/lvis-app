/**
 * Permission Manager — §6.3 Layer 2-3 도구 실행 권한 관리
 *
 * 3-Layer 보안 모델:
 * - Layer 1: ToolRegistry deny rules (도구 존재 자체를 숨김) → tool-registry.ts
 * - Layer 2: Per-call permission check (이 파일) → allow/deny/ask 판정
 * - Layer 3: User prompt (ask 판정 시 UI 승인 요청) → 향후 구현
 *
 * Execution Modes:
 * - default: 위험 도구만 ask, 나머지 allow
 * - strict: 모든 도구 ask
 * - auto: 모든 도구 allow (에이전트가 자율 판단)
 */

export type PermissionDecision = "allow" | "deny" | "ask";
export type ExecutionMode = "default" | "strict" | "auto";

export interface PermissionRule {
  /** 도구 이름 패턴 (glob: "memory_*", "web_*", "*") */
  pattern: string;
  /** 허용/차단 */
  action: "allow" | "deny";
}

export class PermissionManager {
  private rules: PermissionRule[] = [];
  private mode: ExecutionMode = "default";
  private readonly alwaysAllowed = new Set<string>();

  /** 실행 모드 설정 */
  setMode(mode: ExecutionMode): void {
    this.mode = mode;
  }

  getMode(): ExecutionMode {
    return this.mode;
  }

  /** allow/deny 규칙 설정 */
  setRules(rules: PermissionRule[]): void {
    this.rules = [...rules];
  }

  /** 사용자가 "항상 허용"을 선택한 도구 등록 (Layer 3 결과) */
  addAlwaysAllowed(toolName: string): void {
    this.alwaysAllowed.add(toolName);
  }

  /**
   * §6.3 Layer 2 — 도구 실행 가능 여부 판정
   *
   * 판정 우선순위:
   * 1. deny 규칙 매칭 → deny
   * 2. allow 규칙 매칭 → allow
   * 3. always-allowed → allow
   * 4. execution mode 기반 판정
   */
  check(toolName: string): PermissionDecision {
    // 1. Deny rules first (deny는 항상 우선)
    for (const rule of this.rules) {
      if (rule.action === "deny" && matchGlob(rule.pattern, toolName)) {
        return "deny";
      }
    }

    // 2. Allow rules
    for (const rule of this.rules) {
      if (rule.action === "allow" && matchGlob(rule.pattern, toolName)) {
        return "allow";
      }
    }

    // 3. Always-allowed (사용자가 이전에 승인)
    if (this.alwaysAllowed.has(toolName)) {
      return "allow";
    }

    // 4. Execution mode 기반 판정
    switch (this.mode) {
      case "auto":
        return "allow";
      case "strict":
        return "ask";
      case "default":
        return classifyToolRisk(toolName);
    }
  }
}

// ─── Helpers ────────────────────────────────────────

function matchGlob(pattern: string, name: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return regex.test(name);
}

/**
 * TODO(human): 도구 위험 분류 정책
 *
 * Default 모드에서 "ask" vs "allow" 판정 기준.
 * 현재 보수적 기본값: read-only 도구는 allow, 그 외 ask.
 * 프로젝트 요구에 맞게 분류를 조정하세요.
 */
function classifyToolRisk(toolName: string): PermissionDecision {
  // Read-only / 조회성 도구는 자동 허용
  const safePatterns = [
    /^memory_(search|list)$/,   // 메모 조회
    /^index_(scan|documents)$/,  // 문서 목록/스캔
    /^chat_preview$/,            // 문서 검색 미리보기
    /^email_(status|list)$/,     // 이메일 상태/목록 조회
    /^meeting_(transcript|sessions)$/, // 회의 전사/세션 조회
    /^web_search$/,              // 웹 검색 (read-only)
  ];

  if (safePatterns.some((p) => p.test(toolName))) {
    return "allow";
  }

  // 상태 변경 도구는 ask (사용자 확인 필요)
  return "ask";
}

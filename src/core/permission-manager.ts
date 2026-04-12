/**
 * Permission Manager — tool-governance.md §4 Source-Aware Permission Model
 *
 * 통합 도구 거버넌스:
 * - 모든 도구(Builtin/Plugin/MCP)에 대해 source + trust 기반 판정
 * - Deny-by-default: MCP 도구는 strict 모드 강제
 * - 감사 로그 연동을 위한 판정 사유 추적
 *
 * 판정 우선순위 (§4.1):
 * 1. Governance deny 규칙 (불변)
 * 2. 관리자 명시 deny 규칙
 * 3. 관리자 명시 allow 규칙
 * 4. 사용자 "항상 허용" 규칙
 * 5. Trust-based 기본 정책
 */
import type { ToolSource, TrustLevel } from "./tool-registry.js";
import { trustFromSource } from "./tool-registry.js";

export type PermissionDecision = "allow" | "deny" | "ask";
export type ExecutionMode = "default" | "strict" | "auto";

export interface PermissionRule {
  /** 도구 이름 패턴 (glob: "memory_*", "mcp_*", "*") */
  pattern: string;
  /** 허용/차단 */
  action: "allow" | "deny";
  /** 적용 소스 제한 (없으면 전체 적용) */
  source?: ToolSource;
}

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason: string;
  layer: number; // 어떤 단계에서 결정되었는지
}

export class PermissionManager {
  private rules: PermissionRule[] = [];
  private mode: ExecutionMode = "default";
  private readonly alwaysAllowed = new Set<string>();
  /** Trust 수준 오버라이드 (관리자 설정) */
  private readonly trustOverrides = new Map<string, TrustLevel>();

  // ─── 설정 ────────────────────────────────────────

  setMode(mode: ExecutionMode): void {
    this.mode = mode;
  }

  getMode(): ExecutionMode {
    return this.mode;
  }

  setRules(rules: PermissionRule[]): void {
    this.rules = [...rules];
  }

  addAlwaysAllowed(toolName: string): void {
    this.alwaysAllowed.add(toolName);
  }

  setTrustOverride(toolName: string, trust: TrustLevel): void {
    this.trustOverrides.set(toolName, trust);
  }

  // ─── 판정 (§4.1) ────────────────────────────────

  /**
   * Source-aware 도구 실행 권한 판정.
   * 간단 인터페이스 — 이전 호환.
   */
  check(toolName: string, source?: ToolSource, category?: "read" | "write" | "dangerous"): PermissionDecision {
    return this.checkDetailed(toolName, source, category).decision;
  }

  /**
   * 상세 판정 — 감사 로그용 사유 포함.
   */
  checkDetailed(
    toolName: string,
    source?: ToolSource,
    category?: "read" | "write" | "dangerous",
  ): PermissionCheckResult {
    const trust = this.resolveTrust(toolName, source);

    // 1. Deny rules (최우선, 불변)
    for (const rule of this.rules) {
      if (rule.action !== "deny") continue;
      if (rule.source && rule.source !== source) continue;
      if (matchGlob(rule.pattern, toolName)) {
        return { decision: "deny", reason: `deny 규칙: ${rule.pattern}`, layer: 1 };
      }
    }

    // 2. Allow rules
    for (const rule of this.rules) {
      if (rule.action !== "allow") continue;
      if (rule.source && rule.source !== source) continue;
      if (matchGlob(rule.pattern, toolName)) {
        return { decision: "allow", reason: `allow 규칙: ${rule.pattern}`, layer: 2 };
      }
    }

    // 3. Always-allowed (사용자 이전 승인)
    if (this.alwaysAllowed.has(toolName)) {
      return { decision: "allow", reason: "사용자 영구 승인", layer: 3 };
    }

    // 4. Trust-based 기본 정책 (§4.1)
    return this.trustBasedDecision(toolName, trust, category);
  }

  // ─── Private ─────────────────────────────────────

  private resolveTrust(toolName: string, source?: ToolSource): TrustLevel {
    // 관리자 오버라이드
    const override = this.trustOverrides.get(toolName);
    if (override) return override;
    // 소스 기반
    return trustFromSource(source ?? "builtin");
  }

  /**
   * Trust 기반 판정 (tool-governance.md §4.1):
   *
   * HIGH  + read  → ALLOW
   * HIGH  + write → ASK (default mode) / ALLOW (auto mode)
   * MEDIUM + read → ALLOW
   * MEDIUM + write → ASK (default mode)
   * LOW   + any   → ASK (strict 강제)
   */
  private trustBasedDecision(
    toolName: string,
    trust: TrustLevel,
    category?: "read" | "write" | "dangerous",
  ): PermissionCheckResult {
    // auto 모드: 모든 trust 허용
    if (this.mode === "auto") {
      return { decision: "allow", reason: `auto 모드 (trust: ${trust})`, layer: 4 };
    }

    // strict 모드: 모든 것 ask
    if (this.mode === "strict") {
      return { decision: "ask", reason: `strict 모드 (trust: ${trust})`, layer: 4 };
    }

    // default 모드: trust + category 기반
    const resolvedCategory = category ?? classifyToolCategory(toolName);

    // LOW trust (MCP): 항상 ask
    if (trust === "low") {
      return { decision: "ask", reason: `MCP 도구 strict 강제 (trust: low)`, layer: 4 };
    }

    // dangerous: 항상 ask
    if (resolvedCategory === "dangerous") {
      return { decision: "ask", reason: `위험 도구 (category: dangerous)`, layer: 4 };
    }

    // read: 허용
    if (resolvedCategory === "read") {
      return { decision: "allow", reason: `조회 도구 (trust: ${trust}, category: read)`, layer: 4 };
    }

    // write (MEDIUM/HIGH): ask
    return { decision: "ask", reason: `상태 변경 도구 (trust: ${trust}, category: write)`, layer: 4 };
  }
}

// ─── Helpers ────────────────────────────────────────

function matchGlob(pattern: string, name: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return regex.test(name);
}

/** 도구 이름에서 Read/Write 분류 추론 */
function classifyToolCategory(toolName: string): "read" | "write" | "dangerous" {
  const readPatterns = [
    /_(search|list|get|query|status|transcript|sessions|documents|preview|fetch)$/,
    /^web_search$/,
    /^web_fetch$/,
  ];
  if (readPatterns.some((p) => p.test(toolName))) return "read";
  return "write";
}

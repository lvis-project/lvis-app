/**
 * Permission Manager — tool-governance.md §4 Source-Aware Permission Model
 *
 * 통합 도구 거버넌스:
 * - 모든 도구(Builtin/Plugin/MCP)에 대해 source + trust 기반 판정
 * - Deny-by-default: MCP 도구는 strict 모드 강제
 * - 감사 로그 연동을 위한 판정 사유 추적
 *
 * 판정 우선순위 (§4.1 + MCP per-tool override):
 * 1. deny 규칙
 * 2. MCP strict override
 * 3. allow 규칙
 * 4. MCP auto override
 * 5. 사용자 "항상 허용" 규칙
 * 6. Trust-based 기본 정책
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { DenyRule, ToolCategory, ToolSource, TrustLevel } from "../tools/types.js";
import { trustFromSource } from "../tools/types.js";
import { readPermissionsFile, updatePermissionsFile } from "./permissions-store.js";
import { isProactiveOrigin } from "../shared/proactive-source.js";
import { getToolCategoryDescriptor } from "./category-registry.js";

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
  /**
   * Q12 P2.5 §3 Layer 2 — structured deny reasons for audit forensics.
   * The pipeline records the *current* deny entry only (short-circuit
   * evaluation; later layers are skipped). Hypothetical other-layer
   * decisions belong to dry-run mode, not normal audit.
   *
   * Each entry: { layer, reason, source }
   *   layer    — which Q12 layer fired (0=sensitive, 1=allowed-dir, …)
   *   reason   — short machine-readable code (e.g. "out-of-allowed-dir")
   *   source   — emitter ("directory-policy", "sensitive-paths", …)
   */
  denyReasons?: ReadonlyArray<{
    layer: number;
    reason: string;
    source: string;
  }>;
}

export interface PermissionCheckContext {
  /**
   * Background/routine turns are not direct user gestures. Mutating tools must
   * still ask even when an allow rule or auto mode would otherwise permit them.
   */
  headless?: boolean;
}

export class PermissionManager {
  private rules: PermissionRule[] = [];
  private mode: ExecutionMode = "default";
  private readonly alwaysAllowed = new Set<string>();
  /** Trust 수준 오버라이드 (관리자 설정) */
  private readonly trustOverrides = new Map<string, TrustLevel>();
  /** MCP approval.toolPermissionMode 등 per-tool 실행 모드 override */
  private readonly toolModeOverrides = new Map<string, ExecutionMode>();
  /** 영구 규칙 저장 경로 (~/.lvis/permissions.json) */
  private readonly permissionsFilePath: string;

  constructor(permissionsFilePath?: string) {
    this.permissionsFilePath =
      permissionsFilePath ?? resolve(homedir(), ".lvis", "permissions.json");
  }

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

  setTrustOverride(toolName: string, trust: TrustLevel): void {
    this.trustOverrides.set(toolName, trust);
  }

  setToolModeOverride(toolName: string, mode: ExecutionMode): void {
    if (mode === "default") {
      this.toolModeOverrides.delete(toolName);
      return;
    }
    this.toolModeOverrides.set(toolName, mode);
  }

  clearToolModeOverride(toolName: string): void {
    this.toolModeOverrides.delete(toolName);
  }

  getVisibilityDenyRules(): DenyRule[] {
    return this.rules
      .filter((rule) => rule.action === "deny" && !rule.source)
      .map((rule) => ({ pattern: rule.pattern }));
  }

  // ─── 영구 규칙 관리 (B1) ─────────────────────────

  /**
   * 도구 이름(패턴)을 영구 allow 규칙으로 추가.
   * 인메모리 + permissions.json 동시 업데이트.
   */
  async addAlwaysAllowedPersist(pattern: string): Promise<void> {
    // 인메모리: alwaysAllowed Set (checkDetailed layer 5)
    this.alwaysAllowed.add(pattern);
    // 영구: rules 배열에 allow 규칙 추가 (중복 방지)
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      const exists = file.rules.some(
        (r) => r.action === "allow" && r.pattern === pattern && !r.source,
      );
      if (!exists) {
        file.rules.push({ pattern, action: "allow" });
      }
    });
  }

  /**
   * 도구 이름(패턴)을 영구 deny 규칙으로 추가.
   * 인메모리 rules 배열 + permissions.json 동시 업데이트.
   */
  async addAlwaysDeniedPersist(pattern: string): Promise<void> {
    // 인메모리: rules 배열 선두 삽입 (deny 최우선)
    const exists = this.rules.some(
      (r) => r.action === "deny" && r.pattern === pattern && !r.source,
    );
    if (!exists) {
      this.rules.unshift({ pattern, action: "deny" });
    }
    // 영구
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      const fileExists = file.rules.some(
        (r) => r.action === "deny" && r.pattern === pattern && !r.source,
      );
      if (!fileExists) {
        file.rules.unshift({ pattern, action: "deny" });
      }
    });
  }

  /**
   * 패턴 + 액션으로 영구 규칙 삭제.
   */
  async removeRule(pattern: string, action: "allow" | "deny"): Promise<void> {
    // 인메모리
    this.rules = this.rules.filter(
      (r) => !(r.pattern === pattern && r.action === action && !r.source),
    );
    if (action === "allow") this.alwaysAllowed.delete(pattern);
    // 영구
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      file.rules = file.rules.filter(
        (r) => !(r.pattern === pattern && r.action === action && !r.source),
      );
    });
  }

  /**
   * 앱 부팅 시 호출. permissions.json → 인메모리 병합.
   * 파일 없음 → no-op (정상).
   */
  async loadRulesFromFile(): Promise<void> {
    const file = await readPermissionsFile(this.permissionsFilePath);
    if (!file) return;

    // mode 동기화
    if (file.mode) this.mode = file.mode;

    // rules 병합: 파일 규칙은 기존 인메모리 규칙 뒤에 추가 (중복 제거)
    for (const rule of file.rules) {
      const dup = this.rules.some(
        (r) => r.pattern === rule.pattern && r.action === rule.action && r.source === rule.source,
      );
      if (!dup) {
        if (rule.action === "deny") {
          this.rules.unshift(rule); // deny는 최우선
        } else {
          this.rules.push(rule);
          // allow 규칙은 alwaysAllowed Set에도 반영
          if (!rule.source) this.alwaysAllowed.add(rule.pattern);
        }
      }
    }
  }

  /**
   * permissions.json에 저장된 규칙 목록 반환 (Settings UI용).
   * 파일 없음 → 빈 배열.
   */
  async listPersistedRules(): Promise<PermissionRule[]> {
    const file = await readPermissionsFile(this.permissionsFilePath);
    return file?.rules ?? [];
  }

  /**
   * mode를 변경하고 permissions.json에 영구 저장.
   */
  async setModePersist(mode: ExecutionMode): Promise<void> {
    this.mode = mode;
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      file.mode = mode;
    });
  }

  // ─── 판정 (§4.1) ────────────────────────────────

  /**
   * 상세 판정 — 감사 로그용 사유 포함.
   *
   * `proactiveOrigin` (예: `"proactive:meeting-detection"`) 가 set 이면
   * 모든 write/shell/network 도구는 **사용자 영구 승인 (`allow-always`) /
   * config allow rules / auto 모드** 와 무관하게 `ask` 로 강제됨.
   * Brain 트리거가 사용자 컨펌 없이 destructive 작업 자동 실행되는 것을
   * 막는 차단막 — `<proactive-origin-guidance>` 시스템 프롬프트의 1차
   * LLM-side 검토와 짝을 이루는 hard-gate. read 도구는 영향 없음.
   *
   * Q12 — 5-axis category model. Layer 3 의 decisionFor() 가 trust-based
   * fallback 을 대체. `meta` category 는 descriptor 가 `"override"` 를
   * 반환하므로 caller (executor) 의 decisionOverride 분기로 routing.
   */
  checkDetailed(
    toolName: string,
    source?: ToolSource,
    category?: ToolCategory,
    proactiveOrigin?: string | null,
    context: PermissionCheckContext = {},
  ): PermissionCheckResult {
    const trust = this.resolveTrust(toolName, source);
    // Strict pattern (shared with the rest of the proactive flow —
    // see shared/proactive-source.ts). Loose `startsWith` would
    // accept malformed values like "proactive:Bad/Path" that no
    // upstream gate emits but a future hand-injected codepath might;
    // fail-closed on malformed input.
    const isProactive = isProactiveOrigin(proactiveOrigin ?? null);
    const resolvedCategory: ToolCategory = category ?? classifyToolCategory(toolName);
    const isMutating =
      resolvedCategory === "write" ||
      resolvedCategory === "shell" ||
      resolvedCategory === "network";

    // 1. Deny rules (최우선, 불변)
    for (const rule of this.rules) {
      if (rule.action !== "deny") continue;
      if (rule.source && rule.source !== source) continue;
      if (matchGlob(rule.pattern, toolName)) {
        return { decision: "deny", reason: `deny 규칙: ${rule.pattern}`, layer: 1 };
      }
    }

    const toolModeOverride = this.toolModeOverrides.get(toolName);
    if (toolModeOverride === "strict") {
      return { decision: "ask", reason: "MCP 서버 strict 모드", layer: 2 };
    }

    if (context.headless && isMutating) {
      return {
        decision: "ask",
        reason: "headless 실행 컨텍스트 — 쓰기 도구는 사용자 컨펌 필수",
        layer: 2,
      };
    }

    // Proactive origin override — write/shell/network 도구는 cached
    // allow rules / always-allowed / auto-mode 를 모두 우회하고
    // 항상 사용자 컨펌을 받음. read 는 자동 실행 OK.
    if (isProactive && isMutating) {
      return {
        decision: "ask",
        reason: `proactive 출처 (${proactiveOrigin}) — 쓰기 도구는 사용자 컨펌 필수`,
        layer: 2,
      };
    }

    // 3. Allow rules
    for (const rule of this.rules) {
      if (rule.action !== "allow") continue;
      if (rule.source && rule.source !== source) continue;
      if (matchGlob(rule.pattern, toolName)) {
        return { decision: "allow", reason: `allow 규칙: ${rule.pattern}`, layer: 3 };
      }
    }

    if (toolModeOverride === "auto" && this.mode !== "strict") {
      return { decision: "allow", reason: "MCP 서버 auto 모드", layer: 4 };
    }

    // 5. Always-allowed (사용자 이전 승인)
    if (this.alwaysAllowed.has(toolName)) {
      return { decision: "allow", reason: "사용자 영구 승인", layer: 5 };
    }

    // 6. Layer 3 — Category × Source × Trust via registry descriptor
    return this.categoryBasedDecision(toolName, trust, resolvedCategory, context);
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
   * Q12 Layer 3 — Category × Source × Mode via registry descriptor.
   *
   * The descriptor's `decisionFor()` returns one of:
   *   - "allow"    → permitted (with audit)
   *   - "ask"      → ApprovalGate round-trip
   *   - "deny"     → refused (used by future restricted categories)
   *   - "reviewer" → defer to Phase 3 reviewer agent (headless lane)
   *   - "override" → meta category — caller reads tool.decisionOverride
   *
   * The Phase 3 reviewer is not yet wired; until it lands, "reviewer"
   * is mapped to "ask" so the user is prompted instead of silently
   * permitting a headless write — fail-safe per design §1 principles.
   *
   * MCP (trust: low) tools are always asked regardless of category —
   * the trust axis still beats the registry decision because MCP has
   * no manifest integrity proxy yet (Phase 4).
   */
  private categoryBasedDecision(
    toolName: string,
    trust: TrustLevel,
    category: ToolCategory,
    context: PermissionCheckContext,
  ): PermissionCheckResult {
    // strict 모드: 모든 것 ask (read 포함)
    if (this.mode === "strict") {
      return {
        decision: "ask",
        reason: `strict 모드 (trust: ${trust}, category: ${category})`,
        layer: 6,
      };
    }

    // LOW trust (MCP): 항상 ask — manifest integrity guard 가 없는 동안 trust override
    if (trust === "low") {
      return {
        decision: "ask",
        reason: `MCP 도구 strict 강제 (trust: low, category: ${category})`,
        layer: 6,
      };
    }

    const descriptor = getToolCategoryDescriptor(category);
    const decision = descriptor.decisionFor({
      mode: this.mode,
      source: trust === "high" ? "builtin" : "plugin",
      headless: context.headless === true,
    });

    switch (decision) {
      case "allow":
        return {
          decision: "allow",
          reason: `${this.mode} 모드 (category: ${category}, trust: ${trust})`,
          layer: 6,
        };
      case "deny":
        return {
          decision: "deny",
          reason: `정책 거부 (category: ${category})`,
          layer: 6,
        };
      case "reviewer":
        // Phase 3 reviewer not yet wired — until then, surface to user.
        // This is the documented temporary mapping per design §1
        // ("Fail-safe defaults"); the reviewer agent ships in Phase 3.
        return {
          decision: "ask",
          reason: `headless ${category} — reviewer agent 미배치, 사용자 컨펌`,
          layer: 6,
        };
      case "override":
        // meta category — executor handles via tool.decisionOverride
        return {
          decision: "allow",
          reason: `meta tool (category: ${category}) — decisionOverride 적용`,
          layer: 6,
        };
      case "ask":
      default:
        return {
          decision: "ask",
          reason: `사용자 컨펌 필요 (category: ${category}, trust: ${trust})`,
          layer: 6,
        };
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
 * Last-resort heuristic when a caller fails to thread the static manifest
 * category through. Production paths supply the manifest category
 * directly; this only fires for legacy or test-only paths that drop the
 * argument. Returns a 5-axis category — `dangerous` is gone.
 */
function classifyToolCategory(toolName: string): ToolCategory {
  const readPatterns = [
    /_(search|list|get|query|status|transcript|sessions|documents|preview|fetch)$/,
    /^web_search$/,
    /^web_fetch$/,
  ];
  if (readPatterns.some((p) => p.test(toolName))) return "read";
  return "write";
}

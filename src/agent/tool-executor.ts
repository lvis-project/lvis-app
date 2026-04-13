/**
 * Tool Executor — tool-governance.md §3 Single Choke Point
 *
 * 8-Step Pipeline (모든 도구 호출은 예외 없이 이 파이프라인을 통과):
 *
 * 1. Lookup       — ToolRegistry.findByName() + source/trust 확인
 * 2. PreHook      — HookRunner.preToolUse() — 입력 검사/변환
 * 3. Permission   — PermissionManager.check(name, source, category)
 * 4. HookOverride — PreHook deny 결과 적용
 * 5. RateLimit    — Trust별 호출 빈도 제한
 * 6. Execute      — tool.execute(args)
 * 7. PostHook     — HookRunner.postToolUse() + DLP 검사
 * 8. Audit+Result — AuditLogger + 결과 반환
 *
 * 불변 규칙:
 * - 우회 불가: 모든 도구는 이 파이프라인을 거침
 * - 감사 필수: Step 8은 에러 시에도 항상 실행
 * - 순서 고정: 1→8 순차
 * - 실패 격리: Step 6 실패가 Step 8을 건너뛰지 않음
 */
import type { ToolRegistry, ToolSource, TrustLevel } from "../core/tool-registry.js";
import { trustFromSource } from "../core/tool-registry.js";
import type { PermissionManager, PermissionCheckResult } from "../core/permission-manager.js";
import { HookRunner } from "./hook-runner.js";
import { AuditLogger } from "./audit-logger.js";
import { maskSensitiveData } from "./dlp-filter.js";
import { BashAstValidator } from "../main/bash-ast-validator.js";

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ToolExecutorCallbacks {
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string, isError: boolean) => void;
}

// ─── Rate Limiter (tool-governance.md §9) ──────────

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

class RateLimiter {
  /** Trust별 분당 제한: high=무제한, medium=60, low=20 */
  private static LIMITS: Record<TrustLevel, number> = { high: Infinity, medium: 60, low: 20 };
  private readonly buckets = new Map<string, RateBucket>();

  check(toolName: string, trust: TrustLevel): { allowed: boolean; remaining: number } {
    const limit = RateLimiter.LIMITS[trust];
    if (limit === Infinity) return { allowed: true, remaining: Infinity };

    const key = `${trust}:${toolName}`;
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: limit, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    // 토큰 리필 (1분당 limit 토큰)
    const elapsed = (now - bucket.lastRefill) / 60_000;
    bucket.tokens = Math.min(limit, bucket.tokens + elapsed * limit);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      return { allowed: false, remaining: 0 };
    }
    bucket.tokens -= 1;
    return { allowed: true, remaining: Math.floor(bucket.tokens) };
  }
}

// ─── Executor ──────────────────────────────────────

export class ToolExecutor {
  private readonly toolRegistry: ToolRegistry;
  private readonly hookRunner: HookRunner;
  private readonly permissionManager?: PermissionManager;
  private readonly auditLogger: AuditLogger;
  private readonly rateLimiter = new RateLimiter();
  private readonly bashAstValidator?: BashAstValidator;

  constructor(
    toolRegistry: ToolRegistry,
    hookRunner?: HookRunner,
    permissionManager?: PermissionManager,
    bashAstValidator?: BashAstValidator,
  ) {
    this.toolRegistry = toolRegistry;
    this.hookRunner = hookRunner ?? new HookRunner();
    this.permissionManager = permissionManager;
    this.auditLogger = new AuditLogger();
    this.bashAstValidator = bashAstValidator;
  }

  getHookRunner(): HookRunner {
    return this.hookRunner;
  }

  /** 복수 tool_use 병렬 실행 — 최대 5개씩 배치 처리 */
  async executeAll(
    toolUses: ToolUseBlock[],
    callbacks?: ToolExecutorCallbacks,
    sessionId?: string,
  ): Promise<ToolResult[]> {
    const BATCH_SIZE = 5;
    if (toolUses.length <= BATCH_SIZE) {
      return Promise.all(toolUses.map((tu) => this.executeOne(tu, callbacks, sessionId)));
    }

    const results: ToolResult[] = [];
    for (let i = 0; i < toolUses.length; i += BATCH_SIZE) {
      const batch = toolUses.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map((tu) => this.executeOne(tu, callbacks, sessionId)));
      results.push(...batchResults);
    }
    return results;
  }

  /** 단일 도구 — 8단계 파이프라인 (Single Choke Point) */
  private async executeOne(
    toolUse: ToolUseBlock,
    callbacks?: ToolExecutorCallbacks,
    sessionId?: string,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    let permissionResult: PermissionCheckResult | undefined;
    let source: ToolSource = "builtin";
    let trust: TrustLevel = "high";

    // ── Step 1: Lookup + source/trust 확인 ──────────
    const tool = this.toolRegistry.findByName(toolUse.name);
    if (!tool) {
      this.auditToolCall(sessionId, toolUse.name, "builtin", "high", toolUse.input, "도구 없음", true, startTime, { decision: "deny", reason: "도구 없음", layer: 0 }, Infinity);
      return { tool_use_id: toolUse.id, content: `도구를 찾을 수 없습니다: ${toolUse.name}`, is_error: true };
    }
    source = tool.source;
    trust = trustFromSource(source);

    // ── Step 2: PreToolUse Hook ─────────────────────
    const preResult = await this.hookRunner.runPreHooks({
      toolName: toolUse.name,
      toolInput: toolUse.input,
    });

    // ── Step 2.5: Bash AST Pre-Validator ────────────
    if (this.bashAstValidator) {
      const bashResult = this.bashAstValidator.validate(toolUse.name, toolUse.input);
      if (bashResult.decision === "deny") {
        const msg = `[Bash AST 차단] ${bashResult.reason} (pattern: ${bashResult.patternId})`;
        callbacks?.onToolStart?.(toolUse.name, toolUse.input);
        callbacks?.onToolEnd?.(toolUse.name, msg, true);
        this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, { decision: "deny", reason: bashResult.reason ?? "bash AST", layer: 0 }, Infinity);
        return { tool_use_id: toolUse.id, content: msg, is_error: true };
      }
      if (bashResult.decision === "warn") {
        console.warn(`[Bash AST 경고] ${bashResult.reason}`);
      }
    }

    // ── Step 3: Permission (source-aware) ───────────
    if (this.permissionManager) {
      permissionResult = this.permissionManager.checkDetailed(toolUse.name, source, tool.category);
      if (permissionResult.decision === "deny") {
        const msg = `[권한 차단] 도구 '${toolUse.name}' (${source}, trust:${trust}) — ${permissionResult.reason}`;
        callbacks?.onToolStart?.(toolUse.name, toolUse.input);
        callbacks?.onToolEnd?.(toolUse.name, msg, true);
        this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
        return { tool_use_id: toolUse.id, content: msg, is_error: true };
      }
      if (permissionResult.decision === "ask") {
        // H2 fix: MCP 도구는 UI 승인 구현 전까지 deny (보안 우선)
        if (source === "mcp") {
          const msg = `[MCP 보안] 도구 '${toolUse.name}' — 승인 UI 미구현으로 차단. ${permissionResult.reason}`;
          console.warn(msg);
          callbacks?.onToolStart?.(toolUse.name, toolUse.input);
          callbacks?.onToolEnd?.(toolUse.name, msg, true);
          this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
          return { tool_use_id: toolUse.id, content: msg, is_error: true };
        }
        // Builtin/Plugin: 경고 후 허용 (향후 UI 승인 대화상자 연동)
        console.log(`[PermissionManager] '${toolUse.name}' (${source}) — ask: ${permissionResult.reason}`);
      }
    }

    // ── Step 4: Hook Override ───────────────────────
    if (preResult.action === "deny") {
      const msg = `[훅 차단] ${preResult.reason ?? "PreToolUse 훅에 의해 차단됨"}`;
      callbacks?.onToolStart?.(toolUse.name, toolUse.input);
      callbacks?.onToolEnd?.(toolUse.name, msg, true);
      this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
      return { tool_use_id: toolUse.id, content: msg, is_error: true };
    }

    const finalInput = preResult.action === "modify" && preResult.updatedInput
      ? preResult.updatedInput
      : toolUse.input;

    // ── Step 5: Rate Limit (trust별) ────────────────
    const rateResult = this.rateLimiter.check(toolUse.name, trust);
    if (!rateResult.allowed) {
      const msg = `[속도 제한] 도구 '${toolUse.name}' (trust:${trust}) 호출 빈도 초과. 잠시 후 다시 시도해주세요.`;
      callbacks?.onToolStart?.(toolUse.name, finalInput);
      callbacks?.onToolEnd?.(toolUse.name, msg, true);
      this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, 0);
      return { tool_use_id: toolUse.id, content: msg, is_error: true };
    }

    callbacks?.onToolStart?.(toolUse.name, finalInput);

    // ── Step 6: Execute ─────────────────────────────
    let content: string;
    let isError = false;

    try {
      const result = await tool.execute(finalInput);
      content = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      content = err instanceof Error ? err.message : "알 수 없는 도구 실행 오류";
      isError = true;
    }

    // ── Step 7: PostHook + Feedback Merge ───────────
    const postFeedback = await this.hookRunner.runPostHooks({
      toolName: toolUse.name,
      toolInput: finalInput,
      toolOutput: content,
      isError,
    });

    if (postFeedback) content = `${content}\n\n[Hook Feedback]\n${postFeedback}`;
    if (preResult.feedback) content = `${content}\n\n[Pre-Hook Note]\n${preResult.feedback}`;

    // ── Step 7b: DLP 민감 데이터 마스킹 ────────────
    const dlpResult = maskSensitiveData(content);
    if (dlpResult.detections.length > 0) {
      content = dlpResult.masked;
      console.warn(
        `[DLP] 민감 데이터 탐지 및 마스킹 — 도구: '${toolUse.name}', 패턴: ${dlpResult.detections.join(", ")}`,
      );
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "unknown",
        type: "tool_call",
        input: JSON.stringify(finalInput).slice(0, 500),
        output: `[DLP 마스킹 적용] 패턴: ${dlpResult.detections.join(", ")}`,
        toolCalls: [{
          name: toolUse.name,
          isError: false,
          source,
          trust,
          executionTimeMs: Date.now() - startTime,
          permissionDecision: "dlp_masked",
          permissionReason: `탐지된 패턴: ${dlpResult.detections.join(", ")}`,
        }],
      });
    }

    // ── Step 8: Audit + Result (항상 실행) ──────────
    callbacks?.onToolEnd?.(toolUse.name, content, isError);
    this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, content, isError, startTime, permissionResult, rateResult.remaining);

    return { tool_use_id: toolUse.id, content, ...(isError && { is_error: true }) };
  }

  // ─── Audit (불변 — 항상 실행) ────────────────────

  private auditToolCall(
    sessionId: string | undefined,
    toolName: string,
    source: ToolSource,
    trust: TrustLevel,
    input: Record<string, unknown>,
    output: string,
    isError: boolean,
    startTime: number,
    permission: PermissionCheckResult | undefined,
    rateLimitRemaining: number,
  ): void {
    try {
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "unknown",
        type: "tool_call",
        input: JSON.stringify(input).slice(0, 500),
        output: output.slice(0, 1024),
        toolCalls: [{
          name: toolName,
          isError,
          source,
          trust,
          executionTimeMs: Date.now() - startTime,
          permissionDecision: permission?.decision ?? "allow",
          permissionReason: permission?.reason,
          rateLimitRemaining,
        }],
      });
    } catch {
      // 감사 실패가 도구 실행을 차단하면 안 됨
    }
  }
}

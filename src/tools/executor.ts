/**
 * Tool Executor — tool-governance.md §3 Single Choke Point
 *
 * 8-Step Pipeline (모든 도구 호출은 예외 없이 이 파이프라인을 통과):
 *
 * 1. Lookup       — ToolRegistry.findByName() + source/trust 확인
 * 2. PreHook      — HookRunner.preToolUse() — 입력 검사/변환
 * 3. Permission   — PermissionManager.checkDetailed(name, source, category, proactiveOrigin)
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
import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import type { ToolRegistry } from "./registry.js";
import type {
  ToolSource,
  TrustLevel,
  ToolExecutionContext,
} from "./types.js";
import { trustFromSource } from "./types.js";
import type { PermissionManager, PermissionCheckResult } from "../permissions/permission-manager.js";
import type { ApprovalGate, ApprovalMode } from "../permissions/approval-gate.js";
import { isSensitivePath, canonicalizePathForMatch } from "../permissions/sensitive-paths.js";
import { HookRunner } from "../hooks/hook-runner.js";
import { AuditLogger } from "../audit/audit-logger.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import { BashAstValidator } from "../main/bash-ast-validator.js";

export interface ToolCallMeta {
  groupId: string;
  toolUseId: string;
  displayOrder: number;
}

// ─── C1: Sensitive-path + read-only hint extraction ────────

/**
 * Static list of tool names known to perform only read operations.
 * Used by {@link ToolExecutor} to set `isReadOnly` on ApprovalRequest so
 * the §S4 approval-gate short-circuit can auto-approve (except in plan mode).
 * Conservative: tools not listed here are treated as state-mutating.
 */
const READ_ONLY_TOOL_NAMES = new Set<string>([
  "read_file",
  "glob",
  "grep",
  "knowledge_search",
  "list_directory",
  "file_read",
  "web_fetch",
]);

/**
 * Extract an absolute filesystem target path from a tool's input, if one
 * can be inferred from common arg shapes. Used so {@link ApprovalGate}'s
 * §S1 sensitive-path hard-block can actually run against the path the
 * tool is about to touch. Returns `undefined` if no recognizable path
 * field is present (e.g. bash `command`, which is handled separately
 * by the BashAstValidator).
 */
function extractTargetFilePath(
  _toolName: string,
  input: unknown,
): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const obj = input as Record<string, unknown>;
  const candidate =
    (typeof obj.path === "string" && obj.path) ||
    (typeof obj.file_path === "string" && obj.file_path) ||
    (typeof obj.filePath === "string" && obj.filePath) ||
    undefined;
  if (!candidate) return undefined;
  try {
    return pathResolve(candidate);
  } catch {
    return undefined;
  }
}

/**
 * H3: Redact every `freeText` field from an `ask_user_question` tool
 * result before it is written to the audit log. Result shape (one card,
 * 1–4 questions):
 *   {"answers":[{"choice":"…"},{"freeText":"…"}],"dismissed":false}
 * We keep choice/dismissed but replace each non-empty freeText with a
 * placeholder so user-typed PII never lands in the audit trail. Falls
 * back to the original content when JSON parsing fails (e.g. error
 * responses).
 */
function redactAskUserAuditOutput(rawOutput: string): string {
  try {
    const parsed = JSON.parse(rawOutput) as Record<string, unknown>;
    const answers = Array.isArray(parsed.answers) ? (parsed.answers as unknown[]) : null;
    if (!answers) return rawOutput;
    let touched = false;
    const redacted = answers.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const a = entry as Record<string, unknown>;
      if (typeof a.freeText === "string" && a.freeText.length > 0) {
        touched = true;
        return { ...a, freeText: `[redacted ${a.freeText.length} chars]` };
      }
      return a;
    });
    if (!touched) return rawOutput;
    return JSON.stringify({ ...parsed, answers: redacted });
  } catch {
    return rawOutput;
  }
}

export interface ToolUseBlock {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
  /** MCP Apps spec §3.2 — optional UI payload from MCP tool response. */
  uiPayload?: import("../mcp/types.js").McpUiPayload;
}

export interface ToolExecutorCallbacks {
  onToolStart?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta) => void;
  onToolEnd?: (name: string, result: string, isError: boolean, meta: ToolCallMeta, uiPayload?: import("../mcp/types.js").McpUiPayload) => void;
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
  private readonly approvalGate?: ApprovalGate;
  private readonly auditLogger: AuditLogger;
  private readonly rateLimiter = new RateLimiter();
  private readonly bashAstValidator?: BashAstValidator;

  constructor(
    toolRegistry: ToolRegistry,
    hookRunner?: HookRunner,
    permissionManager?: PermissionManager,
    bashAstValidator?: BashAstValidator,
    approvalGate?: ApprovalGate,
  ) {
    this.toolRegistry = toolRegistry;
    this.hookRunner = hookRunner ?? new HookRunner();
    this.permissionManager = permissionManager;
    this.approvalGate = approvalGate;
    this.auditLogger = new AuditLogger();
    this.bashAstValidator = bashAstValidator;
  }

  /**
   * C1: convert the PermissionManager execution mode into the ApprovalMode
   * vocabulary understood by ApprovalGate (§S4 read-only short-circuit).
   * `strict` → `default` (show dialog); `auto` → `full_auto`; `default` → `default`.
   */
  private currentApprovalMode(): ApprovalMode {
    const pm = this.permissionManager?.getMode?.();
    if (pm === "auto") return "full_auto";
    // strict + default both map to "default" — plan mode is not yet wired
    // through the PermissionManager and must be requested explicitly.
    return "default";
  }

  getHookRunner(): HookRunner {
    return this.hookRunner;
  }

  /** 복수 tool_use 병렬 실행 — 최대 5개씩 배치 처리.
   *
   * `proactiveOrigin` (예: `"proactive:meeting-detection"`) 가 set 이면
   * 모든 write/dangerous 호출이 사용자 영구 승인을 우회해 ask 로 강제됨
   * (PermissionManager.checkDetailed 의 새 가드). Brain 트리거가 자동
   * 실행되는 destructive 작업 차단막.
   */
  async executeAll(
    toolUses: ToolUseBlock[],
    callbacks?: ToolExecutorCallbacks,
    sessionId?: string,
    proactiveOrigin?: string | null,
    /**
     * C3(b): forwarded into each executeOne's ToolExecutionContext.metadata
     * so the `agent_spawn` tool can detect it is being invoked from inside
     * an already-spawned sub-agent and refuse to recurse.
     */
    spawnDepth?: number,
    /**
     * Per-turn abort signal. Threaded into each tool's ToolExecutionContext
     * so long-blocking tools (e.g. `ask_user_question`) can honor the user's
     * "중단" button. Without this the turn stays stuck on a pending tool
     * even though the streaming side has already been aborted.
     */
    abortSignal?: AbortSignal,
  ): Promise<ToolResult[]> {
    const groupId = randomUUID();
    const BATCH_SIZE = 5;
    if (toolUses.length <= BATCH_SIZE) {
      return Promise.all(toolUses.map((tu, idx) => this.executeOne(tu, groupId, idx, callbacks, sessionId, proactiveOrigin, spawnDepth, abortSignal)));
    }

    const results: ToolResult[] = [];
    for (let i = 0; i < toolUses.length; i += BATCH_SIZE) {
      const batch = toolUses.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map((tu, batchIdx) => this.executeOne(tu, groupId, i + batchIdx, callbacks, sessionId, proactiveOrigin, spawnDepth, abortSignal)));
      results.push(...batchResults);
    }
    return results;
  }

  /** 단일 도구 — 8단계 파이프라인 (Single Choke Point) */
  private async executeOne(
    toolUse: ToolUseBlock,
    groupId: string,
    displayOrder: number,
    callbacks?: ToolExecutorCallbacks,
    sessionId?: string,
    proactiveOrigin?: string | null,
    spawnDepth?: number,
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const meta: ToolCallMeta = { groupId, toolUseId: toolUse.id, displayOrder };
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
        callbacks?.onToolStart?.(toolUse.name, toolUse.input, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta);
        this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, { decision: "deny", reason: bashResult.reason ?? "bash AST", layer: 0 }, Infinity);
        return { tool_use_id: toolUse.id, content: msg, is_error: true };
      }
      if (bashResult.decision === "warn") {
        console.warn(`[Bash AST 경고] ${bashResult.reason}`);
      }
    }

    // ── Step 3: Permission (source-aware) ───────────
    //
    // C1 fix: `ask_user_question` is itself the "ask the user" intent — the
    // tool fires its own AskUserQuestionCard on the renderer. If we route
    // it through ApprovalGate as well, the user sees TWO modals back-to-
    // back ("approve this tool?" then the actual question). Short-circuit
    // permission for this single tool BEFORE PermissionManager runs so the
    // approval modal never gets requested. Allowed because:
    //   1. The tool only emits a renderer card and awaits user input — it
    //      never mutates state on its own.
    //   2. The user is always the explicit decision-maker for the tool's
    //      effect (the question itself), so a separate "may I ask?" modal
    //      is redundant.
    //   3. The tool's permission category="dangerous" still applies to the
    //      audit log (Step 8) so we keep visibility into its calls.
    const isAskUserQuestionShortCircuit =
      toolUse.name === "ask_user_question" && source === "builtin";
    if (this.permissionManager && !isAskUserQuestionShortCircuit) {
      permissionResult = this.permissionManager.checkDetailed(toolUse.name, source, tool.category, proactiveOrigin);
      if (permissionResult.decision === "deny") {
        const msg = `[권한 차단] 도구 '${toolUse.name}' (${source}, trust:${trust}) — ${permissionResult.reason}`;
        callbacks?.onToolStart?.(toolUse.name, toolUse.input, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta);
        this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
        return { tool_use_id: toolUse.id, content: msg, is_error: true };
      }
      if (permissionResult.decision === "ask") {
        if (this.approvalGate) {
          // §6.3 Layer 3 + §8: 렌더러 승인 모달로 round-trip
          // C1: wire target.filePath + isReadOnly + mode so that §S1
          // sensitive-path hard-block and §S4 read-only short-circuit
          // actually fire. Previously these were missing → §S1 check
          // read `undefined` and was effectively dead code.
          const targetFilePath = extractTargetFilePath(toolUse.name, toolUse.input);
          const sensitivePathPattern = targetFilePath
            ? isSensitivePath(canonicalizePathForMatch(targetFilePath))
            : null;
          const approvalRequest = {
            id: randomUUID(),
            category: "tool" as const,
            toolName: toolUse.name,
            args: toolUse.input,
            reason: permissionResult.reason,
            source: source as "builtin" | "plugin" | "mcp",
            createdAt: Date.now(),
            ...(targetFilePath ? { target: { filePath: targetFilePath } } : {}),
            isReadOnly: READ_ONLY_TOOL_NAMES.has(toolUse.name),
            mode: this.currentApprovalMode(),
            sensitivePathPattern,
          };

          // §F3: requestAndWait 실패 시 감사 로그 보장 후 deny-once 처리
          let decision;
          try {
            decision = await this.approvalGate.requestAndWait(approvalRequest);
          } catch (approvalErr) {
            const msg = `[승인 오류] 도구 '${toolUse.name}' — 승인 게이트 내부 오류: ${approvalErr instanceof Error ? approvalErr.message : String(approvalErr)}`;
            callbacks?.onToolStart?.(toolUse.name, toolUse.input, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta);
            this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
            return { tool_use_id: toolUse.id, content: msg, is_error: true };
          }

          if (decision.choice.startsWith("deny")) {
            // deny-always: 영구 거부 규칙 추가
            if (decision.choice === "deny-always" && this.permissionManager) {
              const pattern = decision.rememberPattern ?? toolUse.name;
              await this.permissionManager.addAlwaysDeniedPersist(pattern);
            }
            const msg = `[승인 거부] 도구 '${toolUse.name}' — 사용자가 실행을 거부했습니다.`;
            callbacks?.onToolStart?.(toolUse.name, toolUse.input, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta);
            this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
            return { tool_use_id: toolUse.id, content: msg, is_error: true };
          }

          // allow-always: 영구 허용 규칙 추가
          if (decision.choice === "allow-always" && this.permissionManager) {
            const pattern = decision.rememberPattern ?? toolUse.name;
            await this.permissionManager.addAlwaysAllowedPersist(pattern);
          }
          // allow-once / allow-always: 실행 계속
        } else {
          // §F4: approvalGate 미연결 시 fail-closed — 모든 ask 결정을 차단
          const msg = `[승인 게이트 미연결] 도구 '${toolUse.name}' (${source}) — ask 결정이지만 승인 게이트가 없어 차단. ${permissionResult.reason}`;
          console.error(msg);
          callbacks?.onToolStart?.(toolUse.name, toolUse.input, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta);
          this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
          return { tool_use_id: toolUse.id, content: msg, is_error: true };
        }
      }
    }

    // ── Step 4: Hook Override ───────────────────────
    if (preResult.action === "deny") {
      const msg = `[훅 차단] ${preResult.reason ?? "PreToolUse 훅에 의해 차단됨"}`;
      callbacks?.onToolStart?.(toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta);
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
      callbacks?.onToolStart?.(toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta);
      this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, 0);
      return { tool_use_id: toolUse.id, content: msg, is_error: true };
    }

    callbacks?.onToolStart?.(toolUse.name, finalInput, meta);

    // ── Step 6: Execute ─────────────────────────────
    let content: string;
    let isError = false;
    let uiPayload: import("../mcp/types.js").McpUiPayload | undefined;

    const executionContext: ToolExecutionContext = {
      cwd: process.cwd(),
      metadata: {
        sessionId: sessionId ?? "unknown",
        // C3(b): spawn depth visible to tools — `agent_spawn` reads this
        // and refuses when >= 1 (a sub-agent cannot itself spawn).
        spawnDepth: spawnDepth ?? 0,
      },
      abortSignal,
    };

    try {
      const result = await tool.execute(finalInput, executionContext);
      content = result.output;
      isError = result.isError;
      // MCP Apps §3.2 — propagate uiPayload from tool metadata
      if (result.metadata?.uiPayload) {
        uiPayload = result.metadata.uiPayload as import("../mcp/types.js").McpUiPayload;
      }
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
    callbacks?.onToolEnd?.(toolUse.name, content, isError, meta, uiPayload);
    // H3: redact the user's freeText answer before it lands in the audit
    // log. The DLP filter at Step 7b only catches structured patterns
    // (emails, IDs); a free-form answer ("내 비밀번호는 …") wouldn't match
    // any pattern but is still PII the user typed in. For ask_user_question
    // specifically, the LLM doesn't need the raw text in audit — provenance
    // (the question + that the user replied) is what matters.
    //
    // R2-CR-4: gate on `source === "builtin"` (mirrors the C1 short-circuit
    // pattern at Step 3). Otherwise a plugin/MCP tool that happens to be
    // named `ask_user_question` would have its `freeText` field blindly
    // replaced — a name collision should not trigger host-level redaction.
    const auditContent =
      toolUse.name === "ask_user_question" && source === "builtin" && !isError
        ? redactAskUserAuditOutput(content)
        : content;
    this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, auditContent, isError, startTime, permissionResult, rateResult.remaining);

    return { tool_use_id: toolUse.id, content, ...(isError && { is_error: true }), ...(uiPayload && { uiPayload }) };
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

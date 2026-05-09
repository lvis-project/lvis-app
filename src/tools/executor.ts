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
  ToolCategory,
  ToolExecutionContext,
} from "./types.js";
import { trustFromSource } from "./types.js";
import type { PermissionManager, PermissionCheckResult } from "../permissions/permission-manager.js";
import type { ApprovalGate, ApprovalMode } from "../permissions/approval-gate.js";
import { isSensitivePath, canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";
import {
  buildAllowedScope,
  isPathAllowed,
  pickClosestParent,
  validateDirectoryAddition,
} from "../permissions/allowed-directories.js";
import { HookRunner } from "../hooks/hook-runner.js";
import { AuditLogger } from "../audit/audit-logger.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import { BashAstValidator } from "../main/bash-ast-validator.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("executor");

export interface ToolCallMeta {
  groupId: string;
  toolUseId: string;
  displayOrder: number;
}

// ─── C1: Sensitive-path + invocation category extraction ────────

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

function resolveInvocationCategory(
  tool: import("./base.js").Tool,
  finalInput: Record<string, unknown>,
): ToolCategory {
  // Q12 5-axis: meta / shell / network are first-class manifest categories
  // and bypass the read/write input-aware probe. Only `write` (the default)
  // and `read` are derived from the tool's runtime self-classification.
  if (tool.category === "meta") return "meta";
  if (tool.category === "shell") return "shell";
  if (tool.category === "network") return "network";

  // Trust boundary: plugin tools must NOT decide their own policy axis at
  // invocation time. The plugin's `isReadOnly()` runs plugin-controlled code
  // and could falsely classify a write operation as read to bypass approval.
  // For plugins, the static manifest `category` (validated at install time
  // via manifest-validation.ts) is the only authoritative signal.
  if (tool.source === "plugin") {
    return tool.category === "read" ? "read" : "write";
  }
  // Built-in tools: input-aware classification is safe — host code is trusted.
  try {
    return tool.isReadOnly(finalInput) ? "read" : "write";
  } catch (err) {
    log.warn(
      "tool '%s' isReadOnly(input) failed — treating invocation as write: %s",
      tool.name,
      err instanceof Error ? err.message : String(err),
    );
    return "write";
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
  /**
   * Wall-clock time spent inside this tool's handler (Step 6) plus any
   * pipeline overhead measured from Step 1's start. Surfaced on every
   * tool_end emission so the renderer can display per-tool execution
   * cost (`⏱ 1.4s`) inside ToolGroupCard.
   *
   * Always present — including on early-aborts (deny/rate-limit/error)
   * so the UI never has a "missing" timer for a tool the user saw run.
   */
  durationMs: number;
}

export interface ToolExecutorCallbacks {
  onToolStart?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta) => void;
  /**
   * Fired after Step 7b (DLP) and Step 8 (audit) for both success and
   * failure paths. `durationMs` is wall-clock from Step 1 start to the
   * moment the result is finalized — used by the renderer to show
   * per-tool execution cost (`⏱ 1.4s`) on each ToolGroupCard row.
   */
  onToolEnd?: (
    name: string,
    result: string,
    isError: boolean,
    meta: ToolCallMeta,
    uiPayload: import("../mcp/types.js").McpUiPayload | undefined,
    durationMs: number,
  ) => void;
}

export interface ToolPermissionContext {
  headless?: boolean;
  allowedPluginIds?: ReadonlySet<string>;
  /**
   * Q12 P2.5 — Layer 1 path policy. User-configured directories from
   * `permissions.additionalDirectories` in settings.json. Boot threads
   * this through every executeAll() invocation. The executor merges with
   * computed defaults via {@link buildAllowedScope}; an `undefined` value
   * here means "use defaults only" (NOT "silent allow").
   */
  additionalDirectories?: readonly string[];
  /**
   * Q12 P2.5 §9 — trust origin classification carried with each tool
   * invocation. Audited and propagated into approval-request payloads.
   * Distinguishes user-keyboard input (trusted) from system / plugin /
   * proactive (untrusted) origins. Defaults to "user" when unset.
   */
  trustOrigin?: "user" | "system" | "plugin" | "proactive" | "routine" | "agent";
}

/**
 * Q12 Phase 2 — bundled execution options for {@link ToolExecutor.executeAll}
 * and {@link ToolExecutor.executeOne}. Replaces the legacy 9-positional-arg
 * shape so adding a new pipeline-wide concern (per-turn telemetry, audit
 * correlation id, …) doesn't ripple through every callsite. All fields
 * are optional; an empty object is the canonical "default everything"
 * invocation.
 */
export interface ExecuteOptions {
  callbacks?: ToolExecutorCallbacks;
  sessionId?: string;
  /**
   * Brain proactive origin tag (e.g. `"proactive:meeting-detection"`).
   * When set, write/shell/network tools force ApprovalGate `ask` and
   * bypass the user's `allow-always` cache.
   */
  proactiveOrigin?: string | null;
  /**
   * Sub-agent recursion depth — `agent_spawn` refuses when ≥1 so a
   * sub-agent cannot itself spawn (defense-in-depth on top of the
   * SubAgentRunner registry strip).
   */
  spawnDepth?: number;
  abortSignal?: AbortSignal;
  permissionContext?: ToolPermissionContext;
}

function maskDisplayValue(value: unknown): unknown {
  if (typeof value === "string") {
    return maskSensitiveData(value).masked;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskDisplayValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, maskDisplayValue(item)]),
    );
  }
  return value;
}

function maskToolInputForDisplay(input: Record<string, unknown>): Record<string, unknown> {
  return maskDisplayValue(input) as Record<string, unknown>;
}

function emitToolStart(
  callbacks: ToolExecutorCallbacks | undefined,
  name: string,
  input: Record<string, unknown>,
  meta: ToolCallMeta,
): void {
  callbacks?.onToolStart?.(name, maskToolInputForDisplay(input), meta);
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
   * 모든 write/shell/network 호출이 사용자 영구 승인을 우회해 ask 로 강제됨
   * (PermissionManager.checkDetailed 의 새 가드). Brain 트리거가 자동
   * 실행되는 destructive 작업 차단막.
   *
   * Q12 Phase 2: {@link ExecuteOptions} bundle replaces the legacy 7
   * positional args so adding a new pipeline concern doesn't ripple
   * through every callsite.
   */
  async executeAll(
    toolUses: ToolUseBlock[],
    opts: ExecuteOptions = {},
  ): Promise<ToolResult[]> {
    const groupId = randomUUID();
    const BATCH_SIZE = 5;
    if (toolUses.length <= BATCH_SIZE) {
      return Promise.all(toolUses.map((tu, idx) => this.executeOne(tu, groupId, idx, opts)));
    }

    const results: ToolResult[] = [];
    for (let i = 0; i < toolUses.length; i += BATCH_SIZE) {
      const batch = toolUses.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map((tu, batchIdx) => this.executeOne(tu, groupId, i + batchIdx, opts)));
      results.push(...batchResults);
    }
    return results;
  }

  /** 단일 도구 — 8단계 파이프라인 (Single Choke Point) */
  private async executeOne(
    toolUse: ToolUseBlock,
    groupId: string,
    displayOrder: number,
    opts: ExecuteOptions = {},
  ): Promise<ToolResult> {
    const {
      callbacks,
      sessionId,
      proactiveOrigin,
      spawnDepth,
      abortSignal,
      permissionContext,
    } = opts;
    const startTime = Date.now();
    const meta: ToolCallMeta = { groupId, toolUseId: toolUse.id, displayOrder };
    let permissionResult: PermissionCheckResult | undefined;
    let source: ToolSource = "builtin";
    let trust: TrustLevel = "high";

    // ── Step 1: Lookup + source/trust 확인 ──────────
    const tool = this.toolRegistry.findByName(toolUse.name);
    if (!tool) {
      const durationMs = Date.now() - startTime;
      this.auditToolCall(sessionId, toolUse.name, "builtin", "high", toolUse.input, "도구 없음", true, startTime, { decision: "deny", reason: "도구 없음", layer: 0 }, Infinity);
      callbacks?.onToolEnd?.(toolUse.name, `도구를 찾을 수 없습니다: ${toolUse.name}`, true, meta, undefined, durationMs);
      return { tool_use_id: toolUse.id, content: `도구를 찾을 수 없습니다: ${toolUse.name}`, is_error: true, durationMs };
    }
    source = tool.source;
    trust = trustFromSource(source);

    // ── Step 2: PreToolUse Hook ─────────────────────
    const preResult = await this.hookRunner.runPreHooks({
      toolName: toolUse.name,
      toolInput: toolUse.input,
    });

    if (preResult.action === "deny") {
      const msg = `[훅 차단] ${preResult.reason ?? "PreToolUse 훅에 의해 차단됨"}`;
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    }

    const finalInput = preResult.action === "modify" && preResult.updatedInput
      ? preResult.updatedInput
      : toolUse.input;

    // ── Step 2.5: Bash AST Pre-Validator ────────────
    //
    // Hooks are allowed to rewrite tool inputs. Validate the final invocation,
    // not the original provider payload, so a hook cannot approve one command
    // and execute another.
    if (this.bashAstValidator) {
      const bashResult = this.bashAstValidator.validate(toolUse.name, finalInput);
      if (bashResult.decision === "deny") {
        const msg = `[Bash AST 차단] ${bashResult.reason} (pattern: ${bashResult.patternId})`;
        const durationMs = Date.now() - startTime;
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { decision: "deny", reason: bashResult.reason ?? "bash AST", layer: 0 }, Infinity);
        return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
      }
      if (bashResult.decision === "warn") {
        log.warn(`${bashResult.reason}`);
      }
    }

    const invocationCategory = resolveInvocationCategory(tool, finalInput);
    const targetFilePath = extractTargetFilePath(toolUse.name, finalInput);
    // Q12 P2.5 — frozen-canonical contract: canonicalize ONCE here and
    // reuse the same string for Layer 0 (sensitive-path) + Layer 1
    // (allowed-directories) checks below. No layer re-resolves the path.
    const canonicalTargetPath = targetFilePath
      ? caseFoldForMatch(canonicalizePathForMatch(targetFilePath))
      : null;
    const sensitivePathPattern = canonicalTargetPath
      ? isSensitivePath(canonicalTargetPath)
      : null;

    if (source === "plugin" && permissionContext?.allowedPluginIds) {
      const pluginAllowed = !!tool.pluginId && permissionContext.allowedPluginIds.has(tool.pluginId);
      if (!pluginAllowed) {
        const msg = `[권한 차단] 플러그인 도구 '${toolUse.name}' — 현재 실행 scope 밖의 pluginId=${tool.pluginId ?? "(unknown)"}`;
        const durationMs = Date.now() - startTime;
        const blockedPermission: PermissionCheckResult = {
          decision: "deny",
          reason: "plugin tool outside active allowed plugin scope",
          layer: 0,
        };
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity);
        return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
      }
    }

    if (sensitivePathPattern) {
      const msg = `[민감 경로 차단] 도구 '${toolUse.name}' (${source}) — ${targetFilePath} matches ${sensitivePathPattern}`;
      const durationMs = Date.now() - startTime;
      const blockedPermission: PermissionCheckResult = {
        decision: "deny",
        reason: `sensitive path hard-block: ${sensitivePathPattern}`,
        layer: 0,
        denyReasons: [
          { layer: 0, reason: "sensitive-path", source: "sensitive-paths" },
        ],
      };
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity);
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    }

    // ── Step 2.6: Layer 1 (Q12 P2.5) — Allowed Directories ─────
    //
    // Frozen-canonical: reuse `canonicalTargetPath` from above (already
    // realpath'd + case-folded). No re-canonicalization in this block.
    //
    // Skipped when no path-typed input was extracted (e.g. bash, MCP
    // network calls). Phase 4 will widen `extractTargetFilePath` to
    // honor `manifest.toolSchemas[*].pathFields`; for now the 3-field
    // extractor (path|file_path|filePath) is the coverage frontier.
    if (canonicalTargetPath) {
      const allowedScope = buildAllowedScope(permissionContext?.additionalDirectories);
      const inAllowed = isPathAllowed(canonicalTargetPath, allowedScope);
      if (!inAllowed) {
        const headless = permissionContext?.headless === true;
        const trustOrigin = permissionContext?.trustOrigin ?? "user";
        const validation = validateDirectoryAddition(canonicalTargetPath);
        const suggestedParent = pickClosestParent(
          canonicalTargetPath,
          allowedScope.directories,
        );
        const dirLayerResult: PermissionCheckResult = {
          decision: headless ? "ask" : "ask",
          reason: `out-of-allowed-dir: ${targetFilePath} (not in additionalDirectories)`,
          layer: 1,
          denyReasons: [
            {
              layer: 1,
              reason: "out-of-allowed-dir",
              source: "directory-policy",
            },
          ],
        };

        if (this.approvalGate && !headless) {
          // Interactive mode — dispatch directory-confirm modal. The
          // renderer routes on `kind === "out-of-allowed-dir"` to the
          // OutOfAllowedDirCard variant.
          const adjacencyWarnings = validation.adjacencyWarnings;
          const approvalRequest = {
            id: randomUUID(),
            category: "tool" as const,
            kind: "out-of-allowed-dir" as const,
            toolName: toolUse.name,
            args: finalInput,
            reason: dirLayerResult.reason,
            source: source as "builtin" | "plugin" | "mcp",
            createdAt: Date.now(),
            ...(targetFilePath ? { target: { filePath: targetFilePath } } : {}),
            isReadOnly: invocationCategory === "read",
            mode: this.currentApprovalMode(),
            sensitivePathPattern,
            outOfAllowedDir: {
              candidatePath: targetFilePath ?? canonicalTargetPath,
              suggestedParent,
              currentAllowed: allowedScope.directories,
              adjacencyWarnings,
            },
            trustOrigin,
          };

          let decision;
          try {
            decision = await this.approvalGate.requestAndWait(approvalRequest);
          } catch (approvalErr) {
            const msg = `[디렉토리 정책 오류] 도구 '${toolUse.name}' — ${approvalErr instanceof Error ? approvalErr.message : String(approvalErr)}`;
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, dirLayerResult, Infinity);
            return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
          }

          if (decision.choice.startsWith("deny")) {
            const msg = `[디렉토리 정책 차단] 도구 '${toolUse.name}' — 사용자가 허용 디렉토리 외부 경로 접근을 거부했습니다 (${targetFilePath}).`;
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity);
            return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
          }
          // allow-once / allow-always — fall through to Step 3
          // (full Layer 3 check still runs; Layer 1 is necessary, not
          // sufficient).
        } else if (headless) {
          // Headless mode — Phase 3 will route to the reviewer agent.
          // For Phase 2.5 we map "reviewer" to "ask" but ApprovalGate
          // is not connected; fail-closed is the safe stance.
          const msg = `[디렉토리 정책 차단 — headless] 도구 '${toolUse.name}' (${source}) — 허용 디렉토리 외부 경로 (${targetFilePath}). Phase 3 reviewer 미적용 단계 → fail-closed.`;
          const durationMs = Date.now() - startTime;
          log.warn(msg);
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity);
          return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
        } else {
          // §F4 mirror — approvalGate미연결 시 fail-closed.
          const msg = `[승인 게이트 미연결 — Layer 1] 도구 '${toolUse.name}' (${source}) — 허용 디렉토리 외부 경로이지만 승인 게이트가 없어 차단.`;
          const durationMs = Date.now() - startTime;
          log.error(msg);
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity);
          return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
        }
      }
    }

    // ── Step 3: Permission (source-aware) ───────────
    //
    // Q12 Layer 3 — `meta` category tools take an explicit decisionOverride
    // path instead of running the standard matrix:
    //
    //   `always-allow-with-audit` (e.g. ask_user_question)
    //     The tool IS the "ask the user" intent — it fires its own
    //     AskUserQuestionCard. Running it through ApprovalGate would show
    //     the user two modals back-to-back ("approve this tool?" then the
    //     actual question). Short-circuit BEFORE PermissionManager runs.
    //     The tool only emits a renderer card and awaits user input — it
    //     never mutates state on its own; the user is always the explicit
    //     decision-maker for the effect. Audit (Step 8) still records.
    //
    //   `ask` (e.g. agent_spawn)
    //     Category is `meta` (control-flow primitive, not a write), but
    //     the action is sensitive enough to warrant an approval modal.
    //     We fall through to the standard ask path below — the override
    //     just signals "skip auto-allow lanes".
    //
    // Trust boundary: only honor decisionOverride for builtin tools. A
    // plugin or MCP tool that happens to declare `meta` does not get
    // host-level override authority — it must satisfy the normal Layer 3
    // matrix (which for `meta` category falls through to the regular
    // descriptor flow via the registry).
    const metaOverride = source === "builtin" && tool.category === "meta"
      ? tool.decisionOverride
      : undefined;
    const isAlwaysAllowMeta = metaOverride === "always-allow-with-audit";
    if (this.permissionManager && !isAlwaysAllowMeta) {
      permissionResult = this.permissionManager.checkDetailed(
        toolUse.name,
        source,
        invocationCategory,
        proactiveOrigin,
        permissionContext,
      );
      // Q12 — meta tools with decisionOverride="ask" force the approval
      // modal regardless of the registry descriptor's "override" lane.
      // The override means "skip auto-allow lanes"; the registry already
      // returns "allow" for `meta` (override sentinel) so we must elevate
      // to ask here when the tool author marked it sensitive.
      if (metaOverride === "ask" && permissionResult.decision === "allow") {
        permissionResult = {
          decision: "ask",
          reason: `meta tool decisionOverride='ask' — 사용자 컨펌 필요`,
          layer: 6,
        };
      }
      if (permissionResult.decision === "deny") {
        const msg = `[권한 차단] 도구 '${toolUse.name}' (${source}, trust:${trust}) — ${permissionResult.reason}`;
        const durationMs = Date.now() - startTime;
        emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
        return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
      }
      if (permissionResult.decision === "ask") {
        if (this.approvalGate) {
          // §6.3 Layer 3 + §8: 렌더러 승인 모달로 round-trip
          // C1: wire target.filePath + isReadOnly + mode so that §S1
          // sensitive-path hard-block and §S4 read-only short-circuit
          // actually fire. Previously these were missing → §S1 check
          // read `undefined` and was effectively dead code.
          const approvalRequest = {
            id: randomUUID(),
            category: "tool" as const,
            toolName: toolUse.name,
            args: finalInput,
            reason: permissionResult.reason,
            source: source as "builtin" | "plugin" | "mcp",
            createdAt: Date.now(),
            ...(targetFilePath ? { target: { filePath: targetFilePath } } : {}),
            isReadOnly: invocationCategory === "read",
            mode: this.currentApprovalMode(),
            sensitivePathPattern,
          };

          // §F3: requestAndWait 실패 시 감사 로그 보장 후 deny-once 처리
          let decision;
          try {
            decision = await this.approvalGate.requestAndWait(approvalRequest);
          } catch (approvalErr) {
            const msg = `[승인 오류] 도구 '${toolUse.name}' — 승인 게이트 내부 오류: ${approvalErr instanceof Error ? approvalErr.message : String(approvalErr)}`;
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
            return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
          }

          if (decision.choice.startsWith("deny")) {
            // deny-always: 영구 거부 규칙 추가
            if (decision.choice === "deny-always" && this.permissionManager) {
              const pattern = decision.rememberPattern ?? toolUse.name;
              await this.permissionManager.addAlwaysDeniedPersist(pattern);
            }
            const msg = `[승인 거부] 도구 '${toolUse.name}' — 사용자가 실행을 거부했습니다.`;
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
            return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
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
          const durationMs = Date.now() - startTime;
          log.error(msg);
          emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity);
          return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
        }
      }
    }

    // ── Step 5: Rate Limit (trust별) ────────────────
    const rateResult = this.rateLimiter.check(toolUse.name, trust);
    if (!rateResult.allowed) {
      const msg = `[속도 제한] 도구 '${toolUse.name}' (trust:${trust}) 호출 빈도 초과. 잠시 후 다시 시도해주세요.`;
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, 0);
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    }

    emitToolStart(callbacks, toolUse.name, finalInput, meta);

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
        // Tool 자기 호출의 stable id — 렌더러가 inline UI 카드 (sub-agent 등)
        // 를 ToolGroupCard 옆에 join 할 때 키로 사용. agent_spawn 이 emit 하는
        // 라이프사이클 이벤트에 함께 실어 보냄.
        toolUseId: toolUse.id,
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
    //
    // The tool_result content is part of the machine channel consumed by
    // the next LLM round. Do not mutate it with display/audit redactions:
    // user-provided operational data such as an email recipient must remain
    // available to later tools. DLP applies only to renderer callbacks and
    // audit entries.
    let displayContent = content;
    const dlpResult = maskSensitiveData(content);
    if (dlpResult.detections.length > 0) {
      displayContent = dlpResult.masked;
      const dlpAuditInput = maskSensitiveData(JSON.stringify(finalInput)).masked;
      log.warn(
        `민감 데이터 탐지 및 마스킹 — 도구: '${toolUse.name}', 패턴: ${dlpResult.detections.join(", ")}`,
      );
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "unknown",
        type: "tool_call",
        input: dlpAuditInput.slice(0, 500),
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
    const durationMs = Date.now() - startTime;
    callbacks?.onToolEnd?.(toolUse.name, displayContent, isError, meta, uiPayload, durationMs);
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
        ? redactAskUserAuditOutput(displayContent)
        : displayContent;
    this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, auditContent, isError, startTime, permissionResult, rateResult.remaining);

    return { tool_use_id: toolUse.id, content, ...(isError && { is_error: true }), ...(uiPayload && { uiPayload }), durationMs };
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
      const inputText = JSON.stringify(input);
      const auditInput = maskSensitiveData(inputText).masked;
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "unknown",
        type: "tool_call",
        input: auditInput.slice(0, 500),
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

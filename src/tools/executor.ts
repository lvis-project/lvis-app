/**
 * Tool Executor — tool-governance.md §3 Single Choke Point
 *
 * 8-Step Pipeline (모든 도구 호출은 예외 없이 이 파이프라인을 통과):
 *
 * 1. Lookup       — ToolRegistry.findByName() + source/trust 확인
 * 2. PreHook      — HookRunner.preToolUse() — 입력 검사/변환
 * 3. Permission   — PermissionManager.checkDetailed(name, source, category, overlayTriggerOrigin)
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
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";
import type { ToolRegistry } from "./registry.js";
import type {
  ToolSource,
  TrustLevel,
  ToolCategory,
  ToolExecutionContext,
  ToolTrustOrigin,
} from "./types.js";
import { trustFromSource } from "./types.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { runWithCeiling } from "./executor-ceiling.js";
import type { PermissionManager, PermissionCheckResult } from "../permissions/permission-manager.js";
import type { ApprovalGate, ApprovalMode } from "../permissions/approval-gate.js";
import {
  buildPermissionEvaluationContext,
  type PermissionEvaluationContext,
} from "../permissions/evaluation-context.js";
import { isSensitivePath, canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";
import {
  buildAllowedScope,
  buildRuntimeAllowedDirectories,
  isFilesystemRootPath,
  isPathAllowed,
  pickClosestParent,
  validateDirectoryAddition,
} from "../permissions/allowed-directories.js";
import { dispatchPermissionDirCommand } from "../permissions/permission-slash.js";
import { HookRunner } from "../hooks/hook-runner.js";
import type { ScriptHookManager } from "../hooks/script-hook-manager.js";
import type { HookTrustOrigin } from "../hooks/script-hook-types.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { PermissionAuditEntryInput } from "../audit/audit-schema.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import type { RiskVerdict } from "../permissions/reviewer/risk-classifier.js";
import { detectSandboxCapability } from "../permissions/sandbox-capability.js";
import { lvisHome } from "../shared/lvis-home.js";
import type {
  ApprovalPurposeSuggestion,
  PermissionReviewEvent,
} from "../shared/permission-review-status.js";
import { BashAstValidator } from "../main/bash-ast-validator.js";
import {
  findShellPathPolicyViolation,
  type ShellPathPolicyViolation,
} from "./shell-path-policy.js";
import { createLogger } from "../lib/logger.js";
import {
  TOOL_RESULT_CHUNK_READER_METADATA_KEY,
  type ToolResultChunkReader,
} from "./tool-result-chunk.js";
import { t } from "../i18n/index.js";
const log = createLogger("executor");

export interface ToolCallMeta {
  groupId: string;
  toolUseId: string;
  displayOrder: number;
  source?: ToolSource;
  category?: ToolCategory;
  pluginId?: string;
  mcpServerId?: string;
}

/**
 * Extract absolute filesystem target paths from a tool's declared
 * `pathFields` contract. Used so {@link ApprovalGate}'s
 * §S1 sensitive-path hard-block can actually run against the path the
 * tool is about to touch. Returns an empty list when a tool declares no
 * path fields; built-in shell tools enforce command operands inside their
 * own native execution surface.
 */
function extractTargetFilePaths(
  tool: import("./base.js").Tool,
  input: unknown,
  cwd: string,
): string[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const fields = new Set<string>(tool.pathFields ?? []);
  const paths: string[] = [];
  for (const field of fields) {
    const candidate = getDottedFieldValue(obj, field);
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      if (typeof value !== "string" || value.length === 0) continue;
      try {
        paths.push(resolveToolPathForPermission(value, cwd));
      } catch {
        // Tool schema validation owns argument-type failures.
      }
    }
  }
  return [...new Set(paths)];
}

function getDottedFieldValue(input: Record<string, unknown>, field: string): unknown {
  let current: unknown = input;
  for (const segment of field.split(".")) {
    if (segment.length === 0) return undefined;
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function resolveToolPathForPermission(value: string, cwd: string): string {
  const expanded = value === "~"
    ? homedir()
    : value.startsWith("~/") || value.startsWith("~\\")
      ? pathResolve(homedir(), value.slice(2))
      : value;
  return pathResolve(pathResolve(cwd), expanded);
}

function summarizeInputForDeferred(input: Record<string, unknown>): string {
  try {
    return maskSensitiveData(JSON.stringify(input)).masked.slice(0, 1000);
  } catch {
    return "[unserializable input]";
  }
}

function resolveInvocationCategory(
  tool: import("./base.js").Tool,
  finalInput: Record<string, unknown>,
): ToolCategory {
  return tool.categoryForInput?.(finalInput) ?? tool.category;
}

function shellPathPolicyViolation(
  finalInput: Record<string, unknown>,
  sandboxRoot: string,
  allowedDirectories: readonly string[],
): ShellPathPolicyViolation | null {
  const command = finalInput.command;
  if (typeof command !== "string" || command.length === 0) {
    return { kind: "invalid-path", reason: "Shell path policy: missing command string" };
  }
  const cwdValue = finalInput.cwd;
  if (cwdValue !== undefined && typeof cwdValue !== "string") {
    return { kind: "invalid-path", reason: "Shell path policy: cwd must be a string when provided" };
  }
  const resolvedCwd = cwdValue
    ? pathResolve(sandboxRoot, cwdValue)
    : sandboxRoot;
  return findShellPathPolicyViolation(
    command,
    resolvedCwd,
    sandboxRoot,
    allowedDirectories,
  );
}

/**
 * Redact every `freeText` field from an `ask_user_question` tool result
 * before it is written to the audit log. Result shape (one card,
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
  /** Host-internal raw tool result for non-LLM plugin invocation surfaces. */
  rawResult?: unknown;
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
  onPermissionReview?: (event: PermissionReviewEvent) => void;
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
   * Internal per-invocation approval cache identity. The executor derives
   * this from Tool.approvalCacheKey after hooks have finalized args.
   */
  approvalCacheKey?: string;
  /**
   * Layer 1 path policy. User-configured directories from
   * `permissions.additionalDirectories` in settings.json. Boot threads this
   * through every executeAll() invocation. The executor merges with computed
   * defaults via {@link buildAllowedScope}; an `undefined` value here means
   * "use defaults only" (NOT "silent allow").
   *
   * Snapshot taken when executeAll() is dispatched. For within-round
   * propagation of mid-batch grants, prefer `getAdditionalDirectories`
   * which is re-evaluated at the top of each `executeOne`.
   */
  additionalDirectories?: readonly string[];
  /**
   * Optional fresh accessor for the additional-directories view. When
   * provided, `executeOne` invokes this at its start so that an earlier
   * tool in the same ordered `executeAll()` run granting
   * `allow-once`/`allow-session` widens the scope visible to later tools.
   * Falls back to `additionalDirectories` (snapshot) when omitted — keeps
   * legacy callers working.
   */
  getAdditionalDirectories?: () => readonly string[];
  /**
   * Trust origin classification carried with each tool invocation. Audited and
   * propagated into approval-request payloads. Distinguishes user-keyboard
   * input from plugin-emitted, LLM-tool-arg, and file-content origins.
   */
  trustOrigin: ToolTrustOrigin;
  /**
   * Recent user-authored turn text. Used only to provide reviewer context
   * and prefill the high-risk approval purpose field; plugin/file origins
   * should leave this absent.
   */
  userIntent?: string;
  /**
   * Invoked when the user selects "이번 1회만" (turn-scope grant) on an
   * out-of-allowed-dir approval. The conversation loop is expected to
   * remember `approvedDirectory` for the remaining tool calls inside the
   * SAME `runTurn`, then drop it. Distinct from `onSessionDirectoryGrant`
   * (whole conversation lifetime) and persisted rules (settings.json).
   */
  onTurnDirectoryGrant?: (approvedDirectory: string) => void;
  /**
   * Invoked when the user selects "이번 세션 동안 허용" (session-scope
   * grant). The conversation loop appends `approvedDirectory` to the
   * session-wide allow list, surviving across user messages but cleared
   * on `newConversation` / `loadSession`.
   */
  onSessionDirectoryGrant?: (approvedDirectory: string) => void;
}

/**
 * Bundled execution options for {@link ToolExecutor.executeAll} and
 * {@link ToolExecutor.executeOne}. Replaces the positional-arg shape so adding
 * a new pipeline-wide concern (per-turn telemetry, audit correlation id, ...)
 * doesn't ripple through every callsite. A missing permission context is a
 * strict-deny condition for concrete tool execution.
 */
export interface ExecuteOptions {
  callbacks?: ToolExecutorCallbacks;
  sessionId?: string;
  /**
   * Overlay trigger origin tag (e.g. `"overlay:meeting-detection"`).
   * When set, write/shell/network tools force ApprovalGate `ask` and
   * bypass the user's `allow-always` cache.
   */
  overlayTriggerOrigin?: string | null;
  /**
   * Sub-agent recursion depth — `agent_spawn` refuses when ≥1 so a
   * sub-agent cannot itself spawn (defense-in-depth on top of the
   * SubAgentRunner registry strip).
   */
  spawnDepth?: number;
  abortSignal?: AbortSignal;
  toolResultChunkReader?: ToolResultChunkReader;
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

function approvalCacheKeyFor(
  tool: import("./base.js").Tool,
  input: Record<string, unknown>,
  cwd: string,
): string | undefined {
  const rawKey = tool.approvalCacheKey?.(input, { cwd });
  if (rawKey === undefined) return undefined;
  const key = rawKey.trim();
  if (!key) {
    throw new Error(`approvalCacheKey for ${tool.name} returned an empty key`);
  }
  return `${tool.name}:${key}`;
}

function emitToolStart(
  callbacks: ToolExecutorCallbacks | undefined,
  name: string,
  input: Record<string, unknown>,
  meta: ToolCallMeta,
): void {
  callbacks?.onToolStart?.(name, maskToolInputForDisplay(input), meta);
}

function emitPermissionReview(
  callbacks: ToolExecutorCallbacks | undefined,
  event: PermissionReviewEvent,
): void {
  callbacks?.onPermissionReview?.(event);
}

function cleanApprovalPurposeText(value: unknown, maxLength = 180): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.startsWith("/")) return undefined;
  return normalized.length > maxLength
    ? `${normalized.slice(0, Math.max(0, maxLength - 1))}…`
    : normalized;
}

function purposeSentenceFromIntent(intent: string): string {
  const text = intent.replace(/[.!?。！？]+$/u, "").trim();
  return maskSensitiveData(t("be_executor.purposeSentence", { text })).masked;
}

function pickPurposeFromToolInput(input: Record<string, unknown>): string | undefined {
  const keys = [
    "purpose",
    "intent",
    "reason",
    "task",
    "summary",
    "query",
    "prompt",
    "message",
    "text",
    "description",
  ];
  for (const key of keys) {
    const value = cleanApprovalPurposeText(input[key]);
    if (value) return value;
  }
  return undefined;
}

function buildApprovalPurposeSuggestion(
  finalInput: Record<string, unknown>,
  context: ToolPermissionContext,
): ApprovalPurposeSuggestion | undefined {
  const userIntent = cleanApprovalPurposeText(context.userIntent, 220);
  if (userIntent) {
    return {
      text: purposeSentenceFromIntent(userIntent),
      source: "conversation",
      confidence: "sufficient",
    };
  }

  const toolPurpose = pickPurposeFromToolInput(finalInput);
  if (!toolPurpose) return undefined;
  return {
    text: purposeSentenceFromIntent(toolPurpose),
    source: "tool-input",
    confidence: "insufficient",
  };
}

function auditTrustOrigin(context?: ToolPermissionContext): HookTrustOrigin {
  return context?.trustOrigin ?? "unknown";
}

function auditDirectoryForInput(
  tool: import("./base.js").Tool | undefined,
  input: Record<string, unknown>,
  cwd: string,
  canonicalTargetFilePath?: string,
): string | undefined {
  if (tool) {
    if (canonicalTargetFilePath) return canonicalTargetFilePath;
    if (tool.category === "shell" && typeof input.cwd === "string" && input.cwd.length > 0) {
      return resolveToolPathForPermission(input.cwd, cwd);
    }
  }
  return undefined;
}

function permissionAuditBase(args: {
  toolName: string;
  tool?: import("./base.js").Tool;
  source: ToolSource;
  category: ToolCategory;
  trustOrigin: HookTrustOrigin;
}): Pick<
  Extract<PermissionAuditEntryInput, { decision: "allow" }>,
  "ts" | "auditId" | "trustOrigin" | "tool" | "source" | "category"
> {
  return {
    ts: new Date().toISOString(),
    auditId: randomUUID(),
    trustOrigin: args.trustOrigin,
    tool: args.toolName,
    source: args.source,
    category: args.category,
  };
}

function permissionAuditEntryFromToolCall(args: {
  toolName: string;
  tool?: import("./base.js").Tool;
  source: ToolSource;
  category: ToolCategory;
  input: Record<string, unknown>;
  permission: PermissionCheckResult | undefined;
  rateLimitRemaining: number;
  trustOrigin: HookTrustOrigin;
  cwd: string;
  auditDirectory?: string;
}): PermissionAuditEntryInput {
  const base = permissionAuditBase(args);
  if (args.permission?.deferred) {
    return {
      ...base,
      decision: "deferred",
      reviewerVerdict: args.permission.deferred.reviewerVerdict,
      queueId: args.permission.deferred.queueId,
    };
  }
  if (args.permission?.decision === "deny") {
    const denyReasons = args.permission.denyReasons?.length
      ? args.permission.denyReasons
      : [{
        layer: args.permission.layer,
        reason: args.permission.reason,
        source: "tool-executor",
      }];
    return {
      ...base,
      decision: "deny",
      denyReasons,
    };
  }
  const auditDirectory = auditDirectoryForInput(args.tool, args.input, args.cwd, args.auditDirectory);
  const allowEntry: Extract<PermissionAuditEntryInput, { decision: "allow" }> = {
    ...base,
    decision: "allow",
    layer: args.permission?.layer ?? 6,
  };
  if (args.permission?.reviewer?.verdict) {
    allowEntry.reviewer = args.permission.reviewer.verdict;
  }
  if (auditDirectory) {
    allowEntry.directory = auditDirectory;
    allowEntry.directoryAllowed = true;
  }
  if (Number.isFinite(args.rateLimitRemaining)) {
    allowEntry.rateLimitRemaining = args.rateLimitRemaining;
  }
  return allowEntry;
}

function permissionAuditAskEntryFromToolCall(args: {
  toolName: string;
  tool?: import("./base.js").Tool;
  source: ToolSource;
  category: ToolCategory;
  input: Record<string, unknown>;
  permission: PermissionCheckResult;
  trustOrigin: HookTrustOrigin;
  cwd: string;
  auditDirectory?: string;
}): PermissionAuditEntryInput {
  const auditDirectory = auditDirectoryForInput(args.tool, args.input, args.cwd, args.auditDirectory);
  const askEntry: Extract<PermissionAuditEntryInput, { decision: "ask" }> = {
    ...permissionAuditBase(args),
    decision: "ask",
    layer: args.permission.layer,
    reason: args.permission.reason,
  };
  if (auditDirectory) {
    askEntry.directory = auditDirectory;
  }
  return askEntry;
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
  private readonly requirePermissionAuditChain: boolean;
  private readonly rateLimiter = new RateLimiter();
  private readonly bashAstValidator?: BashAstValidator;
  private readonly scriptHookManager?: ScriptHookManager;

  constructor(
    toolRegistry: ToolRegistry,
    hookRunner?: HookRunner,
    permissionManager?: PermissionManager,
    bashAstValidator?: BashAstValidator,
    approvalGate?: ApprovalGate,
    scriptHookManager?: ScriptHookManager,
    auditLogger?: AuditLogger,
  ) {
    this.toolRegistry = toolRegistry;
    this.hookRunner = hookRunner ?? new HookRunner();
    this.permissionManager = permissionManager;
    this.approvalGate = approvalGate;
    this.auditLogger = auditLogger ?? new AuditLogger();
    this.bashAstValidator = bashAstValidator;
    this.scriptHookManager = scriptHookManager;
    this.requirePermissionAuditChain = auditLogger?.isPermissionAuditChainReady() === true;
  }

  /**
   * Convert the PermissionManager execution mode into the ApprovalMode
   * vocabulary understood by ApprovalGate's read-only short-circuit.
   * `strict` → `ask_all` (show dialog even for read-only);
   * `auto` / `allow` → `full_auto`;
   * `default` → `default`.
   */
  private currentApprovalMode(): ApprovalMode {
    const pm = this.permissionManager?.getMode?.();
    if (pm === "strict") return "ask_all";
    if (pm === "auto" || pm === "allow") return "full_auto";
    return "default";
  }

  getHookRunner(): HookRunner {
    return this.hookRunner;
  }

  private async runScriptHook(
    hookType: "pre" | "post" | "perm",
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    input: Record<string, unknown>,
    sessionId: string | undefined,
    context: ToolPermissionContext,
    toolOutput?: string,
    isError?: boolean,
  ) {
    if (!this.scriptHookManager) {
      return { decision: "allow" as const, reason: "script hooks not wired", results: [] };
    }
    const payload = {
      toolName,
      source,
      category,
      input,
      sessionId: sessionId ?? "unknown",
      trustOrigin: context.trustOrigin as HookTrustOrigin,
      ...(toolOutput !== undefined ? { toolOutput } : {}),
      ...(isError !== undefined ? { isError } : {}),
    };
    if (hookType === "pre") return this.scriptHookManager.runPreToolUse(payload);
    if (hookType === "post") return this.scriptHookManager.runPostToolUse(payload);
    return this.scriptHookManager.runPermissionRequest(payload);
  }

  private async dispatchReviewerForHeadless(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    pathFields: readonly string[],
    finalInput: Record<string, unknown>,
    cacheIdentityInput: Record<string, unknown>,
    allowedDirectories: string[],
    sensitivePathsAdjacent: string[],
    context: ToolPermissionContext,
    evaluationContext: PermissionEvaluationContext,
    sandboxAttestation: { writesToOwnSandbox?: boolean; ownerPluginSandboxRoot?: string },
    callbacks: ToolExecutorCallbacks | undefined,
    meta: ToolCallMeta,
    approvalPurpose: ApprovalPurposeSuggestion | undefined,
    abortSignal?: AbortSignal,
  ): Promise<
    | { allowed: true; permissionResult: PermissionCheckResult }
    | { allowed: false; message: string; permissionResult: PermissionCheckResult }
  > {
    if (this.permissionManager?.getMode() === "strict") {
      const reason = "strict mode requires explicit user approval";
      const verdict: RiskVerdict = { level: "high", reason };
      const deferredId = await this.permissionManager.getDeferredQueue()?.append({
        toolName,
        source,
        category,
        inputSummary: summarizeInputForDeferred(finalInput),
        evaluationContext,
        verdict,
      });
      return {
        allowed: false,
        message:
          t("be_executor.permHoldStrictHeadless", { toolName, source }) +
          (deferredId ? ` (deferredId=${deferredId})` : ""),
        permissionResult: {
          decision: "deny",
          reason: "strict headless requires explicit approval",
          layer: 5,
          reviewer: { route: "headless", verdict },
          ...(deferredId ? { deferred: { queueId: deferredId, reviewerVerdict: verdict } } : {}),
        },
      };
    }

    if (!this.permissionManager?.hasReviewer()) {
      return {
        allowed: false,
        message: t("be_executor.permBlockHeadlessNoReviewer", { toolName, source }),
        permissionResult: {
          decision: "deny",
          reason: "headless reviewer not wired",
          layer: 5,
        },
      };
    }
    emitPermissionReview(callbacks, {
      status: "reviewing",
      toolName,
      toolCategory: category,
      source,
      ...meta,
      ...(approvalPurpose ? { approvalPurpose } : {}),
    });
    const reviewer = await this.permissionManager.dispatchReviewer(
      toolName,
      {
        source,
        category,
        pathFields,
        finalInput,
        cacheIdentityInput,
        allowedDirectories,
        sensitivePathsAdjacent,
        trustOrigin: context.trustOrigin,
        evaluationContext,
        ...(context.userIntent ? { conversationContext: { recentUserMessage: context.userIntent } } : {}),
        ...(context.approvalCacheKey ? { approvalCacheKey: context.approvalCacheKey } : {}),
        ...(sandboxAttestation.writesToOwnSandbox !== undefined
          ? { writesToOwnSandbox: sandboxAttestation.writesToOwnSandbox }
          : {}),
        ...(sandboxAttestation.ownerPluginSandboxRoot !== undefined
          ? { ownerPluginSandboxRoot: sandboxAttestation.ownerPluginSandboxRoot }
          : {}),
      },
      {
        allowedPluginIds: context.allowedPluginIds
          ? [...context.allowedPluginIds]
          : undefined,
        additionalDirectories: context.additionalDirectories ?? [],
      },
      { defer: "medium-high", abortSignal },
    );
    emitPermissionReview(callbacks, {
      status: reviewer.verdict.level === "low" ? "auto_approved" : "needs_approval",
      toolName,
      toolCategory: category,
      source,
      ...meta,
      verdictLevel: reviewer.verdict.level,
      reason: reviewer.verdict.reason,
      ...(approvalPurpose ? { approvalPurpose } : {}),
    });
    if (reviewer.verdict.level !== "low") {
      return {
        allowed: false,
        message:
          t("be_executor.permHoldReviewer", { toolName, source, reason: reviewer.verdict.reason }) +
          (reviewer.deferredId ? ` (deferredId=${reviewer.deferredId})` : ""),
        permissionResult: {
          decision: "deny",
          reason: `reviewer ${reviewer.verdict.level}: ${reviewer.verdict.reason}`,
          layer: 5,
          reviewer: { route: "headless", verdict: reviewer.verdict },
          ...(reviewer.deferredId
            ? { deferred: { queueId: reviewer.deferredId, reviewerVerdict: reviewer.verdict } }
            : {}),
        },
      };
    }
    return {
      allowed: true,
      permissionResult: {
        decision: "allow",
        reason: `reviewer ${reviewer.verdict.level}: ${reviewer.verdict.reason}`,
        layer: 5,
        reviewer: { route: "headless", verdict: reviewer.verdict },
      },
    };
  }

  private async dispatchReviewerForInteractiveAuto(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    pathFields: readonly string[],
    finalInput: Record<string, unknown>,
    cacheIdentityInput: Record<string, unknown>,
    allowedDirectories: string[],
    sensitivePathsAdjacent: string[],
    context: ToolPermissionContext,
    evaluationContext: PermissionEvaluationContext,
    sandboxAttestation: { writesToOwnSandbox?: boolean; ownerPluginSandboxRoot?: string },
    callbacks: ToolExecutorCallbacks | undefined,
    meta: ToolCallMeta,
    approvalPurpose: ApprovalPurposeSuggestion | undefined,
    abortSignal?: AbortSignal,
  ): Promise<PermissionCheckResult | null> {
    if (context.headless === true) return null;
    // Issue #690 — the gate is EITHER legacy `auto` exec mode OR the
    // interactive auto-approve setting. PermissionManager.categoryBasedDecision
    // only sets `reviewer.route='foreground-auto'` when one of those is
    // true, so reaching here implies opt-in, but check explicitly to
    // stay robust against future producers that set the route directly.
    const mgr = this.permissionManager;
    if (!mgr) return null;
    if (mgr.getMode() !== "auto" && mgr.getInteractiveAutoApprove() === "off") {
      return null;
    }
    if (category !== "write" && category !== "shell" && category !== "network") {
      return null;
    }
    if (!mgr.hasReviewer()) {
      return {
        decision: "ask",
        reason: "auto-review reviewer unavailable — explicit user approval required",
        layer: 5,
      };
    }

    emitPermissionReview(callbacks, {
      status: "reviewing",
      toolName,
      toolCategory: category,
      source,
      ...meta,
      ...(approvalPurpose ? { approvalPurpose } : {}),
    });

    let reviewer: Awaited<ReturnType<PermissionManager["dispatchReviewer"]>>;
    try {
      reviewer = await mgr.dispatchReviewer(
        toolName,
        {
          source,
          category,
          pathFields,
          finalInput,
          cacheIdentityInput,
          allowedDirectories,
          sensitivePathsAdjacent,
          trustOrigin: context.trustOrigin,
          evaluationContext,
          ...(context.userIntent ? { conversationContext: { recentUserMessage: context.userIntent } } : {}),
          ...(context.approvalCacheKey ? { approvalCacheKey: context.approvalCacheKey } : {}),
          ...(sandboxAttestation.writesToOwnSandbox !== undefined
            ? { writesToOwnSandbox: sandboxAttestation.writesToOwnSandbox }
            : {}),
          ...(sandboxAttestation.ownerPluginSandboxRoot !== undefined
            ? { ownerPluginSandboxRoot: sandboxAttestation.ownerPluginSandboxRoot }
            : {}),
        },
        {
          allowedPluginIds: context.allowedPluginIds
            ? [...context.allowedPluginIds]
            : undefined,
          additionalDirectories: context.additionalDirectories ?? [],
        },
        { defer: "none", abortSignal },
      );
    } catch (err) {
      emitPermissionReview(callbacks, {
        status: "failed",
        toolName,
        toolCategory: category,
        source,
        ...meta,
        reason: err instanceof Error ? err.message : String(err),
        ...(approvalPurpose ? { approvalPurpose } : {}),
      });
      throw err;
    }

    emitPermissionReview(callbacks, {
      status: reviewer.verdict.level === "low" ? "auto_approved" : "needs_approval",
      toolName,
      toolCategory: category,
      source,
      ...meta,
      verdictLevel: reviewer.verdict.level,
      reason: reviewer.verdict.reason,
      ...(approvalPurpose ? { approvalPurpose } : {}),
    });

    if (reviewer.verdict.level === "low") {
      return {
        decision: "allow",
        reason: `reviewer low: ${reviewer.verdict.reason}`,
        layer: 5,
        reviewer: { route: "foreground-auto", verdict: reviewer.verdict },
      };
    }
    return {
      decision: "ask",
      reason: `reviewer ${reviewer.verdict.level}: ${reviewer.verdict.reason}`,
      layer: 5,
      reviewer: { route: "foreground-auto", verdict: reviewer.verdict },
    };
  }

  /** 복수 tool_use 순서 실행.
   *
   * `overlayTriggerOrigin` (예: `"overlay:meeting-detection"`) 가 set 이면
   * 모든 write/shell/network 호출이 사용자 영구 승인을 우회해 ask 로 강제됨
   * (PermissionManager.checkDetailed 의 새 가드). Overlay trigger가 자동
   * 실행하는 destructive 작업 차단막.
   *
   * {@link ExecuteOptions} bundles pipeline concerns so adding a new
   * concern doesn't ripple
   * through every callsite.
   */
  async executeAll(
    toolUses: ToolUseBlock[],
    opts: ExecuteOptions = {},
  ): Promise<ToolResult[]> {
    const groupId = randomUUID();
    const results: ToolResult[] = [];
    for (let idx = 0; idx < toolUses.length; idx++) {
      results.push(await this.executeOne(toolUses[idx], groupId, idx, opts));
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
      overlayTriggerOrigin,
      spawnDepth,
      abortSignal,
      toolResultChunkReader,
      permissionContext,
    } = opts;
    const startTime = Date.now();
    const executionCwd = process.cwd();
    const meta: ToolCallMeta = { groupId, toolUseId: toolUse.id, displayOrder };
    let permissionResult: PermissionCheckResult | undefined;
    let source: ToolSource = "builtin";
    let trust: TrustLevel = "high";

    // ── Step 1: Lookup + source/trust 확인 ──────────
    const tool = this.toolRegistry.findByName(toolUse.name);
    if (!tool) {
      const durationMs = Date.now() - startTime;
      await this.auditToolCall(sessionId, toolUse.name, "builtin", "high", toolUse.input, t("be_executor.toolNotFoundAudit"), true, startTime, { decision: "deny", reason: t("be_executor.toolNotFoundAudit"), layer: 0 }, Infinity, permissionContext);
      callbacks?.onToolEnd?.(toolUse.name, t("be_executor.toolNotFound", { name: toolUse.name }), true, meta, undefined, durationMs);
      return { tool_use_id: toolUse.id, content: t("be_executor.toolNotFound", { name: toolUse.name }), is_error: true, durationMs };
    }
    source = tool.source;
    trust = trustFromSource(source);
    let invocationCategory = resolveInvocationCategory(tool, toolUse.input);
    meta.source = source;
    meta.category = invocationCategory;
    if (tool.pluginId) meta.pluginId = tool.pluginId;
    if (tool.mcpServerId) meta.mcpServerId = tool.mcpServerId;

    const returnUserAbort = async (input: Record<string, unknown>): Promise<ToolResult> => {
      const msg = t("be_executor.toolExecutionCancelled");
      const durationMs = Date.now() - startTime;
      const abortedPermission: PermissionCheckResult = {
        decision: "deny",
        reason: "user aborted turn",
        layer: 0,
      };
      emitToolStart(callbacks, toolUse.name, input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await this.auditToolCall(
        sessionId,
        toolUse.name,
        source,
        trust,
        input,
        msg,
        true,
        startTime,
        abortedPermission,
        Infinity,
        permissionContext,
        invocationCategory,
        executionCwd,
        undefined,
        "user-abort",
      );
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    };

    if (abortSignal?.aborted) {
      return returnUserAbort(toolUse.input);
    }

    const foldedExecutionCwd = caseFoldForMatch(canonicalizePathForMatch(executionCwd));
    if (isFilesystemRootPath(foldedExecutionCwd)) {
      const msg = t("be_executor.permBlockCwdRoot", { name: toolUse.name, source });
      const durationMs = Date.now() - startTime;
      const blockedPermission: PermissionCheckResult = {
        decision: "deny",
        reason: "execution cwd is filesystem root",
        layer: 0,
      };
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, blockedPermission, Infinity, permissionContext, invocationCategory, executionCwd);
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    }

    if (!permissionContext?.trustOrigin) {
      const msg = t("be_executor.permBlockTrustOriginMissing", { name: toolUse.name, source });
      const durationMs = Date.now() - startTime;
      const blockedPermission: PermissionCheckResult = {
        decision: "deny",
        reason: "tool trust origin missing",
        layer: 0,
      };
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, blockedPermission, Infinity, permissionContext, invocationCategory, executionCwd);
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    }

    // ── Step 2: PreToolUse Hook ─────────────────────
    const preResult = await this.hookRunner.runPreHooks({
      toolName: toolUse.name,
      toolInput: toolUse.input,
    });

    if (preResult.action === "deny") {
      const msg = t("be_executor.hookBlockPre", { reason: preResult.reason ?? t("be_executor.hookBlockPreDefaultReason") });
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity, permissionContext, invocationCategory, executionCwd);
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    }

    const finalInput = preResult.action === "modify" && preResult.updatedInput
      ? preResult.updatedInput
      : toolUse.input;
    if (finalInput !== toolUse.input) {
      invocationCategory = resolveInvocationCategory(tool, finalInput);
      meta.category = invocationCategory;
    }
    const approvalCacheKey = approvalCacheKeyFor(tool, finalInput, executionCwd);
    const invocationPermissionContext: ToolPermissionContext = {
      ...permissionContext,
      ...(approvalCacheKey ? { approvalCacheKey } : {}),
    };
    const approvalPurpose = buildApprovalPurposeSuggestion(finalInput, invocationPermissionContext);
    const reviewerInput = maskToolInputForDisplay(finalInput);
    if (abortSignal?.aborted) {
      return returnUserAbort(finalInput);
    }
    // Within-round freshness: when the caller provided a getter we read
    // the *current* additional-directories view at the top of this
    // executeOne (rather than the snapshot taken when executeAll() was
    // dispatched). This makes an `allow-once`/`allow-session` grant
    // applied by an earlier tool visible to later tools in the same
    // ordered run.
    const baseAdditionalDirectories: readonly string[] =
      invocationPermissionContext.getAdditionalDirectories?.()
      ?? invocationPermissionContext.additionalDirectories
      ?? [];
    let invocationAllowedScope = buildAllowedScope(baseAdditionalDirectories);
    let invocationRuntimeAllowedDirectories = buildRuntimeAllowedDirectories(baseAdditionalDirectories);
    const makeEvaluationContext = (input: {
      pathFields: readonly string[];
      targetFilePaths?: readonly string[];
      sensitivePathsAdjacent?: readonly string[];
    }): PermissionEvaluationContext => buildPermissionEvaluationContext({
      policyMode: this.permissionManager?.getMode?.() ?? "unmanaged",
      headless: invocationPermissionContext.headless === true,
      source,
      category: invocationCategory,
      trustOrigin: invocationPermissionContext.trustOrigin,
      executionCwd,
      allowedDirectories: invocationAllowedScope.directories,
      pathFields: input.pathFields,
      targetFilePaths: input.targetFilePaths ?? [],
      sensitivePathsAdjacent: input.sensitivePathsAdjacent ?? [],
    });

    const requestOutOfAllowedDirectoryAccess = async (
      outOfAllowedTarget: { filePath: string; canonicalPath: string },
      dirLayerResult: PermissionCheckResult,
      requestSensitivePathPattern: string | null,
      reviewerPathFields: readonly string[],
    ): Promise<
      | { allowed: true; approvedDirectory: string; scope: "turn" | "session" | "always"; permissionResult?: PermissionCheckResult }
      | { allowed: false; result: ToolResult }
    > => {
      const headless = invocationPermissionContext.headless === true;
      const trustOrigin = invocationPermissionContext.trustOrigin;
      const validation = validateDirectoryAddition(outOfAllowedTarget.canonicalPath);
      if (!validation.ok) {
        const msg = t("be_executor.dirPolicyBlock", { name: toolUse.name, reason: validation.reason, filePath: outOfAllowedTarget.filePath });
        const durationMs = Date.now() - startTime;
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { allowed: false, result: { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs } };
      }
      // Detect whether the request path itself is a directory (e.g.
      // `list_files /Users/ken`) so the auto-suggest goes to the path
      // itself rather than its parent. `statSync` is used here only to
      // hint the UI suggestion — the actual permission check downstream
      // is prefix-based and unaffected by TOCTOU, and the user must
      // re-type the suggested path before persisting (phishing defense).
      let isDirectoryTarget = false;
      try {
        isDirectoryTarget = statSync(outOfAllowedTarget.canonicalPath).isDirectory();
      } catch {
        // Path does not exist yet (e.g. write target before first write);
        // fall back to file-style behavior (suggest the parent dir).
      }
      const suggestedParent = pickClosestParent(
        outOfAllowedTarget.canonicalPath,
        invocationAllowedScope.directories,
        isDirectoryTarget,
      );

      if (this.approvalGate && !headless) {
        const approvalRequest = {
          id: randomUUID(),
          category: "tool" as const,
          kind: "out-of-allowed-dir" as const,
          toolName: toolUse.name,
          toolCategory: invocationCategory,
          args: finalInput,
          reason: dirLayerResult.reason,
          source: source as "builtin" | "plugin" | "mcp",
          createdAt: Date.now(),
          target: { filePath: outOfAllowedTarget.filePath },
          isReadOnly: invocationCategory === "read",
          mode: this.currentApprovalMode(),
          sensitivePathPattern: requestSensitivePathPattern,
          // Issue #691 round-1 user request — sandbox capability surfaced
          // to the dialog so the user can see whether the tool will run
          // under OS isolation or with no protection.
          sandboxCapability: detectSandboxCapability(),
          evaluationContext: makeEvaluationContext({
            pathFields: reviewerPathFields,
            targetFilePaths: [outOfAllowedTarget.filePath],
            sensitivePathsAdjacent: validation.adjacencyWarnings,
          }),
          outOfAllowedDir: {
            candidatePath: outOfAllowedTarget.filePath,
            suggestedParent,
            currentAllowed: invocationAllowedScope.directories,
            adjacencyWarnings: validation.adjacencyWarnings,
          },
          trustOrigin,
          // Propagate approvalCacheKey so renderer record key
          // matches dispatchReviewer lookup key — end-to-end symmetry.
          ...(approvalCacheKey ? { approvalCacheKey } : {}),
        };

        let decision;
        try {
          await this.auditPermissionAsk(
            toolUse.name,
            source,
            invocationCategory,
        finalInput,
            dirLayerResult,
            executionCwd,
            invocationPermissionContext,
            outOfAllowedTarget.filePath,
          );
          decision = await this.approvalGate.requestAndWait(approvalRequest);
        } catch (approvalErr) {
          const msg = t("be_executor.dirPolicyError", { name: toolUse.name, error: approvalErr instanceof Error ? approvalErr.message : String(approvalErr) });
          const durationMs = Date.now() - startTime;
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, dirLayerResult, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return { allowed: false, result: { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs } };
        }

        if (decision.choice.startsWith("deny")) {
          const msg = t("be_executor.dirPolicyUserDenied", { name: toolUse.name, filePath: outOfAllowedTarget.filePath });
          const durationMs = Date.now() - startTime;
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return { allowed: false, result: { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs } };
        }
        const approvedDirectory = decision.choice === "allow-always"
          ? (typeof decision.rememberPattern === "string" && decision.rememberPattern.length > 0
              ? decision.rememberPattern
              : suggestedParent ?? outOfAllowedTarget.filePath)
          : outOfAllowedTarget.filePath;
        if (decision.choice === "allow-always") {
          const dirResult = await dispatchPermissionDirCommand({
            verb: "allow",
            path: approvedDirectory,
            session: false,
            acknowledgeWarnings: true,
          });
          if (!dirResult.ok || dirResult.verb !== "allow") {
            const msg = t("be_executor.dirPolicySaveFailed", { name: toolUse.name, error: dirResult.ok ? "unexpected result" : dirResult.error });
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { allowed: false, result: { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs } };
          }
          return { allowed: true, approvedDirectory, scope: "always" };
        }
        if (decision.choice === "allow-session") {
          // Mirror allow-always' persist convention so the permission
          // audit trail records the directory addition; the caller's
          // onSessionDirectoryGrant callback then keeps the in-memory
          // ConversationLoop scope in sync. `session: true` ensures
          // settings.json is NOT mutated — the grant dies with the
          // conversation. Widen to suggestedParent (when present) so
          // the next tool call in the same conversation hitting a
          // sibling path under the same directory passes Layer 1
          // without re-prompting.
          const sessionScopePath = suggestedParent ?? outOfAllowedTarget.filePath;
          const dirResult = await dispatchPermissionDirCommand({
            verb: "allow",
            path: sessionScopePath,
            session: true,
            acknowledgeWarnings: true,
          });
          if (!dirResult.ok || dirResult.verb !== "allow") {
            const msg = t("be_executor.dirPolicySessionRegFailed", { name: toolUse.name, error: dirResult.ok ? "unexpected result" : dirResult.error });
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { allowed: false, result: { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs } };
          }
          return { allowed: true, approvedDirectory: sessionScopePath, scope: "session" };
        }
        // allow-once: turn-scope, no persistence, narrowest path.
        return { allowed: true, approvedDirectory, scope: "turn" };
      }

      if (headless) {
        const deferredQueue = this.permissionManager?.getDeferredQueue();
        const verdict: RiskVerdict = {
          level: "high",
          reason: "headless out-of-allowed-dir requires manual directory approval",
        };
        const deferredId = deferredQueue
          ? await deferredQueue.append({
            toolName: toolUse.name,
            source,
            category: invocationCategory,
            inputSummary: summarizeInputForDeferred(finalInput),
            evaluationContext: makeEvaluationContext({
              pathFields: reviewerPathFields,
              targetFilePaths: [outOfAllowedTarget.filePath],
              sensitivePathsAdjacent: validation.adjacencyWarnings,
            }),
            verdict,
          })
          : undefined;
        const permissionResult: PermissionCheckResult = {
          decision: "deny",
          reason: "headless out-of-allowed-dir requires manual directory approval",
          layer: 1,
          reviewer: { route: "headless", verdict },
          ...(deferredId ? { deferred: { queueId: deferredId, reviewerVerdict: verdict } } : {}),
        };
        const msg =
          t("be_executor.permHoldHeadlessDirectory", { name: toolUse.name, source }) +
          (deferredId ? ` (deferredId=${deferredId})` : "");
        const durationMs = Date.now() - startTime;
        log.warn(msg);
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { allowed: false, result: { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs } };
      }

      const msg = t("be_executor.approvalGateMissingLayer1", { name: toolUse.name, source });
      const durationMs = Date.now() - startTime;
      log.error(msg);
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
      return { allowed: false, result: { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs } };
    };

    const applyApprovedDirectory = (approvedDirectory: string): void => {
      // Re-read fresh: an earlier tool in the same ordered executeAll run may
      // have just resolved its own out-of-allowed-dir dialog and mutated the
      // conversation loop's session/turn lists. Spreading from
      // `baseAdditionalDirectories` (executeOne-entry snapshot) would silently
      // drop that grant — read-side is fresh via getAdditionalDirectories but
      // write-side must also be fresh for symmetry. (architect 2-round Q1)
      const fresh: readonly string[] =
        invocationPermissionContext.getAdditionalDirectories?.()
        ?? baseAdditionalDirectories;
      invocationAllowedScope = buildAllowedScope([...fresh, approvedDirectory]);
      invocationRuntimeAllowedDirectories = buildRuntimeAllowedDirectories([...fresh, approvedDirectory]);
    };

    // Propagate the user's grant lifetime choice up to the conversation
    // loop. The local `applyApprovedDirectory` only widens the *current*
    // invocation's scope; without these callbacks the grant would not
    // outlive this single tool call — the exact "한 번만 허용 = 1 tool
    // call" bug being fixed here. Fail-loud on missing callback: silently
    // dropping a grant is exactly the bug class this refactor eliminates,
    // so we log and degrade conservatively (session → turn) rather than
    // pretending the propagation succeeded.
    const propagateGrantScope = (approvedDirectory: string, scope: "turn" | "session" | "always"): void => {
      const emitGrantAudit = (lifetime: "turn" | "session" | "always" | "degraded-to-turn"): void => {
        // Fire-and-forget: audit append errors are logged inside the
        // helper (or thrown only when requirePermissionAuditChain), so we
        // don't block tool execution on audit I/O.
        void this.auditPermissionGrant({
          toolName: toolUse.name,
          source,
          category: invocationCategory,
          directory: approvedDirectory,
          grantLifetime: lifetime,
          permissionContext: invocationPermissionContext,
        });
      };
      if (scope === "turn") {
        if (!invocationPermissionContext.onTurnDirectoryGrant) {
          log.warn(`[permission-scope] onTurnDirectoryGrant unwired — turn-scope grant for ${approvedDirectory} will not survive this tool call`);
          return;
        }
        invocationPermissionContext.onTurnDirectoryGrant(approvedDirectory);
        emitGrantAudit("turn");
        return;
      }
      if (scope === "session") {
        if (!invocationPermissionContext.onSessionDirectoryGrant) {
          if (!invocationPermissionContext.onTurnDirectoryGrant) {
            log.error(`[permission-scope] both session and turn callbacks unwired — session-scope grant for ${approvedDirectory} dropped entirely`);
            return;
          }
          log.error(`[permission-scope] onSessionDirectoryGrant unwired — degrading session-scope grant for ${approvedDirectory} to turn-scope`);
          invocationPermissionContext.onTurnDirectoryGrant(approvedDirectory);
          emitGrantAudit("degraded-to-turn");
          return;
        }
        invocationPermissionContext.onSessionDirectoryGrant(approvedDirectory);
        emitGrantAudit("session");
        return;
      }
      // "always" — dispatchPermissionDirCommand already persisted the rule
      // inside requestOutOfAllowedDirectoryAccess; emit the audit row here
      // so forensic replay sees a unified grant timeline across all three
      // lifetimes.
      emitGrantAudit("always");
    };

    if (invocationCategory === "shell") {
      while (true) {
        const shellPathViolation = shellPathPolicyViolation(
          finalInput,
          executionCwd,
          invocationRuntimeAllowedDirectories,
        );
        if (!shellPathViolation) break;

        if (shellPathViolation.kind === "sandbox-boundary" && shellPathViolation.path) {
          const canonicalPath = caseFoldForMatch(canonicalizePathForMatch(shellPathViolation.path));
          const dirLayerResult: PermissionCheckResult = {
            decision: "ask",
            reason: `out-of-allowed-dir: ${shellPathViolation.path} (not in additionalDirectories)`,
            layer: 1,
            denyReasons: [
              {
                layer: 1,
                reason: "out-of-allowed-dir",
                source: "directory-policy",
              },
            ],
          };
          const resolution = await requestOutOfAllowedDirectoryAccess(
            { filePath: shellPathViolation.path, canonicalPath },
            dirLayerResult,
            null,
            [],
          );
          if (!resolution.allowed) return resolution.result;
          if (resolution.permissionResult) permissionResult = resolution.permissionResult;
          applyApprovedDirectory(resolution.approvedDirectory);
          propagateGrantScope(resolution.approvedDirectory, resolution.scope);
          continue;
        }

        const msg = t("be_executor.shellPathPolicyBlock", { name: toolUse.name, reason: shellPathViolation.reason });
        const durationMs = Date.now() - startTime;
        const blockedPermission: PermissionCheckResult = {
          decision: "deny",
          reason: shellPathViolation.reason,
          layer: 0,
          denyReasons: [
            { layer: 0, reason: "shell-path-policy", source: "directory-policy" },
          ],
        };
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
      }
    }

    // ── Step 2.5: Bash AST Pre-Validator ────────────
    //
    // Hooks are allowed to rewrite tool inputs. Validate the final invocation,
    // not the original provider payload, so a hook cannot approve one command
    // and execute another.
    if (this.bashAstValidator) {
      const bashResult = this.bashAstValidator.validate(toolUse.name, finalInput);
      if (bashResult.decision === "deny") {
        const msg = t("be_executor.bashAstBlock", { reason: bashResult.reason ?? "", patternId: bashResult.patternId ?? "" });
        const durationMs = Date.now() - startTime;
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { decision: "deny", reason: bashResult.reason ?? "bash AST", layer: 0 }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
      }
      if (bashResult.decision === "warn") {
        log.warn(`${bashResult.reason}`);
      }
    }

    const targetFilePaths = extractTargetFilePaths(tool, finalInput, executionCwd);
    // Frozen-canonical contract: canonicalize once here and reuse the same
    // string for Layer 0 (sensitive-path) + Layer 1
    // (allowed-directories) checks below. No layer re-resolves the path.
    const canonicalTargets = targetFilePaths.map((filePath) => ({
      filePath,
      canonicalPath: caseFoldForMatch(canonicalizePathForMatch(filePath)),
    }));
    const sensitiveTarget = canonicalTargets
      .map((target) => ({ ...target, pattern: isSensitivePath(target.canonicalPath) }))
      .find((target) => target.pattern);
    const targetFilePath = canonicalTargets[0]?.filePath;
    const sensitivePathPattern = sensitiveTarget?.pattern ?? null;

    if (source === "plugin" && invocationPermissionContext.allowedPluginIds) {
      const pluginAllowed = !!tool.pluginId && invocationPermissionContext.allowedPluginIds.has(tool.pluginId);
      if (!pluginAllowed) {
        const msg = t("be_executor.permBlockPluginOutOfScope", { name: toolUse.name, pluginId: tool.pluginId ?? "(unknown)" });
        const durationMs = Date.now() - startTime;
        const blockedPermission: PermissionCheckResult = {
          decision: "deny",
          reason: "plugin tool outside active allowed plugin scope",
          layer: 0,
        };
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
      }
    }

    if (sensitivePathPattern) {
      const msg = t("be_executor.sensitivePathBlock", { name: toolUse.name, source, filePath: sensitiveTarget?.filePath ?? "", pattern: sensitivePathPattern ?? "" });
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
      await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    }

    // ── Step 2.6: Layer 1 — Allowed Directories ─────
    //
    // Frozen-canonical: reuse `canonicalTargetPath` from above (already
    // realpath'd + case-folded). No re-canonicalization in this block.
    //
    // Skipped when no path-typed input was extracted (e.g. MCP network
    // calls). Shell tools run the same Layer 1 request path above because
    // their filesystem operands are parsed from the command string. Native
    // host tools and plugin tools both declare
    // path-bearing arguments on Tool.pathFields; plugin entries are copied
    // from SDK manifest authority metadata by plugin-tool-adapter.
    if (canonicalTargets.length > 0) {
      while (true) {
        const outOfAllowedTarget = canonicalTargets.find(
          (target) => !isPathAllowed(target.canonicalPath, invocationAllowedScope),
        );
        if (!outOfAllowedTarget) break;
        const dirLayerResult: PermissionCheckResult = {
          decision: "ask",
          reason: `out-of-allowed-dir: ${outOfAllowedTarget.filePath} (not in additionalDirectories)`,
          layer: 1,
          denyReasons: [
            {
              layer: 1,
              reason: "out-of-allowed-dir",
              source: "directory-policy",
            },
          ],
        };
        const resolution = await requestOutOfAllowedDirectoryAccess(
          outOfAllowedTarget,
          dirLayerResult,
          sensitivePathPattern,
          tool.pathFields ?? [],
        );
        if (!resolution.allowed) return resolution.result;
        if (resolution.permissionResult) permissionResult = resolution.permissionResult;
        applyApprovedDirectory(resolution.approvedDirectory);
        propagateGrantScope(resolution.approvedDirectory, resolution.scope);
        // allow-once / allow-session / allow-always — fall through to Step 3
        // (full Layer 3 check still runs; Layer 1 is necessary, not
        // sufficient).
      }
    }
    const evaluationContext = makeEvaluationContext({
      pathFields: tool.pathFields ?? [],
      targetFilePaths,
      sensitivePathsAdjacent: sensitivePathPattern ? [sensitivePathPattern] : [],
    });

    // ── Step 3: Permission (source-aware) ───────────
    //
    // Permission policy Layer 3 — `meta` category tools take an explicit decisionOverride
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
    //     just signals "skip automatic approval lanes".
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
        overlayTriggerOrigin,
        invocationPermissionContext,
      );
      // Permission policy — meta tools with decisionOverride="ask" force the approval
      // modal regardless of the registry descriptor's "override" lane.
      // The override means "skip automatic approval lanes"; the registry already
      // returns "allow" for `meta` (override sentinel) so we must elevate
      // to ask here when the tool author marked it sensitive.
      if (metaOverride === "ask" && permissionResult.decision === "allow") {
        permissionResult = {
          decision: "ask",
          reason: t("be_executor.metaToolAskOverrideReason"),
          layer: 6,
        };
      }
      if (permissionResult.decision === "ask" && permissionResult.reviewer?.route === "foreground-auto") {
        const reviewerResult = await this.dispatchReviewerForInteractiveAuto(
          toolUse.name,
          source,
          invocationCategory,
          tool.pathFields ?? [],
          reviewerInput,
          finalInput,
          invocationAllowedScope.directories,
          sensitivePathPattern ? [sensitivePathPattern] : [],
          invocationPermissionContext,
          evaluationContext,
          // Issue #664 P1 — manifest-declared sandbox-write self-attestation
          // populated from the Tool descriptor. `ownerPluginSandboxRoot` is
          // computed only when the tool is plugin-owned; builtin / MCP tools
          // have no sandbox root and the auto-LOW rule will not engage.
          {
            writesToOwnSandbox: tool.writesToOwnSandbox,
            ownerPluginSandboxRoot: tool.pluginId
              ? pathResolve(lvisHome(), "plugins", tool.pluginId)
              : undefined,
          },
          callbacks,
          meta,
          approvalPurpose,
          abortSignal,
        );
        if (reviewerResult) {
          permissionResult = reviewerResult;
        }
      }
      if (permissionResult.decision === "deny") {
        const msg = t("be_executor.permBlockDeny", { name: toolUse.name, source, trust, reason: permissionResult.reason });
        const durationMs = Date.now() - startTime;
        // Use finalInput (post-PreToolUse hook) so audit/UI never show stale
        // pre-hook args for a hook-modified invocation.
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
      }
      if (permissionResult.decision === "ask") {
        if (invocationPermissionContext.headless === true) {
          const headlessReviewerRoute =
            permissionResult.reviewer?.route === "headless" ||
            this.permissionManager?.getMode() === "strict";
          if (!headlessReviewerRoute) {
            const headlessDeny: PermissionCheckResult = {
              decision: "deny",
              reason: `headless explicit approval unavailable: ${permissionResult.reason}`,
              layer: permissionResult.layer,
            };
            const msg = t("be_executor.permBlockHeadlessDeny", { name: toolUse.name, source, reason: headlessDeny.reason });
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, headlessDeny, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
          }
          const reviewerResult = await this.dispatchReviewerForHeadless(
            toolUse.name,
            source,
            invocationCategory,
            tool.pathFields ?? [],
            reviewerInput,
            finalInput,
            invocationAllowedScope.directories,
            sensitivePathPattern ? [sensitivePathPattern] : [],
            invocationPermissionContext,
            evaluationContext,
            // Issue #664 P1 — sandbox-write attestation (see interactive
            // call site for rationale).
            {
              writesToOwnSandbox: tool.writesToOwnSandbox,
              ownerPluginSandboxRoot: tool.pluginId
                ? pathResolve(lvisHome(), "plugins", tool.pluginId)
                : undefined,
            },
            callbacks,
            meta,
            approvalPurpose,
            abortSignal,
          );
          if (reviewerResult.allowed) {
            permissionResult = reviewerResult.permissionResult;
          } else {
            const msg = reviewerResult.message;
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, reviewerResult.permissionResult, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
          }
        }
      }
      if (permissionResult.decision === "ask") {
        if (this.approvalGate) {
          // Layer 3: wire target.filePath + isReadOnly + mode so the
          // approval gate can apply sensitive-path and read-only checks to
          // the exact invocation shown to the user.
          const approvalRequest = {
            id: randomUUID(),
            category: "tool" as const,
            toolName: toolUse.name,
            toolCategory: invocationCategory,
            reviewerVerdict: permissionResult.reviewer?.verdict,
            ...(approvalPurpose ? { approvalPurpose } : {}),
            args: finalInput,
            reason: permissionResult.reason,
            source: source as "builtin" | "plugin" | "mcp",
            createdAt: Date.now(),
            ...(targetFilePath ? { target: { filePath: targetFilePath } } : {}),
            isReadOnly: invocationCategory === "read",
            mode: this.currentApprovalMode(),
            sensitivePathPattern,
            trustOrigin: invocationPermissionContext.trustOrigin,
            // Propagate approvalCacheKey so renderer record key
            // matches dispatchReviewer lookup key — end-to-end symmetry.
            ...(approvalCacheKey ? { approvalCacheKey } : {}),
            // Issue #691 round-1 — sandbox capability for the dialog.
            sandboxCapability: detectSandboxCapability(),
            evaluationContext,
          };

          const permHook = await this.runScriptHook(
            "perm",
            toolUse.name,
            source,
            invocationCategory,
            finalInput,
            sessionId,
            invocationPermissionContext,
          );
          if (permHook.decision === "deny") {
            const msg = t("be_executor.hookPermissionBlock", { reason: permHook.reason });
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...permissionResult, decision: "deny", reason: permHook.reason }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
          }

          // §F3: requestAndWait 실패 시 감사 로그 보장 후 deny-once 처리
          let decision;
          try {
            await this.auditPermissionAsk(
              toolUse.name,
              source,
              invocationCategory,
              finalInput,
              permissionResult,
              executionCwd,
              invocationPermissionContext,
              targetFilePath,
            );
            decision = await this.approvalGate.requestAndWait(approvalRequest);
          } catch (approvalErr) {
            const msg = t("be_executor.approvalGateError", { name: toolUse.name, error: approvalErr instanceof Error ? approvalErr.message : String(approvalErr) });
            const durationMs = Date.now() - startTime;
            // finalInput keeps audit/UI consistent with the args shown to the
            // approval gate (which already uses finalInput in approvalRequest).
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, {
              ...permissionResult,
              decision: "deny",
              reason: `approval gate error: ${approvalErr instanceof Error ? approvalErr.message : String(approvalErr)}`,
            }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
          }

          if (decision.choice.startsWith("deny")) {
            // deny-always: 영구 거부 규칙 추가
            if (decision.choice === "deny-always" && this.permissionManager) {
              const pattern = approvalCacheKey ?? decision.rememberPattern ?? toolUse.name;
              await this.permissionManager.addAlwaysDeniedPersist(pattern);
            }
            const msg = t("be_executor.approvalDeniedByUser", { name: toolUse.name });
            const durationMs = Date.now() - startTime;
            // finalInput matches the args the user actually saw + denied via
            // approvalRequest — never log stale pre-hook input here.
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, {
              ...permissionResult,
              decision: "deny",
              reason: "user denied approval request",
            }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
          }

          // allow-always: 영구 허용 규칙 추가
          if (decision.choice === "allow-always" && this.permissionManager) {
            const pattern = approvalCacheKey ?? decision.rememberPattern ?? toolUse.name;
            await this.permissionManager.addAlwaysAllowedPersist(pattern);
          }
          permissionResult = {
            decision: "allow",
            reason: `user approved approval request (${decision.choice})`,
            layer: permissionResult.layer,
          };
          // allow-once / allow-always: 실행 계속
        } else {
          // §F4: approvalGate 미연결 시 fail-closed — 모든 ask 결정을 차단
          const msg = t("be_executor.approvalGateMissing", { name: toolUse.name, source, reason: permissionResult.reason });
          const durationMs = Date.now() - startTime;
          log.error(msg);
          // finalInput so audit reflects post-hook args even when the gate is
          // unavailable.
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, {
            ...permissionResult,
            decision: "deny",
            reason: `approval gate missing: ${permissionResult.reason}`,
          }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
        }
      }
    }

    const scriptPre = await this.runScriptHook(
      "pre",
      toolUse.name,
      source,
      invocationCategory,
      finalInput,
      sessionId,
      invocationPermissionContext,
    );
    if (scriptPre.decision === "deny") {
      const msg = t("be_executor.hookBlockScript", { reason: scriptPre.reason });
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { decision: "deny", reason: scriptPre.reason, layer: 6 }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    }

    // ── Step 5: Rate Limit (trust별) ────────────────
    const rateResult = this.rateLimiter.check(toolUse.name, trust);
    if (!rateResult.allowed) {
      const msg = t("be_executor.rateLimitExceeded", { name: toolUse.name, trust });
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, 0, invocationPermissionContext, invocationCategory, executionCwd);
      return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
    }

    if (this.requirePermissionAuditChain) {
      try {
        this.auditLogger.assertPermissionAuditWritable();
      } catch (err) {
        const msg = t("be_executor.auditChainBlock", { name: toolUse.name, error: err instanceof Error ? err.message : String(err) });
        const durationMs = Date.now() - startTime;
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        this.auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: sessionId ?? "unknown",
          type: "tool_call",
          input: maskSensitiveData(JSON.stringify(finalInput)).masked.slice(0, 500),
          output: msg.slice(0, 1024),
          toolCalls: [{
            name: toolUse.name,
            isError: true,
            source,
            trust,
            executionTimeMs: durationMs,
            permissionDecision: "deny",
            permissionReason: "permission audit chain unavailable before execution",
            rateLimitRemaining: rateResult.remaining,
          }],
        });
        return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
      }
    }

    emitToolStart(callbacks, toolUse.name, finalInput, meta);

    // ── Step 6: Execute ─────────────────────────────
    let content: string;
    let isError = false;
    let uiPayload: import("../mcp/types.js").McpUiPayload | undefined;
    let rawResult: unknown;

    const executionContext: ToolExecutionContext = {
      cwd: executionCwd,
      extraAllowedDirectories: [...new Set(invocationRuntimeAllowedDirectories)],
      metadata: {
        sessionId: sessionId ?? "unknown",
        // C3(b): spawn depth visible to tools — `agent_spawn` reads this
        // and refuses when >= 1 (a sub-agent cannot itself spawn).
        spawnDepth: spawnDepth ?? 0,
        // Tool 자기 호출의 stable id — 렌더러가 inline UI 카드 (sub-agent 등)
        // 를 ToolGroupCard 옆에 join 할 때 키로 사용. agent_spawn 이 emit 하는
        // 라이프사이클 이벤트에 함께 실어 보냄.
        toolUseId: toolUse.id,
        trustOrigin: invocationPermissionContext.trustOrigin,
        ...(toolResultChunkReader
          ? { [TOOL_RESULT_CHUNK_READER_METADATA_KEY]: toolResultChunkReader }
          : {}),
      },
      abortSignal,
    };

    // Global ceiling via `runWithCeiling` helper — last-resort cap with a
    // linked AbortController so the underlying tool work actually stops
    // (tools that participate in `executionContext.abortSignal` propagate
    // the cancellation). `agent_spawn` runs a full sub-agent loop and uses
    // the larger `subAgentCeilingMs` instead of the per-tool cap.
    const effectiveCeilingMs =
      toolUse.name === "agent_spawn"
        ? TOOL_TIMEOUT_POLICY.subAgentCeilingMs
        : TOOL_TIMEOUT_POLICY.globalCeilingMs;
    let terminationReason: "ok" | "ceiling" | "user-abort" | "error" = "ok";
    const outcome = await runWithCeiling(
      async (signal) => {
        const ctx: ToolExecutionContext = { ...executionContext, abortSignal: signal };
        return tool.execute(finalInput, ctx);
      },
      effectiveCeilingMs,
      abortSignal,
      toolUse.name,
    );
    if (outcome.ok) {
      const result = outcome.value;
      content = result.output;
      isError = result.isError;
      // MCP Apps §3.2 — propagate uiPayload from tool metadata
      if (result.metadata?.uiPayload) {
        uiPayload = result.metadata.uiPayload as import("../mcp/types.js").McpUiPayload;
      }
      if (Object.prototype.hasOwnProperty.call(result.metadata ?? {}, "rawResult")) {
        rawResult = result.metadata?.rawResult;
      }
      if (isError) terminationReason = "error";
    } else {
      terminationReason = outcome.reason;
      content =
        outcome.reason === "ceiling"
          ? `tool execution exceeded global ceiling (${effectiveCeilingMs}ms): ${toolUse.name}`
          : outcome.reason === "user-abort"
            ? t("be_executor.toolExecutionCancelled")
            : outcome.error.message || t("be_executor.toolExecutionUnknownError");
      isError = true;
    }

    if (terminationReason === "user-abort") {
      const durationMs = Date.now() - startTime;
      callbacks?.onToolEnd?.(toolUse.name, content, true, meta, undefined, durationMs);
      await this.auditToolCall(
        sessionId,
        toolUse.name,
        source,
        trust,
        finalInput,
        content,
        true,
        startTime,
        permissionResult,
        rateResult.remaining,
        invocationPermissionContext,
        invocationCategory,
        executionCwd,
        targetFilePath,
        terminationReason,
      );
      return { tool_use_id: toolUse.id, content, is_error: true, durationMs };
    }

    // ── Step 7: PostHook + Feedback Merge ───────────
    const postFeedback = await this.hookRunner.runPostHooks({
      toolName: toolUse.name,
      toolInput: finalInput,
      toolOutput: content,
      isError,
    });
    const scriptPost = await this.runScriptHook(
      "post",
      toolUse.name,
      source,
      invocationCategory,
      finalInput,
      sessionId,
      invocationPermissionContext,
      content,
      isError,
    );

    if (postFeedback) content = `${content}\n\n[Hook Feedback]\n${postFeedback}`;
    if (scriptPost.results.length > 0 && scriptPost.decision === "deny") {
      content = `${content}\n\n[Script Hook Feedback]\n${scriptPost.reason}`;
    }
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
    // Redact the user's freeText answer before it lands in the audit
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
    await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, auditContent, isError, startTime, permissionResult, rateResult.remaining, invocationPermissionContext, invocationCategory, executionCwd, targetFilePath, terminationReason);

    return {
      tool_use_id: toolUse.id,
      content,
      ...(isError && { is_error: true }),
      ...(uiPayload && { uiPayload }),
      ...(rawResult !== undefined && { rawResult }),
      durationMs,
    };
  }

  // ─── Audit (불변 — 항상 실행) ────────────────────

  /**
   * Emit an `AuditAllow` row when the user resolves an out-of-allowed-dir
   * approval (allow-once / allow-session / allow-always) — or when
   * `propagateGrantScope` had to degrade a session-intent grant to turn
   * scope because the session callback was unwired. Decoupled from
   * `auditToolCall` so the per-tool audit row can stay focused on
   * execution outcome while the directory-grant decision lives in a
   * dedicated forensic row tied to the dialog click.
   */
  private async auditPermissionGrant(args: {
    toolName: string;
    source: ToolSource;
    category: ToolCategory;
    directory: string;
    grantLifetime: "turn" | "session" | "always" | "degraded-to-turn";
    permissionContext?: ToolPermissionContext;
  }): Promise<void> {
    if (!this.auditLogger.isPermissionAuditChainReady()) {
      if (this.requirePermissionAuditChain) {
        throw new Error("permission audit chain is not initialized");
      }
      return;
    }
    const entry: PermissionAuditEntryInput = {
      decision: "allow",
      ts: new Date().toISOString(),
      auditId: randomUUID(),
      tool: args.toolName,
      source: args.source,
      category: args.category,
      directory: args.directory,
      directoryAllowed: true,
      grantLifetime: args.grantLifetime,
      layer: 1,
      trustOrigin: auditTrustOrigin(args.permissionContext),
    };
    try {
      await this.auditLogger.appendPermissionAuditEntry(entry);
    } catch (err) {
      if (this.requirePermissionAuditChain) {
        throw err;
      }
      log.warn(
        "permission grant audit append failed for %s (%s): %s",
        args.toolName,
        args.grantLifetime,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async auditPermissionAsk(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    input: Record<string, unknown>,
    permission: PermissionCheckResult,
    cwd: string,
    permissionContext?: ToolPermissionContext,
    auditDirectory?: string,
  ): Promise<void> {
    const tool = this.toolRegistry.findByName(toolName);
    const entry = permissionAuditAskEntryFromToolCall({
      toolName,
      tool,
      source,
      category,
      input,
      permission,
      trustOrigin: auditTrustOrigin(permissionContext),
      cwd,
      auditDirectory,
    });
    if (!this.auditLogger.isPermissionAuditChainReady()) {
      if (this.requirePermissionAuditChain) {
        throw new Error("permission audit chain is not initialized");
      }
      return;
    }
    try {
      await this.auditLogger.appendPermissionAuditEntry(entry);
    } catch (err) {
      if (this.requirePermissionAuditChain) {
        throw err;
      }
      log.warn(
        "permission ask audit append failed for %s: %s",
        toolName,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async auditToolCall(
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
    permissionContext?: ToolPermissionContext,
    category?: ToolCategory,
    cwd?: string,
    auditDirectory?: string,
    terminationReason?: "ok" | "ceiling" | "user-abort" | "error",
  ): Promise<void> {
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
          permissionDecision: permission?.deferred ? "deferred" : permission?.decision ?? "allow",
          permissionReason: permission?.reason,
          rateLimitRemaining,
          ...(terminationReason ? { terminationReason } : {}),
        }],
      });
    } catch (err) {
      log.warn(
        "general tool audit failed for %s: %s",
        toolName,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!category || !cwd) {
      return;
    }
    const tool = this.toolRegistry.findByName(toolName);
    const entry = permissionAuditEntryFromToolCall({
      toolName,
      tool,
      source,
      category,
      input,
      permission,
      rateLimitRemaining,
      trustOrigin: auditTrustOrigin(permissionContext),
      cwd,
      auditDirectory,
    });
    if (!this.auditLogger.isPermissionAuditChainReady()) {
      if (this.requirePermissionAuditChain) {
        throw new Error("permission audit chain is not initialized");
      }
      return;
    }
    try {
      await this.auditLogger.appendPermissionAuditEntry(entry);
    } catch (err) {
      if (this.requirePermissionAuditChain) {
        throw err;
      }
      log.warn(
        "permission audit append failed for %s: %s",
        toolName,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

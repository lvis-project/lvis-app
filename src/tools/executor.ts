



import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import type { Tool } from "./base.js";
import { isModelExposedTool } from "./base.js";
import type { ToolRegistry } from "./registry.js";
// Effective invocation-origin SoT (AsyncLocalStorage). The plugin-surface executor
// enters a `runWithInvocationOrigin` frame for every card/panel/plugin call, so this
// is defined ("mcp-app" | "ui" | "plugin") ONLY on that path; the model's main-loop
// executor runs in no frame → `undefined`. That is the one signal separating a
// governed card/panel invocation from the model lane (MAJOR-1). Leaf module (imports
// only node:async_hooks) — no cycle.
import { currentInvocationOrigin } from "../plugins/runtime/origin-chain.js";
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
import { PermissionManager, requiredTier, type PermissionCheckResult } from "../permissions/permission-manager.js";
import type { ApprovalGate, ApprovalMode } from "../permissions/approval-gate.js";
import {
  buildPermissionEvaluationContext,
  type PermissionEvaluationContext,
} from "../permissions/evaluation-context.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";
import {
  buildAllowedScope,
  buildRuntimeAllowedDirectories,
  isFilesystemRootPath,
  pickClosestParent,
  validateDirectoryAddition,
} from "../permissions/allowed-directories.js";
import { dispatchPermissionDirCommand } from "../permissions/permission-slash.js";
import { HookRunner } from "../hooks/hook-runner.js";
import type { ScriptHookManager, HookDispatchResult } from "../hooks/script-hook-manager.js";
import type { HookTrustOrigin } from "../hooks/script-hook-types.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { HookResult } from "../audit/audit-schema.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import type { RiskVerdict } from "../permissions/reviewer/risk-classifier.js";
import { emitEffectShadowLog } from "../permissions/reviewer/risk-shadow-log.js";
import { runWithEffectLedger, type EffectLedger } from "../permissions/effect-ledger.js";
import { runWithEffectGateContext } from "../permissions/effect-enforcement.js";
import { CHOKEPOINT_EFFECT } from "../permissions/effect-kind.js";
import { resolveReviewerSandboxCapability } from "../permissions/sandbox-capability.js";
import { lvisHome } from "../shared/lvis-home.js";
import type {
  ApprovalPurposeSuggestion,
  PermissionReviewEvent,
} from "../shared/permission-review-status.js";
import { BashAstValidator } from "../main/bash-ast-validator.js";
import { createLogger } from "../lib/logger.js";
import {
  TOOL_RESULT_CHUNK_READER_METADATA_KEY,
  type ToolResultChunkReader,
} from "./tool-result-chunk.js";
import { t } from "../i18n/index.js";
// ── C7 pipeline decomposition — behavior-preserving extracted units.
// executor.ts remains the orchestrator (executeAll/executeOne bodies + the
// 7-export barrel); these compose the LOW/MEDIUM-risk clusters. See
// ./pipeline/*.ts. The HIGHEST-risk executeOne closures stay here (C8).
import { extractTargetFilePaths, shellPathPolicyViolation } from "./pipeline/path-extraction.js";
import { buildApprovalPurposeSuggestion } from "./pipeline/approval-purpose.js";
import {
  hookChainFromDispatch,
  mergeHookChains,
  redactAskUserAuditOutput,
} from "./pipeline/audit-entries.js";
import {
  approvalCacheKeyFor,
  emitToolStart,
  maskToolInputForDisplay,
  summarizeInputForDeferred,
} from "./pipeline/display-mask.js";
import { RateLimiter } from "./pipeline/rate-limiter.js";
import { ReviewerAuthorizationStore } from "./pipeline/reviewer-authorization-store.js";
import { resolveEnforcedCategory as resolveEnforcedCategoryImpl } from "./pipeline/risk-classification.js";
import { tryUserApprovalMemorySkip as tryUserApprovalMemorySkipImpl } from "./pipeline/approval-memory-skip.js";
import {
  dispatchReviewerForHeadless as dispatchReviewerForHeadlessImpl,
  dispatchReviewerForInteractiveAuto as dispatchReviewerForInteractiveAutoImpl,
} from "./pipeline/reviewer-dispatch.js";
import { AuditWriter } from "./pipeline/audit-writer.js";
// ── C8 pipeline decomposition — the per-invocation mutable-state contract +
// initial-state factory + the self-contained user-abort helper. The two
// SECURITY-CRITICAL sandbox filesystem-containment relaxation blocks and their
// mutable locals stay INLINE in executeOne (byte-identical). See
// ./pipeline/invocation-context.ts for what was deliberately left inline.
import { createInvocationContext, returnUserAbort } from "./pipeline/invocation-context.js";
const log = createLogger("executor");
/**
 * One-time guard for the shadow-sink construction warning. Process-wide so the
 * permission-shadow reconciliation dataset's deliverability is flagged at most
 * once even when many ToolExecutors are constructed (boot wires one production
 * executor; tests construct many). See {@link ToolExecutor.warnIfShadowSinkUnwired}.
 */
let shadowSinkWarningEmitted = false;

export interface ToolCallMeta {
  groupId: string;
  toolUseId: string;
  displayOrder: number;
  source?: ToolSource;
  category?: ToolCategory;
  pluginId?: string;
  workerId?: string;
  mcpServerId?: string;
}

function resolveInvocationCategory(
  tool: import("./base.js").Tool,
  finalInput: Record<string, unknown>,
): ToolCategory {
  return tool.categoryForInput?.(finalInput) ?? tool.category;
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
   * True when a plugin invocation is rooted in a direct plugin panel/renderer
   * user action. This suppresses the normal foreground agent approval modal for
   * plugin tools only; Layer 1 denies, Layer 2 hard asks, forceModal asks, and
   * operator perm-hook denies still apply.
   */
  pluginPanelUserAction?: boolean;
  /**
   * Recent user-authored turn text. Used only to provide reviewer context
   * and prefill the high-risk approval purpose field; plugin/file origins
   * should leave this absent.
   */
  userIntent?: string;
  /**
   * User-keyboard-only approval phrase for the conversational reviewer retry
   * path. Unlike `userIntent`, this is never populated for queue/headless/plugin
   * origins; executor still requires a matching pending reviewer-blocked exact
   * action before it can authorize anything.
   */
  explicitAuthorizationIntent?: string;



  onTurnDirectoryGrant?: (approvedDirectory: string) => void;



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
  /**
   * Permission policy host-classifies-risk migration gate. When this returns
   * `true`, {@link resolveEnforcedCategory} enforces the host-derived category;
   * when `false` (default) it enforces the plugin-declared category. Shadow
   * logging runs regardless. Defaults to always-off so existing call sites and
   * tests keep their current behaviour without change.
   */
  private readonly hostClassifiesRiskProvider: () => boolean;
  /**
   * Filesystem-containment interlock for the foreground plugin read-relaxation.
   * The relaxation (see executeOne's effect-boundary block) removes the pre-exec
   * ask and relies on the host-mediated effect-boundary gate. That is safe only
   * when this specific plugin tool is backed by an execution substrate that
   * filesystem-contains off-hostApi mutations (direct `node:fs` / bare `fetch` /
   * detached async frames). A process-global "sandbox active" boolean is not
   * enough. Defaults to always-off so existing call sites/tests fall back to the
   * known-safe pre-exec ask.
   */
  private readonly sandboxFsContainedProvider: (tool: Tool) => boolean;
  private readonly reviewerAuthorizations = new ReviewerAuthorizationStore();
  private readonly auditWriter: AuditWriter;

  constructor(
    toolRegistry: ToolRegistry,
    hookRunner?: HookRunner,
    permissionManager?: PermissionManager,
    bashAstValidator?: BashAstValidator,
    approvalGate?: ApprovalGate,
    scriptHookManager?: ScriptHookManager,
    auditLogger?: AuditLogger,
    hostClassifiesRiskProvider?: () => boolean,
    sandboxFsContainedProvider?: (tool: Tool) => boolean,
  ) {
    this.toolRegistry = toolRegistry;
    this.hookRunner = hookRunner ?? new HookRunner();
    this.permissionManager = permissionManager;
    this.approvalGate = approvalGate;
    this.auditLogger = auditLogger ?? new AuditLogger();
    this.bashAstValidator = bashAstValidator;
    this.scriptHookManager = scriptHookManager;
    this.hostClassifiesRiskProvider = hostClassifiesRiskProvider ?? (() => false);
    this.sandboxFsContainedProvider = sandboxFsContainedProvider ?? (() => false);
    this.requirePermissionAuditChain = auditLogger?.isPermissionAuditChainReady() === true;
    this.auditWriter = new AuditWriter(
      this.auditLogger,
      this.toolRegistry,
      this.scriptHookManager,
      this.requirePermissionAuditChain,
    );
    this.warnIfShadowSinkUnwired(auditLogger === undefined);
  }

  /**
   * Observability dataset detectability — the permission-shadow reconciliation
   * records (risk + effect shadow) are the ONLY output of the host-effect
   * observability stage, and {@link emitRiskShadowLog}/{@link emitEffectShadowLog}
   * deliberately swallow {@link AuditLogger.logShadow} failures so the shadow path
   * can never break a tool call. The cost is that a silently-empty dataset is
   * undetectable: an executor wired without a real AuditLogger (the `?? new
   * AuditLogger()` fallback) or one whose shadow channel is unwritable would drop
   * the entire dataset with no signal. Surface a ONE-TIME warning so that
   * condition is detectable. Never throws — observability must never break a tool
   * call, and a logging probe must not break construction.
   */
  private warnIfShadowSinkUnwired(unwired: boolean): void {
    if (shadowSinkWarningEmitted) return;
    try {
      if (unwired) {
        shadowSinkWarningEmitted = true;
        log.warn(
          "[permission-shadow] ToolExecutor constructed without an AuditLogger — the host-effect reconciliation dataset is routed to a fresh fallback channel; verify the production executor wires the shared AuditLogger.",
        );
        return;
      }
      if (!this.auditLogger.isShadowChannelWritable()) {
        shadowSinkWarningEmitted = true;
        log.warn(
          "[permission-shadow] shadow reconciliation channel is unwritable (%s) — risk/effect shadow records will be silently dropped.",
          this.auditLogger.getPermissionShadowLogFile(),
        );
      }
    } catch {
      // A detectability probe must never break ToolExecutor construction.
    }
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

  private recordPendingReviewerAuthorization(input: {
    sessionId: string | undefined;
    toolName: string;
    source: ToolSource;
    finalInput: Record<string, unknown>;
    context: ToolPermissionContext;
    verdict: RiskVerdict;
  }): void {
    this.reviewerAuthorizations.record(input);
  }

  private consumePendingReviewerAuthorization(input: {
    sessionId: string | undefined;
    toolName: string;
    source: ToolSource;
    finalInput: Record<string, unknown>;
    context: ToolPermissionContext;
  }): PermissionCheckResult | null {
    return this.reviewerAuthorizations.consume(input);
  }

  getHookRunner(): HookRunner {
    return this.hookRunner;
  }

  /**
   * Permission policy host-classifies-risk — resolve the EFFECTIVE category the
   * policy pipeline will enforce for this invocation, and emit the shadow log.
   *
   * Shadow mode (always on): compute the host-derived category from host-owned
   * signals ({@link inspectHostRisk}) and log it against the declared category
   * so divergence can be reconciled across plugins before enforcement flips.
   *
   * Enforcement: when {@link hostClassifiesRiskProvider} returns `false`
   * (the default), the DECLARED category is returned unchanged — behaviour
   * is identical to before this method existed. When it returns `true`, the
   * host-derived category is returned (default-strict: never below the declared
   * level is NOT asserted here — the inspector itself never classifies down to
   * read without positive evidence).
   */
  private resolveEnforcedCategory(
    tool: import("./base.js").Tool,
    declaredCategory: ToolCategory,
    finalInput: Record<string, unknown>,
    allowedDirectories: readonly string[],
    correlationId: string,
  ): ToolCategory {
    return resolveEnforcedCategoryImpl({
      tool,
      declaredCategory,
      finalInput,
      allowedDirectories,
      correlationId,
      hostClassifiesRisk: this.hostClassifiesRiskProvider(),
      auditLogger: this.auditLogger,
    });
  }

  private async runScriptHook(
    hookType: "pre" | "post" | "perm",
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    input: Record<string, unknown>,
    sessionId: string | undefined,
    context: ToolPermissionContext,
    mcpServerId?: string,
    pluginId?: string,
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
      // Per-request MCP/plugin origin identity (#811 hooks-on-mcp-calls).
      ...(mcpServerId !== undefined ? { mcpServerId } : {}),
      ...(pluginId !== undefined ? { pluginId } : {}),
      ...(toolOutput !== undefined ? { toolOutput } : {}),
      ...(isError !== undefined ? { isError } : {}),
    };
    if (hookType === "pre") return this.scriptHookManager.runPreToolUse(payload);
    if (hookType === "post") return this.scriptHookManager.runPostToolUse(payload);
    return this.scriptHookManager.runPermissionRequest(payload);
  }

  /**
   * Fire a NON-BLOCKING lifecycle event (#811 milestone-2). OBSERVE-ONLY: the
   * returned decision is recorded in audit but NEVER affects control flow — the
   * executor ignores it. Fail-soft: the manager's `runLifecycleEvent` never
   * throws, but we additionally swallow any unexpected error so a lifecycle hook
   * can never break a tool call. No-op when the manager is unwired (back-compat:
   * no hooks.json ⇒ no lifecycle dispatch, behavior identical).
   */
  private async fireLifecycleEvent(
    event: "PostToolUseFailure" | "PermissionDenied",
    sessionId: string | undefined,
    context: ToolPermissionContext,
    payload: import("../hooks/script-hook-manager.js").LifecycleEventPayload,
  ): Promise<HookDispatchResult | undefined> {
    return this.auditWriter.fireLifecycleEvent(event, sessionId, context, payload);
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
    sandboxAttestation: { ownerPluginSandboxRoot?: string },
    callbacks: ToolExecutorCallbacks | undefined,
    meta: ToolCallMeta,
    approvalPurpose: ApprovalPurposeSuggestion | undefined,
    abortSignal?: AbortSignal,
  ): Promise<
    | { allowed: true; permissionResult: PermissionCheckResult }
    | { allowed: false; message: string; permissionResult: PermissionCheckResult }
  > {
    return dispatchReviewerForHeadlessImpl(
      this.permissionManager,
      toolName,
      source,
      category,
      pathFields,
      finalInput,
      cacheIdentityInput,
      allowedDirectories,
      sensitivePathsAdjacent,
      context,
      evaluationContext,
      sandboxAttestation,
      callbacks,
      meta,
      approvalPurpose,
      abortSignal,
    );
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
    sandboxAttestation: { ownerPluginSandboxRoot?: string },
    callbacks: ToolExecutorCallbacks | undefined,
    meta: ToolCallMeta,
    approvalPurpose: ApprovalPurposeSuggestion | undefined,
    abortSignal?: AbortSignal,
  ): Promise<PermissionCheckResult | null> {
    return dispatchReviewerForInteractiveAutoImpl(
      this.permissionManager,
      toolName,
      source,
      category,
      pathFields,
      finalInput,
      cacheIdentityInput,
      allowedDirectories,
      sensitivePathsAdjacent,
      context,
      evaluationContext,
      sandboxAttestation,
      callbacks,
      meta,
      approvalPurpose,
      abortSignal,
    );
  }

  /** Store B explicit-approval memory skip — see ./pipeline/approval-memory-skip.ts. */
  private async tryUserApprovalMemorySkip(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    pathFields: readonly string[],
    finalInput: Record<string, unknown>,
    allowedDirectories: string[],
    sensitivePathsAdjacent: string[],
    context: ToolPermissionContext,
    approvalCacheKey: string | undefined,
    sandboxAttestation: { ownerPluginSandboxRoot?: string },
    mcpServerId?: string,
    workerId?: string,
    pluginId?: string,
  ): Promise<PermissionCheckResult | null> {
    return tryUserApprovalMemorySkipImpl(
      toolName,
      source,
      category,
      pathFields,
      finalInput,
      allowedDirectories,
      sensitivePathsAdjacent,
      context,
      approvalCacheKey,
      sandboxAttestation,
      mcpServerId,
      workerId,
      pluginId,
    );
  }




  async executeAll(
    toolUses: ToolUseBlock[],
    opts: ExecuteOptions = {},
  ): Promise<ToolResult[]> {
    const groupId = randomUUID();
    const results: ToolResult[] = new Array(toolUses.length);
    for (let idx = 0; idx < toolUses.length;) {
      if (!this.isParallelSafeToolUse(toolUses[idx])) {
        results[idx] = await this.executeOne(toolUses[idx], groupId, idx, opts);
        idx += 1;
        continue;
      }

      const start = idx;
      while (idx < toolUses.length && this.isParallelSafeToolUse(toolUses[idx])) {
        idx += 1;
      }
      const segment = toolUses.slice(start, idx);
      const segmentResults = await Promise.all(
        segment.map((toolUse, offset) =>
          this.executeOne(toolUse, groupId, start + offset, opts),
        ),
      );
      for (let offset = 0; offset < segmentResults.length; offset++) {
        results[start + offset] = segmentResults[offset];
      }
    }
    return results;
  }

  private isParallelSafeToolUse(toolUse: ToolUseBlock): boolean {
    const tool = this.toolRegistry.findByName(toolUse.name);
    return tool?.parallelSafe === true;
  }


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
    if (tool.workerId) meta.workerId = tool.workerId;
    if (tool.mcpServerId) meta.mcpServerId = tool.mcpServerId;

    // ── MAJOR-1 (cluster review) — the model MUST NOT execute a tool hidden from it ──
    // `findByName` deliberately does NOT filter `modelVisible` (an app-only tool is a
    // registry `Tool` precisely so its CARD's governed call can run under the gate — see
    // `isModelExposedTool` / `ToolRegistry.getModelVisibleTools`). That same resolution
    // means a model `tool_use` naming an app-only tool — e.g. a prompt injection naming
    // `<plugin>_auth_login`, whose handler spawns a credentialed auth BrowserWindow —
    // would otherwise reach the handler. `modelVisible === false` means "hidden from the
    // model" by definition, so the model has no legitimate reason to call it. The
    // governed card/panel arms reach these tools through their OWN origins —
    // `PluginRuntime.callFromApp` ("mcp-app") / `callFromUi` ("ui"), both entering the
    // executor inside a `runWithInvocationOrigin` frame — so the effective invocation
    // origin is the ONE discriminator: the model's main-loop executor runs in NO frame
    // (`currentInvocationOrigin()` → `undefined`) and an LLM/plugin `ctx.callTool` is
    // `"plugin"`; neither is a governed app surface, so both are refused here, at the ONE
    // model-tool_use dispatch site. Fail-closed ALLOW-LIST (only the two governed origins
    // pass — a future origin defaults to denied). Mirrors the `toolNotFound` deny above:
    // the model-facing result is the same "not found" text (no disclosure that the hidden
    // tool exists), audited as a `deny` — never a throw. The card-arm auth-trio deny in
    // `callFromApp` is a SEPARATE, additional defense and is untouched.
    if (!isModelExposedTool(tool)) {
      const invocationOrigin = currentInvocationOrigin();
      if (invocationOrigin !== "mcp-app" && invocationOrigin !== "ui") {
        const durationMs = Date.now() - startTime;
        const modelFacing = t("be_executor.toolNotFound", { name: toolUse.name });
        const deny: PermissionCheckResult = {
          decision: "deny",
          reason: `model-hidden tool '${toolUse.name}' is not model-callable (origin: ${invocationOrigin ?? "model"})`,
          layer: 0,
        };
        await this.auditToolCall(sessionId, toolUse.name, source, trust, toolUse.input, deny.reason, true, startTime, deny, Infinity, permissionContext, invocationCategory, executionCwd);
        callbacks?.onToolEnd?.(toolUse.name, modelFacing, true, meta, undefined, durationMs);
        return { tool_use_id: toolUse.id, content: modelFacing, is_error: true, durationMs };
      }
    }

    // ── C8: user-abort terminal helper moved to ./pipeline/invocation-context.ts.
    // Its wide capture surface (source/trust/invocationCategory/meta/callbacks/…)
    // is threaded via a named-field deps object; `this.auditWriter` is passed
    // directly (executeOne's private auditToolCall was a pure pass-through).
    const abortDeps = (input: Record<string, unknown>): Parameters<typeof returnUserAbort>[0] => ({
      input,
      toolUse,
      meta,
      callbacks,
      source,
      trust,
      invocationCategory,
      sessionId,
      permissionContext,
      executionCwd,
      startTime,
      auditWriter: this.auditWriter,
    });

    if (abortSignal?.aborted) {
      return returnUserAbort(abortDeps(toolUse.input));
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
      return returnUserAbort(abortDeps(finalInput));
    }
    // ── C8: initial per-invocation state (see ./pipeline/invocation-context.ts).
    // The factory builds the Layer-1 allowed scope + runtime allowed dirs + the
    // parent/own effect ledgers exactly as the former inline initializers did,
    // including the within-round freshness read of additionalDirectories.
    // `invocationAllowedScope` / `invocationRuntimeAllowedDirectories` stay `let`
    // LOCALS here (not context fields): applyApprovedDirectory reassigns them and
    // the sandbox-relaxation blocks below read them inline — boxing them would
    // force edits inside those byte-identical trust-boundary blocks.
    const initialState = createInvocationContext(invocationPermissionContext);
    const baseAdditionalDirectories = initialState.baseAdditionalDirectories;
    let invocationAllowedScope = initialState.allowedScope;
    let invocationRuntimeAllowedDirectories = initialState.runtimeAllowedDirectories;
    // Permission policy host-classifies-risk — shadow mode (always) + enforced
    // category (flag-gated). The declared category resolved above is the input;
    // when the flag is off this is a no-op and `invocationCategory` is unchanged.
    // Snapshot the DECLARED category before resolveEnforcedCategory may swap in
    // the host-derived one (flag on) — the effect shadow reconciles the declared
    // category against the host-observed effect summary post-execution.
    const declaredCategoryForEffectShadow = invocationCategory;
    // Parent (ambient) + per-invocation effect ledgers — created in the factory
    // (parent captured BEFORE own; full rationale lives in invocation-context.ts).
    const parentEffectLedger = initialState.parentEffectLedger;
    const effectLedger: EffectLedger = initialState.effectLedger;
    invocationCategory = this.resolveEnforcedCategory(
      tool,
      invocationCategory,
      finalInput,
      invocationAllowedScope.directories,
      effectLedger.correlationId,
    );
    meta.category = invocationCategory;
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
          // under OS isolation or with no protection. Substrate-aware so a
          // plugin/MCP or in-process builtin call honestly shows "none" rather
          // than the process-global "asrt" that only the host-shell path earns
          // — and the GENUINE asrt for an ASRT-wrapped external MCP worker
          // keyed on its specific server id.
          sandboxCapability: resolveReviewerSandboxCapability(
            source,
            toolUse.name,
            tool.mcpServerId,
            tool.workerId,
            tool.pluginId,
          ),
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
    // Layer 0/1 path-scope predicate lives in PermissionManager (SOT V2).
    // The executor keeps canonicalization (above) + the layer-0 deny and
    // layer-1 modal wiring below; PM only answers "which target is sensitive
    // / out-of-allowed". Static call so this runs even when no
    // PermissionManager instance is wired (the Layer 0/1 hard-block and
    // out-of-directory prompt are not gated on `this.permissionManager`).
    const sensitiveTarget = PermissionManager.checkPathScope({
      canonicalTargets,
      allowedDirectories: invocationAllowedScope.directories,
    }).sensitiveHit;
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
        // Re-run the Layer 1 predicate each iteration: applyApprovedDirectory
        // widens `invocationAllowedScope` after a grant, so the scope must be
        // re-supplied to PermissionManager.checkPathScope (SOT V2).
        const outOfAllowedTarget = PermissionManager.checkPathScope({
          canonicalTargets,
          allowedDirectories: invocationAllowedScope.directories,
        }).outOfAllowed;
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
      // Permission policy V1 SOT — the meta `decisionOverride="ask"` re-elevation
      // (agent_spawn: elevate the registry's override-`allow` to a per-invocation
      // `forceModal` ask, except under allow-all mode) now lives inside
      // categoryBasedDecision's "override" branch. The executor only CARRIES the
      // override into the check context; it never rewrites the verdict or
      // re-consults getMode(). The allow-all invariant (mode==="allow" → no
      // prompt, meta included) is single-sourced in PermissionManager.
      permissionResult = this.permissionManager.checkDetailed(
        toolUse.name,
        source,
        invocationCategory,
        overlayTriggerOrigin,
        { ...invocationPermissionContext, decisionOverride: metaOverride },
      );
      // ── Plugin-read auto-allow ↔ sandbox-fs-containment coupling ──────────
      //
      // The merged read-relaxation coupling (the block immediately below) only
      // gates the `ask` path: it requires `this.sandboxFsContainedProvider(tool)`
      // before flipping a FOREGROUND PLUGIN `ask` (layer ≥ 3) to `allow`. But a
      // plugin tool the host inspector classifies as `read` (inspectHostRisk →
      // `"read"` for a read-only command-bearing arg) is auto-allowed DIRECTLY by
      // the category × source × trust matrix — `categoryBasedDecision` returns
      // `{ decision: "allow", layer: 6 }`, never an `ask` — so it SKIPS the
      // relaxation block and its sandbox coupling entirely. That leaves its
      // off-hostApi residual (direct `node:fs`, a bare `fetch`, or a detached
      // async frame that escapes the tool-execute ALS scope) UNCONTAINED when the
      // sandbox is not filesystem-contained — the exact gap the relaxation
      // coupling (`isActiveSandboxFilesystemContained`) closes for the ask path.
      // Close it for the read-auto-allow path too: when `hostClassifiesRisk` is
      // ON and the active sandbox does NOT filesystem-contain the host, a plugin
      // read auto-allow must NOT silently proceed — convert it to the pre-exec
      // approval `ask` so the residual is gated, exactly mirroring the relaxation.
      //
      // MUTUAL EXCLUSIVITY — this fires only when `!sandboxFsContainedProvider(tool)`;
      // the relaxation below fires only when `sandboxFsContainedProvider(tool)`. The
      // two are mutually exclusive on the same signal and can never both fire on
      // one invocation, so the ordering relative to the relaxation is immaterial
      // (a `read` flipped here to `ask` is NOT re-relaxed below — that requires
      // fs-containment, which is false on this path — so the ask stands).
      //
      // SCOPE — each clause load-bearing, mirroring the relaxation:
      //   • FLAG ON only (`hostClassifiesRiskProvider()`). Flag OFF → the declared
      //     category drives the decision and this coupling is skipped (byte-for-byte
      //     unchanged), consistent with the relaxation being flag-gated.
      //   • PLUGIN only (`source === "plugin"`). BUILTIN reads are host-trusted (no
      //     off-hostApi-plugin residual) and MCP is host-derived `"network"` (never
      //     `"read"`) + low-trust `ask` — both untouched.
      //   • HOST-DERIVED READ only (`invocationCategory === "read"`). Under the flag
      //     this is the inspector's positive-evidence read, not a self-declared one.
      //   • CATEGORY-MATRIX AUTO-ALLOW only (`decision === "allow"`, `layer === 6`,
      //     `getMode() !== "allow"`). An explicit user allow rule (layer 3) /
      //     always-allow (layer 5) / `allow` mode (the user's deliberate global
      //     opt-in, under which plugin WRITES are also un-relaxed and uncontained)
      //     are deliberate grants left intact — just as the relaxation never
      //     touches a standing `allow`; coupling reads but not writes in allow mode
      //     would be asymmetric.
      //   • FOREGROUND only (`headless !== true`). Mirrors the relaxation's
      //     foreground scope: in a headless/routine lane a bare layer-6 `ask`
      //     carries no `reviewer` route, so the headless ask handler would
      //     HARD-DENY it — breaking legitimate routine reads and making headless
      //     reads stricter than headless writes (which take the reviewer lane).
      //     Headless plugin reads keep today's auto-allow, exactly as the
      //     relaxation leaves the headless write lane untouched.
      //   • NOT FILESYSTEM-CONTAINED only (`!sandboxFsContainedProvider(tool)`).
      //     A worker-backed, ASRT-wrapped plugin tool keeps the read auto-allow;
      //     degraded / sandbox-off / ordinary in-process plugin tools fall back
      //     to the pre-exec ask. Same plugin-effect containment signal the
      //     relaxation uses.
      // Deny rules still win — they resolve to a layer-1 `deny` and never reach here.
      if (
        this.hostClassifiesRiskProvider() &&
        source === "plugin" &&
        invocationCategory === "read" &&
        permissionResult.decision === "allow" &&
        permissionResult.layer === 6 &&
        invocationPermissionContext.headless !== true &&
        this.permissionManager?.getMode() !== "allow" &&
        !this.sandboxFsContainedProvider(tool)
      ) {
        permissionResult = {
          decision: "ask",
          reason:
            "plugin read auto-allow requires a filesystem-contained sandbox — pre-exec ask stands (hostClassifiesRisk)",
          layer: permissionResult.layer,
        };
      }
      // ── Effect-boundary pre-exec relaxation (flag-gated, default OFF) ──────
      //
      // When `hostClassifiesRisk` is ON, a FIRST-PARTY PLUGIN tool in a
      // FOREGROUND (interactive) context does NOT run the pre-exec blocking
      // approval lane (the host-classify category ASK + the reviewer/modal that
      // follows it). Instead the tool is allowed to EXECUTE, and the merged
      // effect-boundary gate (bound around `tool.execute` below) is the ONLY
      // gate: a plugin READ tool performs no mutating host-mediated effect →
      // runs to completion with NO modal; a plugin WRITE tool trips the
      // effect-gate AT THE MUTATION (foreground deny → tool error; headless
      // fails closed). This replaces the imprecise default-strict pre-exec ASK
      // (which the host inspector raises to `write` without positive read
      // evidence, so it over-asks for genuine reads) with the precise,
      // effect-observed gate.
      //
      // SCOPE — narrowed deliberately (each clause is load-bearing):
      //   • PLUGIN ONLY (`source === "plugin"`). MCP tools are
      //     `hostObservable:false` (not host-mediated) so the effect-gate never
      //     sees their mutations — relaxing them would be a FAIL-OPEN; builtins
      //     carry their own trusted host categories. Both keep the full pre-exec
      //     ask (this branch is skipped for them).
      //   • FOREGROUND ONLY (`headless !== true`). In a headless/routine lane a
      //     plugin write would HARD-THROW at the effect-gate (which fails closed
      //     with no approver) instead of taking the host's deferred/headless
      //     approval lane, breaking legitimate routine writes — so headless
      //     keeps the pre-exec lane untouched.
      //   • ASK ONLY, layer ≥ 3, not `forceModal`. A `deny` (standing deny rule
      //     or a persisted `deny-always`) is layer 1 and never an ask, so it is
      //     untouched — explicit user deny still wins. The layer ≥ 3 floor
      //     preserves the layer ≤ 2 hard gates (overlay-trigger mutation guard,
      //     MCP/per-tool strict override, global strict mode) exactly as the
      //     Store B memory-skip does; a per-invocation `forceModal` ask is never
      //     relaxed.
      //   • SANDBOX FILESYSTEM-CONTAINED ONLY (`this.sandboxFsContainedProvider(tool)`).
      //     The effect-boundary only CONTAINS the off-hostApi mutation residual
      //     (residual #1 below) when the OS sandbox FILESYSTEM-CONTAINS the host.
      //     This requires `confines.filesystem === true` on the ACTIVE sandbox
      //     capability, NOT merely that some sandbox is active. On a host that is
      //     not filesystem-contained (degraded / gate off) the relaxation would
      //     be WEAKER than the pre-exec ask it replaces, so it does NOT fire —
      //     the existing pre-exec approval ask stands. This makes
      //     `hostClassifiesRisk`-ON safe on every platform: macOS / Linux
      //     (full ASRT) can relax filesystem-contained plugin reads; current
      //     ordinary plugin tools and degraded/sandbox-off hosts fall back to the
      //     known-safe ask. Mirrors the reviewer SOT `sandboxRelaxesCategory`,
      //     but with the specific plugin worker substrate threaded in.
      //   • FLAG OFF (default) → this whole block is skipped: behaviour is
      //     byte-for-byte today's full pre-exec ask. The condition is the FIRST
      //     read, so the relaxed path is reachable only with the flag ON.
      //
      // PERM-HOOK PRESERVATION — the relaxation flips the pre-exec ASK to `allow`
      // BEFORE the `decision === "ask"` block below, which is the ONLY callsite of
      // the operator's `perm-*.sh` (PermissionRequest) script hook. Without firing
      // it here, an operator deny policy encoded in a `perm-*.sh` hook would be
      // SILENTLY dropped under the flag for exactly the relaxed plugin calls. So on
      // the relaxed path we run the SAME perm hook FIRST: a perm-hook DENY blocks
      // the tool FAIL-CLOSED (no relaxation), identical to the ask lane's perm-hook
      // deny handling below; a perm-hook allow / no-opinion proceeds with the
      // relaxation (no modal), preserving the clean read-relaxation UX. (The
      // always-on `pre-*.sh` hook still fires downstream regardless — but the
      // perm-hook is a DISTINCT, separately-registrable deny surface, so it is
      // restored here under the flag.) Done inside the relaxation branch so it runs
      // only for the narrowed plugin/foreground/ask/layer≥3 set; for every other
      // tool the perm hook still runs in its original ask-lane callsite.
      //
      // HONEST RESIDUAL — what this gate does NOT contain (NOT papered over).
      //   NOTE: the relaxation below does NOT pre-classify read vs write — it flips
      //   ANY foreground/plugin/layer≥3 `ask` to `allow`, so the pre-exec ask is
      //   gone for EVERY relaxed plugin tool (a read AND a write tool). The ONLY
      //   remaining gate under the flag is the effect-boundary. The residuals:
      //   1. OFF-hostApi mutation. This gates LLM-driven plugin actions over
      //      HOST-MEDIATED effects only. A plugin that mutates OFF the host API
      //      (direct `node:fs`, a bare `fetch`, or a detached async frame that
      //      escapes the tool-execute ALS scope) records NO effect → the
      //      effect-boundary sees a read → it runs with no gate. Closed ONLY by the
      //      OS sandbox (ASRT) FILESYSTEM-CONTAINING the host. This relaxation now
      //      REQUIRES the active sandbox to filesystem-contain (the
      //      `sandboxFsContainedProvider(tool)` clause above), so whenever the
      //      relaxation is in effect this `node:fs` WRITE residual is contained
      //      by the tool's actual worker substrate. A call path that is not
      //      worker-backed does not relax. NOT a regression: a first-party plugin
      //      already executes arbitrary in-process code today — this is an
      //      LLM-action gate over mediated effects, not an in-process jail.
      //   2. The mediated excluded writes (ENFORCEMENT_EXCLUSIONS). The relaxation
      //      removes the pre-exec ask, so these are gated ONLY at the effect-boundary
      //      — and the excluded paths are by definition NOT generically gated there:
      //        • openExternalUrl (system-browser egress / exfil-class) is now GATED
      //          at the effect-boundary (moved OUT of the exclusions) — caught;
      //        • hostFetch self-gates INLINE in its closure (same effect-gate) —
      //          caught; the other gated async writes are caught generically;
      //        • the THREE remaining exclusions run UNGATED under the flag, each
      //          BOUNDED: registerKeywords = SYNC + start-only, not reachable during
      //          tool.execute (no effect during a gated invocation); config.set =
      //          the plugin's OWN config namespace (not user/external data);
      //          agentApproval.respond = resolves HOST-OWNED approval machinery,
      //          gating it with itself is circular (would deadlock).
      //      This bounded-ungated set is enumerated (here + effect-enforcement.ts) —
      //      it is NOT a hidden fail-open hole.
      //   3. READ-SIDE exfiltration. Skipping the foreground reviewer for plugin
      //      READ tools means a plugin read of sensitive data no longer gets a
      //      pre-exec review. Exfiltration of what it read is contained ONLY by the
      //      gated `hostFetch` verb chokepoint (Tier A deny-by-default network
      //      allow-list) + the OS sandbox — NOT by a pre-exec ask. This is the UX
      //      cost the flag deliberately buys; documented so the default-flip
      //      decision weighs it.
      if (
        this.hostClassifiesRiskProvider() &&
        this.sandboxFsContainedProvider(tool) &&
        source === "plugin" &&
        invocationPermissionContext.headless !== true &&
        permissionResult.decision === "ask" &&
        permissionResult.layer >= 3 &&
        permissionResult.forceModal !== true
      ) {
        const relaxedPermHook = await this.runScriptHook(
          "perm",
          toolUse.name,
          source,
          invocationCategory,
          finalInput,
          sessionId,
          invocationPermissionContext,
          tool.mcpServerId,
          tool.pluginId,
        );
        if (relaxedPermHook.decision === "deny") {
          // Operator perm-hook DENY wins over the relaxation — fail closed exactly
          // as the ask lane does on a perm-hook deny.
          const msg = t("be_executor.hookPermissionBlock", { reason: relaxedPermHook.reason });
          const durationMs = Date.now() - startTime;
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...permissionResult, decision: "deny", reason: relaxedPermHook.reason }, Infinity, invocationPermissionContext, invocationCategory, executionCwd, undefined, undefined, hookChainFromDispatch("perm", relaxedPermHook));
          return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
        }
        permissionResult = {
          decision: "allow",
          reason:
            "plugin foreground pre-exec ask relaxed — gated at the effect boundary (hostClassifiesRisk)",
          layer: permissionResult.layer,
        };
      }
      if (
        source === "plugin" &&
        invocationPermissionContext.pluginPanelUserAction === true &&
        invocationPermissionContext.headless !== true &&
        permissionResult.decision === "ask" &&
        permissionResult.layer >= 3 &&
        permissionResult.forceModal !== true
      ) {
        const panelPermHook = await this.runScriptHook(
          "perm",
          toolUse.name,
          source,
          invocationCategory,
          finalInput,
          sessionId,
          invocationPermissionContext,
          tool.mcpServerId,
          tool.pluginId,
        );
        if (panelPermHook.decision === "deny") {
          const msg = t("be_executor.hookPermissionBlock", { reason: panelPermHook.reason });
          const durationMs = Date.now() - startTime;
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...permissionResult, decision: "deny", reason: panelPermHook.reason }, Infinity, invocationPermissionContext, invocationCategory, executionCwd, undefined, undefined, hookChainFromDispatch("perm", panelPermHook));
          return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
        }
        permissionResult = {
          decision: "allow",
          reason: "plugin panel user action - standard agent approval modal suppressed",
          layer: permissionResult.layer,
        };
      }
      // #885 v6 (§5.3): the untrusted `tool.writesToOwnSandbox` self-claim is no
      // longer threaded to the reviewer — the auto-LOW keys solely on the
      // HOST-computed `ownerPluginSandboxRoot` + host-verified path containment.
      const sandboxAttestation = {
        ...(tool.pluginId
          ? { ownerPluginSandboxRoot: pathResolve(lvisHome(), "plugins", tool.pluginId) }
          : {}),
      };
      let foregroundMemorySkipChecked = false;
      if (permissionResult.decision === "ask" && permissionResult.reviewer?.route === "foreground-auto") {
        if (
          permissionResult.layer >= 3 &&
          permissionResult.forceModal !== true &&
          invocationPermissionContext.headless !== true
        ) {
          foregroundMemorySkipChecked = true;
          const memorySkip = await this.tryUserApprovalMemorySkip(
            toolUse.name,
            source,
            invocationCategory,
            tool.pathFields ?? [],
            finalInput,
            invocationAllowedScope.directories,
            sensitivePathPattern ? [sensitivePathPattern] : [],
            invocationPermissionContext,
            approvalCacheKey,
            sandboxAttestation,
            tool.mcpServerId,
            tool.workerId,
            tool.pluginId,
          );
          if (memorySkip) {
            permissionResult = memorySkip;
          }
        }
      }
      if (permissionResult.decision === "ask" && permissionResult.reviewer?.route === "foreground-auto") {
        const explicitAuthorization = this.consumePendingReviewerAuthorization({
          sessionId,
          toolName: toolUse.name,
          source,
          finalInput,
          context: invocationPermissionContext,
        });
        if (explicitAuthorization) {
          permissionResult = explicitAuthorization;
        }
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
          sandboxAttestation,
          callbacks,
          meta,
          approvalPurpose,
          abortSignal,
        );
        if (reviewerResult) {
          permissionResult = reviewerResult;
        }
      }
      if (
        permissionResult.decision === "deny" &&
        permissionResult.reviewer?.route === "foreground-auto" &&
        permissionResult.reviewer.verdict
      ) {
        this.recordPendingReviewerAuthorization({
          sessionId,
          toolName: toolUse.name,
          source,
          finalInput,
          context: invocationPermissionContext,
          verdict: permissionResult.reviewer.verdict,
        });
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
            sandboxAttestation,
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
      // ── Store B: explicit-approval memory skip (foreground only) ──────────
      // checkDetailed (sync) consults Store A — durable glob rules + the
      // alwaysAllowed Map (Layers 3/5). It cannot see Store B, the exact-tuple
      // user-approval memory written by ToolApprovalDialog for DURABLE
      // choices only (allow-session / allow-always; allow-once never
      // records). Pre-fix, choosing "allow this session" still
      // re-showed the modal on the next call because the foreground ask path
      // never read Store B (only the reviewer lane did). Mirror the reviewer
      // lane's lookup here so a prior session/persistent approval for the same
      // (toolName, args, source, trustOrigin, approvalCacheKey) tuple skips the
      // modal. Headless requests never reach here (the headless ask block above
      // either denied or flipped the decision), so Store B stays foreground-only.
      //
      // Security invariant (deny > hard-ask > allow preserved): checkDetailed
      // evaluates the immutable Layer 1-2 hard gates FIRST —
      //   • deny rules        → decision "deny", layer 1 (never an ask)
      //   • MCP strict         → decision "ask",  layer 2
      //   • overlay-trigger    → decision "ask",  layer 2
      //   • global strict mode → decision "ask",  layer 2
      // A prior user approval must NEVER auto-skip these hard gates, so we only
      // consult Store B for "normal" asks (layer >= 3 — the category/reviewer
      // confirmation lanes, layer 6). Gating on the layer is the precise,
      // route-agnostic test: overlay/strict/MCP-strict carry no reviewer route
      // but are uniformly layer <= 2.
      if (
        permissionResult.decision === "ask" &&
        permissionResult.layer >= 3 &&
        // A meta tool whose author declared decisionOverride="ask" is a
        // per-invocation hard gate — never satisfied by a stored approval.
        permissionResult.forceModal !== true &&
        invocationPermissionContext.headless !== true &&
        foregroundMemorySkipChecked !== true
      ) {
        const memorySkip = await this.tryUserApprovalMemorySkip(
          toolUse.name,
          source,
          invocationCategory,
          tool.pathFields ?? [],
          finalInput,
          invocationAllowedScope.directories,
          sensitivePathPattern ? [sensitivePathPattern] : [],
          invocationPermissionContext,
          approvalCacheKey,
          sandboxAttestation,
          tool.mcpServerId,
          tool.workerId,
          tool.pluginId,
        );
        if (memorySkip) {
          permissionResult = memorySkip;
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
            // Substrate-aware: plugin/MCP + in-process builtins show "none"
            // (their effects are not ASRT-wrapped); only bash/powershell may
            // show the active "asrt" when the gate is ON — plus a genuinely
            // ASRT-wrapped external MCP worker, keyed on id.
            sandboxCapability: resolveReviewerSandboxCapability(
              source,
              toolUse.name,
              tool.mcpServerId,
              tool.workerId,
              tool.pluginId,
            ),
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
            tool.mcpServerId,
            tool.pluginId,
          );
          if (permHook.decision === "deny") {
            const msg = t("be_executor.hookPermissionBlock", { reason: permHook.reason });
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...permissionResult, decision: "deny", reason: permHook.reason }, Infinity, invocationPermissionContext, invocationCategory, executionCwd, undefined, undefined, hookChainFromDispatch("perm", permHook));
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
            // P2 — stamp the grant tier from the final resolved category so an
            // "Allow always" on a read tool grants read-tier (still asks on a
            // later write of the same pattern) while a write/shell/network/meta
            // tool grants write-tier (covers everything). requiredTier is the
            // shared SOT for the category→tier mapping.
            await this.permissionManager.addAlwaysAllowedPersist(
              pattern,
              requiredTier(invocationCategory),
            );
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
      tool.mcpServerId,
      tool.pluginId,
    );
    if (scriptPre.decision === "deny") {
      const msg = t("be_executor.hookBlockScript", { reason: scriptPre.reason });
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { decision: "deny", reason: scriptPre.reason, layer: 6 }, Infinity, invocationPermissionContext, invocationCategory, executionCwd, undefined, undefined, hookChainFromDispatch("pre", scriptPre));
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
      // Owner plugin sandbox root — same derivation the reviewer uses
      // (executor permission path). Plugin-owned tools confine their OS
      // write-jail to `~/.lvis/plugins/<pluginId>/`; builtins pass undefined.
      ...(tool.pluginId
        ? { ownerPluginSandboxRoot: pathResolve(lvisHome(), "plugins", tool.pluginId) }
        : {}),
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
        // Bind the per-invocation effect ledger for the async chain of this
        // execution so the in-process plugin hostApi closures record onto it.
        // AsyncLocalStorage propagates through the loopback transport (the same
        // path `currentInvocationOrigin` relies on); a re-entrant callTool opens
        // its own ledger scope, so nested effects never double-count here.
        //
        // Effect-boundary ENFORCEMENT — bind the per-invocation gate context
        // alongside the ledger so a host-classified WRITE reached during execute
        // can ask AT THE EFFECT (foreground) or fail closed (headless).
        // `headless` is the SAME signal that drives the pre-exec headless lane; the
        // fresh `onceGrants` set dedups N writes to one target within this call.
        // When `hostClassifiesRisk` is OFF (default) the gate is a pass-through,
        // so binding the context here is inert.
        return runWithEffectLedger(effectLedger, () =>
          runWithEffectGateContext(
            {
              headless: invocationPermissionContext.headless === true,
              toolName: toolUse.name,
            },
            () => tool.execute(finalInput, ctx),
          ),
        );
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

    // ── Effect shadow (observability only) ───────────────────────────
    // The execution has returned, so the per-invocation ledger now holds the
    // host-observed effects. This is the dedicated shadow reconciliation log
    // (NOT the HMAC audit-grade channel). `hasMutatingEffect` is the host-owned
    // read/write classification for this call; it drives NO permission decision
    // here — a later read-recognition gate consumes it.
    const effectSummary = effectLedger.summary();
    // Propagate a MUTATING inner invocation onto the parent (outer wrapper)
    // ledger. Without this a read-declared wrapper W that delegates a mutation
    // via callTool(M) would record `hasMutatingEffect:false` on its OWN ledger
    // (M's write lives only on M's inner ledger), which a later read-recognition
    // gate could treat as a confirmed read — fail-permissive. The marker surfaces
    // W's ledger as mutating. Effect class from the SOT.
    if (parentEffectLedger && effectSummary.hasMutatingEffect) {
      parentEffectLedger.record({
        kind: "callTool-child",
        effect: CHOKEPOINT_EFFECT["callTool-child"],
        target: tool.name,
      });
    }
    // Emit the EFFECT shadow record for plugin/MCP invocations (builtins never
    // touch the hostApi closures, so their ledger is empty — no reconciliation
    // value). `hostObservable` is false for external MCP tools: their effects are
    // NOT host-mediated, so an empty ledger is NOT a confirmed read and a later
    // read-recognition gate MUST fail closed on it. In-process plugin tools route
    // through the instrumented hostApi closures, so they are host-observable.
    if (tool.source === "plugin" || tool.source === "mcp") {
      emitEffectShadowLog(
        {
          toolName: tool.name,
          source: tool.source,
          ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
          declaredCategory: declaredCategoryForEffectShadow,
          hostObservable: tool.source === "plugin",
          hostObservedEffect: effectSummary,
        },
        this.auditLogger,
      );
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
      tool.mcpServerId,
      tool.pluginId,
      content,
      isError,
    );

    // ── #811 m2: PostToolUseFailure (NON-BLOCKING) ──
    // Fires alongside PostToolUse when the tool's execute() returned isError.
    // OBSERVE-ONLY: the deny is recorded for audit but never alters the result
    // that already returned (mirrors PostToolUse). Payload adds errorMessage
    // (DLP-redacted by the manager) + durationMs.
    if (isError) {
      await this.fireLifecycleEvent(
        "PostToolUseFailure",
        sessionId,
        invocationPermissionContext,
        {
          toolName: toolUse.name,
          errorMessage: content,
          durationMs: Date.now() - startTime,
        },
      );
    }

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
        `Sensitive data detected and masked — tool: '${toolUse.name}', patterns: ${dlpResult.detections.join(", ")}`,
      );
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "unknown",
        type: "tool_call",
        input: dlpAuditInput.slice(0, 500),
          output: `[DLP masking applied] patterns: ${dlpResult.detections.join(", ")}`,
        toolCalls: [{
          name: toolUse.name,
          isError: false,
          source,
          trust,
          executionTimeMs: Date.now() - startTime,
          permissionDecision: "dlp_masked",
            permissionReason: `Detected patterns: ${dlpResult.detections.join(", ")}`,
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
    // Forensic hook chain on the success/post path: the pre hooks that allowed
    // this call plus the post hooks that ran after it. `undefined` when neither
    // fired (keeps non-hook rows clean). config-hook vs `.sh`-hook is now
    // distinguishable via each row's `source` (#811 cluster-review follow-up).
    const successHookChain = mergeHookChains(
      hookChainFromDispatch("pre", scriptPre),
      hookChainFromDispatch("post", scriptPost),
    );
    await this.auditToolCall(sessionId, toolUse.name, source, trust, finalInput, auditContent, isError, startTime, permissionResult, rateResult.remaining, invocationPermissionContext, invocationCategory, executionCwd, targetFilePath, terminationReason, successHookChain);

    return {
      tool_use_id: toolUse.id,
      content,
      ...(isError && { is_error: true }),
      ...(uiPayload && { uiPayload }),
      ...(rawResult !== undefined && { rawResult }),
      durationMs,
    };
  }

  // ─── Audit (불변 — 항상 실행) — chokepoint owned by AuditWriter ────

  private async auditPermissionGrant(args: {
    toolName: string;
    source: ToolSource;
    category: ToolCategory;
    directory: string;
    grantLifetime: "turn" | "session" | "always" | "degraded-to-turn";
    permissionContext?: ToolPermissionContext;
  }): Promise<void> {
    return this.auditWriter.auditPermissionGrant(args);
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
    return this.auditWriter.auditPermissionAsk(
      toolName,
      source,
      category,
      input,
      permission,
      cwd,
      permissionContext,
      auditDirectory,
    );
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
    hookChain?: HookResult[],
  ): Promise<void> {
    return this.auditWriter.auditToolCall(
      sessionId,
      toolName,
      source,
      trust,
      input,
      output,
      isError,
      startTime,
      permission,
      rateLimitRemaining,
      permissionContext,
      category,
      cwd,
      auditDirectory,
      terminationReason,
      hookChain,
    );
  }
}

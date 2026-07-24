import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { Tool } from "./base.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import { isModelExposedTool } from "./base.js";
import { isCanonicalBashTool } from "./bash.js";
import { isCanonicalPowerShellTool } from "./powershell.js";
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
} from "./types.js";
import { trustFromSource } from "./types.js";
import { PermissionManager, type PermissionCheckResult } from "../permissions/permission-manager.js";
import type { ApprovalDecision } from "../permissions/approval-gate.js";
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
import {
  dispatchPermissionDirCommand,
  type PermissionDirectoryLifecycle,
} from "../permissions/permission-slash.js";
import type { HookResult, ToolExecutionAuditMetadata } from "../audit/audit-schema.js";
import type { RiskVerdict } from "../permissions/reviewer/risk-classifier.js";
import type { EffectLedger } from "../permissions/effect-ledger.js";
import { currentToolExecutionCwd } from "./execution-context.js";
import {
  getHostShellExecutionPlan,
  resolveReviewerSandboxCapability,
} from "../permissions/sandbox-capability.js";
import {
  getHostShellExecutionPlanAuditProjection,
  requiresExplicitHostShellFallbackApproval,
  type HostShellExecutionPlanAuditProjection,
} from "../permissions/host-shell-execution-plan.js";
import {
  buildHostShellExecutionPermitBinding,
  type HostShellExecutionPermitBinding,
} from "../permissions/host-shell-execution-permit.js";
import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
// ── C7 pipeline decomposition — behavior-preserving extracted units.
// This runner owns preparation/path policy and composes the extracted
// LOW/MEDIUM-risk helpers. Authorization and execution/finalization are
// delegated to their named stages below.
import { extractTargetFilePaths, shellPathPolicyViolation } from "./pipeline/path-extraction.js";
import { buildApprovalPurposeSuggestion } from "./pipeline/approval-purpose.js";
import {
  approvalCacheKeyFor,
  emitToolStart,
  maskToolInputForDisplay,
  summarizeInputForDeferred,
} from "./pipeline/display-mask.js";
import {
  auditSafeToolInput,
  AuditWriter,
} from "./pipeline/audit-writer.js";
// ── C8 pipeline decomposition — the per-invocation mutable-state contract +
// initial-state factory + the self-contained user-abort helper. The two
// SECURITY-CRITICAL sandbox filesystem-containment relaxation blocks stay
// together in invocation-authorization.ts. The shared initial state and abort
// terminal remain in invocation-context.ts.
import { createInvocationContext, returnUserAbort } from "./pipeline/invocation-context.js";
import type { RationaleHostRuntime } from "./pipeline/rationale-orchestrator.js";
import type { RationaleExecutorControlOutcome } from "./pipeline/rationale-pr1-contract.js";
import { canonicalStringify } from "../permissions/user-approval-store.js";
import type { SealedRationaleResumeRequest } from "./pipeline/rationale-resume-contract.js";
import {
  type AuthorizedRationaleResume,
  type PreparedRationaleResume,
  type RationaleResumeHostRuntime,
  type StartedRationaleResume,
} from "./pipeline/rationale-resume-runner.js";
import {
  type ExecuteOptions,
  type ToolCallMeta,
  type ToolPermissionContext,
  type ToolResult,
  type ToolUseBlock,
} from "./executor-contract.js";
import {
  currentApprovalMode,
  resolveEnforcedCategory,
  type InvocationRunnerServices,
} from "./invocation-services.js";
import { authorizeToolInvocation } from "./invocation-authorization.js";
import { executeAuthorizedToolInvocation } from "./invocation-execution.js";
import {
  resolvePluginOperation,
  type ResolvedPluginOperation,
} from "./plugin-operation-governance.js";
import type { PluginOperationPrincipal } from "../permissions/plugin-operation-grant.js";
import type { HostPluginGenerationState } from "../plugins/plugin-host-generation.js";
import type { PluginGenerationLease } from "../plugins/plugin-generation-coordinator.js";

const log = createLogger("executor");

type AuditToolCallArgs = Parameters<AuditWriter["auditToolCall"]>;
type AuditPermissionAskArgs = Parameters<AuditWriter["auditPermissionAsk"]>;

function resolveInvocationCategory(
  tool: Tool,
  finalInput: Record<string, unknown>,
): ToolCategory {
  return tool.categoryForInput?.(finalInput) ?? tool.category;
}

export interface RationaleBatchExecutionContext {
  runtime: RationaleHostRuntime;
  batchId: string;
  originalToolUseIds: readonly string[];
  completedToolUseIds: readonly string[];
}

export interface RationaleRequiredExecuteOneOutcome {
  outcome: "rationale-required";
  control: RationaleExecutorControlOutcome;
}

export interface RationaleResumeExecutionContext {
  request: SealedRationaleResumeRequest;
  runtime?: RationaleResumeHostRuntime;
  prepared?: PreparedRationaleResume;
  authorized?: AuthorizedRationaleResume;
  started?: StartedRationaleResume;
  terminalizationAttempted?: boolean;
  terminalized?: boolean;
}

export async function runToolInvocation(
  services: InvocationRunnerServices,
    toolUse: ToolUseBlock,
    groupId: string,
    displayOrder: number,
    opts: ExecuteOptions = {},
    rationaleBatchContext?: RationaleBatchExecutionContext,
    rationaleResumeContext?: RationaleResumeExecutionContext,
  ): Promise<ToolResult | RationaleRequiredExecuteOneOutcome> {
    const {
      callbacks,
      sessionId,
      overlayTriggerOrigin,
      spawnDepth,
      supportsA2AParentDelivery,
      approvalReasonPrefix,
      abortSignal,
      a2aCausalContext,
      toolResultChunkReader,
      permissionContext,
      executionCwd: requestedExecutionCwd,
    } = opts;
    const startTime = Date.now();
    const executionCwd =
      requestedExecutionCwd ?? currentToolExecutionCwd() ?? process.cwd();
    const meta: ToolCallMeta = { groupId, toolUseId: toolUse.id, displayOrder };
    let permissionResult: PermissionCheckResult | undefined;
    let source: ToolSource = "builtin";
    let trust: TrustLevel = "high";
    let hostShellExecutionPlanAudit: HostShellExecutionPlanAuditProjection | undefined;
    let governedTool = false;
    const withHostShellExecutionPlan = (result: ToolResult): ToolResult =>
      hostShellExecutionPlanAudit === undefined
        ? result
        : { ...result, executionPlan: hostShellExecutionPlanAudit };
    const currentAuditMetadata = (
      input: Record<string, unknown> = toolUse.input,
    ): ToolExecutionAuditMetadata => ({
      toolUseId: toolUse.id,
      ...(hostShellExecutionPlanAudit !== undefined
        ? { executionPlan: hostShellExecutionPlanAudit }
        : {}),
      ...(governedTool
        ? {
            governedOperation:
              typeof input.operation === "string" ? input.operation : null,
          }
        : {}),
    });
    const auditCurrentToolCall = (...args: AuditToolCallArgs): Promise<void> => {
      args[16] = currentAuditMetadata(args[4]);
      return services.auditWriter.auditToolCall(...args);
    };
    const auditCurrentPermissionAsk = (
      ...args: AuditPermissionAskArgs
    ): Promise<void> => {
      args[8] = currentAuditMetadata(args[3]);
      return services.auditWriter.auditPermissionAsk(...args);
    };


    const tool = services.toolRegistry.findByName(toolUse.name);
    if (!tool) {
      const durationMs = Date.now() - startTime;
      await auditCurrentToolCall(sessionId, toolUse.name, "builtin", "high", toolUse.input, t("be_executor.toolNotFoundAudit"), true, startTime, { decision: "deny", reason: t("be_executor.toolNotFoundAudit"), layer: 0 }, Infinity, permissionContext);
      callbacks?.onToolEnd?.(toolUse.name, t("be_executor.toolNotFound", { name: toolUse.name }), true, meta, undefined, durationMs);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: t("be_executor.toolNotFound", { name: toolUse.name }), is_error: true, durationMs });
    }
    governedTool = tool.operationPolicy !== undefined;
    let generationAccess: ReturnType<
      InvocationRunnerServices["pluginGenerationAccessProvider"]
    >;
    let generationLease: PluginGenerationLease<HostPluginGenerationState> | undefined;
    if (tool.pluginGeneration) {
      generationAccess = services.pluginGenerationAccessProvider();
      try {
        if (!generationAccess) {
          throw new Error("plugin generation access is unavailable");
        }
        generationLease = await generationAccess.acquireExact(
          tool.pluginGeneration.pluginId,
          tool.pluginGeneration.generationId,
        );
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const reason = `Plugin generation admission denied: ${
          error instanceof Error ? error.message : String(error)
        }`;
        const denied: PermissionCheckResult = {
          decision: "deny",
          reason,
          layer: 0,
        };
        await auditCurrentToolCall(
          sessionId,
          toolUse.name,
          tool.source,
          trustFromSource(tool.source),
          toolUse.input,
          reason,
          true,
          startTime,
          denied,
          Infinity,
          permissionContext,
        );
        callbacks?.onToolEnd?.(
          toolUse.name,
          reason,
          true,
          meta,
          undefined,
          durationMs,
        );
        return withHostShellExecutionPlan({
          tool_use_id: toolUse.id,
          content: reason,
          is_error: true,
          durationMs,
        });
      }
    }
    const executeAdmitted = async (): Promise<
      ToolResult | RationaleRequiredExecuteOneOutcome
    > => {
    if (
      permissionContext?.expectedMcpServerId &&
      tool.mcpServerId !== permissionContext.expectedMcpServerId
    ) {
      const durationMs = Date.now() - startTime;
      const reason = `MCP tool owner changed: expected '${
        permissionContext.expectedMcpServerId
      }', got '${tool.mcpServerId ?? "unknown"}'`;
      const denied: PermissionCheckResult = {
        decision: "deny",
        reason,
        layer: 0,
      };
      await auditCurrentToolCall(
        sessionId,
        toolUse.name,
        tool.source,
        trustFromSource(tool.source),
        toolUse.input,
        reason,
        true,
        startTime,
        denied,
        Infinity,
        permissionContext,
      );
      callbacks?.onToolEnd?.(
        toolUse.name,
        reason,
        true,
        meta,
        undefined,
        durationMs,
      );
      return withHostShellExecutionPlan({
        tool_use_id: toolUse.id,
        content: reason,
        is_error: true,
        durationMs,
      });
    }
    source = tool.source;
    trust = trustFromSource(source);
    let invocationCategory = resolveInvocationCategory(tool, toolUse.input);
    meta.source = source;
    meta.category = invocationCategory;
    if (tool.pluginId) meta.pluginId = tool.pluginId;
    if (tool.workerId) meta.workerId = tool.workerId;
    if (tool.mcpServerId) meta.mcpServerId = tool.mcpServerId;

    const returnRationaleResumeBlock = async (
      reason: string,
      input: Record<string, unknown>,
      blockedPermission: PermissionCheckResult = {
        decision: "deny",
        reason,
        layer: 0,
      },
      hookChain?: HookResult[],
      suppressPermissionDeniedLifecycle = false,
    ): Promise<ToolResult> => {
      const content = "Rationale resume blocked: " + reason;
      const durationMs = Date.now() - startTime;
      callbacks?.onToolEnd?.(toolUse.name, content, true, meta, undefined, durationMs);
      await auditCurrentToolCall(
        sessionId,
        toolUse.name,
        source,
        trust,
        input,
        content,
        true,
        startTime,
        { ...blockedPermission, decision: "deny", reason },
        Infinity,
        permissionContext,
        invocationCategory,
        executionCwd,
        undefined,
        undefined,
        hookChain,
        undefined,
        suppressPermissionDeniedLifecycle,
      );
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content, is_error: true, durationMs });
    };

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
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, deny.reason, true, startTime, deny, Infinity, permissionContext, invocationCategory, executionCwd);
        callbacks?.onToolEnd?.(toolUse.name, modelFacing, true, meta, undefined, durationMs);
        return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: modelFacing, is_error: true, durationMs });
      }
    }

    // ── C8: user-abort terminal helper moved to ./pipeline/invocation-context.ts.
    // Its wide capture surface (source/trust/invocationCategory/meta/callbacks/…)
    // is threaded via a named-field deps object; `services.auditWriter` is passed
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
      auditWriter: services.auditWriter,
      audit: currentAuditMetadata(input),
    });

    if (abortSignal?.aborted) {
      return withHostShellExecutionPlan(await returnUserAbort(abortDeps(toolUse.input)));
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
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, blockedPermission, Infinity, permissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
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
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, blockedPermission, Infinity, permissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }

    // ── Step 2: PreToolUse Hook ─────────────────────
    // Governed plugin operations never dispatch effect-capable extension
    // hooks. Their provider state is protected by a Host-owned serialized
    // account scope; arbitrary hook code cannot participate in that proof or
    // be made crash-contained on every supported OS.
    const preResult: Awaited<ReturnType<HookRunner["runPreHooks"]>> =
      tool.operationPolicy
        ? { action: "allow" }
        : await services.hookRunner.runPreHooks({
            toolName: toolUse.name,
            toolInput: toolUse.input,
          });

    if (preResult.action === "deny") {
      if (rationaleResumeContext) {
        return returnRationaleResumeBlock(
          "argument PreToolUse hook denied the sealed action: " +
            (preResult.reason ?? "no reason"),
          toolUse.input,
        );
      }
      const msg = t("be_executor.hookBlockPre", { reason: preResult.reason ?? t("be_executor.hookBlockPreDefaultReason") });
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, toolUse.input, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, toolUse.input, msg, true, startTime, permissionResult, Infinity, permissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }

    const finalInput = preResult.action === "modify" && preResult.updatedInput
      ? preResult.updatedInput
      : toolUse.input;
    let resolvedPluginOperation: ResolvedPluginOperation | undefined;
    let pluginOperationPrincipal: PluginOperationPrincipal | undefined;
    if (tool.operationPolicy) {
      const ambientOrigin = currentInvocationOrigin();
      const operationOrigin = ambientOrigin === undefined ? "model" : ambientOrigin;
      try {
        resolvedPluginOperation = resolvePluginOperation(
          tool.operationPolicy,
          finalInput,
          operationOrigin,
        );
        const hostContext =
          permissionContext?.pluginOperation ??
          services.pluginOperationIdentityProvider(tool, sessionId);
        if (hostContext && tool.pluginId) {
          if (
            !tool.pluginGeneration ||
            hostContext.generationId !== tool.pluginGeneration.generationId
          ) {
            throw new Error("host-derived operation generation does not match the resolved tool");
          }
          const appGrantRequired =
            operationOrigin === "ui" || operationOrigin === "mcp-app";
          if (hostContext.appGrantRequired !== appGrantRequired) {
            throw new Error("host-derived operation grant policy does not match the effective origin");
          }
          pluginOperationPrincipal = {
            ownerPluginId: tool.pluginId,
            ownerVersion: hostContext.ownerVersion,
            generationId: hostContext.generationId,
            appSessionId: hostContext.appSessionId,
            accountScopeHash: hostContext.accountScopeHash,
            accountHash: hostContext.accountHash,
          };
        } else {
          throw new Error("host-derived operation identity is missing");
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const msg = `Plugin operation denied: ${reason}`;
        const durationMs = Date.now() - startTime;
        const denied: PermissionCheckResult = {
          decision: "deny",
          reason,
          layer: 0,
        };
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(
          toolUse.name,
          msg,
          true,
          meta,
          undefined,
          durationMs,
        );
        await auditCurrentToolCall(
          sessionId,
          toolUse.name,
          source,
          trust,
          finalInput,
          msg,
          true,
          startTime,
          denied,
          Infinity,
          permissionContext,
          invocationCategory,
          executionCwd,
        );
        return withHostShellExecutionPlan({
          tool_use_id: toolUse.id,
          content: msg,
          is_error: true,
          durationMs,
        });
      }
    }
    if (rationaleResumeContext) {
      let inputsMatch = false;
      try {
        inputsMatch =
          canonicalStringify(toolUse.input) === canonicalStringify(
            rationaleResumeContext.request.control.sealedAction.originalInput,
          ) &&
          canonicalStringify(finalInput) === canonicalStringify(
            rationaleResumeContext.request.control.sealedAction.finalInput,
          );
      } catch {
        inputsMatch = false;
      }
      if (!inputsMatch) {
        return returnRationaleResumeBlock(
          "sealed original/final input changed after argument PreToolUse hooks",
          finalInput,
        );
      }
    }
    if (finalInput !== toolUse.input) {
      invocationCategory = resolveInvocationCategory(tool, finalInput);
      meta.category = invocationCategory;
    }

    if (abortSignal?.aborted) {
      return withHostShellExecutionPlan(await returnUserAbort(abortDeps(finalInput)));
    }
    // ── C8: initial per-invocation state (see ./pipeline/invocation-context.ts).
    // The factory builds the Layer-1 allowed scope + runtime allowed dirs + the
    // parent/own effect ledgers exactly as the former inline initializers did,
    // including the within-round freshness read of additionalDirectories.
    // `invocationAllowedScope` / `invocationRuntimeAllowedDirectories` stay `let`
    // LOCALS here (not context fields): applyApprovedDirectory reassigns them and
    // the sandbox-relaxation blocks below read them inline — boxing them would
    // force edits inside those byte-identical trust-boundary blocks.
    const initialState = createInvocationContext(permissionContext, executionCwd);
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
    invocationCategory = resolveEnforcedCategory(
      services,
      tool,
      invocationCategory,
      finalInput,
      invocationAllowedScope.directories,
      effectLedger.correlationId,
      resolvedPluginOperation?.rule.minimumRisk,
    );
    meta.category = invocationCategory;
    // Freeze the shell substrate before any reviewer, memory, or approval path.
    // Only these host-owned builtin tools may consume the plan.
    const hostShellToolName =
      invocationCategory !== "shell" || toolUse.name !== tool.name
        ? undefined
        : isCanonicalBashTool(tool)
          ? "bash"
          : isCanonicalPowerShellTool(tool)
            ? "powershell"
            : undefined;
    const hostShellExecutionPlan =
      hostShellToolName !== undefined
        ? getHostShellExecutionPlan()
        : undefined;
    const hostShellRequiresExplicitApproval =
      hostShellExecutionPlan !== undefined &&
      requiresExplicitHostShellFallbackApproval(hostShellExecutionPlan);
    hostShellExecutionPlanAudit = hostShellExecutionPlan === undefined
      ? undefined
      : getHostShellExecutionPlanAuditProjection(hostShellExecutionPlan);
    if (hostShellExecutionPlanAudit !== undefined) {
      // Reuse the exact immutable safe projection for tool lifecycle events.
      meta.executionPlan = hostShellExecutionPlanAudit;
    }
    // The cache key is an authority boundary too: derive it only after the
    // canonical host shell substrate is sealed, then reuse its exact public
    // projection through reviewer, modal, rationale, result, and audit paths.
    const approvalCacheKey = approvalCacheKeyFor(
      tool,
      finalInput,
      executionCwd,
      hostShellExecutionPlanAudit,
    );
    const invocationPermissionContext: ToolPermissionContext = {
      ...permissionContext,
      ...(approvalCacheKey ? { approvalCacheKey } : {}),
    };
    const approvalPurpose = buildApprovalPurposeSuggestion(finalInput, invocationPermissionContext);
    const reviewerInput = maskToolInputForDisplay(finalInput);
    const auditInput = auditSafeToolInput(
      finalInput,
      currentAuditMetadata(finalInput),
    );
    // The Plan-B binding is created only after every Layer-1 directory grant
    // has finalized the effective validator scope. It remains host-only.
    let hostShellExecutionPermitBinding:
      | HostShellExecutionPermitBinding
      | undefined;
    let hostShellApprovalDecision: ApprovalDecision | undefined;
    const makeEvaluationContext = (input: {
      pathFields: readonly string[];
      targetFilePaths?: readonly string[];
      sensitivePathsAdjacent?: readonly string[];
    }): PermissionEvaluationContext => buildPermissionEvaluationContext({
      policyMode: services.permissionManager?.getMode?.() ?? "unmanaged",
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
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
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

      if (services.approvalGate && !headless) {
        const approvalRequest = {
          id: randomUUID(),
          category: "tool" as const,
          kind: "out-of-allowed-dir" as const,
          toolName: toolUse.name,
          toolCategory: invocationCategory,
          args: finalInput,
          reason: approvalReasonPrefix
            ? `${approvalReasonPrefix} ${dirLayerResult.reason}`
            : dirLayerResult.reason,
          source: source as "builtin" | "plugin" | "mcp",
          createdAt: Date.now(),
          target: { filePath: outOfAllowedTarget.filePath },
          isReadOnly: invocationCategory === "read",
          mode: currentApprovalMode(services.permissionManager),
          sensitivePathPattern: requestSensitivePathPattern,
          // Canonical host shells carry the sealed renderer-safe projection;
          // every other execution route retains the existing capability display.
          ...(hostShellExecutionPlanAudit === undefined
            ? {
                sandboxCapability: resolveReviewerSandboxCapability(
                  source,
                  toolUse.name,
                  tool.mcpServerId,
                  tool.workerId,
                  tool.pluginId,
                ),
              }
            : { executionPlan: hostShellExecutionPlanAudit }),
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
          await auditCurrentPermissionAsk(
            toolUse.name,
            source,
            invocationCategory,
        finalInput,
            dirLayerResult,
            executionCwd,
            invocationPermissionContext,
            outOfAllowedTarget.filePath,
          );
          decision = await services.approvalGate.requestAndWait(approvalRequest);
        } catch (approvalErr) {
          const msg = t("be_executor.dirPolicyError", { name: toolUse.name, error: approvalErr instanceof Error ? approvalErr.message : String(approvalErr) });
          const durationMs = Date.now() - startTime;
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, dirLayerResult, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
        }

        if (decision.choice.startsWith("deny")) {
          const msg = t("be_executor.dirPolicyUserDenied", { name: toolUse.name, filePath: outOfAllowedTarget.filePath });
          const durationMs = Date.now() - startTime;
          emitToolStart(callbacks, toolUse.name, finalInput, meta);
          callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
          await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
          return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
        }
        const approvedDirectory = decision.choice === "allow-always"
          ? (typeof decision.rememberPattern === "string" && decision.rememberPattern.length > 0
              ? decision.rememberPattern
              : suggestedParent ?? outOfAllowedTarget.filePath)
          : outOfAllowedTarget.filePath;
        if (decision.choice === "allow-always") {
          let lifecycle: PermissionDirectoryLifecycle | undefined;
          try {
            lifecycle = services.workspaceRootLifecycleProvider();
          } catch {
            lifecycle = undefined;
          }
          const dirResult = lifecycle
            ? await dispatchPermissionDirCommand({
                verb: "allow",
                path: approvedDirectory,
                session: false,
                acknowledgeWarnings: true,
              }, undefined, lifecycle)
            : { ok: false as const, error: "workspace lifecycle unavailable" };
          if (!dirResult.ok || dirResult.verb !== "allow") {
            const msg = t("be_executor.dirPolicySaveFailed", { name: toolUse.name, error: dirResult.ok ? "unexpected result" : dirResult.error });
            const durationMs = Date.now() - startTime;
            emitToolStart(callbacks, toolUse.name, finalInput, meta);
            callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
            await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
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
            await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
            return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
          }
          return { allowed: true, approvedDirectory: sessionScopePath, scope: "session" };
        }
        // allow-once: turn-scope, no persistence, narrowest path.
        return { allowed: true, approvedDirectory, scope: "turn" };
      }

      if (headless) {
        const deferredQueue = services.permissionManager?.getDeferredQueue();
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
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
      }

      const msg = t("be_executor.approvalGateMissingLayer1", { name: toolUse.name, source });
      const durationMs = Date.now() - startTime;
      log.error(msg);
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { ...dirLayerResult, decision: "deny" }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
      return { allowed: false, result: withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs }) };
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
      invocationAllowedScope = buildAllowedScope([...fresh, approvedDirectory], executionCwd);
      invocationRuntimeAllowedDirectories = buildRuntimeAllowedDirectories(
        [...fresh, approvedDirectory],
        executionCwd,
      );
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
        void services.auditWriter.auditPermissionGrant({
          toolName: toolUse.name,
          source,
          category: invocationCategory,
          directory: approvedDirectory,
          grantLifetime: lifetime,
          permissionContext: invocationPermissionContext,
          audit: currentAuditMetadata(),
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
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
      }
    }

    // ── Step 2.5: Bash AST Pre-Validator ────────────
    //
    // Hooks are allowed to rewrite tool inputs. Validate the final invocation,
    // not the original provider payload, so a hook cannot approve one command
    // and execute another.
    if (services.bashAstValidator) {
      const bashResult = services.bashAstValidator.validate(toolUse.name, finalInput);
      if (bashResult.decision === "deny") {
        const msg = t("be_executor.bashAstBlock", { reason: bashResult.reason ?? "", patternId: bashResult.patternId ?? "" });
        const durationMs = Date.now() - startTime;
        emitToolStart(callbacks, toolUse.name, finalInput, meta);
        callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { decision: "deny", reason: bashResult.reason ?? "bash AST", layer: 0 }, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
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
    // out-of-directory prompt are not gated on `services.permissionManager`).
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
        await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
        return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
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
      await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, blockedPermission, Infinity, invocationPermissionContext, invocationCategory, executionCwd);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
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
        if (rationaleResumeContext) {
          return returnRationaleResumeBlock(
            "current allowed-directory scope no longer covers the sealed action",
            finalInput,
            dirLayerResult,
          );
        }
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
    if (
      hostShellExecutionPlan !== undefined &&
      hostShellToolName !== undefined &&
      hostShellRequiresExplicitApproval
    ) {
      hostShellExecutionPermitBinding = buildHostShellExecutionPermitBinding({
        plan: hostShellExecutionPlan,
        toolName: hostShellToolName,
        toolUseId: toolUse.id,
        rawInput: finalInput,
        executionCwd,
        extraAllowedDirectories: invocationRuntimeAllowedDirectories,
      });
    }
    const evaluationContext = makeEvaluationContext({
      pathFields: tool.pathFields ?? [],
      targetFilePaths,
      sensitivePathsAdjacent: sensitivePathPattern ? [sensitivePathPattern] : [],
    });

    const authorization = await authorizeToolInvocation({
      services,
      tool,
      toolUse,
      source,
      trust,
      invocationCategory,
      approvalReasonPrefix,
      overlayTriggerOrigin,
      hostShellRequiresExplicitApproval,
      hostShellExecutionPlan,
      hostShellExecutionPlanAudit,
      hostShellExecutionPermitBinding,
      hostShellApprovalDecision,
      finalInput,
      invocationAllowedScope,
      sensitivePathPattern,
      invocationPermissionContext,
      evaluationContext,
      callbacks,
      meta,
      approvalPurpose,
      reviewerInput,
      auditInput,
      abortSignal,
      rationaleResumeContext,
      rationaleBatchContext,
      targetFilePaths,
      targetFilePath,
      canonicalTargets,
      approvalCacheKey,
      executionCwd,
      auditCurrentToolCall,
      auditCurrentPermissionAsk,
      withHostShellExecutionPlan,
      abortDeps,
      returnRationaleResumeBlock,
      sessionId,
      startTime,
      permissionResult,
      resolvedPluginOperation,
      pluginOperationPrincipal,
    });
    if ("tool_use_id" in authorization || authorization.outcome === "rationale-required") {
      return authorization;
    }
    permissionResult = authorization.permissionResult;
    hostShellApprovalDecision = authorization.hostShellApprovalDecision;

    return executeAuthorizedToolInvocation({
      services,
      tool,
      toolUse,
      source,
      trust,
      invocationCategory,
      declaredCategoryForEffectShadow,
      finalInput,
      sessionId,
      invocationPermissionContext,
      rationaleResumeContext,
      returnRationaleResumeBlock,
      startTime,
      callbacks,
      meta,
      auditCurrentToolCall,
      currentAuditMetadata,
      withHostShellExecutionPlan,
      permissionResult,
      abortSignal,
      hostShellExecutionPermitBinding,
      hostShellApprovalDecision,
      hostShellExecutionPlan,
      hostShellRequiresExplicitApproval,
      invocationRuntimeAllowedDirectories,
      supportsA2AParentDelivery,
      spawnDepth,
      a2aCausalContext,
      toolResultChunkReader,
      executionCwd,
      parentEffectLedger,
      effectLedger,
      targetFilePath,
      preResult,
      resolvedPluginOperation,
      pluginOperationPrincipal,
    });
    };
    try {
      return generationAccess && generationLease
        ? await generationAccess.runWithLease(generationLease, executeAdmitted)
        : await executeAdmitted();
    } finally {
      generationLease?.release();
    }
  }

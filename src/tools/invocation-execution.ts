import type { ApprovalDecision } from "../permissions/approval-gate.js";
import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import type { PermissionCheckResult } from "../permissions/permission-manager.js";
import type { ToolExecutionAuditMetadata } from "../audit/audit-schema.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import { emitEffectShadowLog } from "../permissions/reviewer/risk-shadow-log.js";
import { runWithEffectLedger, type EffectLedger } from "../permissions/effect-ledger.js";
import { runWithToolExecutionCwd } from "./execution-context.js";
import { runWithEffectGateContext } from "../permissions/effect-enforcement.js";
import { CHOKEPOINT_EFFECT } from "../permissions/effect-kind.js";
import type { HostShellExecutionPermitBinding } from "../permissions/host-shell-execution-permit.js";
import { mintHostShellExecutionPermit } from "../permissions/host-shell-execution-permit.js";
import { runWithCeiling } from "./executor-ceiling.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  A2A_CAUSAL_CONTEXT_METADATA_KEY,
  isA2AAgentCausalContext,
  type A2AAgentCausalContext,
} from "../engine/a2a-agent-message-envelope.js";
import { TOOL_RESULT_CHUNK_READER_METADATA_KEY } from "./tool-result-chunk.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import { lvisHome } from "../shared/lvis-home.js";
import type { Tool } from "./base.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import type {
  ToolCategory,
  ToolExecutionContext,
  ToolResultImage,
  ToolSource,
  TrustLevel,
} from "./types.js";
import {
  hookChainFromDispatch,
  mergeHookChains,
  redactAskUserAuditOutput,
} from "./pipeline/audit-entries.js";
import { emitToolStart } from "./pipeline/display-mask.js";
import { returnUserAbort } from "./pipeline/invocation-context.js";
import {
  finishRationaleResume,
  startRationaleResume,
} from "./pipeline/rationale-resume-runner.js";
import {
  runScriptHook,
  type InvocationRunnerServices,
} from "./invocation-services.js";
import type { AuditWriter } from "./pipeline/audit-writer.js";
import {
  RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT,
  type ExecuteOptions,
  type ToolCallMeta,
  type ToolExecutorCallbacks,
  type ToolPermissionContext,
  type ToolResult,
  type ToolUseBlock,
} from "./executor-contract.js";
import type { RationaleResumeExecutionContext } from "./invocation-runner.js";
import type { ResolvedPluginOperation } from "./plugin-operation-governance.js";
import {
  PluginOperationExecutionLeaseAbortedError,
  pluginOperationExecutionDomain,
  type PluginOperationPrincipal,
} from "../permissions/plugin-operation-grant.js";

const log = createLogger("executor");

type AuditToolCall = (...args: Parameters<AuditWriter["auditToolCall"]>) => Promise<void>;

function satisfiesDeclaredReadResultStatus(
  value: unknown,
  successfulStatuses: readonly string[] | undefined,
): boolean {
  if (successfulStatuses === undefined) return true;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const status = (value as Record<string, unknown>).status;
  return typeof status === "string" && successfulStatuses.includes(status);
}

export interface ExecutionStageContext {
  services: InvocationRunnerServices;
  tool: Tool;
  toolUse: ToolUseBlock;
  source: ToolSource;
  trust: TrustLevel;
  invocationCategory: ToolCategory;
  declaredCategoryForEffectShadow: ToolCategory;
  finalInput: Record<string, unknown>;
  sessionId: string | undefined;
  invocationPermissionContext: ToolPermissionContext;
  rationaleResumeContext: RationaleResumeExecutionContext | undefined;
  returnRationaleResumeBlock: (
    reason: string,
    input: Record<string, unknown>,
    blockedPermission?: PermissionCheckResult,
    hookChain?: import("../audit/audit-schema.js").HookResult[],
    suppressPermissionDeniedLifecycle?: boolean,
  ) => Promise<ToolResult>;
  startTime: number;
  callbacks: ToolExecutorCallbacks | undefined;
  meta: ToolCallMeta;
  auditCurrentToolCall: AuditToolCall;
  currentAuditMetadata: () => ToolExecutionAuditMetadata;
  withHostShellExecutionPlan: (result: ToolResult) => ToolResult;
  permissionResult: PermissionCheckResult | undefined;
  abortSignal: AbortSignal | undefined;
  hostShellExecutionPermitBinding: HostShellExecutionPermitBinding | undefined;
  hostShellApprovalDecision: ApprovalDecision | undefined;
  hostShellExecutionPlan: HostShellExecutionPlan | undefined;
  hostShellRequiresExplicitApproval: boolean;
  invocationRuntimeAllowedDirectories: string[];
  supportsA2AParentDelivery: boolean | undefined;
  spawnDepth: number | undefined;
  a2aCausalContext: A2AAgentCausalContext | undefined;
  toolResultChunkReader: ExecuteOptions["toolResultChunkReader"];
  executionCwd: string;
  parentEffectLedger: EffectLedger | undefined;
  effectLedger: EffectLedger;
  targetFilePath: string | undefined;
  preResult: Awaited<ReturnType<HookRunner["runPreHooks"]>>;
  resolvedPluginOperation: ResolvedPluginOperation | undefined;
  pluginOperationPrincipal: PluginOperationPrincipal | undefined;
}

export async function executeAuthorizedToolInvocation(
  context: ExecutionStageContext,
): Promise<ToolResult> {
  const {
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
  } = context;


  const scriptPre = resolvedPluginOperation
    ? {
        decision: "allow" as const,
        reason: "governed operation hooks are disabled",
        results: [],
      }
    : await runScriptHook(
        services.scriptHookManager,
        "pre",
        toolUse.name,
        source,
        invocationCategory,
        finalInput,
        sessionId,
        invocationPermissionContext,
        tool.mcpServerId,
        tool.pluginId,
        undefined,
        undefined,
        tool.pluginGeneration !== undefined,
      );
  if (scriptPre.decision === "deny") {
    if (rationaleResumeContext) {
      return returnRationaleResumeBlock(
        "script PreToolUse hook denied the sealed action: " + scriptPre.reason,
        finalInput,
        { decision: "deny", reason: scriptPre.reason, layer: 6 },
        hookChainFromDispatch("pre", scriptPre),
      );
    }
    const msg = t("be_executor.hookBlockScript", { reason: scriptPre.reason });
    const durationMs = Date.now() - startTime;
    emitToolStart(callbacks, toolUse.name, finalInput, meta);
    callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
    await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, { decision: "deny", reason: scriptPre.reason, layer: 6 }, Infinity, invocationPermissionContext, invocationCategory, executionCwd, undefined, undefined, hookChainFromDispatch("pre", scriptPre));
    return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
  }

  // ── Step 5: Rate Limit (trust별) ────────────────
  const rateResult = services.rateLimiter.check(toolUse.name, trust);
  if (!rateResult.allowed) {
    if (rationaleResumeContext) {
      return returnRationaleResumeBlock(
        "rate limit denied the sealed action",
        finalInput,
        permissionResult,
      );
    }
    const msg = t("be_executor.rateLimitExceeded", { name: toolUse.name, trust });
    const durationMs = Date.now() - startTime;
    emitToolStart(callbacks, toolUse.name, finalInput, meta);
    callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
    await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, msg, true, startTime, permissionResult, 0, invocationPermissionContext, invocationCategory, executionCwd);
    return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
  }

  if (services.requirePermissionAuditChain) {
    try {
      services.auditLogger.assertPermissionAuditWritable();
    } catch (err) {
      if (rationaleResumeContext) {
        return returnRationaleResumeBlock(
          "permission audit chain is not writable: " +
            (err instanceof Error ? err.message : String(err)),
          finalInput,
          permissionResult,
        );
      }
      const msg = t("be_executor.auditChainBlock", { name: toolUse.name, error: err instanceof Error ? err.message : String(err) });
      const durationMs = Date.now() - startTime;
      emitToolStart(callbacks, toolUse.name, finalInput, meta);
      callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
      services.auditLogger.log({
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
          ...currentAuditMetadata(),
          permissionDecision: "deny",
          permissionReason: "permission audit chain unavailable before execution",
          rateLimitRemaining: rateResult.remaining,
        }],
      });
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
    }
  }

  const operationExecutionDomain =
    resolvedPluginOperation && pluginOperationPrincipal
      ? pluginOperationExecutionDomain(
          pluginOperationPrincipal,
          toolUse.name,
          resolvedPluginOperation.operation,
          services.toolRegistry.listAll(),
        )
      : undefined;
  let operationExecutionLease:
    | Awaited<ReturnType<
        typeof services.pluginOperationGrants.acquireExecutionLease
      >>
    | undefined;
  try {
    operationExecutionLease =
      resolvedPluginOperation &&
      pluginOperationPrincipal &&
      operationExecutionDomain
        ? await services.pluginOperationGrants.acquireExecutionLease(
            operationExecutionDomain,
            pluginOperationPrincipal,
            abortSignal,
          )
        : undefined;
  } catch (error) {
    if (error instanceof PluginOperationExecutionLeaseAbortedError) {
      return withHostShellExecutionPlan(await returnUserAbort({
        input: finalInput,
        toolUse,
        meta,
        callbacks,
        source,
        trust,
        invocationCategory,
        sessionId,
        permissionContext: invocationPermissionContext,
        executionCwd,
        startTime,
        auditWriter: services.auditWriter,
        audit: currentAuditMetadata(),
      }));
    }
    const msg = error instanceof Error ? error.message : String(error);
    if (rationaleResumeContext) {
      return returnRationaleResumeBlock(
        `governed operation admission failed: ${msg}`,
        finalInput,
        permissionResult,
        undefined,
        true,
      );
    }
    const durationMs = Date.now() - startTime;
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
      { decision: "deny", reason: msg, layer: 6 },
      rateResult.remaining,
      invocationPermissionContext,
      invocationCategory,
      executionCwd,
      undefined,
      "error",
      undefined,
      undefined,
      true,
    );
    return withHostShellExecutionPlan({
      tool_use_id: toolUse.id,
      content: msg,
      is_error: true,
      durationMs,
    });
  }
  let content: string;
  let isError = false;
  let uiPayload: import("../mcp/types.js").McpUiPayload | undefined;
  let rawResult: unknown;
  let image: ToolResultImage | undefined;
  let terminationReason:
    | "ok"
    | "ceiling"
    | "user-abort"
    | "error"
    | "indeterminate" = "ok";
  let consumedPluginOperationGrantId: string | undefined;
  let deferredOperationSettlement: Promise<unknown> | undefined;
  let indeterminateAuditPersisted = false;
  let interruptionReason: "ceiling" | "user-abort" | undefined;
  let holdOperationLeaseForFinalBoundary = false;
  const releaseOperationLeaseAfterFinalBoundary = (): void => {
    if (!holdOperationLeaseForFinalBoundary) return;
    holdOperationLeaseForFinalBoundary = false;
    operationExecutionLease?.release();
  };
  let pendingReadReceipt:
    | {
        principal: PluginOperationPrincipal;
        readTool: string;
        readOperation: string;
        domainKey: string;
      }
    | undefined;
  let postFeedback: string | undefined;
  let scriptPost: Awaited<ReturnType<typeof runScriptHook>> = {
    decision: "allow",
    reason: "post hooks not run",
    results: [],
  };
  try {
    if (
      resolvedPluginOperation?.rule.kind === "read" &&
      pluginOperationPrincipal &&
      operationExecutionDomain
    ) {
      services.pluginOperationGrants.beginRead({
        ...pluginOperationPrincipal,
        readTool: toolUse.name,
        readOperation: resolvedPluginOperation.operation,
      }, operationExecutionDomain);
    }
    if (rationaleResumeContext) {
      if (!rationaleResumeContext.authorized) {
        return returnRationaleResumeBlock(
          "rationale resume authorization was lost before invocation start",
          finalInput,
          permissionResult,
        );
      }
      const started = await startRationaleResume(rationaleResumeContext.authorized);
      if (!started.ok) {
        return returnRationaleResumeBlock(
          started.reason,
          finalInput,
          permissionResult,
        );
      }
      rationaleResumeContext.started = started.value;
    }

    if (
      resolvedPluginOperation?.rule.kind === "write" &&
      pluginOperationPrincipal
    ) {
      const readRequirement = resolvedPluginOperation.rule.requiresRead;
      const grantContext = invocationPermissionContext.pluginOperation;
      const consumed = grantContext?.appGrantRequired === true
        ? services.pluginOperationGrants.consume(
            grantContext.grantToken,
            {
              ...pluginOperationPrincipal,
              toolName: toolUse.name,
              operation: resolvedPluginOperation.operation,
              intentHash: resolvedPluginOperation.intentHash,
              requiresRead: readRequirement !== undefined,
            },
            operationExecutionDomain!,
          )
        : readRequirement
          ? services.pluginOperationGrants.consumeRequiredRead(
              pluginOperationPrincipal,
              {
                readTool: readRequirement.tool,
                readOperations: readRequirement.operations,
                maxAgeMs: readRequirement.maxAgeMs,
              },
              operationExecutionDomain!,
            )
          : { ok: true as const };
      const consumedGrantId =
        "grantId" in consumed && typeof consumed.grantId === "string"
          ? consumed.grantId
          : undefined;
      if (consumed.ok) consumedPluginOperationGrantId = consumedGrantId;
      let grantAuditError: unknown;
      try {
        const commonGrantAudit = {
          ts: new Date().toISOString(),
          auditId: randomUUID(),
          tool: toolUse.name,
          source,
          category: invocationCategory,
          trustOrigin: invocationPermissionContext.trustOrigin,
          pluginOperation: {
            pluginId: pluginOperationPrincipal.ownerPluginId,
            operation: resolvedPluginOperation.operation,
            outcome: consumed.ok ? "consumed" : "rejected",
            ...(consumedGrantId ? { grantId: consumedGrantId } : {}),
          },
        } as const;
        if (consumed.ok) {
          await services.auditLogger.appendPermissionAuditEntry({
            ...commonGrantAudit,
            decision: "allow",
            layer: 6,
          });
        } else {
          await services.auditLogger.appendPermissionAuditEntry({
            ...commonGrantAudit,
            decision: "deny",
            denyReasons: [{
              layer: 6,
              reason: consumed.reason,
              source: "plugin-operation-grant",
            }],
          });
        }
      } catch (error) {
        grantAuditError = error;
      }
      if (!consumed.ok || grantAuditError !== undefined) {
        const reason = consumed.ok
          ? `permission audit chain failed: ${grantAuditError instanceof Error ? grantAuditError.message : String(grantAuditError)}`
          : consumed.reason;
        const msg = `Plugin operation denied: ${reason}`;
        const durationMs = Date.now() - startTime;
        const denied: PermissionCheckResult = {
          decision: "deny",
          reason,
          layer: 6,
        };
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
          rateResult.remaining,
          invocationPermissionContext,
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

    emitToolStart(callbacks, toolUse.name, finalInput, meta);

    // ── Step 6: Execute ─────────────────────────────
  // Mint only after all permission, hook, rate-limit, and audit gates passed.
  // The permit is private host state, binds this exact final shell action,
  // and is consumed once by the plain requested-sandbox fallback spawn path.
  const hostShellExecutionPermit =
    hostShellExecutionPlan !== undefined &&
    hostShellExecutionPermitBinding !== undefined
      ? mintHostShellExecutionPermit({
          plan: hostShellExecutionPlan,
          approvalDecision: hostShellApprovalDecision,
          binding: hostShellExecutionPermitBinding,
        })
      : undefined;
  if (
    hostShellRequiresExplicitApproval &&
    hostShellExecutionPermit === undefined
  ) {
    const msg =
      "Requested-sandbox shell execution blocked: no host-verified allow-once receipt was available for this action.";
    const durationMs = Date.now() - startTime;
    emitToolStart(callbacks, toolUse.name, finalInput, meta);
    callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
    await auditCurrentToolCall(
      sessionId,
      toolUse.name,
      source,
      trust,
      finalInput,
      msg,
      true,
      startTime,
      permissionResult
        ? {
            ...permissionResult,
            decision: "deny",
            reason: msg,
            layer: permissionResult.layer ?? 6,
          }
        : { decision: "deny", reason: msg, layer: 6 },
      rateResult.remaining,
      invocationPermissionContext,
      invocationCategory,
      executionCwd,
    );
    return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: msg, is_error: true, durationMs });
  }

  const executionContext: ToolExecutionContext = {
    cwd: executionCwd,
    extraAllowedDirectories: [...new Set(invocationRuntimeAllowedDirectories)],
    // Owner plugin sandbox root — same derivation the reviewer uses
    // (executor permission path). Plugin-owned tools confine their OS
    // write-jail to `~/.lvis/plugins/<pluginId>/`; builtins pass undefined.
    ...(tool.pluginId
      ? { ownerPluginSandboxRoot: pathResolve(lvisHome(), "plugins", tool.pluginId) }
      : {}),
    ...(hostShellExecutionPlan ? { hostShellExecutionPlan } : {}),
    ...(hostShellExecutionPermit ? { hostShellExecutionPermit } : {}),
    metadata: {
      sessionId: sessionId ?? "unknown",
      // C3(b): spawn depth visible to tools — `agent_spawn` reads this
      // and refuses when >= 1 (a sub-agent cannot itself spawn).
      spawnDepth: spawnDepth ?? 0,
      supportsA2AParentDelivery: supportsA2AParentDelivery === true,
      // Tool 자기 호출의 stable id — 렌더러가 inline UI 카드 (sub-agent 등)
      // 를 ToolGroupCard 옆에 join 할 때 키로 사용. agent_spawn 이 emit 하는
      // 라이프사이클 이벤트에 함께 실어 보냄.
      toolUseId: toolUse.id,
      trustOrigin: invocationPermissionContext.trustOrigin,
      ...(toolResultChunkReader
        ? { [TOOL_RESULT_CHUNK_READER_METADATA_KEY]: toolResultChunkReader }
        : {}),
      ...(toolUse.name === "agent_send"
        && tool.source === "builtin"
        && spawnDepth === 1
        && sessionId === a2aCausalContext?.recipientChildSessionId
        && isA2AAgentCausalContext(a2aCausalContext)
        ? { [A2A_CAUSAL_CONTEXT_METADATA_KEY]: a2aCausalContext }
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
      // When `hostClassifiesRisk` is OFF (disabled/unset; the shipped default
      // is ON, see settings-store.ts) the gate is a pass-through, so binding
      // the context here is inert.
      return runWithToolExecutionCwd(executionCwd, () =>
        runWithEffectLedger(effectLedger, () =>
          runWithEffectGateContext(
            {
              headless: invocationPermissionContext.headless === true,
              toolName: toolUse.name,
            },
            () => {
              if (
                pluginOperationPrincipal &&
                operationExecutionDomain
              ) {
                // No await may separate this final revocation check from
                // handler entry. Session/account/generation teardown that won
                // the race after lease admission therefore blocks dispatch.
                services.pluginOperationGrants.assertExecutionAuthorized(
                  pluginOperationPrincipal,
                  operationExecutionDomain,
                );
              }
              return tool.execute(finalInput, ctx);
            },
          ),
        ),
      );
    },
    effectiveCeilingMs,
    abortSignal,
    toolUse.name,
  );
  if (
    resolvedPluginOperation &&
    operationExecutionDomain
  ) {
    if (
      resolvedPluginOperation.rule.kind === "write" ||
      outcome.settlement
    ) {
      // Declared writes and any interrupted governed execution may have
      // changed remote state. Advance before the exclusive lease can release.
      services.pluginOperationGrants.markDomainMutation(
        operationExecutionDomain,
      );
    }
  }
  if (
    outcome.settlement &&
    resolvedPluginOperation &&
    pluginOperationPrincipal
  ) {
    deferredOperationSettlement = outcome.settlement;
    terminationReason = "indeterminate";
    await services.auditLogger.appendPermissionAuditEntry({
      ts: new Date().toISOString(),
      auditId: randomUUID(),
      tool: toolUse.name,
      source,
      category: invocationCategory,
      trustOrigin: invocationPermissionContext.trustOrigin,
      decision: "deny",
      denyReasons: [{
        layer: 6,
        reason: "authorized governed operation remains unsettled after interruption",
        source: "plugin-operation-execution",
      }],
      pluginOperation: {
        pluginId: pluginOperationPrincipal.ownerPluginId,
        operation: resolvedPluginOperation.operation,
        outcome: "indeterminate",
        ...(consumedPluginOperationGrantId
          ? { grantId: consumedPluginOperationGrantId }
          : {}),
      },
    });
    indeterminateAuditPersisted = true;
  }
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
    // view_image et al. — an image the model should see travels on a sibling
    // field; the Claude mapper turns it into an image block, other vendors keep
    // the text placeholder.
    if (result.image) {
      image = result.image;
    }
    if (isError) terminationReason = "error";
  } else {
    if (
      outcome.reason === "ceiling" ||
      outcome.reason === "user-abort"
    ) {
      interruptionReason = outcome.reason;
    }
    if (!outcome.settlement) terminationReason = outcome.reason;
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
  if (
    operationExecutionDomain &&
    resolvedPluginOperation?.rule.kind === "read" &&
    !outcome.settlement &&
    effectSummary.hasMutatingEffect
  ) {
    services.pluginOperationGrants.markDomainMutation(
      operationExecutionDomain,
    );
  }
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
  // A signed read declaration alone cannot mint freshness. Stage the receipt
  // only after a successful Host-observable plugin execution with no mutation.
  // Publication waits until post hooks and the required final audit are both
  // durably complete below.
  if (
    !isError &&
    tool.source === "plugin" &&
    resolvedPluginOperation?.rule.kind === "read" &&
    pluginOperationPrincipal &&
    services.pluginOperationGrants.canRecordRead(
      pluginOperationPrincipal,
      operationExecutionDomain!,
    ) &&
    !effectSummary.hasMutatingEffect &&
    satisfiesDeclaredReadResultStatus(
      rawResult,
      resolvedPluginOperation.rule.successfulResultStatuses,
    )
  ) {
    pendingReadReceipt = {
      principal: pluginOperationPrincipal,
      readTool: toolUse.name,
      readOperation: resolvedPluginOperation.operation,
      domainKey: operationExecutionDomain!,
    };
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
      services.auditLogger,
    );
  }
  if (
    operationExecutionLease &&
    !deferredOperationSettlement
  ) {
    // Keep the exclusive governed-operation lease through every terminal audit,
    // rationale transition, receipt publication, and callback. User-abort is a
    // terminal result too; it cannot release before its final audit persists.
    holdOperationLeaseForFinalBoundary = true;
  }
  } finally {
    if (
      operationExecutionLease &&
      deferredOperationSettlement &&
      indeterminateAuditPersisted &&
      pluginOperationPrincipal &&
      resolvedPluginOperation
    ) {
      const lease = operationExecutionLease;
      const pluginId = pluginOperationPrincipal.ownerPluginId;
      const operation = resolvedPluginOperation.operation;
      const grantId = consumedPluginOperationGrantId;
      void deferredOperationSettlement
        .then(async () => {
          try {
            await services.auditLogger.appendPermissionAuditEntry({
              ts: new Date().toISOString(),
              auditId: randomUUID(),
              tool: toolUse.name,
              source,
              category: invocationCategory,
              trustOrigin: invocationPermissionContext.trustOrigin,
              decision: "allow",
              layer: 6,
              pluginOperation: {
                pluginId,
                operation,
                outcome: "settled",
                ...(grantId ? { grantId } : {}),
              },
            });
            lease.release();
          } catch (error) {
            log.error(
              "late plugin operation settlement audit failed; domain remains poisoned for %s: %s",
              toolUse.name,
              error instanceof Error ? error.message : String(error),
            );
          }
        }, (error) => {
          log.error(
            "late plugin operation settlement tracking failed; domain remains poisoned for %s: %s",
            toolUse.name,
            error instanceof Error ? error.message : String(error),
          );
        });
    } else if (operationExecutionLease && deferredOperationSettlement) {
      void deferredOperationSettlement.catch((error) => {
        log.error(
          "unaudited late plugin operation settlement tracking failed; domain remains poisoned for %s: %s",
          toolUse.name,
          error instanceof Error ? error.message : String(error),
        );
      });
      log.error(
        "plugin operation interruption audit failed; domain remains poisoned for %s",
        toolUse.name,
      );
    } else if (!holdOperationLeaseForFinalBoundary) {
      operationExecutionLease?.release();
    }
  }

  if (interruptionReason === "user-abort") {
    const durationMs = Date.now() - startTime;
    try {
      if (!rationaleResumeContext?.started) {
        callbacks?.onToolEnd?.(toolUse.name, content, true, meta, undefined, durationMs);
      }
      await auditCurrentToolCall(
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
      if (rationaleResumeContext?.started) {
        rationaleResumeContext.terminalizationAttempted = true;
        const terminalCommitted = await finishRationaleResume(
          rationaleResumeContext.started,
          false,
        );
        rationaleResumeContext.terminalized = terminalCommitted;
        if (!terminalCommitted) {
          callbacks?.onToolEnd?.(toolUse.name, RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT, true, meta, undefined, durationMs);
          return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT, is_error: true, durationMs });
        }
        callbacks?.onToolEnd?.(toolUse.name, content, true, meta, undefined, durationMs);
      }
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content, is_error: true, durationMs });
    } catch (error) {
      if (operationExecutionDomain && resolvedPluginOperation) {
        services.pluginOperationGrants.poisonDomain(operationExecutionDomain);
      }
      throw error;
    } finally {
      releaseOperationLeaseAfterFinalBoundary();
    }
  }

  try {
  // ── Step 7: PostHook + Feedback Merge ───────────
  if (!resolvedPluginOperation) {
    postFeedback = await services.hookRunner.runPostHooks({
      toolName: toolUse.name,
      toolInput: finalInput,
      toolOutput: content,
      isError,
    });
    scriptPost = await runScriptHook(
      services.scriptHookManager,
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
      tool.pluginGeneration !== undefined,
    );
    if (isError) {
      await services.auditWriter.fireLifecycleEvent(
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
    services.auditLogger.log({
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
        ...currentAuditMetadata(),
        permissionDecision: "dlp_masked",
          permissionReason: `Detected patterns: ${dlpResult.detections.join(", ")}`,
      }],
    });
  }

  // ── Step 8: Audit + Result (항상 실행) ──────────
  const durationMs = Date.now() - startTime;
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
  await auditCurrentToolCall(sessionId, toolUse.name, source, trust, finalInput, auditContent, isError, startTime, permissionResult, rateResult.remaining, invocationPermissionContext, invocationCategory, executionCwd, targetFilePath, terminationReason, successHookChain);
  if (rationaleResumeContext?.started) {
    rationaleResumeContext.terminalizationAttempted = true;
    const terminalCommitted = await finishRationaleResume(
      rationaleResumeContext.started,
      !isError && terminationReason === "ok",
    );
    rationaleResumeContext.terminalized = terminalCommitted;
    if (!terminalCommitted) {
      log.error("Rationale resume invocation terminal audit CAS failed");
      callbacks?.onToolEnd?.(toolUse.name, RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT, true, meta, undefined, durationMs);
      return withHostShellExecutionPlan({ tool_use_id: toolUse.id, content: RATIONALE_TERMINAL_AUDIT_UNKNOWN_RESULT, is_error: true, durationMs });
    }
  }
  if (pendingReadReceipt) {
    services.pluginOperationGrants.recordRead({
      ...pendingReadReceipt.principal,
      readTool: pendingReadReceipt.readTool,
      readOperation: pendingReadReceipt.readOperation,
    }, pendingReadReceipt.domainKey);
  }
  callbacks?.onToolEnd?.(
    toolUse.name,
    displayContent,
    isError,
    meta,
    uiPayload,
    durationMs,
  );

  return withHostShellExecutionPlan({
    tool_use_id: toolUse.id,
    content,
    ...(isError && { is_error: true }),
    ...(uiPayload && { uiPayload }),
    ...(rawResult !== undefined && { rawResult }),
    ...(image && { image }),
    durationMs,
  });
  } catch (error) {
    if (operationExecutionDomain && resolvedPluginOperation) {
      try {
        services.pluginOperationGrants.poisonDomain(operationExecutionDomain);
      } catch (poisonError) {
        log.error(
          "failed to poison governed operation domain after final boundary failure for %s: %s",
          toolUse.name,
          poisonError instanceof Error ? poisonError.message : String(poisonError),
        );
      }
    }
    throw error;
  } finally {
    releaseOperationLeaseAfterFinalBoundary();
  }
}

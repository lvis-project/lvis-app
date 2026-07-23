import { randomUUID } from "node:crypto";
import type { Tool } from "./base.js";
import type { ToolRegistry } from "./registry.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { PermissionCheckResult } from "../permissions/permission-manager.js";
import type { ApprovalGate } from "../permissions/approval-gate.js";
import type { HostShellExecutionPlan } from "../permissions/host-shell-execution-plan.js";
import { HookRunner } from "../hooks/hook-runner.js";
import type { ScriptHookManager } from "../hooks/script-hook-manager.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { PermissionDirectoryLifecycle } from "../permissions/permission-slash.js";
import { RateLimiter } from "./pipeline/rate-limiter.js";
import { tryUserApprovalMemorySkip as tryUserApprovalMemorySkipImpl } from "./pipeline/approval-memory-skip.js";
import { AuditWriter } from "./pipeline/audit-writer.js";
import type { RationaleHostRuntime } from "./pipeline/rationale-orchestrator.js";
import type { RationaleExecutorControlOutcome } from "./pipeline/rationale-pr1-contract.js";
import type { SealedRationaleResumeRequest } from "./pipeline/rationale-resume-contract.js";
import {
  extractSealedRationaleExecutionTarget,
  finishRationaleResume,
  type AuthorizedRationaleResume,
  type PreparedRationaleResume,
  type RationaleResumeHostRuntime,
  type StartedRationaleResume,
} from "./pipeline/rationale-resume-runner.js";
import type {
  ConversationBatchExecuteOptions,
  ConversationBatchExecutionOutcome,
  ConversationExecuteOptions,
  ExecuteOptions,
  RationaleResumeExecuteOptions,
  ToolResult,
  ToolPermissionContext,
  ToolUseBlock,
} from "./executor-contract.js";
import type { ToolCategory, ToolSource } from "./types.js";
import { runToolInvocation } from "./invocation-runner.js";
import { createLogger } from "../lib/logger.js";
import {
  resolvePluginOperation,
} from "./plugin-operation-governance.js";
import {
  PluginOperationGrantCoordinator,
  pluginOperationExecutionDomain,
  type PluginOperationPrincipal,
} from "../permissions/plugin-operation-grant.js";
import type { PluginRuntimeGenerationAccess } from "../plugins/plugin-host-generation.js";

const log = createLogger("executor");
/**
 * One-time guard for the shadow-sink construction warning. Process-wide so the
 * permission-shadow reconciliation dataset's deliverability is flagged at most
 * once even when many ToolExecutors are constructed (boot wires one production
 * executor; tests construct many). See {@link ToolExecutor.warnIfShadowSinkUnwired}.
 */
let shadowSinkWarningEmitted = false;

interface RationaleBatchExecutionContext {
  runtime: RationaleHostRuntime;
  batchId: string;
  originalToolUseIds: readonly string[];
  completedToolUseIds: readonly string[];
}

interface RationaleRequiredExecuteOneOutcome {
  outcome: "rationale-required";
  control: RationaleExecutorControlOutcome;
}

interface RationaleResumeExecutionContext {
  request: SealedRationaleResumeRequest;
  runtime?: RationaleResumeHostRuntime;
  prepared?: PreparedRationaleResume;
  authorized?: AuthorizedRationaleResume;
  started?: StartedRationaleResume;
  terminalizationAttempted?: boolean;
  terminalized?: boolean;
}

function isRationaleRequiredExecuteOneOutcome(
  value: ToolResult | RationaleRequiredExecuteOneOutcome,
): value is RationaleRequiredExecuteOneOutcome {
  return "outcome" in value && value.outcome === "rationale-required";
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
  private readonly hostClassifiesRiskProvider: () => boolean;
  private readonly sandboxFsContainedProvider: (tool: Tool) => boolean;
  private readonly workspaceRootLifecycleProvider: () => PermissionDirectoryLifecycle | undefined;
  private readonly auditWriter: AuditWriter;
  private readonly pluginOperationGrants: PluginOperationGrantCoordinator;
  private readonly pluginGenerationAccessProvider: () => PluginRuntimeGenerationAccess | undefined;

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
    workspaceRootLifecycleProvider?: () => PermissionDirectoryLifecycle | undefined,
    pluginOperationGrants?: PluginOperationGrantCoordinator,
    pluginGenerationAccessProvider?: () => PluginRuntimeGenerationAccess | undefined,
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
    this.workspaceRootLifecycleProvider = workspaceRootLifecycleProvider ?? (() => undefined);
    this.pluginOperationGrants = pluginOperationGrants ?? new PluginOperationGrantCoordinator();
    this.pluginGenerationAccessProvider = pluginGenerationAccessProvider ?? (() => undefined);
    this.requirePermissionAuditChain = auditLogger?.isPermissionAuditChainReady() === true;
    this.auditWriter = new AuditWriter(
      this.auditLogger,
      this.toolRegistry,
      this.scriptHookManager,
      this.requirePermissionAuditChain,
    );
    this.warnIfShadowSinkUnwired(auditLogger === undefined);
  }

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

  getHookRunner(): HookRunner {
    return this.hookRunner;
  }

  issuePluginOperationGrant(args: {
    toolName: string;
    input: Record<string, unknown>;
    principal: PluginOperationPrincipal;
    origin?: "ui" | "mcp-app";
    ttlMs?: number;
  }): { token: string; grantId: string; readRevision: string | null } {
    const inspected = this.inspectPluginOperationGrant(args);
    return this.issueInspectedPluginOperationGrant({
      toolName: args.toolName,
      principal: args.principal,
      inspected,
      ttlMs: args.ttlMs,
    });
  }

  issueInspectedPluginOperationGrant(args: {
    toolName: string;
    principal: PluginOperationPrincipal;
    inspected: {
      operation: string;
      intentHash: string;
      readRevision: string | null;
      operationDomain: string;
      requiredRead?: {
        readTool: string;
        readOperations: readonly string[];
        maxAgeMs: number;
      };
    };
    ttlMs?: number;
  }): { token: string; grantId: string; readRevision: string | null } {
    const issued = this.pluginOperationGrants.issue(
      {
        ...args.principal,
        toolName: args.toolName,
        operation: args.inspected.operation,
        intentHash: args.inspected.intentHash,
        readRevision: args.inspected.readRevision,
        expiresAt:
          Date.now() +
          Math.min(Math.max(args.ttlMs ?? 60_000, 1), 300_000),
      },
      args.inspected.operationDomain,
      args.inspected.requiredRead,
    );
    return { ...issued, readRevision: args.inspected.readRevision };
  }

  inspectPluginOperationGrant(args: {
    toolName: string;
    input: Record<string, unknown>;
    principal: PluginOperationPrincipal;
    origin?: "ui" | "mcp-app";
  }): {
    operation: string;
    intentHash: string;
    readRevision: string | null;
    operationDomain: string;
    requiredRead?: {
      readTool: string;
      readOperations: readonly string[];
      maxAgeMs: number;
    };
    approvalArgs: Record<string, unknown>;
  } {
    const tool = this.toolRegistry.findByName(args.toolName);
    if (!tool?.pluginId || !tool.operationPolicy) {
      throw new Error(`[plugin-operation-policy] governed plugin tool '${args.toolName}' not found`);
    }
    if (tool.pluginId !== args.principal.ownerPluginId) {
      throw new Error("[plugin-operation-policy] owner mismatch");
    }
    const generationAccess = this.pluginGenerationAccessProvider();
    if (!generationAccess) {
      throw new Error("[plugin-operation-policy] plugin generation access is not wired");
    }
    if (
      !tool.pluginGeneration ||
      tool.pluginGeneration.pluginId !== args.principal.ownerPluginId ||
      tool.pluginGeneration.generationId !== args.principal.generationId
    ) {
      throw new Error("[plugin-operation-policy] tool generation mismatch");
    }
    const activeGeneration = generationAccess.getActive(args.principal.ownerPluginId);
    if (!activeGeneration || activeGeneration.generationId !== args.principal.generationId) {
      throw new Error("[plugin-operation-policy] principal generation is not active");
    }
    const resolved = resolvePluginOperation(tool.operationPolicy, args.input, args.origin ?? "ui");
    if (resolved.rule.kind !== "write") {
      throw new Error("[plugin-operation-policy] only writes receive app grants");
    }
    const operationDomain = pluginOperationExecutionDomain(
      args.principal,
      args.toolName,
      resolved.operation,
      this.toolRegistry.listAll(),
    );
    let readRevision: string | null = null;
    let requiredRead:
      | {
          readTool: string;
          readOperations: readonly string[];
          maxAgeMs: number;
        }
      | undefined;
    if (resolved.rule.requiresRead) {
      const latest = this.pluginOperationGrants.latestRequiredRead(
        args.principal,
        resolved.rule.requiresRead.tool,
        resolved.rule.requiresRead.operations,
        resolved.rule.requiresRead.maxAgeMs,
        operationDomain,
      );
      if (!latest) {
        throw new Error("[plugin-operation-policy] required read is missing or stale");
      }
      readRevision = latest;
      requiredRead = {
        readTool: resolved.rule.requiresRead.tool,
        readOperations: resolved.rule.requiresRead.operations,
        maxAgeMs: resolved.rule.requiresRead.maxAgeMs,
      };
    }
    const approvalArgs = structuredClone(args.input);
    return {
      operation: resolved.operation,
      intentHash: resolved.intentHash,
      readRevision,
      operationDomain,
      ...(requiredRead ? { requiredRead } : {}),
      approvalArgs,
    };
  }

  revokePluginOperationGeneration(pluginId: string, generationId: string): void {
    this.pluginOperationGrants.revokeGeneration(pluginId, generationId);
  }

  revokePluginOperationSession(appSessionId: string): void {
    this.pluginOperationGrants.revokeSession(appSessionId);
  }

  revokePluginOperationAccount(
    pluginId: string,
    generationId: string,
    accountHash: string,
  ): void {
    this.pluginOperationGrants.revokeAccount(pluginId, generationId, accountHash);
  }

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
    hostShellExecutionPlan?: HostShellExecutionPlan,
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
      hostShellExecutionPlan,
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

  async executeConversationTools(
    toolUses: ToolUseBlock[],
    opts: ConversationExecuteOptions,
  ): Promise<ToolResult[]> {
    return this.executeAll(toolUses, opts);
  }

  async executeConversationBatch(
    toolUses: ToolUseBlock[],
    opts: ConversationBatchExecuteOptions,
  ): Promise<ConversationBatchExecutionOutcome> {
    const runtime = opts.rationaleRuntime;
    if (!runtime?.requestAnchor && !opts.interceptedMetaToolHandler) {
      return {
        outcome: "completed",
        results: await this.executeAll(toolUses, opts),
      };
    }

    const batchId = randomUUID();
    const originalToolUseIds = toolUses.map((toolUse) => toolUse.id);
    const completedResults: ToolResult[] = [];
    for (let displayOrder = 0; displayOrder < toolUses.length; displayOrder += 1) {
      const toolUse = toolUses[displayOrder];
      const registeredTool = this.toolRegistry.findByName(toolUse.name);
      const interceptedMetaToolHandler = opts.interceptedMetaToolHandler;
      const shouldInterceptMetaTool =
        interceptedMetaToolHandler !== undefined &&
        registeredTool?.source === "builtin" &&
        (toolUse.name === "request_plugin" ||
          toolUse.name === "tool_search");
      let result: ToolResult | RationaleRequiredExecuteOneOutcome;
      if (shouldInterceptMetaTool && interceptedMetaToolHandler) {
        try {
          const intercepted = await interceptedMetaToolHandler(toolUse);
          result = intercepted?.tool_use_id === toolUse.id
            ? intercepted
            : {
                tool_use_id: toolUse.id,
                content: "Intercepted meta-tool handling failed closed",
                is_error: true,
                durationMs: 0,
              };
        } catch {
          result = {
            tool_use_id: toolUse.id,
            content: "Intercepted meta-tool handling failed closed",
            is_error: true,
            durationMs: 0,
          };
        }
      } else if (runtime?.requestAnchor) {
        result = await this.executeOne(
          toolUse,
          batchId,
          displayOrder,
          opts,
          {
            runtime,
            batchId,
            originalToolUseIds,
            completedToolUseIds: completedResults.map((item) => item.tool_use_id),
          },
        );
      } else {
        result = await this.executeOne(toolUse, batchId, displayOrder, opts);
      }
      if (isRationaleRequiredExecuteOneOutcome(result)) {
        return {
          outcome: "rationale-required",
          completedResults,
          control: result.control,
        };
      }
      completedResults.push(result);
    }

    return { outcome: "completed", results: completedResults };
  }

  async executeSealedRationaleResume(
    request: SealedRationaleResumeRequest,
    opts: RationaleResumeExecuteOptions,
  ): Promise<ToolResult> {
    const target = extractSealedRationaleExecutionTarget(request);
    if (!target) {
      return {
        tool_use_id: "rationale-resume",
        content: "Rationale resume blocked: invalid or expired sealed resume request",
        is_error: true,
        durationMs: 0,
      };
    }
    const toolUse: ToolUseBlock = {
      id: target.control.sealedAction.toolUseId,
      name: target.control.sealedAction.toolName,
      input: target.control.sealedAction.originalInput,
    };
    const rationaleResumeContext: RationaleResumeExecutionContext = {
      request: target.request,
      runtime: opts.rationaleResumeRuntime,
    };
    try {
      return await this.executeOne(
        toolUse,
        randomUUID(),
        0,
        opts,
        undefined,
        rationaleResumeContext,
      );
    } finally {
      // Once the host start CAS has committed, every exit path must close the
      // invocation. The ordinary success/error paths finalize below; this
      // guard covers callback, hook, and audit exceptions after start.
      if (rationaleResumeContext.started && !rationaleResumeContext.terminalizationAttempted) {
        rationaleResumeContext.terminalizationAttempted = true;
        rationaleResumeContext.terminalized = await finishRationaleResume(
          rationaleResumeContext.started,
          false,
        );
      }
    }
  }

  private isParallelSafeToolUse(toolUse: ToolUseBlock): boolean {
    const tool = this.toolRegistry.findByName(toolUse.name);
    return tool?.parallelSafe === true;
  }


  private async executeOne(
    toolUse: ToolUseBlock,
    groupId: string,
    displayOrder: number,
    opts?: ExecuteOptions,
  ): Promise<ToolResult>;
  private async executeOne(
    toolUse: ToolUseBlock,
    groupId: string,
    displayOrder: number,
    opts: ExecuteOptions,
    rationaleBatchContext: RationaleBatchExecutionContext,
  ): Promise<ToolResult | RationaleRequiredExecuteOneOutcome>;
  private async executeOne(
    toolUse: ToolUseBlock,
    groupId: string,
    displayOrder: number,
    opts: ExecuteOptions,
    rationaleBatchContext: undefined,
    rationaleResumeContext: RationaleResumeExecutionContext,
  ): Promise<ToolResult>;
  private async executeOne(
    toolUse: ToolUseBlock,
    groupId: string,
    displayOrder: number,
    opts: ExecuteOptions = {},
    rationaleBatchContext?: RationaleBatchExecutionContext,
    rationaleResumeContext?: RationaleResumeExecutionContext,
  ): Promise<ToolResult | RationaleRequiredExecuteOneOutcome> {
    return runToolInvocation(
      {
        toolRegistry: this.toolRegistry,
        hookRunner: this.hookRunner,
        permissionManager: this.permissionManager,
        approvalGate: this.approvalGate,
        auditLogger: this.auditLogger,
        requirePermissionAuditChain: this.requirePermissionAuditChain,
        rateLimiter: this.rateLimiter,
        bashAstValidator: this.bashAstValidator,
        scriptHookManager: this.scriptHookManager,
        hostClassifiesRiskProvider: this.hostClassifiesRiskProvider,
        sandboxFsContainedProvider: this.sandboxFsContainedProvider,
        workspaceRootLifecycleProvider: this.workspaceRootLifecycleProvider,
        auditWriter: this.auditWriter,
        tryUserApprovalMemorySkip: this.tryUserApprovalMemorySkip.bind(this),
        pluginOperationGrants: this.pluginOperationGrants,
        pluginGenerationAccessProvider: this.pluginGenerationAccessProvider,
      },
      toolUse,
      groupId,
      displayOrder,
      opts,
      rationaleBatchContext,
      rationaleResumeContext,
    );
  }


}

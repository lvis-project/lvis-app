import type { Tool } from "./base.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolCategory, ToolSource } from "./types.js";
import type { ApprovalGate, ApprovalMode } from "../permissions/approval-gate.js";
import type { PermissionDirectoryLifecycle } from "../permissions/permission-slash.js";
import type { PermissionManager } from "../permissions/permission-manager.js";
import type { HookDispatchResult, ScriptHookManager } from "../hooks/script-hook-manager.js";
import type { HookTrustOrigin } from "../hooks/script-hook-types.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { BashAstValidator } from "../main/bash-ast-validator.js";
import type { ToolPermissionContext } from "./executor-contract.js";
import type { HookRunner } from "../hooks/hook-runner.js";
import type { AuditWriter } from "./pipeline/audit-writer.js";
import type { RateLimiter } from "./pipeline/rate-limiter.js";
import { resolveEnforcedCategory as resolveEnforcedCategoryImpl } from "./pipeline/risk-classification.js";
import { tryUserApprovalMemorySkip as tryUserApprovalMemorySkipImpl } from "./pipeline/approval-memory-skip.js";
import {
  PluginOperationGrantCoordinator,
} from "../permissions/plugin-operation-grant.js";
import type { PluginRuntimeGenerationAccess } from "../plugins/plugin-host-generation.js";
import type { GovernedRiskFloor } from "./plugin-operation-governance.js";

export interface InvocationRunnerServices {
  readonly toolRegistry: ToolRegistry;
  readonly hookRunner: HookRunner;
  readonly permissionManager?: PermissionManager;
  readonly approvalGate?: ApprovalGate;
  readonly auditLogger: AuditLogger;
  readonly requirePermissionAuditChain: boolean;
  readonly rateLimiter: RateLimiter;
  readonly bashAstValidator?: BashAstValidator;
  readonly scriptHookManager?: ScriptHookManager;
  readonly hostClassifiesRiskProvider: () => boolean;
  readonly sandboxFsContainedProvider: (tool: Tool) => boolean;
  readonly workspaceRootLifecycleProvider: () => PermissionDirectoryLifecycle | undefined;
  readonly auditWriter: AuditWriter;
  readonly tryUserApprovalMemorySkip: typeof tryUserApprovalMemorySkipImpl;
  readonly pluginOperationGrants: PluginOperationGrantCoordinator;
  readonly pluginGenerationAccessProvider: () => PluginRuntimeGenerationAccess | undefined;
}

export function currentApprovalMode(
  permissionManager: PermissionManager | undefined,
): ApprovalMode {
  const mode = permissionManager?.getMode?.();
  if (mode === "strict") return "ask_all";
  if (mode === "auto" || mode === "allow") return "full_auto";
  return "default";
}

export function resolveEnforcedCategory(
  services: InvocationRunnerServices,
  tool: Tool,
  declaredCategory: ToolCategory,
  finalInput: Record<string, unknown>,
  allowedDirectories: readonly string[],
  correlationId: string,
  operationFloor?: GovernedRiskFloor,
): ToolCategory {
  return resolveEnforcedCategoryImpl({
    tool,
    declaredCategory,
    finalInput,
    allowedDirectories,
    correlationId,
    hostClassifiesRisk: services.hostClassifiesRiskProvider(),
    auditLogger: services.auditLogger,
    operationFloor,
  });
}

export async function runScriptHook(
  scriptHookManager: ScriptHookManager | undefined,
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
  generationOwned = false,
): Promise<HookDispatchResult> {
  if (!scriptHookManager) {
    if (generationOwned) {
      throw new Error(
        `[plugin-hooks] script Hook manager is not wired for generation-owned tool '${toolName}'`,
      );
    }
    return { decision: "allow", reason: "script hooks not wired", results: [] };
  }
  const payload = {
    toolName,
    source,
    category,
    input,
    sessionId: sessionId ?? "unknown",
    trustOrigin: context.trustOrigin as HookTrustOrigin,
    ...(mcpServerId !== undefined ? { mcpServerId } : {}),
    ...(pluginId !== undefined ? { pluginId } : {}),
    ...(toolOutput !== undefined ? { toolOutput } : {}),
    ...(isError !== undefined ? { isError } : {}),
  };
  if (hookType === "pre") return scriptHookManager.runPreToolUse(payload);
  if (hookType === "post") return scriptHookManager.runPostToolUse(payload);
  return scriptHookManager.runPermissionRequest(payload);
}

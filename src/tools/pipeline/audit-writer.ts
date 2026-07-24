/**
 * Tool pipeline — audit write chokepoint + non-blocking lifecycle fire.
 *
 * Extracted from `executor.ts` (C7 decomposition). {@link AuditWriter} owns the
 * three permission-audit append paths (grant / ask / tool-call) plus the
 * observe-only lifecycle-event dispatch. It composes the pure entry builders
 * from `audit-entries.ts` with the shared AuditLogger + ToolRegistry +
 * ScriptHookManager handed in by the executor.
 *
 * INVARIANT: `auditToolCall` is the single chokepoint every tool-deny path
 * funnels through, so the `PermissionDenied` lifecycle event fires here EXACTLY
 * ONCE where a deny is finalized — the firing conditions below are load-bearing
 * and must stay exact.
 */
import { randomUUID } from "node:crypto";
import type { ToolRegistry } from "../registry.js";
import type { ToolSource, ToolCategory, TrustLevel } from "../types.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { PermissionAuditEntryInput, HookResult, ToolExecutionAuditMetadata } from "../../audit/audit-schema.js";
import { maskSensitiveData } from "../../audit/dlp-filter.js";
import type {
  ScriptHookManager,
  HookDispatchResult,
  LifecycleEventPayload,
} from "../../hooks/script-hook-manager.js";
import type { HookTrustOrigin } from "../../hooks/script-hook-types.js";
import { createLogger } from "../../lib/logger.js";
import type { ToolPermissionContext } from "../executor.js";
import {
  auditTrustOrigin,
  permissionAuditAskEntryFromToolCall,
  permissionAuditEntryFromToolCall,
} from "./audit-entries.js";

const log = createLogger("executor");

export class AuditWriter {
  constructor(
    private readonly auditLogger: AuditLogger,
    private readonly toolRegistry: ToolRegistry,
    private readonly scriptHookManager: ScriptHookManager | undefined,
    private readonly requirePermissionAuditChain: boolean,
  ) {}

  /**
   * Fire a NON-BLOCKING lifecycle event (#811 milestone-2). OBSERVE-ONLY: the
   * returned decision is recorded in audit but NEVER affects control flow — the
   * executor ignores it. Fail-soft: the manager's `runLifecycleEvent` never
   * throws, but we additionally swallow any unexpected error so a lifecycle hook
   * can never break a tool call. No-op when the manager is unwired (back-compat:
   * no hooks.json ⇒ no lifecycle dispatch, behavior identical).
   */
  async fireLifecycleEvent(
    event: "PostToolUseFailure" | "PermissionDenied",
    sessionId: string | undefined,
    context: ToolPermissionContext,
    payload: LifecycleEventPayload,
  ): Promise<HookDispatchResult | undefined> {
    if (!this.scriptHookManager) return undefined;
    try {
      return await this.scriptHookManager.runLifecycleEvent(
        event,
        sessionId ?? "unknown",
        context.trustOrigin as HookTrustOrigin,
        payload,
      );
    } catch {
      // Defensive: observe-only events must never break a tool call.
      return undefined;
    }
  }

  /**
   * Emit an `AuditAllow` row when the user resolves an out-of-allowed-dir
   * approval (allow-once / allow-session / allow-always) — or when
   * `propagateGrantScope` had to degrade a session-intent grant to turn
   * scope because the session callback was unwired. Decoupled from
   * `auditToolCall` so the per-tool audit row can stay focused on
   * execution outcome while the directory-grant decision lives in a
   * dedicated forensic row tied to the dialog click.
   */
  async auditPermissionGrant(args: {
    toolName: string;
    source: ToolSource;
    category: ToolCategory;
    directory: string;
    grantLifetime: "turn" | "session" | "always" | "degraded-to-turn";
    permissionContext?: ToolPermissionContext;
    audit?: ToolExecutionAuditMetadata;
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
      ...(args.audit?.toolUseId !== undefined ? { toolUseId: args.audit.toolUseId } : {}),
      ...(args.audit?.executionPlan !== undefined ? { executionPlan: args.audit.executionPlan } : {}),
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

  async auditPermissionAsk(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    input: Record<string, unknown>,
    permission: PermissionCheckResult,
    cwd: string,
    permissionContext?: ToolPermissionContext,
    auditDirectory?: string,
    audit?: ToolExecutionAuditMetadata,
  ): Promise<void> {
    const governedTool = this.toolRegistry.findByName(toolName)?.operationPolicy;
    const governedOperation = governedTool && typeof input.operation === "string"
      ? input.operation
      : undefined;
    // Operation-governed tools may carry attendance, identity, or reservation
    // payloads. Their audit contract is metadata-only: operation + outcome.
    // The bearer/account hash are held in ToolPermissionContext and are never
    // serialized here.
    const auditSafeInput = governedTool
      ? { operation: governedOperation ?? "<invalid>" }
      : input;
    const tool = this.toolRegistry.findByName(toolName);
    const entry = permissionAuditAskEntryFromToolCall({
      toolName,
      tool,
      source,
      category,
      input: auditSafeInput,
      permission,
      trustOrigin: auditTrustOrigin(permissionContext),
      cwd,
      auditDirectory,
      audit,
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

  async auditToolCall(
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
    terminationReason?: "ok" | "ceiling" | "user-abort" | "error" | "indeterminate",
    hookChain?: HookResult[],
    audit?: ToolExecutionAuditMetadata,
  ): Promise<void> {
    const governedTool = this.toolRegistry.findByName(toolName)?.operationPolicy;
    const governedOperation = governedTool && typeof input.operation === "string"
      ? input.operation
      : undefined;
    const auditSafeInput = governedTool
      ? { operation: governedOperation ?? "<invalid>" }
      : input;
    const auditSafeOutput = governedTool
      ? (isError ? "governed operation failed" : "governed operation completed")
      : output;
    // ── #811 m2: PermissionDenied (NON-BLOCKING) ──
    // `auditToolCall` is the single chokepoint every tool-deny path funnels
    // through, so firing here observes the deny EXACTLY ONCE where it is
    // finalized. OBSERVE-ONLY: the lifecycle hook's verdict is recorded but the
    // deny stands regardless (control flow already returned the deny result).
    // A user-abort is a CANCEL, not a permission denial — exclude it so a policy
    // hook never sees false "denied" signals. `denyReason.reason` carries the
    // finalized reason so a hook can discriminate the remaining cases (e.g.
    // tool-not-found) itself — restoring forensic granularity beyond the layer.
    if (
      permission?.decision === "deny" &&
      permissionContext !== undefined &&
      terminationReason !== "user-abort"
    ) {
      await this.fireLifecycleEvent(
        "PermissionDenied",
        sessionId,
        permissionContext,
        {
          toolName,
          denyReason: { layer: permission.layer, source: "tool-executor", reason: permission.reason },
        },
      );
    }
    try {
      const inputText = JSON.stringify(auditSafeInput);
      const auditInput = maskSensitiveData(inputText).masked;
      this.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: sessionId ?? "unknown",
        type: "tool_call",
        input: auditInput.slice(0, 500),
        output: auditSafeOutput.slice(0, 1024),
        toolCalls: [{
          name: toolName,
          isError,
          source,
          trust,
          executionTimeMs: Date.now() - startTime,
          ...(audit?.toolUseId !== undefined ? { toolUseId: audit.toolUseId } : {}),
          ...(audit?.executionPlan !== undefined ? { executionPlan: audit.executionPlan } : {}),
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
      input: auditSafeInput,
      permission,
      rateLimitRemaining,
      trustOrigin: auditTrustOrigin(permissionContext),
      cwd,
      auditDirectory,
      ...(hookChain ? { hookChain } : {}),
      audit,
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

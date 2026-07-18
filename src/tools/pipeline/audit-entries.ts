/**
 * Tool pipeline — permission-audit entry builders + audit-output redaction.
 *
 * Pure helpers factored out of `executor.ts` (C7 decomposition). These build
 * the {@link PermissionAuditEntryInput} rows and the hook-chain forensic
 * surface; they touch no executor state. The {@link AuditWriter} (audit-writer.ts)
 * composes them with the shared AuditLogger to actually persist rows.
 */
import { randomUUID } from "node:crypto";
import type { Tool } from "../base.js";
import type { ToolSource, ToolCategory } from "../types.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { PermissionAuditEntryInput, HookResult, ToolExecutionAuditMetadata } from "../../audit/audit-schema.js";
import type { HookTrustOrigin, ScriptHookInvocationResult } from "../../hooks/script-hook-types.js";
import type { HookDispatchResult } from "../../hooks/script-hook-manager.js";
import type { ToolPermissionContext } from "../executor.js";
import { resolveToolPathForPermission } from "./path-extraction.js";

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
export function redactAskUserAuditOutput(rawOutput: string): string {
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

export function auditTrustOrigin(context?: ToolPermissionContext): HookTrustOrigin {
  return context?.trustOrigin ?? "unknown";
}

function auditDirectoryForInput(
  tool: Tool | undefined,
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
  tool?: Tool;
  source: ToolSource;
  category: ToolCategory;
  trustOrigin: HookTrustOrigin;
  audit?: ToolExecutionAuditMetadata;
}): Pick<
  Extract<PermissionAuditEntryInput, { decision: "allow" }>,
  "ts" | "auditId" | "toolUseId" | "executionPlan" | "trustOrigin" | "tool" | "source" | "category"
> {
  return {
    ts: new Date().toISOString(),
    auditId: randomUUID(),
    ...(args.audit?.toolUseId !== undefined ? { toolUseId: args.audit.toolUseId } : {}),
    ...(args.audit?.executionPlan !== undefined ? { executionPlan: args.audit.executionPlan } : {}),
    trustOrigin: args.trustOrigin,
    tool: args.toolName,
    source: args.source,
    category: args.category,
  };
}

/**
 * Derive the `failureReason` discriminant from a fail-closed
 * {@link ScriptHookInvocationResult}. Only a denying result that failed for an
 * operational reason (timeout / nonzero exit / spawn-error / bad output) carries
 * one; a clean `{action:"deny"}` verdict from a hook that ran fine returns
 * `undefined` (it denied on policy, not on failure).
 */
function hookFailureReason(
  r: ScriptHookInvocationResult,
): HookResult["failureReason"] | undefined {
  if (r.timedOut) return "timeout";
  if (r.decision !== "deny") return undefined;
  if (r.reason.startsWith("hook spawn error:")) return "spawn-error";
  if (r.reason.startsWith("failed to serialise hook payload:")) return "spawn-error";
  if (r.reason.startsWith("shell unavailable:")) return "spawn-error";
  if (r.reason.startsWith("hook exited non-zero:")) return "nonzero-exit";
  if (r.reason === "hook stdout not valid {action,reason} JSON") return "bad-output";
  return undefined;
}

/**
 * Map a runtime {@link HookDispatchResult} (pre / post / perm) into the audit
 * {@link HookResult}[] surface (#811 cluster-review follow-up). Each per-script
 * invocation result becomes one forensic row carrying its `decision`/`reason`,
 * the `source` discriminant (`.sh` vs config), the `commandIdentity` anchor, and
 * a `failureReason` when the hook failed closed. Returns `undefined` when the
 * dispatch ran no matching hooks so non-hook audit rows stay clean (`hookChain`
 * remains absent).
 */
export function hookChainFromDispatch(
  event: "pre" | "post" | "perm",
  dispatch: HookDispatchResult | undefined,
): HookResult[] | undefined {
  if (!dispatch || dispatch.results.length === 0) return undefined;
  return dispatch.results.map((r): HookResult => {
    const failureReason = hookFailureReason(r);
    return {
      hookName: r.hookPath,
      // `hookChainFromDispatch` only handles the tool-use events, so the narrow
      // pre|post|perm projection comes straight from the `event` param. (The
      // runner's `r.hookType` widened to `HookEvent` for the lifecycle surface.)
      hookType: event,
      action: r.decision,
      reason: r.reason,
      durationMs: r.durationMs,
      // `event` today equals `hookType`; kept explicit so the closed-set surface
      // is populated for forward-compat readers.
      event,
      handlerType: "command",
      commandIdentity: r.commandIdentity,
      source: r.source,
      decision: r.decision,
      ...(failureReason !== undefined ? { failureReason } : {}),
    };
  });
}

/**
 * Concatenate two optional hook chains (e.g. the pre + post rows on the success
 * path) into one, dropping empty/absent inputs. Returns `undefined` when both
 * are empty so the audit row's `hookChain` stays absent for non-hook calls.
 */
export function mergeHookChains(
  ...chains: Array<HookResult[] | undefined>
): HookResult[] | undefined {
  const merged = chains.filter((c): c is HookResult[] => c !== undefined).flat();
  return merged.length > 0 ? merged : undefined;
}

export function permissionAuditEntryFromToolCall(args: {
  toolName: string;
  tool?: Tool;
  source: ToolSource;
  category: ToolCategory;
  input: Record<string, unknown>;
  permission: PermissionCheckResult | undefined;
  rateLimitRemaining: number;
  trustOrigin: HookTrustOrigin;
  cwd: string;
  auditDirectory?: string;
  hookChain?: HookResult[];
  audit?: ToolExecutionAuditMetadata;
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
      ...(args.hookChain ? { hookChain: args.hookChain } : {}),
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
  if (args.hookChain) {
    allowEntry.hookChain = args.hookChain;
  }
  return allowEntry;
}

export function permissionAuditAskEntryFromToolCall(args: {
  toolName: string;
  tool?: Tool;
  source: ToolSource;
  category: ToolCategory;
  input: Record<string, unknown>;
  permission: PermissionCheckResult;
  trustOrigin: HookTrustOrigin;
  cwd: string;
  auditDirectory?: string;
  audit?: ToolExecutionAuditMetadata;
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

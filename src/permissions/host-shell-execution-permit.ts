/**
 * One-shot execution permit for any requested-sandbox plain-shell fallback.
 *
 * The execution plan says which substrate is honest for a shell invocation;
 * it is not itself proof that the user approved that invocation. This module
 * keeps the proof in a module-private WeakMap, binds it to one final action,
 * and consumes it before the plain child may spawn.
 */
import { isAbsolute, resolve as pathResolve } from "node:path";
import { canonicalizePathForMatch, caseFoldForMatch } from "./sensitive-paths.js";
import { parseHostShellExecutionInput } from "./host-shell-execution-input.js";
import {
  requiresExplicitHostShellFallbackApproval,
  type HostShellExecutionPlan,
} from "./host-shell-execution-plan.js";
import {
  consumeHostApprovedOneShotExecutionBinding,
  type ApprovalDecision,
} from "./approval-gate.js";

export type HostShellToolName = "bash" | "powershell";

/**
 * Renderer-invisible action description attached to the approval pending entry.
 * The ApprovalGate issues a receipt only after an HMAC-verified allow-once
 * response for exactly this binding.
 */
export interface HostShellExecutionPermitBinding {
  readonly planIdentity: string;
  readonly plan: HostShellExecutionPlan;
  readonly toolName: HostShellToolName;
  readonly toolUseId: string;
  readonly command: string;
  readonly requestedCwd: string | undefined;
  readonly executionCwd: string;
  readonly resolvedCwd: string;
  readonly timeoutSeconds: number;
  readonly allowedDirectories: readonly string[];
}

declare const hostShellExecutionPermitBrand: unique symbol;

/** Opaque, in-process capability. A structural lookalike is not valid. */
export interface HostShellExecutionPermit {
  readonly [hostShellExecutionPermitBrand]: "host-shell-execution-permit";
}

interface PermitRecord extends HostShellExecutionPermitBinding {
  readonly plan: HostShellExecutionPlan;
}

const permits = new WeakMap<HostShellExecutionPermit, PermitRecord>();

// Preserve the permit module's public API while moving the runtime parser to a
// neutral dependency shared with ApprovalGate.
export { parseHostShellExecutionInput } from "./host-shell-execution-input.js";
export type { ParsedHostShellExecutionInput } from "./host-shell-execution-input.js";

/** Matches the exact cwd resolution used by BashTool and PowerShellTool. */
export function resolveHostShellWorkingDirectory(
  executionCwd: string,
  requestedCwd: string | undefined,
): string {
  const resolvedExecutionCwd = pathResolve(executionCwd);
  if (!requestedCwd) return resolvedExecutionCwd;
  return isAbsolute(requestedCwd)
    ? pathResolve(requestedCwd)
    : pathResolve(resolvedExecutionCwd, requestedCwd);
}

/** Stable set semantics for the same extra directory scope the tools validate. */
export function canonicalizeHostShellAllowedDirectories(
  directories: readonly string[],
): readonly string[] {
  const canonical = directories
    .filter((directory) => directory.length > 0)
    .map((directory) => caseFoldForMatch(canonicalizePathForMatch(directory)));
  return Object.freeze([...new Set(canonical)].sort());
}

/**
 * Build the host-only action binding after all path grants and hooks have
 * finalized the invocation. Undefined means the raw input cannot represent a
 * native shell spawn, so the explicit fallback must fail closed before it can request a permit.
 */
export function buildHostShellExecutionPermitBinding(input: {
  plan: HostShellExecutionPlan;
  toolName: HostShellToolName;
  toolUseId: string;
  rawInput: unknown;
  executionCwd: string;
  extraAllowedDirectories: readonly string[];
}): HostShellExecutionPermitBinding | undefined {
  const parsed = parseHostShellExecutionInput(input.rawInput);
  if (parsed === undefined) return undefined;
  const executionCwd = pathResolve(input.executionCwd);
  return Object.freeze({
    planIdentity: input.plan.identity,
    plan: input.plan,
    toolName: input.toolName,
    toolUseId: input.toolUseId,
    command: parsed.command,
    requestedCwd: parsed.cwd,
    executionCwd,
    resolvedCwd: resolveHostShellWorkingDirectory(executionCwd, parsed.cwd),
    timeoutSeconds: parsed.timeoutSeconds,
    allowedDirectories: canonicalizeHostShellAllowedDirectories(
      input.extraAllowedDirectories,
    ),
  });
}

/**
 * Minted only after ApprovalGate consumes its HMAC-verified allow-once receipt.
 * Calling this public helper with a structural decision or an unrelated approval
 * fails closed; the receipt is private to ApprovalGate and action-bound.
 */
export function mintHostShellExecutionPermit(input: {
  plan: HostShellExecutionPlan;
  approvalDecision: ApprovalDecision | undefined;
  binding: HostShellExecutionPermitBinding;
}): HostShellExecutionPermit | undefined {
  // The public TypeScript surface declares these fields as required, but
  // module consumers can still arrive through untyped JavaScript or a stale
  // compiled caller. Treat any incomplete input as an unauthorised request
  // instead of throwing before the fail-closed decision.
  if (
    input.approvalDecision === undefined ||
    input.binding === undefined
  ) {
    return undefined;
  }
  if (
    !consumeHostApprovedOneShotExecutionBinding(
      input.approvalDecision,
      input.binding,
    )
  ) return undefined;
  // Any receipt-bearing mint attempt consumes its receipt before checking
  // plan compatibility, so a mismatch cannot be probed or replayed.
  if (!requiresExplicitHostShellFallbackApproval(input.plan)) return undefined;
  if (
    input.binding.plan !== input.plan ||
    input.binding.planIdentity !== input.plan.identity
  ) return undefined;
  const permit = Object.freeze({}) as HostShellExecutionPermit;
  permits.set(permit, Object.freeze({ ...input.binding, plan: input.plan }));
  return permit;
}

/**
 * Verify and irreversibly consume the permit. Delete before comparison so a
 * mismatched/replayed attempt cannot probe or reuse an approved capability.
 */
export function consumeHostShellExecutionPermit(input: {
  permit: HostShellExecutionPermit | undefined;
  plan: HostShellExecutionPlan;
  toolName: HostShellToolName;
  toolUseId: string | undefined;
  command: string;
  requestedCwd: string | undefined;
  executionCwd: string;
  resolvedCwd: string;
  timeoutSeconds: number;
  allowedDirectories: readonly string[];
}): boolean {
  if (input.permit === undefined) return false;
  const record = permits.get(input.permit);
  if (record === undefined) return false;
  permits.delete(input.permit);
  return (
    record.plan === input.plan &&
    record.toolName === input.toolName &&
    record.toolUseId === input.toolUseId &&
    record.command === input.command &&
    record.requestedCwd === input.requestedCwd &&
    record.executionCwd === input.executionCwd &&
    record.resolvedCwd === input.resolvedCwd &&
    record.timeoutSeconds === input.timeoutSeconds &&
    record.allowedDirectories.length === input.allowedDirectories.length &&
    record.allowedDirectories.every(
      (directory, index) => directory === input.allowedDirectories[index],
    )
  );
}

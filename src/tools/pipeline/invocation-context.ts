/**
 * Tool pipeline — per-invocation mutable-state contract + initial-state factory
 * + the self-contained user-abort terminal helper.
 *
 * ── C8 decomposition (SECURITY-CRITICAL trust boundary) ───────────────────────
 * executeOne (executor.ts) owns ~20 per-invocation mutable locals. The highest-
 * risk of them participate in the TWO MUTUALLY-EXCLUSIVE sandbox
 * FILESYSTEM-CONTAINMENT relaxation blocks (one flips a plugin read auto-allow
 * to `ask` only when `!sandboxFsContainedProvider(tool)`; the other relaxes a
 * foreground plugin `ask` to `allow` only when `sandboxFsContainedProvider(tool)`).
 * Those blocks MUST stay inline and byte-identical — a denied WRITE must never
 * become an allowed one, and the read-relaxation must fire under exactly the same
 * conditions. This module therefore extracts ONLY the genuinely self-contained
 * pieces that do NOT participate in that relaxation mutation:
 *
 *   1. {@link InvocationContext} — documents the per-invocation state contract.
 *   2. {@link createInvocationContext} — builds the INITIAL per-invocation state
 *      (Layer-1 allowed scope, runtime allowed dirs, parent + own effect ledgers)
 *      exactly as the former top-of-executeOne initializers did.
 *   3. {@link returnUserAbort} — the terminal user-abort ToolResult builder. It
 *      runs only on the abort short-circuit (never on the relaxation path) and
 *      touches no permission decision — it always emits a fixed `deny`/error row.
 *
 * DELIBERATELY LEFT INLINE in executor.ts (moving them would touch the relaxation
 * blocks, reassign executeOne's `let` locals, or edit the approval-flow closure):
 *   - permissionResult / invocationCategory / invocationAllowedScope /
 *     invocationRuntimeAllowedDirectories reassignments (relaxation-block state);
 *   - the two sandbox relaxation blocks + the relaxed perm-hook preservation;
 *   - applyApprovedDirectory (reassigns the scope `let` locals in place);
 *   - requestOutOfAllowedDirectoryAccess / propagateGrantScope (approval flow);
 *   - makeEvaluationContext (already a thin adapter over buildPermissionEvaluation-
 *     Context, and two of its callsites live inside the left-inline approval
 *     closure — extracting it would force edits there for no behavioral gain).
 */
import {
  buildAllowedScope,
  buildRuntimeAllowedDirectories,
} from "../../permissions/allowed-directories.js";
import {
  createEffectLedger,
  currentEffectLedger,
  type EffectLedger,
} from "../../permissions/effect-ledger.js";
import type { PermissionCheckResult } from "../../permissions/permission-manager.js";
import type { ToolExecutionAuditMetadata } from "../../audit/audit-schema.js";
import { t } from "../../i18n/index.js";
import type { ToolSource, TrustLevel, ToolCategory } from "../types.js";
import type {
  ToolCallMeta,
  ToolExecutorCallbacks,
  ToolPermissionContext,
  ToolResult,
  ToolUseBlock,
} from "../executor.js";
import type { AuditWriter } from "./audit-writer.js";
import { emitToolStart } from "./display-mask.js";

/**
 * The per-invocation mutable-state contract threaded through executeOne's
 * 8-step pipeline. Documents the load-bearing values that mutate as a single
 * tool call flows through permission resolution, the sandbox-relaxation blocks,
 * and execution.
 *
 * NOTE: executeOne holds these as individual `let`/`const` LOCALS, not as one
 * object. Several fields (permissionResult, invocationCategory, allowedScope,
 * runtimeAllowedDirectories) are reassigned by the SECURITY-CRITICAL sandbox
 * filesystem-containment relaxation blocks and by applyApprovedDirectory; boxing
 * them into a shared object would force edits inside those byte-identical
 * trust-boundary blocks. This interface is the CONTRACT/record of that state;
 * {@link createInvocationContext} seeds the initial values ({@link
 * InitialInvocationState}).
 */
export interface InvocationContext {
  /**
   * Layer-3 permission verdict. Reassigned ~15x across executeOne as the call
   * flows through the category matrix, the sandbox relaxation blocks, the
   * reviewer / memory-skip lanes, and the ApprovalGate. LEFT as a `let` local in
   * executeOne — the relaxation blocks reassign it inline.
   */
  permissionResult: PermissionCheckResult | undefined;
  /** Tool source (builtin / plugin / mcp) — set once after the Step-1 lookup. */
  source: ToolSource;
  /** Trust level derived from the source — set once after the Step-1 lookup. */
  trust: TrustLevel;
  /**
   * Effective category. Starts as the declared category, may be swapped by
   * resolveEnforcedCategory (flag-gated) and re-read by the relaxation blocks.
   * LEFT as a `let` local in executeOne.
   */
  invocationCategory: ToolCategory;
  /** Layer-1 allowed scope; widened in place by applyApprovedDirectory. */
  allowedScope: { directories: string[] };
  /**
   * Runtime allowed dirs handed to tool.execute (Step 6); widened alongside
   * allowedScope by applyApprovedDirectory.
   */
  runtimeAllowedDirectories: string[];
  /** Per-invocation effect ledger (observability only); bound around Step 6. */
  effectLedger: EffectLedger;
  /** Ambient parent ledger, captured BEFORE opening this invocation's own. */
  parentEffectLedger: EffectLedger | undefined;
  /**
   * additionalDirectories snapshot at executeOne entry (fresh view when a getter
   * is wired). Reused by applyApprovedDirectory as the merge base.
   */
  baseAdditionalDirectories: readonly string[];
}

/**
 * The subset of {@link InvocationContext} that {@link createInvocationContext}
 * seeds up front. The remaining fields (source / trust / invocationCategory /
 * permissionResult) are set by executeOne's Step-1 lookup and Step-3 flow.
 */
export type InitialInvocationState = Pick<
  InvocationContext,
  | "baseAdditionalDirectories"
  | "allowedScope"
  | "runtimeAllowedDirectories"
  | "parentEffectLedger"
  | "effectLedger"
>;

/**
 * Build the INITIAL per-invocation state at the top of executeOne — byte-for-byte
 * the former inline initializers. No permission decision is made here.
 */
export function createInvocationContext(
  permissionContext: ToolPermissionContext,
  executionCwd: string,
): InitialInvocationState {
  // Within-round freshness: when the caller provided a getter we read the
  // *current* additional-directories view at the top of this executeOne (rather
  // than the snapshot taken when executeAll() was dispatched). This makes an
  // `allow-once`/`allow-session` grant applied by an earlier tool visible to
  // later tools in the same ordered run.
  const baseAdditionalDirectories: readonly string[] =
    permissionContext.getAdditionalDirectories?.()
    ?? permissionContext.additionalDirectories
    ?? [];
  const allowedScope = buildAllowedScope(baseAdditionalDirectories, executionCwd);
  const runtimeAllowedDirectories = buildRuntimeAllowedDirectories(
    baseAdditionalDirectories,
    executionCwd,
  );
  // Capture any AMBIENT (parent) ledger BEFORE opening this invocation's own
  // ledger. For a top-level tool this is undefined; for a re-entrant
  // `callTool(M)` it is the OUTER wrapper's ledger, so a MUTATING inner tool
  // can propagate a child-mutation marker back onto the wrapper (a
  // read-declared wrapper that mutates via delegation must not look like a read).
  const parentEffectLedger = currentEffectLedger();
  // Per-invocation effect ledger (observability only — no enforcement). A
  // fresh ledger per executeOne; bound to the async chain around Step 6 so the
  // in-process plugin hostApi closures record their host-mediated effects here.
  // Created BEFORE resolveEnforcedCategory so its correlationId threads into
  // BOTH the category shadow (pre-exec) and the effect shadow (post-exec).
  const effectLedger = createEffectLedger();
  return {
    baseAdditionalDirectories,
    allowedScope,
    runtimeAllowedDirectories,
    parentEffectLedger,
    effectLedger,
  };
}

/**
 * Dependency bundle for {@link returnUserAbort}. A named-field object (not a
 * positional list) so the wide capture surface of the original closure threads
 * without positional-arg mistakes. `auditWriter.auditToolCall` is called
 * directly — executeOne's private `auditToolCall` was a pure pass-through
 * delegator to it, so this is byte-identical.
 */
export interface UserAbortDeps {
  /** Args to attribute to the aborted call (`toolUse.input` or the post-hook `finalInput`). */
  input: Record<string, unknown>;
  toolUse: ToolUseBlock;
  meta: ToolCallMeta;
  callbacks: ToolExecutorCallbacks | undefined;
  source: ToolSource;
  trust: TrustLevel;
  invocationCategory: ToolCategory;
  sessionId: string | undefined;
  permissionContext: ToolPermissionContext | undefined;
  executionCwd: string;
  startTime: number;
  auditWriter: AuditWriter;
  audit?: ToolExecutionAuditMetadata;
}

/**
 * Terminal user-abort path: emit the standard cancellation ToolResult + audit
 * row. Extracted verbatim from executeOne's `returnUserAbort` closure — same
 * fixed `deny` / "user aborted turn" permission shape, same `"user-abort"`
 * termination reason, same emit/onToolEnd/audit ordering. Never participates in
 * the sandbox-relaxation decision.
 */
export async function returnUserAbort(deps: UserAbortDeps): Promise<ToolResult> {
  const {
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
    auditWriter,
    audit,
  } = deps;
  const msg = t("be_executor.toolExecutionCancelled");
  const durationMs = Date.now() - startTime;
  const abortedPermission: PermissionCheckResult = {
    decision: "deny",
    reason: "user aborted turn",
    layer: 0,
  };
  emitToolStart(callbacks, toolUse.name, input, meta);
  callbacks?.onToolEnd?.(toolUse.name, msg, true, meta, undefined, durationMs);
  await auditWriter.auditToolCall(
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
    undefined,
    audit,
  );
  return { tool_use_id: toolUse.id, content: msg, is_error: true, durationMs };
}

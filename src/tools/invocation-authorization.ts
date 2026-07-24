import { randomUUID } from "node:crypto";
import { resolve as pathResolve } from "node:path";
import type { Tool } from "./base.js";
import type { ToolCategory, ToolSource, TrustLevel } from "./types.js";
import { requiredTier, type PermissionCheckResult,
} from "../permissions/permission-manager.js";
import type { ApprovalDecision } from "../permissions/approval-gate.js";
import type { PermissionEvaluationContext } from "../permissions/evaluation-context.js";
import type {
  HostShellExecutionPlan,
  HostShellExecutionPlanAuditProjection,
} from "../permissions/host-shell-execution-plan.js";
import type { HostShellExecutionPermitBinding } from "../permissions/host-shell-execution-permit.js";
import { resolveReviewerSandboxCapability } from "../permissions/sandbox-capability.js";
import { lvisHome } from "../shared/lvis-home.js";
import type { ApprovalPurposeSuggestion } from "../shared/permission-review-status.js";
import { t } from "../i18n/index.js";
import { createLogger } from "../lib/logger.js";
import {
  hookChainFromDispatch } from "./pipeline/audit-entries.js";
import {
  emitToolStart } from "./pipeline/display-mask.js";
import { maybeMaterializeRationaleControl } from "./pipeline/rationale-orchestrator.js";
import {
  authorizeRationaleResume,
  prepareRationaleResume,
} from "./pipeline/rationale-resume-runner.js";
import {
  dispatchReviewerForHeadless as dispatchReviewerForHeadlessImpl,
  dispatchReviewerForInteractiveAuto as dispatchReviewerForInteractiveAutoImpl,
} from "./pipeline/reviewer-dispatch.js";
import { returnUserAbort, type UserAbortDeps,
} from "./pipeline/invocation-context.js";
import {
  currentApprovalMode,
  runScriptHook,
  type InvocationRunnerServices,
} from "./invocation-services.js";
import type { AuditWriter } from "./pipeline/audit-writer.js";
import type {
  ToolCallMeta,
  ToolExecutorCallbacks,
  ToolPermissionContext,
  ToolResult,
  ToolUseBlock,
} from "./executor-contract.js";
import type {
  RationaleBatchExecutionContext,
  RationaleRequiredExecuteOneOutcome,
  RationaleResumeExecutionContext,
} from "./invocation-runner.js";
import type { ResolvedPluginOperation } from "./plugin-operation-governance.js";
import type { PluginOperationPrincipal } from "../permissions/plugin-operation-grant.js";

const log = createLogger("executor");

type AuditToolCall = (...args: Parameters<AuditWriter["auditToolCall"]>) => Promise<void>;
type AuditPermissionAsk = (
  ...args: Parameters<AuditWriter["auditPermissionAsk"]>
) => Promise<void>;

export interface AuthorizationStageContext {
  services: InvocationRunnerServices;
  tool: Tool;
  toolUse: ToolUseBlock;
  source: ToolSource;
  trust: TrustLevel;
  invocationCategory: ToolCategory;
  approvalReasonPrefix: string | undefined;
  overlayTriggerOrigin: string | null | undefined;
  hostShellRequiresExplicitApproval: boolean;
  hostShellExecutionPlan: HostShellExecutionPlan | undefined;
  hostShellExecutionPlanAudit:
    | HostShellExecutionPlanAuditProjection | undefined;
  hostShellExecutionPermitBinding: HostShellExecutionPermitBinding | undefined;
  hostShellApprovalDecision: ApprovalDecision | undefined;
  finalInput: Record<string, unknown>;
  invocationAllowedScope: { directories: string[] };
  sensitivePathPattern: string | null;
  invocationPermissionContext: ToolPermissionContext;
  evaluationContext: PermissionEvaluationContext;
  callbacks: ToolExecutorCallbacks | undefined;
  meta: ToolCallMeta;
  approvalPurpose: ApprovalPurposeSuggestion | undefined;
  reviewerInput: Record<string, unknown>;
  auditInput: Record<string, unknown>;
  abortSignal: AbortSignal | undefined;
  rationaleResumeContext: RationaleResumeExecutionContext | undefined;
  rationaleBatchContext: RationaleBatchExecutionContext | undefined;
  targetFilePaths: string[];
  targetFilePath: string | undefined;
  canonicalTargets: Array<{ filePath: string; canonicalPath: string }>;
  approvalCacheKey: string | undefined;
  executionCwd: string;
  auditCurrentToolCall: AuditToolCall;
  auditCurrentPermissionAsk: AuditPermissionAsk;
  withHostShellExecutionPlan: (result: ToolResult) => ToolResult;
  abortDeps: (input: Record<string, unknown>) => UserAbortDeps;
  returnRationaleResumeBlock: (
    reason: string,
    input: Record<string, unknown>,
    blockedPermission?: PermissionCheckResult,
    hookChain?: import("../audit/audit-schema.js").HookResult[],
  ) => Promise<ToolResult>;
  sessionId: string | undefined;
  startTime: number;
  permissionResult: PermissionCheckResult | undefined;
  resolvedPluginOperation: ResolvedPluginOperation | undefined;
  pluginOperationPrincipal: PluginOperationPrincipal | undefined;
}

export interface AuthorizedInvocation {
  outcome: "authorized";
  permissionResult: PermissionCheckResult | undefined;
  hostShellApprovalDecision: ApprovalDecision | undefined;
}

export async function authorizeToolInvocation(
  context: AuthorizationStageContext,
): Promise<
  AuthorizedInvocation | ToolResult | RationaleRequiredExecuteOneOutcome
> {
  const {
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
    resolvedPluginOperation,
    pluginOperationPrincipal,
  } = context;
  let { permissionResult, hostShellApprovalDecision } = context;

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
  //     the action still requires policy review. PermissionManager routes it
  //     through the same enabled foreground reviewer threshold as mutating
  //     categories; verdicts above the threshold still ask the user.
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
  // Cross-agent provenance re-elevates even host-owned always-allow meta tools:
  // the receiver must authorize every tool use caused by an A2A Message.
  if (
    (services.permissionManager && !isAlwaysAllowMeta)
    || approvalReasonPrefix !== undefined
    || hostShellRequiresExplicitApproval
  ) {
    // Permission policy V1 SOT — PermissionManager re-elevates
    // `decisionOverride="ask"` and selects either the common foreground
    // reviewer route or a force-modal ask when that route is disabled.
    // The executor only CARRIES the override into the check context; it never
    // rewrites the verdict or re-consults getMode(). The allow-all invariant
    // (mode==="allow" → no prompt, meta included) remains single-sourced in
    // PermissionManager.
    permissionResult = services.permissionManager
      ? services.permissionManager.checkDetailed(
          toolUse.name,
          source,
          invocationCategory,
          overlayTriggerOrigin,
          { ...invocationPermissionContext, decisionOverride: metaOverride },
        )
      : {
          decision: "ask",
          reason: "cross-agent message requires receiver approval",
          layer: 3,
          forceModal: true,
        };
    if (!permissionResult) {
      throw new Error("Permission evaluation returned no result");
    }
    // Every requested-sandbox plain-shell fallback is a host-owned hard gate.
    // It runs before reviewer and approval-memory paths: a plain child has no
    // OS isolation, so neither an auto reviewer nor any durable approval may
    // silently authorize it. Existing deny decisions still win unchanged.
    if (
      hostShellRequiresExplicitApproval &&
      permissionResult.decision !== "deny"
    ) {
      const fallbackReason = hostShellExecutionPlan?.fallbackReason ?? "requested-sandbox-unavailable";
      permissionResult = invocationPermissionContext.headless === true
        ? {
            decision: "deny",
            reason: `${fallbackReason}: headless invocation blocked because interactive approval is unavailable`,
              layer: permissionResult.layer,
            }
          : {
              decision: "ask",
              reason: `${fallbackReason}: this shell will run without OS isolation and requires an exact allow-once approval`,
              layer: permissionResult.layer,
              forceModal: true,
            };
    }

    // A pre-issued app mutation grant replaces only the ordinary foreground
    // approval ask. Hard denies, layer-1/2 asks, forceModal, operator Hooks,
    // rate limits, audit, and final one-shot consumption still apply.
    if (
      rationaleResumeContext === undefined &&
      resolvedPluginOperation?.rule.kind === "write" &&
      pluginOperationPrincipal !== undefined &&
      invocationPermissionContext.pluginOperation?.grantToken !== undefined &&
      permissionResult.decision === "ask" &&
      permissionResult.layer >= 3 &&
      permissionResult.forceModal !== true
    ) {
      const operationPermHook = await runScriptHook(
        services.scriptHookManager,
        "perm",
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
      permissionResult =
        operationPermHook.decision === "deny"
          ? {
              decision: "deny",
              reason: operationPermHook.reason,
              layer: permissionResult.layer,
            }
          : {
              decision: "allow",
              reason:
                "pre-issued app operation grant pending atomic consumption",
              layer: permissionResult.layer,
            };
    }

    // ── Plugin-read auto-allow ↔ sandbox-fs-containment coupling ──────────
    //
    // The merged read-relaxation coupling (the block immediately below) only
    // gates the `ask` path: it requires `services.sandboxFsContainedProvider(tool)`
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
      services.hostClassifiesRiskProvider() &&
      source === "plugin" &&
      invocationCategory === "read" &&
      permissionResult.decision === "allow" &&
      permissionResult.layer === 6 &&
      invocationPermissionContext.headless !== true &&
      services.permissionManager?.getMode() !== "allow" &&
      !services.sandboxFsContainedProvider(tool)
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
    //   • SANDBOX FILESYSTEM-CONTAINED ONLY (`services.sandboxFsContainedProvider(tool)`).
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
    //        • the TWO remaining exclusions run UNGATED under the flag, each
    //          BOUNDED: config.set =
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
      rationaleResumeContext === undefined &&
      services.hostClassifiesRiskProvider() &&
      services.sandboxFsContainedProvider(tool) &&
      source === "plugin" &&
      invocationPermissionContext.headless !== true &&
      permissionResult.decision === "ask" &&
      permissionResult.layer >= 3 &&
      permissionResult.forceModal !== true
    ) {
      const relaxedPermHook = await runScriptHook(
        services.scriptHookManager,
        "perm",
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
      if (relaxedPermHook.decision === "deny") {
        // Operator perm-hook DENY wins over the relaxation — fail closed exactly
        // as the ask lane does on a perm-hook deny.
        const msg = t("be_executor.hookPermissionBlock", {
          reason: relaxedPermHook.reason,
        });
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
          {
            ...permissionResult,
            decision: "deny",
            reason: relaxedPermHook.reason,
          },
          Infinity,
          invocationPermissionContext,
          invocationCategory,
          executionCwd,
          undefined,
          undefined,
          hookChainFromDispatch("perm", relaxedPermHook),
        );
        return withHostShellExecutionPlan({
          tool_use_id: toolUse.id,
          content: msg,
          is_error: true,
          durationMs,
        });
      }
      permissionResult = {
        decision: "allow",
        reason:
          "plugin foreground pre-exec ask relaxed — gated at the effect boundary (hostClassifiesRisk)",
        layer: permissionResult.layer,
      };
    }
    if (
      rationaleResumeContext === undefined &&
      source === "plugin" &&
      invocationPermissionContext.pluginPanelUserAction === true &&
      invocationPermissionContext.headless !== true &&
      permissionResult.decision === "ask" &&
      permissionResult.layer >= 3 &&
      permissionResult.forceModal !== true
    ) {
      const panelPermHook = await runScriptHook(
        services.scriptHookManager,
        "perm",
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
      if (panelPermHook.decision === "deny") {
        const msg = t("be_executor.hookPermissionBlock", {
          reason: panelPermHook.reason,
        });
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
          {
            ...permissionResult,
            decision: "deny",
            reason: panelPermHook.reason,
          },
          Infinity,
          invocationPermissionContext,
          invocationCategory,
          executionCwd,
          undefined,
          undefined,
          hookChainFromDispatch("perm", panelPermHook),
        );
        return withHostShellExecutionPlan({
          tool_use_id: toolUse.id,
          content: msg,
          is_error: true,
          durationMs,
        });
      }
      permissionResult = {
        decision: "allow",
        reason:
          "plugin panel user action - standard agent approval modal suppressed",
        layer: permissionResult.layer,
      };
    }
    // #885 v6 (§5.3): the untrusted `tool.writesToOwnSandbox` self-claim is no
    // longer threaded to the reviewer — the auto-LOW keys solely on the
    // HOST-computed `ownerPluginSandboxRoot` + host-verified path containment.
    const sandboxAttestation = {
      ...(tool.pluginId
        ? {
            ownerPluginSandboxRoot: pathResolve(
              lvisHome(),
              "plugins",
              tool.pluginId,
            ),
          }
        : {}),
    };
    let foregroundMemorySkipChecked = false;
    if (
      permissionResult.decision === "ask" &&
      permissionResult.reviewer?.route === "foreground-auto"
    ) {
      if (
        rationaleResumeContext === undefined &&
        permissionResult.layer >= 3 &&
        permissionResult.forceModal !== true &&
        invocationPermissionContext.headless !== true
      ) {
        foregroundMemorySkipChecked = true;
        const memorySkip = await services.tryUserApprovalMemorySkip(
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
          hostShellExecutionPlan,
          auditInput,
        );
        if (memorySkip) {
          permissionResult = memorySkip;
        }
      }
    }
    if (
      permissionResult.decision === "ask" &&
      permissionResult.reviewer?.route === "foreground-auto"
    ) {
      const reviewerResult = await dispatchReviewerForInteractiveAutoImpl(
        services.permissionManager,
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
        hostShellExecutionPlan,
        abortSignal,
        auditInput,
      );
      if (abortSignal?.aborted) {
        return withHostShellExecutionPlan(
          await returnUserAbort(abortDeps(finalInput)),
        );
      }
      if (reviewerResult) {
        permissionResult = reviewerResult;
      }
    }
    const needsRationaleSecurityContext =
      rationaleBatchContext !== undefined ||
      rationaleResumeContext !== undefined;
    const sandboxCapability = needsRationaleSecurityContext
      ? (hostShellExecutionPlan?.capability ??
        resolveReviewerSandboxCapability(
          source,
          toolUse.name,
          tool.mcpServerId,
          tool.workerId,
          tool.pluginId,
        ))
      : undefined;
    const sandboxExecutionPlan: Record<string, unknown> | undefined =
      sandboxCapability === undefined
        ? undefined
        : {
            // v2 adds the exact sealed host-shell plan to the canonical action
            // identity. A stale v1 rationale ticket therefore fails closed on
            // resume instead of authorizing a changed execution substrate.
            version:
              hostShellExecutionPlanAudit === undefined
                ? "rationale-sandbox-execution-plan/v1"
                : "rationale-sandbox-execution-plan/v2",
            executionCwd,
            allowedDirectories: [...invocationAllowedScope.directories],
            capability: {
              kind: sandboxCapability.kind,
              confidence: sandboxCapability.confidence,
              platform: sandboxCapability.platform,
              reason: sandboxCapability.reason,
              ...(sandboxCapability.confines === undefined
                ? {}
                : {
                    confines: {
                      filesystem: sandboxCapability.confines.filesystem,
                      process: sandboxCapability.confines.process,
                      network: sandboxCapability.confines.network,
                    },
                  }),
            },
            ...(hostShellExecutionPlanAudit === undefined
              ? {}
              : { hostShellExecutionPlan: hostShellExecutionPlanAudit }),
          };
    if (rationaleBatchContext && sandboxCapability && sandboxExecutionPlan) {
      const rationaleControl = await maybeMaterializeRationaleControl(
        rationaleBatchContext.runtime,
        {
          batchId: rationaleBatchContext.batchId,
          originalToolUseIds: rationaleBatchContext.originalToolUseIds,
          completedToolUseIds: rationaleBatchContext.completedToolUseIds,
          toolUseId: toolUse.id,
          originalInput: toolUse.input,
          finalInput,
          toolName: toolUse.name,
          toolVersion: tool.version,
          source,
          category: invocationCategory,
          ...(tool.pluginId === undefined ? {} : { pluginId: tool.pluginId }),
          ...(tool.mcpServerId === undefined
            ? {}
            : { mcpServerId: tool.mcpServerId }),
          ...(tool.workerId === undefined ? {} : { workerId: tool.workerId }),
          invocationTrustOrigin: invocationPermissionContext.trustOrigin,
          targetFilePaths,
          canonicalTargets: canonicalTargets.map(
            (target) => target.canonicalPath,
          ),
          allowedDirectories: invocationAllowedScope.directories,
          ...(approvalCacheKey === undefined ? {} : { approvalCacheKey }),
          sandboxCapability,
          sandboxExecutionPlan,
          permission: permissionResult,
          permissionEvaluationContext: evaluationContext,
          eligibilityContext: {
            headless: invocationPermissionContext.headless === true,
            forceModal: permissionResult.forceModal === true,
            approvalReasonPrefix: approvalReasonPrefix ?? null,
          },
        },
      );
      if (rationaleControl) {
        return { outcome: "rationale-required", control: rationaleControl };
      }
    }
    if (rationaleResumeContext) {
      if (!sandboxCapability || !sandboxExecutionPlan) {
        return returnRationaleResumeBlock(
          "current sandbox capability could not be resolved",
          finalInput,
          permissionResult,
        );
      }
      const prepared = await prepareRationaleResume(
        rationaleResumeContext.request,
        {
          finalInput,
          toolName: toolUse.name,
          toolVersion: tool.version,
          source,
          category: invocationCategory,
          ...(tool.pluginId === undefined ? {} : { pluginId: tool.pluginId }),
          ...(tool.mcpServerId === undefined
            ? {}
            : { mcpServerId: tool.mcpServerId }),
          ...(tool.workerId === undefined ? {} : { workerId: tool.workerId }),
          invocationTrustOrigin: invocationPermissionContext.trustOrigin,
          canonicalTargets: canonicalTargets.map(
            (target) => target.canonicalPath,
          ),
          allowedDirectories: invocationAllowedScope.directories,
          ...(approvalCacheKey === undefined ? {} : { approvalCacheKey }),
          sandboxCapability,
          sandboxExecutionPlan,
          permission: permissionResult,
          permissionEvaluationContext: evaluationContext,
          eligibilityContext: {
            headless: invocationPermissionContext.headless === true,
            forceModal: permissionResult.forceModal === true,
            approvalReasonPrefix: approvalReasonPrefix ?? null,
          },
        },
        rationaleResumeContext.runtime,
      );
      if (!prepared.ok) {
        return returnRationaleResumeBlock(
          prepared.reason,
          finalInput,
          permissionResult,
        );
      }
      rationaleResumeContext.prepared = prepared.value;
    }
    if (permissionResult.decision === "deny") {
      const msg = t("be_executor.permBlockDeny", {
        name: toolUse.name,
        source,
        trust,
        reason: permissionResult.reason,
      });
      const durationMs = Date.now() - startTime;
      // Use finalInput (post-PreToolUse hook) so audit/UI never show stale
      // pre-hook args for a hook-modified invocation.
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
        permissionResult,
        Infinity,
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
    if (permissionResult.decision === "ask") {
      if (invocationPermissionContext.headless === true) {
        const headlessReviewerRoute =
          permissionResult.reviewer?.route === "headless" ||
          services.permissionManager?.getMode() === "strict";
        if (!headlessReviewerRoute) {
          const headlessDeny: PermissionCheckResult = {
            decision: "deny",
            reason: `headless explicit approval unavailable: ${permissionResult.reason}`,
            layer: permissionResult.layer,
          };
          const msg = t("be_executor.permBlockHeadlessDeny", {
            name: toolUse.name,
            source,
            reason: headlessDeny.reason,
          });
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
            headlessDeny,
            Infinity,
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
        const reviewerResult = await dispatchReviewerForHeadlessImpl(
          services.permissionManager,
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
          hostShellExecutionPlan,
          abortSignal,
          auditInput,
        );
        if (abortSignal?.aborted) {
          return withHostShellExecutionPlan(
            await returnUserAbort(abortDeps(finalInput)),
          );
        }
        if (reviewerResult.allowed) {
          permissionResult = reviewerResult.permissionResult;
        } else {
          const msg = reviewerResult.message;
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
            reviewerResult.permissionResult,
            Infinity,
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
    // A cross-agent Message is untrusted input. Preserve any prior deny,
    // but force every otherwise-allowed tool through the receiver's own
    // ApprovalGate with the DLP-masked Sub-Agent provenance label.
    if (approvalReasonPrefix && permissionResult.decision !== "deny") {
      permissionResult = {
        ...permissionResult,
        decision: "ask",
        forceModal: true,
      };
    }
    if (
      rationaleResumeContext === undefined &&
      permissionResult.decision === "ask" &&
      permissionResult.layer >= 3 &&
      // Only an explicit forceModal marker is a per-invocation hard gate;
      // reviewer-routed ask-meta calls use the normal stored-approval lane.
      permissionResult.forceModal !== true &&
      invocationPermissionContext.headless !== true &&
      foregroundMemorySkipChecked !== true
    ) {
      const memorySkip = await services.tryUserApprovalMemorySkip(
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
        hostShellExecutionPlan,
        auditInput,
      );
      if (memorySkip) {
        permissionResult = memorySkip;
      }
    }
    if (permissionResult.decision === "ask") {
      if (rationaleResumeContext?.prepared) {
        const permHook = await runScriptHook(
          services.scriptHookManager,
          "perm",
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
        if (permHook.decision === "deny") {
          return returnRationaleResumeBlock(
            "permission-request hook denied the sealed action: " +
              permHook.reason,
            finalInput,
            { ...permissionResult, decision: "deny", reason: permHook.reason },
            hookChainFromDispatch("perm", permHook),
          );
        }
        try {
          await auditCurrentPermissionAsk(
            toolUse.name,
            source,
            invocationCategory,
            finalInput,
            permissionResult,
            executionCwd,
            invocationPermissionContext,
            targetFilePath,
          );
        } catch (error) {
          return returnRationaleResumeBlock(
            "permission ask audit failed: " +
              (error instanceof Error ? error.message : String(error)),
            finalInput,
            permissionResult,
          );
        }
        if (abortSignal?.aborted) {
          return returnRationaleResumeBlock(
            "resume was aborted before allow-once receipt consumption",
            finalInput,
            permissionResult,
          );
        }
        const authorized = await authorizeRationaleResume(
          rationaleResumeContext.prepared,
        );
        if (!authorized.ok) {
          return returnRationaleResumeBlock(
            authorized.reason,
            finalInput,
            permissionResult,
          );
        }
        rationaleResumeContext.authorized = authorized.value;
        permissionResult = {
          decision: "allow",
          reason: "host-authentic rationale allow-once receipt consumed",
          layer: permissionResult.layer,
        };
      } else if (services.approvalGate) {
        // Layer 3: wire target.filePath + isReadOnly + mode so the
        // approval gate can apply sensitive-path and read-only checks to
        // the exact invocation shown to the user.
        const approvalRequest = {
          id: randomUUID(),
          ...(hostShellRequiresExplicitApproval
            ? {
                // This route intentionally has no durable approval record:
                // its substrate is an honest plain host child for this call only.
                allowedChoices: ["allow-once", "deny-once"] as const,
                forceExplicit: true as const,
                ...(hostShellExecutionPermitBinding === undefined
                  ? {}
                  : { hostShellExecutionPermitBinding }),
              }
            : {}),
          ...(hostShellExecutionPlanAudit === undefined
            ? {}
            : { executionPlan: hostShellExecutionPlanAudit }),
          category: "tool" as const,
          toolName: toolUse.name,
          toolCategory: invocationCategory,
          reviewerVerdict: permissionResult.reviewer?.verdict,
          ...(approvalPurpose ? { approvalPurpose } : {}),
          args: finalInput,
          reason: approvalReasonPrefix
            ? `${approvalReasonPrefix} ${permissionResult.reason}`
            : permissionResult.reason,
          source: source as "builtin" | "plugin" | "mcp",
          createdAt: Date.now(),
          ...(targetFilePath ? { target: { filePath: targetFilePath } } : {}),
          isReadOnly: approvalReasonPrefix
            ? false
            : invocationCategory === "read",
          mode: currentApprovalMode(services.permissionManager),
          sensitivePathPattern,
          trustOrigin: invocationPermissionContext.trustOrigin,
          // Propagate approvalCacheKey so renderer record key
          // matches dispatchReviewer lookup key — end-to-end symmetry.
          ...(approvalCacheKey ? { approvalCacheKey } : {}),
          // Canonical host shells expose only their sealed safe projection;
          // non-host-shell routes retain their existing capability display.
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
            : {}),
          evaluationContext,
        };

        const permHook = await runScriptHook(
          services.scriptHookManager,
          "perm",
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
        if (permHook.decision === "deny") {
          const msg = t("be_executor.hookPermissionBlock", {
            reason: permHook.reason,
          });
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
            { ...permissionResult, decision: "deny", reason: permHook.reason },
            Infinity,
            invocationPermissionContext,
            invocationCategory,
            executionCwd,
            undefined,
            undefined,
            hookChainFromDispatch("perm", permHook),
          );
          return withHostShellExecutionPlan({
            tool_use_id: toolUse.id,
            content: msg,
            is_error: true,
            durationMs,
          });
        }

        // §F3: requestAndWait 실패 시 감사 로그 보장 후 deny-once 처리
        let decision;
        try {
          await auditCurrentPermissionAsk(
            toolUse.name,
            source,
            invocationCategory,
            finalInput,
            permissionResult,
            executionCwd,
            invocationPermissionContext,
            targetFilePath,
          );
          if (abortSignal?.aborted) {
            return withHostShellExecutionPlan(
              await returnUserAbort(abortDeps(finalInput)),
            );
          }
          decision =
            await services.approvalGate.requestAndWait(approvalRequest);
          if (hostShellExecutionPermitBinding !== undefined) {
            hostShellApprovalDecision = decision;
          }
        } catch (approvalErr) {
          const msg = t("be_executor.approvalGateError", {
            name: toolUse.name,
            error:
              approvalErr instanceof Error
                ? approvalErr.message
                : String(approvalErr),
          });
          const durationMs = Date.now() - startTime;
          // finalInput keeps audit/UI consistent with the args shown to the
          // approval gate (which already uses finalInput in approvalRequest).
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
            {
              ...permissionResult,
              decision: "deny",
              reason: `approval gate error: ${approvalErr instanceof Error ? approvalErr.message : String(approvalErr)}`,
            },
            Infinity,
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

        if (decision.choice.startsWith("deny")) {
          // deny-always: 영구 거부 규칙 추가
          if (decision.choice === "deny-always" && services.permissionManager) {
            const pattern =
              approvalCacheKey ?? decision.rememberPattern ?? toolUse.name;
            await services.permissionManager.addAlwaysDeniedPersist(pattern);
          }
          const msg = t("be_executor.approvalDeniedByUser", {
            name: toolUse.name,
          });
          const durationMs = Date.now() - startTime;
          // finalInput matches the args the user actually saw + denied via
          // approvalRequest — never log stale pre-hook input here.
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
            {
              ...permissionResult,
              decision: "deny",
              reason: "user denied approval request",
            },
            Infinity,
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

        // allow-always: 영구 허용 규칙 추가
        if (decision.choice === "allow-always" && services.permissionManager) {
          const pattern =
            approvalCacheKey ?? decision.rememberPattern ?? toolUse.name;
          // P2 — stamp the grant tier from the final resolved category so an
          // "Allow always" on a read tool grants read-tier (still asks on a
          // later write of the same pattern) while a write/shell/network/meta
          // tool grants write-tier (covers everything). requiredTier is the
          // shared SOT for the category→tier mapping.
          await services.permissionManager.addAlwaysAllowedPersist(
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
        const msg = t("be_executor.approvalGateMissing", {
          name: toolUse.name,
          source,
          reason: permissionResult.reason,
        });
        const durationMs = Date.now() - startTime;
        log.error(msg);
        // finalInput so audit reflects post-hook args even when the gate is
        // unavailable.
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
          {
            ...permissionResult,
            decision: "deny",
            reason: `approval gate missing: ${permissionResult.reason}`,
          },
          Infinity,
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
  }

  if (rationaleResumeContext && !rationaleResumeContext.authorized) {
    return returnRationaleResumeBlock(
      "current permission path did not produce an eligible sealed resume authorization",
      finalInput,
      permissionResult,
    );
  }

  return {
    outcome: "authorized",
    permissionResult,
    hostShellApprovalDecision,
  };
}

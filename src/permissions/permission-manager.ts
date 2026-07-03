/**
 * Permission Manager — tool-governance.md §4 Source-Aware Permission Model
 *
 * 통합 도구 거버넌스:
 * - 모든 도구(Builtin/Plugin/MCP)에 대해 source + trust 기반 판정
 * - Global strict mode is mode-first after immutable deny/overlay-trigger guards
 * - 감사 로그 연동을 위한 판정 사유 추적
 *
 * 판정 우선순위 (§4.1 + MCP per-tool override):
 * 1. deny 규칙
 * 2. MCP strict override
 * 3. overlay-trigger mutating origin guard
 * 4. global strict mode
 * 5. headless mutating reviewer lane
 * 6. allow 규칙
 * 7. 사용자 "항상 허용" 규칙
 * 8. Trust/category 기본 정책 (MCP auto 는 별도 우회 없이 여기로 합류)
 */
import { resolve } from "node:path";
import type { DenyRule, ToolCategory, ToolSource, ToolTrustOrigin, TrustLevel } from "../tools/types.js";
import { trustFromSource } from "../tools/types.js";
import { readPermissionsFile, updatePermissionsFile } from "./permissions-store.js";
import { isOverlayTriggerOrigin } from "../shared/overlay-trigger-source.js";
import type { UserApprovalHitPayload, UserApprovalVerdict } from "../shared/permissions-events.js";
import { getToolCategoryDescriptor } from "./category-registry.js";
import {
  LlmRiskClassifier,
  RuleBasedRiskClassifier,
  maxVerdict,
  type RiskClassifier,
  type RiskVerdict,
  type ToolInvocationContext,
} from "./reviewer/risk-classifier.js";
import {
  resolveReviewerSandboxCacheState,
  type ReviewerSandboxCacheState,
} from "./sandbox-capability.js";
import type { PermissionEvaluationContext } from "./evaluation-context.js";
import type { VerdictCache } from "./reviewer/verdict-cache.js";
import type { DeferredQueue } from "./reviewer/deferred-queue.js";
import { globMatch } from "../lib/glob-matcher.js";
import { lvisHome } from "../shared/lvis-home.js";
import { t } from "../i18n/index.js";
import { lookupApproval, canonicalStringify } from "./user-approval-store.js";
import { buildSandboxAuditEntry } from "../audit/sandbox-audit.js";
import { emitSandboxAudit } from "../audit/sandbox-audit-sink.js";
import { maskSensitiveData } from "../audit/dlp-filter.js";
import { isSensitivePath } from "./sensitive-paths.js";
import { isPathAllowed } from "./allowed-directories.js";

export type PermissionDecision = "allow" | "deny" | "ask";
export type ExecutionMode = "default" | "strict" | "auto" | "allow";

/**
 * P2 graduated grant tier. A persisted "Allow always" grant carries a tier so
 * a grant made on a read tool ("read") does NOT silently authorize a later
 * write/shell/network/meta invocation of the same pattern, while a grant made
 * on a write/shell/network/meta tool ("write") covers everything. This makes a
 * grant category-aware instead of the previous flat, all-or-nothing behaviour.
 *
 * The ranking is monotone (read < write): a grant is only ever upgraded, never
 * downgraded, and the covered set widens with the tier.
 */
export type GrantTier = "read" | "write";

export interface PermissionRule {
  /** 도구 이름 패턴 (glob: "memory_*", "mcp_*", "*") */
  pattern: string;
  /** 허용/차단 */
  action: "allow" | "deny";
  /** 적용 소스 제한 (없으면 전체 적용) */
  source?: ToolSource;
  /**
   * P2 graduated grant tier for `action: "allow"` rules. Absent = legacy
   * untiered grant, grandfathered to write-tier (most permissive — preserves a
   * user's previously saved "Allow always"). Ignored for `action: "deny"`.
   */
  tier?: GrantTier;
}

/**
 * Layer 5 reviewer routing lane. Distinguishes the two automatic-approval
 * lanes that {@link PermissionManager.resolveReviewerDecision} translates a
 * verdict for: `headless` (background/routine turns — non-low denies) and
 * `foreground-auto` (interactive auto-review opt-in — non-low asks). Shared by
 * the `reviewer.route` marker and the reviewer-dispatch callsites so the lane
 * union has a single source of truth.
 */
export type ReviewerLane = "foreground-auto" | "headless";

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason: string;
  layer: number; // 어떤 단계에서 결정되었는지
  /**
   * Layer 5 reviewer routing marker. Only PermissionManager may set this.
   * Executor must not infer reviewer eligibility from `decision: "ask"` because
   * overlay-trigger, strict, and low-trust MCP asks are hard user-approval gates.
   */
  reviewer?: {
    route: ReviewerLane;
    verdict?: RiskVerdict;
  };
  /**
   * Per-invocation hard-ask marker. When `true`, this `ask` decision MUST be
   * confirmed by the user on every invocation and is NEVER auto-skipped by the
   * explicit-approval memory store (Store B). Set when a tool author declared
   * `decisionOverride: "ask"` ("always confirm me"); honouring it preserves the
   * author's per-invocation intent against a prior session/persistent grant.
   */
  forceModal?: boolean;
  /**
   * Layer 5 headless reviewer queue metadata. The execution result is still a
   * blocked tool call, but the audit decision must be `deferred` rather than a
   * plain deny so forensics can link it to the manual approval queue entry.
   */
  deferred?: {
    queueId: string;
    reviewerVerdict: RiskVerdict;
  };
  /**
   * Permission policy P2.5 §3 Layer 2 — structured deny reasons for audit forensics.
   * The pipeline records the *current* deny entry only (short-circuit
   * evaluation; later layers are skipped). Hypothetical other-layer
   * decisions belong to dry-run mode, not normal audit.
   *
   * Each entry: { layer, reason, source }
   *   layer    — which Permission policy layer fired (0=sensitive, 1=allowed-dir, …)
   *   reason   — short machine-readable code (e.g. "out-of-allowed-dir")
   *   source   — emitter ("directory-policy", "sensitive-paths", …)
   */
  denyReasons?: ReadonlyArray<{
    layer: number;
    reason: string;
    source: string;
  }>;
}

export interface PermissionCheckContext {
  /**
   * Background/routine turns are not direct user gestures. Mutating tools must
   * still ask even when an allow rule or auto mode would otherwise permit them.
   */
  headless?: boolean;
  /**
   * Permission policy #634 — full approval-cache identity for authority-sensitive tools.
   * When present, user allow rules / allow-always entries match this key
   * instead of the bare tool name so a benign prior approval cannot silently
   * authorize a later call with a broader argument scope.
   */
  approvalCacheKey?: string;
  /**
   * Tool-author `decisionOverride` for `meta`-category builtin tools, carried
   * from the executor so the "override" branch of {@link categoryBasedDecision}
   * owns the re-elevation decision (V1 SOT). `"ask"` (e.g. agent_spawn) elevates
   * the override-`allow` to a per-invocation `forceModal` ask in every mode
   * except `allow` (the allow-all opt-in); `"always-allow-with-audit"` is
   * short-circuited before checkDetailed runs and never reaches here. Non-meta
   * callers pass `undefined` (current behaviour — the override branch keeps its
   * `allow`).
   */
  decisionOverride?: "ask" | "always-allow-with-audit";
}

/**
 * Permission policy P3 — input bundle for reviewer-agent dispatch. Set when the
 * caller wants the headless lane to consult the Layer 5 classifier
 * (rather than the temporary "reviewer → ask" mapping).
 */
export interface ReviewerDispatchInput {
  source: ToolSource;
  category: ToolCategory;
  /** Manifest-declared path-bearing argument selectors. Dotted selectors are supported. */
  pathFields: readonly string[];
  /** DLP-redacted finalInput — caller is responsible for redaction. */
  finalInput: Record<string, unknown>;
  /**
   * Raw invocation identity for local approval/cache matching. This must not be
   * sent to the reviewer classifier, deferred queue, or sandbox audit.
   */
  cacheIdentityInput?: Record<string, unknown>;
  /** Captured policy/sandbox context for user review. */
  evaluationContext?: PermissionEvaluationContext;
  /** Recent user-authored message used for reviewer context-quality checks. */
  conversationContext?: {
    recentUserMessage?: string;
  };
  allowedDirectories: string[];
  sensitivePathsAdjacent: string[];
  /**
   * Permission policy architect round-4 finding: cache identity must include the
   * caller's trust origin. A high-trust verdict cached for `user-keyboard`
   * is unsafe to serve to an `llm-tool-arg` invocation of the same shape — the
   * underlying intent differs even when arguments match. Required so the
   * verdict-cache lookupKey hash always includes origin.
   */
  trustOrigin: ToolTrustOrigin;
  /** Tool-declared authority cache identity, when present. */
  approvalCacheKey?: string;
  /** When true, out-of-allowed-dir access also routes to the reviewer. */
  outOfAllowedDir?: boolean;
  /**
   * Issue #664 P1 — manifest-declared sandbox-write self-attestation.
   * Threaded from the Tool descriptor through to the classifier's
   * {@link ToolInvocationContext} so the auto-LOW rule can engage.
   */
  writesToOwnSandbox?: boolean;
  /**
   * Issue #664 P1 — owning plugin's sandbox root
   * (`~/.lvis/plugins/<pluginId>/`). Computed by the executor when the
   * tool descriptor carries `pluginId` and threaded here for the
   * sandbox-write auto-LOW rule.
   */
  ownerPluginSandboxRoot?: string;
  /**
   * Originating external MCP stdio server id (from
   * `Tool.mcpServerId`). Threaded so the reviewer reports the GENUINE asrt
   * capability for a server whose worker was actually ASRT-wrapped (and so the
   * verdict cache scopes by the real substrate). Omitted for non-MCP calls.
   */
  mcpServerId?: string;
  /**
   * worker-confinement — originating plugin worker identity (from Tool
   * pluginId/workerId). Both fields are required for plugin calls to report a
   * genuine ASRT capability; omitted values keep the historical unwrapped
   * plugin substrate (`none`).
   */
  pluginId?: string;
  workerId?: string;
}

/**
 * Result returned by {@link PermissionManager.dispatchReviewer}. The
 * caller (executor) translates this according to its lane: foreground
 * auto-review asks for MED/HIGH, while headless lanes queue any verdict
 * selected by their defer policy.
 */
export interface ReviewerDispatchResult {
  verdict: RiskVerdict;
  /**
   * "hit" / "miss-stale" / "miss-expired" / "miss-not-found" — surfaces
   * the audit-trail "from cache" hint (m1 architect MAJOR-5 cache
   * deliverable + design v2.1 §11 selective invalidation).
   */
  cacheReason: "hit" | "miss-stale" | "miss-expired" | "miss-not-found";
  /**
   * Deferred-queue id created when the caller's defer policy routed the verdict
   * to the manual queue. Foreground reviewer calls use `defer: "none"`.
   */
  deferredId?: string;
}

export type ReviewerDeferPolicy = "none" | "high" | "medium-high";

// RejectResponse interface and MAX_REVIEWER_RETRIES deferred to follow-up.

function sameReviewerSandboxCacheState(
  a: ReviewerSandboxCacheState,
  b: ReviewerSandboxCacheState,
): boolean {
  const ac = a.capability;
  const bc = b.capability;
  return (
    a.source === b.source &&
    a.substrate === b.substrate &&
    a.wrapped === b.wrapped &&
    a.mcpServerId === b.mcpServerId &&
    a.pluginId === b.pluginId &&
    a.workerId === b.workerId &&
    ac.kind === bc.kind &&
    ac.confidence === bc.confidence &&
    ac.reason === bc.reason &&
    ac.platform === bc.platform &&
    ac.confines?.filesystem === bc.confines?.filesystem &&
    ac.confines?.process === bc.confines?.process &&
    ac.confines?.network === bc.confines?.network
  );
}
// LLM caller retry wiring lives in conversation-loop.ts scope.
// Tracked in follow-up issue for "LLM caller retry wiring" with
// max 2 retry / counter scope / args-change-reset contract.

export class PermissionManager {
  private rules: PermissionRule[] = [];
  private mode: ExecutionMode = "default";
  /**
   * P2 — "Allow always" grants keyed by pattern → highest granted {@link
   * GrantTier}. Was a flat `Set<string>` (category-blind). The Map structurally
   * enforces the "1 grant, highest tier" invariant so a re-grant can only widen
   * coverage (monotone), never desynchronize.
   */
  private readonly alwaysAllowed = new Map<string, GrantTier>();
  /** MCP approval.toolPermissionMode 등 per-tool 실행 모드 override */
  private readonly toolModeOverrides = new Map<string, ExecutionMode>();
  /** 영구 규칙 저장 경로 (~/.lvis/permissions.json) */
  private readonly permissionsFilePath: string;
  /** Permission policy P3 — reviewer agent dispatch components. Wired at boot. */
  private reviewerClassifier: RiskClassifier | null = null;
  private verdictCache: VerdictCache | null = null;
  private deferredQueue: DeferredQueue | null = null;
  private reviewerCacheScope: Record<string, unknown> = {};
  /**
   * Runtime degrade flag — true when the persisted reviewer mode is "llm"
   * but boot wiring could not instantiate the LLM provider adapter (fresh
   * install: no chat provider/key configured) and fell back to the rule
   * classifier. Surfaced to the renderer (PermissionsTab banner) so the
   * user understands the reviewer is running rule-only until they configure
   * a provider. Reset to false on every successful "llm" wiring.
   */
  private reviewerDegradedToRule = false;
  /**
   * Issue #690 — interactive auto-approve setting. "off" by default;
   * "low" means the reviewer's LOW verdict in the foreground flow
   * skips the approval modal. Read by {@link categoryBasedDecision} to
   * decide whether to set `reviewer.route='foreground-auto'`.
   */
  private interactiveAutoApprove: "off" | "low" = "off";
  /** CRITICAL 4.1: optional broadcast for memory-hit auto-approve disclosure */
  private broadcastUserApprovalHit: ((payload: UserApprovalHitPayload) => void) | null = null;
  /**
   * Architectural choke point for permission config fan-out — every
   * persisted mutation through PermissionManager (addAlwaysAllowedPersist,
   * addAlwaysDeniedPersist, removeRule) fires this callback so multi-window
   * PermissionsTab refreshes without each call site re-implementing the
   * broadcast wiring. Wired by boot from
   * `ipc/domains/permissions.ts:broadcastPermissionConfigChanged`.
   */
  private broadcastConfigChanged: (() => void) | null = null;
  /**
   * Cluster review M1 — per-plugin AbortControllers used to abort outstanding
   * `hostApi.resolveApiKey` bearers when permissions are revoked. The
   * persisted-mutation entry points (`addAlwaysAllowedPersist`,
   * `addAlwaysDeniedPersist`, `removeRule`) call {@link revokeAllPluginAccess}
   * so any in-flight bearer with a captured signal fires its `release()`
   * listener and drops the bearer reference.
   *
   * Conservative default: every rule change aborts ALL plugins (coarse but
   * safe — a permission change is rare enough that the cost of re-resolving
   * the bearer for unaffected plugins is negligible compared to the risk of
   * letting a revoked plugin continue holding a captured key via a closure).
   *
   * Controllers are lazily created on first `getPluginRevokeSignal(id)` call
   * and recreated after each abort so the next resolve receives a fresh,
   * un-aborted signal.
   */
  private readonly pluginAbortControllers = new Map<string, AbortController>();

  constructor(permissionsFilePath?: string) {
    this.permissionsFilePath =
      permissionsFilePath ?? resolve(lvisHome(), "permissions.json");
  }

  /**
   * Permission policy P3 — wire the Layer 5 reviewer agent. Call once at boot after
   * loading settings. The executor checks {@link hasReviewer} before headless
   * reviewer dispatch and fail-closes when the reviewer is absent.
   */
  setReviewer(deps: {
    classifier: RiskClassifier;
    cache: VerdictCache;
    deferredQueue: DeferredQueue;
    cacheScope?: Record<string, unknown>;
    /**
     * True when persisted mode is "llm" but wiring degraded to the rule
     * classifier (provider/key not configured). Defaults to false so all
     * non-degraded callers (rule/disabled/strict, successful llm) clear it.
     */
    degradedToRule?: boolean;
  }): void {
    this.reviewerClassifier = deps.classifier;
    this.verdictCache = deps.cache;
    this.deferredQueue = deps.deferredQueue;
    this.reviewerCacheScope = deps.cacheScope ?? {};
    this.reviewerDegradedToRule = deps.degradedToRule ?? false;
  }

  /**
   * Whether the reviewer is currently running rule-only because the persisted
   * "llm" mode could not be wired (provider/key absent). Read by the
   * reviewer-show IPC to surface the degrade banner in PermissionsTab.
   */
  isReviewerDegradedToRule(): boolean {
    return this.reviewerDegradedToRule;
  }

  hasReviewer(): boolean {
    return (
      this.reviewerClassifier !== null &&
      this.verdictCache !== null &&
      this.deferredQueue !== null
    );
  }

  /**
   * Permission SOT V3 — map a reviewer {@link RiskVerdict} to the layer-5
   * allow/deny/ask decision. This is the single source of truth for the
   * verdict→decision translation; the pipeline reviewer-dispatch lanes must
   * call this rather than branching on `verdict.level` inline, so the
   * execution layer can never loosen a verdict on its own.
   *
   * Rules (behavior-neutral move from `reviewer-dispatch.ts`):
   *  - headless lane: `low` → allow(layer 5); non-low (medium/high) → deny(layer 5).
   *  - foreground-auto lane: `low` → allow(layer 5); non-low → ask(layer 5).
   *
   * The returned result carries the reviewer route + verdict marker. The
   * pipeline still owns the human-facing `message`, deferred-queue append,
   * and i18n assembly — this method only decides allow/deny/ask.
   */
  resolveReviewerDecision(
    verdict: RiskVerdict,
    lane: ReviewerLane,
  ): PermissionCheckResult {
    const isLow = verdict.level === "low";
    if (lane === "headless") {
      if (isLow) {
        return {
          decision: "allow",
          reason: `reviewer ${verdict.level}: ${verdict.reason}`,
          layer: 5,
          reviewer: { route: "headless", verdict },
        };
      }
      return {
        decision: "deny",
        reason: `reviewer ${verdict.level}: ${verdict.reason}`,
        layer: 5,
        reviewer: { route: "headless", verdict },
      };
    }
    // foreground-auto lane
    if (isLow) {
      return {
        decision: "allow",
        reason: `reviewer low: ${verdict.reason}`,
        layer: 5,
        reviewer: { route: "foreground-auto", verdict },
      };
    }
    return {
      decision: "ask",
      reason: `reviewer ${verdict.level}: ${verdict.reason}`,
      layer: 5,
      reviewer: { route: "foreground-auto", verdict },
    };
  }

  /**
   * Permission SOT V2 — evaluate the Layer 0 (sensitive-path hard-block) and
   * Layer 1 (allowed-directories) path-scope predicates over a set of
   * already-canonicalized targets. This is the single source of truth for the
   * path-scope predicate: the executor calls this instead of invoking
   * `isSensitivePath` / `isPathAllowed` inline, so "is this path sensitive /
   * out-of-directory" is answered in one place.
   *
   * Predicate ONLY (behavior-neutral move from `executor.ts`). It returns raw
   * hits, NOT a {@link PermissionCheckResult}: the executor still owns the
   * layer-0 deny (message + audit + return) and the layer-1 out-of-directory
   * approval modal + scope mutation, and just drives them off these hits. The
   * audit `layer` field values are unchanged (sensitive = 0, out-of-dir = 1).
   *
   * Frozen-canonical contract: `canonicalTargets[].canonicalPath` MUST already
   * be realpath'd + case-folded by the caller. This method performs NO realpath
   * I/O — it is a pure predicate over the supplied strings. `allowedDirectories`
   * is supplied per-call so the executor can re-evaluate after each directory
   * grant widens the scope.
   *
   * Static because the path-scope predicate is stateless and MUST run on every
   * tool call regardless of whether a PermissionManager instance is wired (the
   * executor's `permissionManager` is optional; the Layer 0/1 hard-block and
   * out-of-directory prompt fire even without one).
   *
   *  - `sensitiveHit`: the first target matching a Layer 0 sensitive-path
   *    pattern, or `null`.
   *  - `outOfAllowed`: the first target NOT covered by `allowedDirectories`,
   *    or `null`.
   */
  static checkPathScope(args: {
    canonicalTargets: readonly { filePath: string; canonicalPath: string }[];
    allowedDirectories: readonly string[];
  }): {
    sensitiveHit: { filePath: string; pattern: string } | null;
    outOfAllowed: { filePath: string; canonicalPath: string } | null;
  } {
    let sensitiveHit: { filePath: string; pattern: string } | null = null;
    for (const target of args.canonicalTargets) {
      const pattern = isSensitivePath(target.canonicalPath);
      if (pattern) {
        sensitiveHit = { filePath: target.filePath, pattern };
        break;
      }
    }
    let outOfAllowed: { filePath: string; canonicalPath: string } | null = null;
    for (const target of args.canonicalTargets) {
      if (!isPathAllowed(target.canonicalPath, { directories: args.allowedDirectories })) {
        outOfAllowed = { filePath: target.filePath, canonicalPath: target.canonicalPath };
        break;
      }
    }
    return { sensitiveHit, outOfAllowed };
  }

  /**
   * Issue #690 — set interactive auto-approve policy. Boot reads
   * `permissions.reviewer.interactive.autoApprove` from settings and
   * pushes it here so the gate inside {@link categoryBasedDecision}
   * does not have to re-read the file on every tool call.
   */
  setInteractiveAutoApprove(autoApprove: "off" | "low"): void {
    this.interactiveAutoApprove = autoApprove;
  }

  getInteractiveAutoApprove(): "off" | "low" {
    return this.interactiveAutoApprove;
  }

  /**
   * CRITICAL 4.1 — wire renderer broadcast for memory-hit auto-approve disclosure.
   * Called once at boot. When set, every user-approval memory hit emits
   * `lvis:permissions:user-approval-hit` to the renderer and a console.info log.
   */
  setBroadcastConfigChanged(fn: () => void): void {
    this.broadcastConfigChanged = fn;
  }

  setBroadcastUserApprovalHit(fn: (payload: UserApprovalHitPayload) => void): void {
    this.broadcastUserApprovalHit = fn;
  }

  /**
   * Cluster review M1 — return the AbortSignal that will fire when this
   * plugin's outstanding bearer leases must be aborted (i.e. on any
   * permission rule change). Lazily creates the controller on first call.
   *
   * Callers combine this signal with the caller-provided per-request signal
   * via `AbortSignal.any` so the bearer's `release()` runs on whichever
   * triggers first. The controller is recreated after every abort, so the
   * returned signal is stable only across the current "lease epoch" — the
   * next call after an abort gets a fresh signal.
   */
  getPluginRevokeSignal(pluginId: string): AbortSignal {
    let controller = this.pluginAbortControllers.get(pluginId);
    if (!controller) {
      controller = new AbortController();
      this.pluginAbortControllers.set(pluginId, controller);
    }
    return controller.signal;
  }

  /**
   * Cluster review M1 — abort the named plugin's outstanding bearer leases
   * and recreate a fresh controller so the next `getPluginRevokeSignal` call
   * returns an un-aborted signal. The abort reason is wrapped in
   * `Error('permission-revoked: <reason>')` so downstream listeners that
   * surface `signal.reason` see a structured, human-readable cause.
   */
  revokePluginAccess(pluginId: string, reason: string): void {
    const controller = this.pluginAbortControllers.get(pluginId);
    if (!controller) return;
    try {
      controller.abort(new Error(`permission-revoked: ${reason}`));
    } catch {
      // AbortController.abort never throws in practice; the catch is
      // defense-in-depth so a bad polyfill can't break the mutation path.
    }
    // Recreate so the NEXT resolve gets an un-aborted controller. Without
    // this, every subsequent resolve would receive the already-aborted
    // signal and fire release() before the bearer is ever read.
    this.pluginAbortControllers.set(pluginId, new AbortController());
  }

  /**
   * Cluster review M1 — abort every known plugin's outstanding bearer leases.
   * Called from the persisted-mutation entry points (addAlwaysAllowedPersist,
   * addAlwaysDeniedPersist, removeRule) so any rule change invalidates
   * outstanding bearers across all plugins (coarse but safe — the alternative
   * is per-rule plugin-id resolution which is fragile when rules use glob
   * patterns that can match any future plugin's tool names).
   */
  revokeAllPluginAccess(reason: string): void {
    for (const pluginId of [...this.pluginAbortControllers.keys()]) {
      this.revokePluginAccess(pluginId, reason);
    }
  }

  /**
   * Permission policy P3 — accessor for the deferred queue. IPC layer reads pending
   * entries from here and resolves them on user gestures. Returns null
   * when the reviewer is not wired.
   */
  getDeferredQueue(): DeferredQueue | null {
    return this.deferredQueue;
  }

  /**
   * Permission policy P3 — accessor for the verdict cache. Used by the slash handler
   * when the user changes settings and we need to drop stale entries.
   */
  getVerdictCache(): VerdictCache | null {
    return this.verdictCache;
  }

  // ─── 설정 ────────────────────────────────────────

  setMode(mode: ExecutionMode): void {
    this.mode = mode;
  }

  getMode(): ExecutionMode {
    return this.mode;
  }

  setRules(rules: PermissionRule[]): void {
    this.rules = [...rules];
  }

  setToolModeOverride(toolName: string, mode: ExecutionMode): void {
    if (mode === "default") {
      this.toolModeOverrides.delete(toolName);
      return;
    }
    this.toolModeOverrides.set(toolName, mode);
  }

  clearToolModeOverride(toolName: string): void {
    this.toolModeOverrides.delete(toolName);
  }

  getVisibilityDenyRules(): DenyRule[] {
    return this.rules
      .filter((rule) => rule.action === "deny" && !rule.source)
      .map((rule) => ({ pattern: rule.pattern }));
  }

  // ─── 영구 규칙 관리 (B1) ─────────────────────────

  /**
   * 도구 이름(패턴)을 영구 allow 규칙으로 추가.
   * permissions.json 저장이 성공한 뒤에만 인메모리 allow cache를 갱신한다.
   *
   * P2 — `tier` records how broadly the grant applies. It defaults to `"write"`
   * so the non-executor callers (slash `/allow`, the PermissionsTab addRule IPC)
   * keep their category-blind grant (grandfather). The executor passes
   * {@link requiredTier}(invocationCategory) so a grant made on a read tool is
   * read-tier. Re-granting is monotone: the tier is only ever upgraded (read→
   * write), never downgraded — a downgrade must go through {@link removeRule}.
   */
  async addAlwaysAllowedPersist(pattern: string, tier: GrantTier = "write"): Promise<void> {
    // 영구: rules 배열에 allow 규칙 추가/승격 (중복 방지 + monotone tier)
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      const existing = file.rules.find(
        (r) => r.action === "allow" && r.pattern === pattern && !r.source,
      );
      if (existing) {
        // Upgrade only — never downgrade a saved grant. A legacy/absent tier
        // grandfathers to write, so a "read" re-grant onto it is a no-op.
        if (tierRank(tier) > tierRank(normalizeTier(existing.tier))) {
          existing.tier = tier;
        }
      } else {
        file.rules.push({ pattern, action: "allow", tier });
      }
    });
    // 인메모리: durable write 성공 후 alwaysAllowed Map (checkDetailed layer 5).
    // maxTier keeps the invariant that the Map holds the highest granted tier.
    this.alwaysAllowed.set(pattern, maxTier(this.alwaysAllowed.get(pattern), tier));
    this.broadcastConfigChanged?.();
    // Cluster review M1 — rule change aborts outstanding bearers so plugins
    // re-resolve their keys under the new policy. An allow rule going wider
    // is benign but still needs the next bearer to reflect the new state.
    this.revokeAllPluginAccess(`allow-rule-added:${pattern}`);
  }

  /**
   * 도구 이름(패턴)을 영구 deny 규칙으로 추가.
   * 인메모리 rules 배열 + permissions.json 동시 업데이트.
   */
  async addAlwaysDeniedPersist(pattern: string): Promise<void> {
    // 인메모리: rules 배열 선두 삽입 (deny 최우선)
    const exists = this.rules.some(
      (r) => r.action === "deny" && r.pattern === pattern && !r.source,
    );
    if (!exists) {
      this.rules.unshift({ pattern, action: "deny" });
    }
    // 영구
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      const fileExists = file.rules.some(
        (r) => r.action === "deny" && r.pattern === pattern && !r.source,
      );
      if (!fileExists) {
        file.rules.unshift({ pattern, action: "deny" });
      }
    });
    this.broadcastConfigChanged?.();
    // Cluster review M1 — deny added → outstanding bearers MUST be aborted
    // so a plugin that held a bearer captured in a closure can't continue
    // calling the upstream provider after the user revoked access.
    this.revokeAllPluginAccess(`deny-rule-added:${pattern}`);
  }

  /**
   * 패턴 + 액션으로 영구 규칙 삭제.
   */
  async removeRule(pattern: string, action: "allow" | "deny"): Promise<void> {
    // 인메모리
    this.rules = this.rules.filter(
      (r) => !(r.pattern === pattern && r.action === action && !r.source),
    );
    if (action === "allow") this.alwaysAllowed.delete(pattern);
    // 영구
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      file.rules = file.rules.filter(
        (r) => !(r.pattern === pattern && r.action === action && !r.source),
      );
    });
    this.broadcastConfigChanged?.();
    // Cluster review M1 — rule removal is also a permission change. An
    // allow removal narrows the policy (revoke); a deny removal widens it.
    // In both cases outstanding bearers should re-resolve under the new
    // policy rather than keep operating under the now-stale snapshot.
    this.revokeAllPluginAccess(`rule-removed:${action}:${pattern}`);
  }

  /**
   * 앱 부팅 시 호출. permissions.json → 인메모리 병합.
   * 파일 없음 → no-op (정상).
   */
  async loadRulesFromFile(): Promise<void> {
    const file = await readPermissionsFile(this.permissionsFilePath);
    if (!file) return;

    // mode 동기화
    if (file.mode) this.mode = file.mode;

    // rules 병합: 파일 규칙은 기존 인메모리 규칙 뒤에 추가 (중복 제거)
    for (const rule of file.rules) {
      const dup = this.rules.some(
        (r) => r.pattern === rule.pattern && r.action === rule.action && r.source === rule.source,
      );
      if (!dup) {
        if (rule.action === "deny") {
          this.rules.unshift(rule); // deny는 최우선
        } else {
          this.rules.push(rule);
          // allow 규칙은 alwaysAllowed Map에도 반영 (P2: tier 보존).
          // normalizeTier grandfathers a legacy/absent tier to write; maxTier
          // keeps the highest tier if the pattern is hydrated more than once.
          if (!rule.source) {
            this.alwaysAllowed.set(
              rule.pattern,
              maxTier(this.alwaysAllowed.get(rule.pattern), normalizeTier(rule.tier)),
            );
          }
        }
      } else if (rule.action === "allow" && !rule.source) {
        // Dup-hit tier reconciliation — MINOR-2 insurance. The surviving rule
        // may be a boot default with no explicit tier (e.g. conversation.ts
        // setRules pre-seeds web_search/web_fetch). setRules does NOT populate
        // alwaysAllowed, so the Map has no entry for that pattern. A persisted
        // tiered file rule hitting this dedup branch would otherwise lose its
        // tier silently: the Map update is skipped and the surviving rule's
        // tier stays undefined (= write-tier via layer-3's normalizeTier,
        // over-permitting relative to a user-explicit read-tier grant).
        //
        // Fix: compute merged = maxTier(Map.get, normalizeTier(file.tier)).
        // This takes the Map's current view (from an earlier non-dup load or a
        // prior call) as the "existing" baseline, NOT the surviving rule's
        // implicit write-tier, so the user's explicit persisted tier wins when
        // the Map is empty. Set both the Map and the surviving rule's tier to
        // merged so layer-3 and layer-5 remain consistent.
        const merged = maxTier(this.alwaysAllowed.get(rule.pattern), normalizeTier(rule.tier));
        this.alwaysAllowed.set(rule.pattern, merged);
        const surviving = this.rules.find(
          (r) => r.pattern === rule.pattern && r.action === "allow" && r.source === rule.source,
        );
        if (surviving) surviving.tier = merged;
      }
    }
  }

  /**
   * permissions.json에 저장된 규칙 목록 반환 (Settings UI용).
   * 파일 없음 → 빈 배열.
   */
  async listPersistedRules(): Promise<PermissionRule[]> {
    const file = await readPermissionsFile(this.permissionsFilePath);
    return file?.rules ?? [];
  }

  /**
   * mode를 permissions.json에 영구 저장한 뒤 인메모리 상태를 갱신.
   * 감사 entry 는 호출자가 먼저 append 하므로, 파일 저장 실패 시 runtime
   * mode 까지 바뀌지 않아야 한다.
   */
  async setModePersist(mode: ExecutionMode): Promise<void> {
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      file.mode = mode;
    });
    this.mode = mode;
  }

  // ─── 판정 (§4.1) ────────────────────────────────

  /**
   * 상세 판정 — 감사 로그용 사유 포함.
   *
   * `overlayTriggerOrigin` (예: `"overlay:meeting-detection"`) 가 set 이면
   * 모든 write/shell/network 도구는 **사용자 영구 승인 (`allow-always`) /
   * config allow rules / auto 모드** 와 무관하게 `ask` 로 강제됨.
   * overlay trigger가 사용자 컨펌 없이 destructive 작업 자동 실행되는 것을
   * 막는 차단막 — `<overlay-trigger-origin-guidance>` 시스템 프롬프트의 1차
   * LLM-side 검토와 짝을 이루는 hard gate. read 도구는 영향 없음.
   *
   * Permission policy — 5-axis category model. Layer 3 의 decisionFor() 가
   * old trust-default 분기를 대체. `meta` category 는 descriptor 가 `"override"` 를
   * 반환하므로 caller (executor) 의 decisionOverride 분기로 routing.
   */
  checkDetailed(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    overlayTriggerOrigin?: string | null,
    context: PermissionCheckContext = {},
  ): PermissionCheckResult {
    const trust = this.resolveTrust(toolName, source);
    // Strict pattern (shared with the rest of the overlay trigger flow —
    // see shared/overlay-trigger-source.ts). Loose `startsWith` would
    // accept malformed values like "overlay:Bad/Path" that no
    // upstream gate emits but a future hand-injected codepath might;
    // fail-closed on malformed input.
    const isOverlayTrigger = isOverlayTriggerOrigin(overlayTriggerOrigin ?? null);
    const resolvedCategory: ToolCategory = category;
    const isMutating =
      resolvedCategory === "write" ||
      resolvedCategory === "shell" ||
      resolvedCategory === "network";

    const approvalCacheKey = normalizeApprovalCacheKey(context.approvalCacheKey);
    const denyTargets = approvalCacheKey ? [toolName, approvalCacheKey] : [toolName];
    const allowTarget = approvalCacheKey ?? toolName;

    // 1. Deny rules (최우선, 불변)
    for (const rule of this.rules) {
      if (rule.action !== "deny") continue;
      if (rule.source && rule.source !== source) continue;
      if (denyTargets.some((target) => globMatch(target, rule.pattern))) {
        return { decision: "deny", reason: t("be_permissionManager.denyRuleReason", { pattern: rule.pattern }), layer: 1 };
      }
    }

    const toolModeOverride = this.toolModeOverrides.get(toolName);
    if (toolModeOverride === "strict") {
      return { decision: "ask", reason: t("be_permissionManager.mcpServerStrictMode"), layer: 2 };
    }

    // Overlay-trigger origin override — write/shell/network 도구는 cached
    // allow rules / always-allowed / auto-mode 를 모두 우회하고
    // 항상 사용자 컨펌을 받음. read 는 자동 실행 OK.
    if (isOverlayTrigger && isMutating) {
      return {
        decision: "ask",
        reason: t("be_permissionManager.overlayTriggerMutatingReason", { origin: overlayTriggerOrigin ?? "" }),
        layer: 2,
      };
    }

    // strict mode is mode-first after immutable deny/overlay-trigger guards:
    // allow rules, always-allowed cache, per-tool overrides, and reviewer
    // automatic approval lanes must not downgrade it.
    if (this.mode === "strict") {
      return {
        decision: "ask",
        reason: t("be_permissionManager.strictModeReason", { trust, category: resolvedCategory }),
        layer: 2,
        ...(context.headless === true && isMutating
          ? { reviewer: { route: "headless" as const } }
          : {}),
      };
    }

    if (context.headless === true && isMutating) {
      return this.categoryBasedDecision(trust, resolvedCategory, context);
    }

    // 3. Allow rules
    let result: PermissionCheckResult | undefined;
    for (const rule of this.rules) {
      if (rule.action !== "allow") continue;
      if (rule.source && rule.source !== source) continue;
      if (globMatch(allowTarget, rule.pattern)) {
        // P2 tier gate — a read-tier grant must not cover a
        // write/shell/network/meta invocation. Untiered/legacy rules default to
        // "write" (grandfather = the pre-P2 all-or-nothing behaviour).
        //
        // This gate MUST mirror the layer-5 gate below. loadRulesFromFile
        // rehydrates a persisted "Allow always" grant into BOTH this.rules
        // (evaluated HERE, first) AND alwaysAllowed (layer-5). A tier gate
        // applied only at layer-5 would therefore be silently defeated by this
        // layer-3 shadow on the first app restart.
        if (!grantCovers(normalizeTier(rule.tier), resolvedCategory)) continue;
        result = { decision: "allow", reason: t("be_permissionManager.allowRuleReason", { pattern: rule.pattern }), layer: 3 };
        break;
      }
    }

    // 5. Always-allowed (사용자 이전 승인)
    if (result === undefined) {
      const grantTier = this.alwaysAllowed.get(allowTarget);
      // P2 tier gate — see the layer-3 mirror above. A read-tier grant covers
      // only read invocations; write-tier covers everything.
      if (grantTier !== undefined && grantCovers(grantTier, resolvedCategory)) {
        result = { decision: "allow", reason: t("be_permissionManager.userPermanentApproval"), layer: 5 };
      }
    }

    // 6. Category × Source × Trust via registry descriptor
    if (result === undefined) {
      result = this.categoryBasedDecision(trust, resolvedCategory, context);
    }

    // Permission policy V1 SOT — per-invocation `decisionOverride="ask"` gate.
    //
    // A `meta`-category builtin tool that declares `decisionOverride: "ask"`
    // (e.g. agent_spawn) must show an approval modal on EVERY invocation,
    // regardless of which layer produced the current `allow` verdict:
    //
    //   layer 3 (allow rule)    — user added agent_spawn to their allow-list
    //   layer 5 (alwaysAllowed) — user clicked "Allow always" on the modal
    //   layer 6 (override case) — the normal first-invocation path
    //
    // The post-guard is layer-agnostic: layers 3/5/6 all fall through to it.
    // The previous override-branch-only approach silently bypassed layer-3/5
    // hits because those paths returned early before categoryBasedDecision ran.
    //
    // Allow-all invariant: `mode !== "allow"` is NOT dead code here — unlike
    // inside the override branch (where strict/allow early-returns narrow the
    // mode), at this point in checkDetailed the mode is not narrowed. Allow
    // mode can reach here via the layer-3 allow-rule loop. The guard must stay
    // so that an explicit allow-all opt-in still auto-allows agent_spawn with
    // no prompt, matching the allow-all invariant.
    //
    // Strict mode: already returned ask at layer 2 before this point, so
    // `result.decision` is never `allow` under strict and the guard never fires.
    if (
      result.decision === "allow" &&
      context.decisionOverride === "ask" &&
      this.mode !== "allow"
    ) {
      return {
        decision: "ask",
        reason: t("be_executor.metaToolAskOverrideReason"),
        layer: 6,
        forceModal: true,
      };
    }

    return result;
  }

  /**
   * Permission policy P3 — dispatch the Layer 5 reviewer agent for a tool invocation.
   *
   * Decision tree (design §3 Layer 5):
   *   1. cache lookup → on hit, skip classify + return cached verdict
   *   2. classify (sync or async, depending on classifier impl)
   *   3. cache the verdict for next time (HIGH cached too)
   *   4. append to deferred queue only when the caller's defer policy asks for
   *      this verdict level; foreground auto-review uses `"none"`, while
   *      headless review uses `"medium-high"`.
   *
   * Failure mode: if {@link setReviewer} was never called, returns
   * HIGH + `deferredId === undefined`. Production callers check
   * {@link hasReviewer} first and fail-close before reaching this path.
   */
  async dispatchReviewer(
    toolName: string,
    input: ReviewerDispatchInput,
    routineScope?: Record<string, unknown>,
    options?: { defer?: ReviewerDeferPolicy; abortSignal?: AbortSignal },
  ): Promise<ReviewerDispatchResult> {
    if (!this.hasReviewer()) {
      return {
        verdict: { level: "high", reason: "reviewer not wired — fail-safe defer" },
        cacheReason: "miss-not-found",
      };
    }
    const classifier = this.reviewerClassifier!;
    const cache = this.verdictCache!;
    const queue = this.deferredQueue!;
    const cacheIdentityInput = input.cacheIdentityInput ?? input.finalInput;

    const lookupKey = {
      toolName,
      source: input.source,
      category: input.category,
      pathFields: input.pathFields,
      trustOrigin: input.trustOrigin,
      approvalCacheKey: input.approvalCacheKey,
      conversationContext: input.conversationContext,
      finalInput: cacheIdentityInput,
      // Issue #664 P1 — sandbox-write attestation participates in cache
      // identity. A future change to the owning plugin's sandbox root
      // (e.g. plugin renamed/reinstalled) invalidates stale verdicts.
      writesToOwnSandbox: input.writesToOwnSandbox,
      ownerPluginSandboxRoot: input.ownerPluginSandboxRoot,
      mcpServerId: input.mcpServerId,
      pluginId: input.pluginId,
      workerId: input.workerId,
    };
    // ── User-approval memory hit ──────────────────────────────────────────
    // Check the user-approval store before consulting the LLM classifier.
    // A memory hit for a non-revoked approval bypasses the LLM call and
    // returns the rule-based verdict directly (composition rule still
    // applies — sandbox/context quality can only raise, not lower).
    // HIGH-verdict approvals are intentionally included: if the user already
    // justified a HIGH action this session, re-running the LLM is wasteful.
    const userApproval = await lookupApproval(
      toolName,
      canonicalStringify(cacheIdentityInput),
      input.source,
      input.trustOrigin,
      input.approvalCacheKey,
    ).catch(() => null); // storage failure must not block tool execution

    const readSandboxCacheState = (): ReviewerSandboxCacheState =>
      resolveReviewerSandboxCacheState(
        input.source,
        toolName,
        input.mcpServerId,
        input.workerId,
        input.pluginId,
      );
    const buildCacheContext = (sandboxCacheState: ReviewerSandboxCacheState) => {
      const sandboxScope = sandboxCacheState.capability;
      return {
        allowedDirectories: input.allowedDirectories,
        scope: {
          ...(routineScope ?? {}),
          reviewer: this.reviewerCacheScope,
          sandboxKind: sandboxScope.kind,
          sandboxConfidence: sandboxScope.confidence,
        },
        sandboxWrapState: sandboxCacheState,
      };
    };

    // Include the sandbox capability in the cache scope so a change to OS
    // isolation invalidates stale verdicts produced under different sandbox
    // assumptions. Capture this live state immediately before cache lookup:
    // no await may sit between wrap-state sampling and cache lookup, or a
    // worker un-wrap could replay a verdict relaxed under stale confinement.
    const sandboxCacheState = readSandboxCacheState();
    const cacheCtx = buildCacheContext(sandboxCacheState);
    const cacheResult = cache.lookup(lookupKey, cacheCtx);
    let verdict: RiskVerdict;
    let ruleVerdictForAudit: RiskVerdict["level"] | null = null;
    let llmVerdictForAudit: RiskVerdict["level"] | null = null;
    let userApprovalUsed: {
      memoryHit: boolean;
      nlJustification: string | null;
      verdictAtApproval: UserApprovalVerdict | null;
    } | null = null;
    let sandboxStateForAudit = sandboxCacheState;
    const buildReviewerContext = (
      reviewerSandboxState: ReviewerSandboxCacheState = sandboxCacheState,
    ): ToolInvocationContext => ({
      toolName,
      source: input.source,
      category: input.category,
      pathFields: input.pathFields,
      trustOrigin: input.trustOrigin,
      finalInput: input.finalInput,
      allowedDirectories: input.allowedDirectories,
      sensitivePathsAdjacent: input.sensitivePathsAdjacent,
      // Substrate-aware (NOT process-global): only the ASRT-wrapped host-shell
      // path may present `asrt` to the reviewer. plugin/MCP (unwrapped worker)
      // and in-process builtins resolve to `none` so isWeakSandbox stays weak
      // and the LLM cannot downgrade a MEDIUM/HIGH verdict for an unsandboxed
      // effect — except a genuinely ASRT-wrapped external MCP worker
      // (keyed on input.mcpServerId) or plugin worker (keyed on
      // input.pluginId/input.workerId). See the resolver invariant.
      sandboxCapability: reviewerSandboxState.capability,
      ...(input.conversationContext ? { conversationContext: input.conversationContext } : {}),
      ...(input.writesToOwnSandbox !== undefined
        ? { writesToOwnSandbox: input.writesToOwnSandbox }
        : {}),
      ...(input.ownerPluginSandboxRoot !== undefined
        ? { ownerPluginSandboxRoot: input.ownerPluginSandboxRoot }
        : {}),
    });

    // Cross-cutting root-cause fix: a legacy user-approval entry may carry
    // `null verdictAtApproval` (the field was added in the user-approval-store
    // wiring; entries written before that change pre-date it). A legacy null
    // means "the original verdict is unrecoverable" — NOT "medium".
    // Treat the memory hit as missing → fresh approval flow takes
    // over. This protects two invariants:
    //   (a) maxVerdict() below would otherwise receive null and
    //       silently treat it as the rule verdict (downgrade risk).
    //   (b) UserApprovalHitPayload broadcast is non-null per SOT —
    //       a coerce to "medium" would mis-represent unknown origin
    //       as a real medium-risk approval in the user's audit toast.
    // Fail-closed: re-prompt is the correct UX when verdict
    // provenance is lost.
    if (userApproval && userApproval.verdictAtApproval == null) {
      // Structured marker as 2nd arg keeps tests stable across i18n /
      // wording changes (cluster review S-Med-1 + C-Med-4). The
      // human-readable first arg stays for existing log readers.
      console.warn(
        `[permission] legacy entry without verdictAtApproval — rejecting memory hit, forcing fresh approval (tool=${toolName}, scope=${userApproval.scope})`,
        { event: "legacy-null-verdict", toolName, scope: userApproval.scope },
      );
    }
    if (userApproval && userApproval.verdictAtApproval != null) {
      // Memory hit — use the rule-based verdict (cheaper + consistent).
      // We still run the rule classifier to get a fresh verdict; we just
      // skip the LLM call. The max(rule, stored) composition would allow
      // the LLM to downgrade — rule-only is the safe choice here.
      const ctx = buildReviewerContext();
      // Use the rule-based classifier for fast sync classification (no LLM call).
      // Take max(ruleVerdict, verdictAtApproval) so a stored HIGH approval cannot
      // be silently downgraded if the rule classifier now returns LOW/MEDIUM.
      const ruleClassifier = new RuleBasedRiskClassifier();
      const ruleVerdict = ruleClassifier.classify(ctx);
      ruleVerdictForAudit = ruleVerdict.level;
      // Narrowed above: the outer `userApproval.verdictAtApproval != null`
      // gate guarantees a concrete verdict literal here.
      const storedLevel: UserApprovalVerdict = userApproval.verdictAtApproval;
      verdict = maxVerdict(ruleVerdict, { level: storedLevel, reason: `stored approval verdict at approval time` });
      userApprovalUsed = {
        memoryHit: true,
        nlJustification: userApproval.nlJustification,
        verdictAtApproval: userApproval.verdictAtApproval,
      };
      // CRITICAL 4.1: disclose memory-hit auto-approve to renderer + log
      console.info(`[permission] memory-hit auto-approve: ${toolName} (scope=${userApproval.scope}, verdict=${userApproval.verdictAtApproval})`);
      try {
        // verdictAtApproval is non-null inside this branch — the outer
        // gate `userApproval.verdictAtApproval != null` rejects legacy
        // entries above. Broadcast passes the concrete literal straight
        // through to UserApprovalHitPayload (non-null per SOT).
        this.broadcastUserApprovalHit?.({
          toolName,
          scope: userApproval.scope,
          verdictAtApproval: storedLevel,
        });
      } catch {
        // broadcast failure must not block tool execution
      }
    } else if (cacheResult.hit && cacheResult.verdict) {
      const ruleClassifier = new RuleBasedRiskClassifier();
      ruleVerdictForAudit = ruleClassifier.classify(buildReviewerContext()).level;
      verdict = cacheResult.verdict;
    } else {
      const ctx = buildReviewerContext();
      try {
        // MAJOR-1: pass abortSignal to LlmRiskClassifier.classify so user
        // cancellation aborts an in-flight LLM call. The RiskClassifier
        // interface is signal-agnostic; LlmRiskClassifier accepts the optional
        // second argument — other classifiers safely ignore extra arguments.
        if (classifier instanceof LlmRiskClassifier) {
          const trace = await classifier.classifyWithTrace(ctx, { abortSignal: options?.abortSignal });
          verdict = trace.finalVerdict;
          ruleVerdictForAudit = trace.ruleVerdict.level;
          llmVerdictForAudit = trace.llmVerdict?.level ?? null;
        } else {
          const classified = classifier.classify(ctx);
          verdict = classified instanceof Promise ? await classified : classified;
          ruleVerdictForAudit = verdict.level;
          llmVerdictForAudit = null;
        }
        const postReviewSandboxState = readSandboxCacheState();
        if (!sameReviewerSandboxCacheState(sandboxCacheState, postReviewSandboxState)) {
          sandboxStateForAudit = postReviewSandboxState;
          const freshRuleVerdict = new RuleBasedRiskClassifier().classify(
            buildReviewerContext(postReviewSandboxState),
          );
          ruleVerdictForAudit = freshRuleVerdict.level;
          verdict = {
            level: "high",
            reason: "reviewer sandbox state changed during classification — fail-safe re-review required",
          };
        } else {
          // Persist for next time (HIGH cached too — re-deny is fast). The
          // verdict is stored only if the live wrap state still matches the
          // reviewer context that produced it.
          await cache.store(lookupKey, cacheCtx, verdict);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        verdict = { level: "high", reason: `reviewer error — ${message}` };
        ruleVerdictForAudit = new RuleBasedRiskClassifier().classify(ctx).level;
        llmVerdictForAudit = classifier instanceof LlmRiskClassifier ? "high" : null;
      }
    }

    // ── S2 audit emit ─────────────────────────────────────────────────────
    // Emit a sandbox audit entry for every dispatchReviewer call so the
    // audit log captures reviewer composition signals + user-approval provenance.
    // Failures are swallowed so audit never blocks tool execution.
    // Record the SUBSTRATE-aware capability used for the final reviewer verdict
    // (not the process-global) so the audit honestly reflects this call's
    // execution substrate.
    const sandboxCap = sandboxStateForAudit.capability;
    const auditEntry = buildSandboxAuditEntry({
      tool: {
        name: toolName,
        // emitSandboxAudit's sink trusts callers to pass DLP-redacted fields.
        args: maskSensitiveData(JSON.stringify(input.finalInput)).masked,
        source: input.source,
        trustOrigin: input.trustOrigin,
        ...(input.approvalCacheKey ? { approvalCacheKey: input.approvalCacheKey } : {}),
      },
      sandbox: {
        kind: sandboxCap.kind,
        confidence: sandboxCap.confidence,
        events: [],
        spawnLatencyMs: 0,
        overheadPercent: 0,
      },
      reviewer: {
        ruleVerdict: ruleVerdictForAudit ?? verdict.level,
        llmVerdict: llmVerdictForAudit,
        finalVerdict: verdict.level,
        compositionRulesTriggered: [],
        userApprovalUsed: userApprovalUsed
          ? {
              ...userApprovalUsed,
              nlJustification:
                userApprovalUsed.nlJustification === null
                  ? null
                  : maskSensitiveData(userApprovalUsed.nlJustification).masked,
            }
          : null,
      },
    });
    emitSandboxAudit(auditEntry).catch(() => {
      // intentionally swallowed — audit failure must not block tool execution
    });

    const deferPolicy = options?.defer ?? "high";
    const shouldDefer =
      deferPolicy === "medium-high"
        ? verdict.level !== "low"
        : deferPolicy === "high"
          ? verdict.level === "high"
          : false;

    if (shouldDefer) {
      const deferredId = await queue.append({
        toolName,
        source: input.source,
        category: input.category,
        inputSummary: summariseInput(input.finalInput),
        ...(input.evaluationContext ? { evaluationContext: input.evaluationContext } : {}),
        verdict,
      });
      return { verdict, cacheReason: cacheResult.reason, deferredId };
    }
    return { verdict, cacheReason: cacheResult.reason };
  }

  // ─── Private ─────────────────────────────────────

  private resolveTrust(_toolName: string, source?: ToolSource): TrustLevel {
    return trustFromSource(source ?? "builtin");
  }

  /**
   * Permission policy Layer 3 — Category × Source × Mode via registry descriptor.
   *
   * The descriptor's `decisionFor()` returns one of:
   *   - "allow"    → permitted (with audit)
   *   - "ask"      → ApprovalGate round-trip
   *   - "deny"     → refused (used by future restricted categories)
   *   - "reviewer" → defer to reviewer agent (headless lane)
   *   - "override" → meta category — caller reads tool.decisionOverride
   *
   * The reviewer agent IS wired (default mode "llm", degrading to the rule
   * classifier when no provider is configured — see reviewer-wiring.ts). It
   * acts as a BACKGROUND adjudicator, not a modal text-filler:
   *   - headless lane: "reviewer" routes to dispatchReviewer (defer policy
   *     queues HIGH verdicts);
   *   - foreground lane: when `interactive.autoApprove === "low"` (the
   *     default), mutating tools are stamped `reviewer.route =
   *     "foreground-auto"` and the executor's
   *     dispatchReviewerForInteractiveAuto auto-allows LOW verdicts with
   *     audit only — MEDIUM/HIGH return a blocked tool result containing
   *     the reviewer verdict, so the main LLM can ask the user and retry
   *     only when the user explicitly authorizes that exact action.
   * When the reviewer is unavailable, "reviewer" maps to "ask" so the user
   * is prompted instead of silently permitting a headless write — fail-safe
   * per design §1 principles.
   *
   * MCP (trust: low) tools are asked in default/auto modes regardless of
   * category; explicit allow mode is the only mode that bypasses this
   * trust-axis prompt after Layer 0/1 hard gates.
   */
  private categoryBasedDecision(
    trust: TrustLevel,
    category: ToolCategory,
    context: PermissionCheckContext,
  ): PermissionCheckResult {
    // strict 모드: 모든 것 ask (read 포함)
    if (this.mode === "strict") {
      return {
        decision: "ask",
        reason: t("be_permissionManager.strictModeReason", { trust, category }),
        layer: 6,
      };
    }

    // allow mode: explicit user opt-in to allow every non-hard-blocked tool.
    // Layer 0 sensitive paths, Layer 1 allowed-directory checks, deny rules,
    // and overlay-trigger mutation guards run before this point.
    if (this.mode === "allow") {
      return {
        decision: "allow",
        reason: t("be_permissionManager.allowAllModeReason", { trust, category }),
        layer: 6,
      };
    }

    // LOW trust (MCP): 항상 ask — manifest integrity guard 가 없는 동안 trust override
    if (trust === "low") {
      return {
        decision: "ask",
        reason: t("be_permissionManager.mcpLowTrustForced", { category }),
        layer: 6,
      };
    }

    const descriptor = getToolCategoryDescriptor(category);
    const decision = descriptor.decisionFor({
      mode: this.mode,
      source: trust === "high" ? "builtin" : "plugin",
      headless: context.headless === true,
    });

    switch (decision) {
      case "allow":
        return {
          decision: "allow",
          reason: t("be_permissionManager.modeAllowReason", { mode: this.mode, category, trust }),
          layer: 6,
        };
      case "deny":
        return {
          decision: "deny",
          reason: t("be_permissionManager.policyDenyReason", { category }),
          layer: 6,
        };
      case "reviewer":
        // Permission policy P3 — when the reviewer is wired, the executor
        // dispatches via {@link dispatchReviewer} synchronously
        // before invoking the tool. categoryBasedDecision still
        // returns "ask" so the executor can perform the async reviewer
        // dispatch at the single choke point. If reviewer wiring is absent,
        // the executor fails closed. The "reviewer" decision is the signal
        // to consult dispatchReviewer; categoryBasedDecision can't
        // do it directly because it isn't async.
        if (this.hasReviewer()) {
          return {
            decision: "ask",
            reason: t("be_permissionManager.headlessReviewerRouted", { category }),
            layer: 6,
            reviewer: { route: "headless" },
          };
        }
        return {
          decision: "ask",
          reason: t("be_permissionManager.headlessReviewerAbsent", { category }),
          layer: 6,
          reviewer: { route: "headless" },
        };
      case "override":
        // meta category — returns `allow` (the registry override sentinel).
        // The per-invocation `decisionOverride="ask"` re-elevation is handled
        // by the post-computation guard at the bottom of `checkDetailed`, which
        // is layer-agnostic (covers layer-3 allow-rule and layer-5 alwaysAllowed
        // hits too, not just this branch). See the post-guard comment there.
        return {
          decision: "allow",
          reason: t("be_permissionManager.metaToolDecisionOverride", { category }),
          layer: 6,
        };
      case "ask":
      default: {
        // Issue #690 — foreground reviewer auto-approve gating.
        //
        // Round-1 critic MAJOR-2: `interactive.autoApprove` is the SOT
        // for foreground-auto opt-in. The legacy `auto` exec mode is no
        // longer a standalone opt-in — it must be paired with an
        // explicit `interactive` setting. The PermissionsTab UI couples
        // both flips so selecting `auto` in the UI still produces the
        // legacy UX.
        //
        // Reviewer wiring is NOT a gate here — when interactive opts in
        // but the reviewer is not wired,
        // {@link ToolExecutor.dispatchReviewerForInteractiveAuto}
        // returns a clear "reviewer unavailable" ask, preserving the
        // pre-PR fail-safe behaviour.
        const mutating = category === "write" || category === "shell" || category === "network";
        const interactiveOptIn = this.interactiveAutoApprove !== "off";
        const enableForegroundAutoReviewer =
          context.headless !== true && mutating && interactiveOptIn;
        return {
          decision: "ask",
          reason: t("be_permissionManager.userConfirmRequired", { category, trust }),
          layer: 6,
          ...(enableForegroundAutoReviewer
            ? { reviewer: { route: "foreground-auto" as const } }
            : {}),
        };
      }
    }
  }
}

// ─── Helpers ────────────────────────────────────────

// ── P2 graduated grant tier helpers ──────────────────
const TIER_RANK: Record<GrantTier, number> = { read: 0, write: 1 };

/** Ordinal rank of a grant tier (read=0 < write=1). */
export function tierRank(tier: GrantTier): number {
  return TIER_RANK[tier];
}

/**
 * The grant tier a category requires to be auto-allowed by a prior
 * "Allow always" grant. `read` → read-tier; `write`/`shell`/`network`/`meta`
 * → write-tier. `meta` deliberately requires write so that a read-tier grant
 * cannot silently short-circuit a meta tool (e.g. agent_spawn).
 *
 * This is the single source of truth for the category→tier mapping; the
 * executor imports it when stamping the tier onto a new grant so the grant-time
 * tier and the check-time coverage predicate can never diverge.
 */
export function requiredTier(category: ToolCategory): GrantTier {
  return category === "read" ? "read" : "write";
}

/**
 * Does a `granted` tier cover an invocation of `category`? A write grant covers
 * every category; a read grant covers only read invocations.
 */
export function grantCovers(granted: GrantTier, category: ToolCategory): boolean {
  return tierRank(granted) >= tierRank(requiredTier(category));
}

/**
 * External-boundary normalization for a persisted `tier` field. permissions.json
 * is a user-editable file; an absent or corrupt `tier` denotes a legacy /
 * untiered grant, which grandfathers to write-tier (most permissive — preserves
 * the user's saved "Allow always"). Normalizing to read-tier instead would
 * silently break saved grants (weakening) and is forbidden. This is the only
 * sanctioned fallback in P2 — it lives at the file boundary, not between
 * internal callers.
 */
export function normalizeTier(tier: unknown): GrantTier {
  return tier === "read" ? "read" : "write";
}

/** Monotone merge — the higher-ranked of two tiers (undefined = take `b`). */
function maxTier(a: GrantTier | undefined, b: GrantTier): GrantTier {
  if (a === undefined) return b;
  return tierRank(a) >= tierRank(b) ? a : b;
}

function normalizeApprovalCacheKey(key: string | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Permission policy P3 — render a deferred-queue-friendly summary of `finalInput`.
 * Caller is expected to have already DLP-redacted; this is a pure
 * length-cap so the queue file stays manageable. Keys are sorted for
 * deterministic display.
 */
function summariseInput(input: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(input).sort()) sorted[k] = input[k];
  const json = JSON.stringify(sorted);
  return json.length > 240 ? json.slice(0, 240) + "…" : json;
}

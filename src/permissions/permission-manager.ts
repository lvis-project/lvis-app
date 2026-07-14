



import { resolve } from "node:path";
import type { DenyRule, ToolCategory, ToolSource, ToolTrustOrigin, TrustLevel } from "../tools/types.js";
import { trustFromSource } from "../tools/types.js";
import { readPermissionsFile, updatePermissionsFile } from "./permissions-store.js";
import type { ReviewerInteractiveAutoApprove } from "./permission-settings-store.js";
import { isStagedTurnOrigin } from "../shared/mcp-app-message-source.js";
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
import {
  isSensitivePath,
  canonicalizePathForMatch,
  caseFoldForMatch,
} from "./sensitive-paths.js";
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

/**
 * #1494 item-4 — a single path-scoped "Allow always" grant pruned by
 * {@link PermissionManager.prunePathGrantsUnderRoot}. Returned so the caller
 * (workspace.removeRoot) can write a redacted per-pattern audit tuple instead of
 * only a count. `path` is the RAW extracted grant path (unredacted) — the caller
 * is responsible for `redactFsPath`-ing it before it reaches the audit log; it
 * never crosses the IPC boundary to the renderer.
 */
export interface PrunedGrant {
  /** The full persisted rule pattern, e.g. `write_file:path:/abs/target`. */
  pattern: string;
  /** Tool-name prefix of the grant (`write_file`), or the whole pattern if the
   * marker split is unexpectedly absent (defensive — should not happen). */
  toolName: string;
  /** Graduated grant tier at prune time (legacy/absent → grandfathered write). */
  tier: GrantTier;
  /** Raw absolute path the grant targeted (UNREDACTED — caller must redact). */
  path: string;
}

export interface PermissionRule {

  pattern: string;

  action: "allow" | "deny";

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
 * `foreground-auto` (interactive auto-review opt-in — verdicts through the
 * configured inclusive threshold allow, higher verdicts ask). Shared by
 * the `reviewer.route` marker and the reviewer-dispatch callsites so the lane
 * union has a single source of truth.
 */
export type ReviewerLane = "foreground-auto" | "headless";

export interface PermissionCheckResult {
  decision: PermissionDecision;
  reason: string;
  layer: number;
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
   * explicit-approval memory store (Store B). Policy sets it only after choosing
   * a hard user-approval lane; `decisionOverride: "ask"` may instead use the
   * common foreground reviewer route when that route is eligible.
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
   * from the executor so the post-computation guard owns re-elevation (V1 SOT).
   * A foreground `"ask"` meta invocation uses the same reviewer route as
   * write/shell/network when interactive auto-review is enabled; otherwise it
   * remains a per-invocation `forceModal` ask. `"always-allow-with-audit"` is
   * short-circuited before checkDetailed runs. Non-meta callers pass
   * `undefined`.
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
   * Issue #664 P1 — owning plugin's sandbox root (`~/.lvis/plugins/<pluginId>/`).
   * Computed HOST-side by the executor when the tool descriptor carries
   * `pluginId` and threaded here for the sandbox-write auto-LOW rule. #885 v6
   * (Q4): the manifest `writesToOwnSandbox` self-attestation that used to
   * accompany it is REMOVED — the auto-LOW keys solely on this host-computed
   * root + host-verified path containment.
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

  private readonly toolModeOverrides = new Map<string, ExecutionMode>();

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
   * Issue #690 — interactive auto-approve setting. "low"/"medium" are auto-mode
   * foreground reviewer thresholds that skip the approval modal for LOW /
   * LOW+MEDIUM respectively. Read by {@link categoryBasedDecision} to
   * decide whether to set `reviewer.route='foreground-auto'`.
   */
  private interactiveAutoApprove: ReviewerInteractiveAutoApprove = "off";
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
   *  - foreground-auto lane: verdicts up to the configured threshold allow; the rest ask.
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
    const isForegroundAutoApproved =
      isLow ||
      (verdict.level === "medium" && this.interactiveAutoApprove === "medium");
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
    if (isForegroundAutoApproved) {
      return {
        decision: "allow",
        reason: `reviewer ${verdict.level}: ${verdict.reason}`,
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
  setInteractiveAutoApprove(autoApprove: ReviewerInteractiveAutoApprove): void {
    this.interactiveAutoApprove = autoApprove;
  }

  getInteractiveAutoApprove(): ReviewerInteractiveAutoApprove {
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

  // ─── Settings ─────────────────────────────────────

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

  // ─── Persistent Rule Management ─────────────────────────

  /**
   * Add a tool-name pattern as a persistent allow rule.
   * Update the in-memory allow cache only after permissions.json is persisted.
   *
   * P2 — `tier` records how broadly the grant applies. It defaults to `"write"`
   * so the non-executor callers (slash `/allow`, the PermissionsTab addRule IPC)
   * keep their category-blind grant (grandfather). The executor passes
   * {@link requiredTier}(invocationCategory) so a grant made on a read tool is
   * read-tier. Re-granting is monotone: the tier is only ever upgraded (read→
   * write), never downgraded — a downgrade must go through {@link removeRule}.
   */
  async addAlwaysAllowedPersist(pattern: string, tier: GrantTier = "write"): Promise<void> {
    // Persisted rule list: add or upgrade allow rules while preserving monotone tiers.
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
    // In-memory cache is updated only after the durable write succeeds.
    // maxTier keeps the invariant that the Map holds the highest granted tier.
    this.alwaysAllowed.set(pattern, maxTier(this.alwaysAllowed.get(pattern), tier));
    this.broadcastConfigChanged?.();
    // Cluster review M1 — rule change aborts outstanding bearers so plugins
    // re-resolve their keys under the new policy. An allow rule going wider
    // is benign but still needs the next bearer to reflect the new state.
    this.revokeAllPluginAccess(`allow-rule-added:${pattern}`);
  }

   /**
   * Add a tool-name pattern as a persistent deny rule.
   * Update the in-memory rules array and permissions.json together.
   */
  async addAlwaysDeniedPersist(pattern: string): Promise<void> {
    // In-memory: insert at the front of the rules array so deny has priority.
    const exists = this.rules.some(
      (r) => r.action === "deny" && r.pattern === pattern && !r.source,
    );
    if (!exists) {
      this.rules.unshift({ pattern, action: "deny" });
    }
    // Persistent file.
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
   * Remove a persistent rule by pattern and action.
   */
  async removeRule(pattern: string, action: "allow" | "deny"): Promise<void> {
    // In-memory.
    this.rules = this.rules.filter(
      (r) => !(r.pattern === pattern && r.action === action && !r.source),
    );
    if (action === "allow") this.alwaysAllowed.delete(pattern);
    // Persistent file.
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
   * #1493 — prune path-scoped "Allow always" grants that live strictly under a
   * removed workspace root.
   *
   * A grant made on a path-bearing tool (write_file / edit_file / …) is
   * persisted with a pattern of the form `<toolName>:path:<absPath>` (see
   * `approvalCacheKeyFor` + file-tools `approvalCacheKey`). `additionalDirectories`
   * (the read allow-list) and `rules[].tier` (the graduated grants) are two
   * INDEPENDENT grant surfaces: removing a workspace root shrinks the former but
   * leaves the latter's path grants orphaned. On the SAME root being re-added
   * they would silently revive, re-authorizing writes the user thought they had
   * revoked. This closes that gap by revoking every allow rule whose pattern
   * targets the removed root itself or a path under it, in a single file rewrite.
   *
   * Matching is canonical/case-folded via the SAME helpers the sensitive-path
   * and workspace scope guards use, so a trailing slash, `..`, symlink, or case
   * variant of the stored path still resolves under the root. The root entry is
   * inclusive: otherwise an exact-root grant can silently revive when the same
   * workspace is registered again. Separately registered descendant roots are
   * carved out through `preserveRoots` below.
   *
   * Non-path allow rules (plain tool-name globs like `web_fetch`) and deny rules
   * are never touched.
   *
   * #1494 item-4 (forensics): returns the pruned grants as {@link PrunedGrant}
   * tuples — `{ pattern, toolName, tier, path }` — so the caller
   * (workspace.removeRoot) can audit redacted per-pattern provenance, not just a
   * count. The count stays derivable (`result.length`); the IPC response shape is
   * UNCHANGED (renderer still receives a bare `prunedGrants` number — the pattern
   * list is audit-only and never crosses the IPC boundary).
   *
   * #1494 item-5 (store-time form): grants are persisted in raw `pathResolve`
   * form (file-tools `resolveApprovalPath`) while this prune canonicalizes via
   * `canonicalizePathForMatch` (realpath + NFC). Rather than move realpath into
   * the synchronous approval hot path (which would also silently invalidate every
   * existing user's raw-form grant), the prune does a belt-and-braces DUAL-FORM
   * compare: a stored grant is under the root if EITHER its canonical form OR its
   * raw `pathResolve` form is a strict descendant of the correspondingly-formed
   * root. This catches grants stored before AND after any future canonicalization
   * change with zero hot-path cost. See the commit body for the full rationale.
   */
  async prunePathGrantsUnderRoot(
    root: string,
    options?: { preserveRoots?: readonly string[] },
  ): Promise<PrunedGrant[]> {
    // Dual-form roots (item-5): canonical (realpath'd) and raw (pathResolve only).
    const rootCanon = caseFoldForMatch(canonicalizePathForMatch(root));
    const rootRaw = caseFoldForMatch(resolve(root).replace(/\\/g, "/"));
    const preservedRoots = (options?.preserveRoots ?? []).flatMap((preserveRoot) => {
      try {
        const canonical = caseFoldForMatch(canonicalizePathForMatch(preserveRoot));
        const raw = caseFoldForMatch(resolve(preserveRoot).replace(/\\/g, "/"));
        // Only a genuine descendant may carve a hole in the removed root.
        // Ignoring the root itself and unrelated paths prevents a malformed
        // caller option from accidentally preserving the whole revoked scope.
        if (
          !isStrictPathDescendant(rootCanon, canonical)
          && !isStrictPathDescendant(rootRaw, raw)
        ) {
          return [];
        }
        return [{ canonical, raw }];
      } catch {
        return [];
      }
    });
    const isUnderRoot = (pattern: string): boolean => {
      const target = extractGrantPath(pattern);
      if (target === null) return false;
      // A grant matches if EITHER form equals the root or places it under the root. The two
      // forms are compared like-for-like (canonical↔canonical, raw↔raw) so a
      // realpath'd stored grant and a raw stored grant are both caught.
      // isStrictPathDescendant folds case defensively (item-7), so passing the
      // already-folded strings is safe + idempotent.
      const targetCanon = caseFoldForMatch(canonicalizePathForMatch(target));
      const targetRaw = caseFoldForMatch(resolve(target).replace(/\\/g, "/"));
      const covered = targetCanon === rootCanon
        || targetRaw === rootRaw
        || isStrictPathDescendant(rootCanon, targetCanon)
        || isStrictPathDescendant(rootRaw, targetRaw);
      if (!covered) return false;
      const preserved = preservedRoots.some(
        (preserveRoot) => targetCanon === preserveRoot.canonical
          || isStrictPathDescendant(preserveRoot.canonical, targetCanon)
          || targetRaw === preserveRoot.raw
          || isStrictPathDescendant(preserveRoot.raw, targetRaw),
      );
      return !preserved;
    };

    // The persisted file is the SOT for path grants: addAlwaysAllowedPersist
    // writes the allow rule to the file + the in-memory alwaysAllowed Map, but
    // NOT to `this.rules` (that array is only hydrated from the file at boot via
    // loadRulesFromFile). Scan the file, not `this.rules`, so a grant made this
    // session is still pruned. Do the read + filter inside ONE
    // updatePermissionsFile pass (atomic under the store lock) and collect the
    // pruned grants so in-memory state (rules + alwaysAllowed) is reconciled and
    // the caller can audit per-pattern tuples.
    const pruned: PrunedGrant[] = [];
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      file.rules = file.rules.filter((r) => {
        if (r.action === "allow" && !r.source && isUnderRoot(r.pattern)) {
          pruned.push(describePrunedGrant(r.pattern, r.tier));
          return false;
        }
        return true;
      });
    });
    if (pruned.length === 0) return [];

    // Reconcile in-memory caches with the persisted shrink (a boot-hydrated rule
    // or a same-session Map entry for the pruned pattern must also drop).
    const prunedPatterns = new Set(pruned.map((p) => p.pattern));
    this.rules = this.rules.filter(
      (r) => !(r.action === "allow" && !r.source && prunedPatterns.has(r.pattern)),
    );
    for (const pattern of prunedPatterns) this.alwaysAllowed.delete(pattern);

    this.broadcastConfigChanged?.();
    // A revoke narrows policy — outstanding bearers must re-resolve under it.
    this.revokeAllPluginAccess(`root-removed-prune:${root}`);
    return pruned;
  }

  /**
   * Called during app boot. Merges permissions.json into memory.
   * Missing file is a normal no-op.
   */
  async loadRulesFromFile(): Promise<void> {
    const file = await readPermissionsFile(this.permissionsFilePath);
    if (!file) return;

    // Sync mode.
    if (file.mode) this.mode = file.mode;

    // Merge rules: add file rules after existing in-memory rules, deduplicated.
    for (const rule of file.rules) {
      const dup = this.rules.some(
        (r) => r.pattern === rule.pattern && r.action === rule.action && r.source === rule.source,
      );
      if (!dup) {
        if (rule.action === "deny") {
          this.rules.unshift(rule); // deny has highest priority.
        } else {
          this.rules.push(rule);
          // Reflect allow rules in the alwaysAllowed Map as well (P2: preserve tier).
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
   * Return the rule list stored in permissions.json for the Settings UI.
   * Missing file returns an empty array.
   */
  async listPersistedRules(): Promise<PermissionRule[]> {
    const file = await readPermissionsFile(this.permissionsFilePath);
    return file?.rules ?? [];
  }

  /**
   * Persist mode to permissions.json before updating in-memory state.
   * The caller appends the audit entry first, so if saving fails the runtime
   * mode must not change either.
   */
  async setModePersist(mode: ExecutionMode): Promise<void> {
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      file.mode = mode;
    });
    this.mode = mode;
  }

  // ─── Decision (§4.1) ──────────────────────────────

  /**
   * Detailed decision with an audit-log reason.
   *
   * When `overlayTriggerOrigin` is a STAGED turn origin — a plugin overlay trigger
   * (`"overlay:meeting-detection"`) or an MCP App's `ui/message` (`"app:<serverId>"`) —
   * every foreground-authority call (write/shell/network plus meta with
   * `decisionOverride: "ask"`) is forced to `ask` regardless of user permanent
   * approval (`allow-always`), config allow rules, or auto mode.
   * This hard gate prevents staged, non-user-authored input from automatically running
   * authority-bearing work without user confirmation, pairing with the first-pass
   * LLM review from `<overlay-trigger-origin-guidance>`. Other calls are unaffected.
   * The set of staged origins has ONE definition — `isStagedTurnOrigin` — so a new one
   * can never be added while quietly skipping this gate.
   *
   * Permission policy — 5-axis category model. Layer 3 decisionFor() replaces
   * the old trust-default branch. `meta` category descriptors return `"override"`,
   * so callers route through the executor's decisionOverride branch.
   */
  checkDetailed(
    toolName: string,
    source: ToolSource,
    category: ToolCategory,
    overlayTriggerOrigin?: string | null,
    context: PermissionCheckContext = {},
  ): PermissionCheckResult {
    const trust = this.resolveTrust(toolName, source);
    // Strict patterns (shared with the rest of the staged-origin flow — see
    // shared/overlay-trigger-source.ts + shared/mcp-app-message-source.ts). Loose
    // `startsWith` would accept malformed values like "overlay:Bad/Path" or "app:" that
    // no upstream gate emits but a future hand-injected codepath might; fail-closed on
    // malformed input.
    const isOverlayTrigger = isStagedTurnOrigin(overlayTriggerOrigin ?? null);
    const resolvedCategory: ToolCategory = category;
    const isMutating =
      resolvedCategory === "write" ||
      resolvedCategory === "shell" ||
      resolvedCategory === "network";
    const isForegroundAuthorityReviewEligible =
      this.isForegroundAuthorityReviewEligible(resolvedCategory, context);

    const approvalCacheKey = normalizeApprovalCacheKey(context.approvalCacheKey);
    const denyTargets = approvalCacheKey ? [toolName, approvalCacheKey] : [toolName];
    const allowTarget = approvalCacheKey ?? toolName;

    // 1. Deny rules (highest priority, immutable)
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

    // Overlay-trigger origin override — every foreground authority-review tool
    // bypasses cached allows and reviewer auto-approval, then asks the user.
    // Read tools may still run automatically.
    if (isOverlayTrigger && isForegroundAuthorityReviewEligible) {
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

    // 5. Always-allowed (previous user approval)
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
    // A meta builtin that declares `decisionOverride: "ask"` must never inherit
    // an unconditional allow from layers 3/5/6. The layer-agnostic post-guard
    // routes foreground calls through the same reviewer lane used by
    // write/shell/network when interactive auto-review is enabled. Otherwise it
    // retains the per-invocation force-modal contract.
    //
    //   layer 3 (allow rule)    — user added agent_spawn to their allow-list
    //   layer 5 (alwaysAllowed) — user clicked "Allow always" on the modal
    //   layer 6 (override case) — the normal first-invocation path
    //
    // Allow-all remains the sole exception: it is the user's explicit global
    // opt-in and still covers every non-hard-blocked tool.
    //
    // Strict mode: already returned ask at layer 2 before this point, so
    // `result.decision` is never `allow` under strict and the guard never fires.
    if (
      result.decision === "allow" &&
      context.decisionOverride === "ask" &&
      this.mode !== "allow"
    ) {
      const foregroundReviewer = this.shouldRouteForegroundReviewer(
        resolvedCategory,
        context,
      );
      return {
        decision: "ask",
        reason: t("be_executor.metaToolAskOverrideReason"),
        layer: 6,
        ...(foregroundReviewer
          ? { reviewer: { route: "foreground-auto" as const } }
          : { forceModal: true }),
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
      // Issue #664 P1 — the owning plugin's sandbox root participates in cache
      // identity. A future change (plugin renamed/reinstalled) invalidates the
      // auto-LOW verdict that now DEPENDS on it. #885 v6: the untrusted
      // `writesToOwnSandbox` self-claim no longer participates (§5.4).
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

  private isForegroundAuthorityReviewEligible(
    category: ToolCategory,
    context: PermissionCheckContext,
  ): boolean {
    return (
      category === "write" ||
      category === "shell" ||
      category === "network" ||
      (category === "meta" && context.decisionOverride === "ask")
    );
  }

  private shouldRouteForegroundReviewer(
    category: ToolCategory,
    context: PermissionCheckContext,
  ): boolean {
    return (
      this.mode === "auto" &&
      context.headless !== true &&
      this.isForegroundAuthorityReviewEligible(category, context) &&
      this.interactiveAutoApprove !== "off"
    );
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
   *   - foreground lane: in `mode="auto"`, an enabled inclusive threshold stamps eligible
   *     write/shell/network and decisionOverride:"ask" meta calls with
   *     `reviewer.route = "foreground-auto"`. The executor auto-allows
   *     verdicts through the configured threshold with audit; higher verdicts
   *     ask the user. The default persisted threshold is MEDIUM.
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
    // Strict mode: ask for everything, including reads.
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

    // LOW trust (MCP): always ask until the manifest integrity guard exists.
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
        const enableForegroundAutoReviewer = this.shouldRouteForegroundReviewer(
          category,
          context,
        );
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

// ── #1493 path-grant prune helpers ───────────────────
/**
 * The marker `approvalCacheKeyFor` + the single-path file tools (`write_file`,
 * `edit_file`, `apply_patch`, `delete_file`) use to embed a resolved path in a
 * persisted grant pattern: `<toolName>:path:<absPath>`. Splitting on the FIRST
 * occurrence is Windows-safe — the tool name never contains `:path:`, and the
 * `<absPath>` tail keeps its own drive-letter colon (`C:\…`) intact.
 *
 * INTENTIONAL SCOPE — `move_file` is NOT covered. MoveFileTool.approvalCacheKey
 * emits a `source:<abs>:destination:<abs>` pattern (two paths, no `:path:`
 * marker — see `src/tools/file-tools.ts` MoveFileTool), so
 * {@link extractGrantPath} returns null for it and a move grant is never pruned
 * by {@link PermissionManager.prunePathGrantsUnderRoot}. This is deliberate: a
 * move straddles two paths (potentially two different roots), so "does this
 * grant live under the removed root?" has no single-path answer. Move grants are
 * left intact on root removal (they are rare and category-`write`, so they still
 * re-prompt via the tier gate for any path the read-list no longer covers). If a
 * future change wants move grants pruned, it must decide the source-vs-destination
 * semantics explicitly rather than silently widening this marker.
 */
const GRANT_PATH_MARKER = ":path:";

/**
 * Extract the absolute path a path-scoped grant pattern targets, or `null` when
 * the pattern is not a path grant. Returns null for plain tool-name globs
 * (`web_fetch`) AND for `move_file`'s `source:…:destination:…` pattern (see
 * {@link GRANT_PATH_MARKER} — move grants are intentionally out of prune scope).
 */
export function extractGrantPath(pattern: string): string | null {
  const idx = pattern.indexOf(GRANT_PATH_MARKER);
  if (idx < 0) return null;
  const tail = pattern.slice(idx + GRANT_PATH_MARKER.length);
  return tail.length > 0 ? tail : null;
}

/**
 * #1494 item-4 — decompose a pruned grant pattern into an auditable tuple. The
 * tool-name is the prefix before {@link GRANT_PATH_MARKER}; the path is the tail
 * (already validated non-null by the prune's `isUnderRoot` guard, but fall back
 * to the whole pattern defensively). Only called on patterns that
 * {@link extractGrantPath} returned non-null for.
 */
function describePrunedGrant(pattern: string, tier: GrantTier | undefined): PrunedGrant {
  const idx = pattern.indexOf(GRANT_PATH_MARKER);
  const toolName = idx > 0 ? pattern.slice(0, idx) : pattern;
  const path = extractGrantPath(pattern) ?? pattern;
  return { pattern, toolName, tier: normalizeTier(tier), path };
}

/**
 * True when `child` is a STRICT descendant of `parent`. Both inputs SHOULD
 * already be canonicalized (realpath'd via {@link canonicalizePathForMatch}) by
 * the caller — this helper does NOT realpath. It DOES fold defensively: slashes
 * are normalized and both sides are run through {@link caseFoldForMatch} so a
 * caller that forgot to case-fold (the previous implicit contract) cannot leak a
 * case-variant descendant past the prefix check on darwin/win32. Case-folding is
 * a cheap string op and idempotent on an already-folded input, so the defensive
 * fold is free for correct callers and closes the footgun for the rest. Equal
 * paths return false (a grant on the root folder itself is not pruned). The
 * trailing-separator guard prevents `/a/foo` from matching under `/a/fo`.
 */
export function isStrictPathDescendant(parent: string, child: string): boolean {
  const foldedParent = caseFoldForMatch(parent.replace(/\\/g, "/"));
  const foldedChild = caseFoldForMatch(child.replace(/\\/g, "/"));
  if (foldedChild === foldedParent) return false;
  const base = foldedParent.endsWith("/") ? foldedParent : `${foldedParent}/`;
  return foldedChild.startsWith(base);
}

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

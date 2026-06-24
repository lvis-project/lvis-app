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
import { detectSandboxCapability } from "./sandbox-capability.js";
import type { PermissionEvaluationContext } from "./evaluation-context.js";
import type { VerdictCache } from "./reviewer/verdict-cache.js";
import type { DeferredQueue } from "./reviewer/deferred-queue.js";
import { globMatch } from "../lib/glob-matcher.js";
import { lvisHome } from "../shared/lvis-home.js";
import { t } from "../i18n/index.js";
import { lookupApproval, canonicalStringify } from "./user-approval-store.js";
import { buildSandboxAuditEntry } from "../audit/sandbox-audit.js";
import { emitSandboxAudit } from "../audit/sandbox-audit-sink.js";

export type PermissionDecision = "allow" | "deny" | "ask";
export type ExecutionMode = "default" | "strict" | "auto" | "allow";

export interface PermissionRule {
  /** 도구 이름 패턴 (glob: "memory_*", "mcp_*", "*") */
  pattern: string;
  /** 허용/차단 */
  action: "allow" | "deny";
  /** 적용 소스 제한 (없으면 전체 적용) */
  source?: ToolSource;
}

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
    route: "foreground-auto" | "headless";
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
// LLM caller retry wiring lives in conversation-loop.ts scope.
// Tracked in follow-up issue for "LLM caller retry wiring" with
// max 2 retry / counter scope / args-change-reset contract.

export class PermissionManager {
  private rules: PermissionRule[] = [];
  private mode: ExecutionMode = "default";
  private readonly alwaysAllowed = new Set<string>();
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
   */
  async addAlwaysAllowedPersist(pattern: string): Promise<void> {
    // 영구: rules 배열에 allow 규칙 추가 (중복 방지)
    await updatePermissionsFile(this.permissionsFilePath, (file) => {
      const exists = file.rules.some(
        (r) => r.action === "allow" && r.pattern === pattern && !r.source,
      );
      if (!exists) {
        file.rules.push({ pattern, action: "allow" });
      }
    });
    // 인메모리: durable write 성공 후 alwaysAllowed Set (checkDetailed layer 5)
    this.alwaysAllowed.add(pattern);
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
          // allow 규칙은 alwaysAllowed Set에도 반영
          if (!rule.source) this.alwaysAllowed.add(rule.pattern);
        }
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
    for (const rule of this.rules) {
      if (rule.action !== "allow") continue;
      if (rule.source && rule.source !== source) continue;
      if (globMatch(allowTarget, rule.pattern)) {
        return { decision: "allow", reason: t("be_permissionManager.allowRuleReason", { pattern: rule.pattern }), layer: 3 };
      }
    }

    // 5. Always-allowed (사용자 이전 승인)
    if (this.alwaysAllowed.has(allowTarget)) {
      return { decision: "allow", reason: t("be_permissionManager.userPermanentApproval"), layer: 5 };
    }

    // 6. Layer 3 — Category × Source × Trust via registry descriptor
    return this.categoryBasedDecision(trust, resolvedCategory, context);
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
    };
    // Include the sandbox capability in the cache scope so a change to OS
    // isolation invalidates stale verdicts produced under different sandbox
    // assumptions. The ASRT sandbox publishes its capability at boot via
    // setActiveSandboxCapability, so detectSandboxCapability() returns the
    // active kind/confidence (falling back to "none" when the sandbox is off).
    const sandboxScope = detectSandboxCapability();
    const cacheCtx = {
      allowedDirectories: input.allowedDirectories,
      scope: {
        ...(routineScope ?? {}),
        reviewer: this.reviewerCacheScope,
        sandboxKind: sandboxScope.kind,
        sandboxConfidence: sandboxScope.confidence,
      },
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

    const cacheResult = cache.lookup(lookupKey, cacheCtx);
    let verdict: RiskVerdict;
    let ruleVerdictForAudit: RiskVerdict["level"] | null = null;
    let llmVerdictForAudit: RiskVerdict["level"] | null = null;
    let userApprovalUsed: {
      memoryHit: boolean;
      nlJustification: string | null;
      verdictAtApproval: UserApprovalVerdict | null;
    } | null = null;
    const buildReviewerContext = (): ToolInvocationContext => ({
      toolName,
      source: input.source,
      category: input.category,
      pathFields: input.pathFields,
      trustOrigin: input.trustOrigin,
      finalInput: input.finalInput,
      allowedDirectories: input.allowedDirectories,
      sensitivePathsAdjacent: input.sensitivePathsAdjacent,
      sandboxCapability: detectSandboxCapability(),
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
        // Persist for next time (HIGH cached too — re-deny is fast).
        await cache.store(lookupKey, cacheCtx, verdict);
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
    const sandboxCap = detectSandboxCapability();
    const auditEntry = buildSandboxAuditEntry({
      tool: {
        name: toolName,
        // args already DLP-redacted by caller (ReviewerDispatchInput.finalInput)
        args: JSON.stringify(input.finalInput),
        source: input.source,
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
        userApprovalUsed,
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
        // meta category — executor handles via tool.decisionOverride
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

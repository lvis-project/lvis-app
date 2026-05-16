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
  /** Captured policy/sandbox context for user review. */
  evaluationContext?: PermissionEvaluationContext;
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

// R-3 RejectResponse interface and MAX_REVIEWER_RETRIES deferred to follow-up.
// The R-3 LLM caller retry wiring lives in conversation-loop.ts scope — outside
// the 17-file boundary of PR-A4. Tracked in follow-up issue for "R-3 LLM caller
// retry wiring" with max 2 retry / counter scope / args-change-reset contract.

export class PermissionManager {
  private rules: PermissionRule[] = [];
  private mode: ExecutionMode = "default";
  private readonly alwaysAllowed = new Set<string>();
  /** Trust 수준 오버라이드 (관리자 설정) */
  private readonly trustOverrides = new Map<string, TrustLevel>();
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
   * Issue #690 — interactive auto-approve setting. "off" by default;
   * "low" means the reviewer's LOW verdict in the foreground flow
   * skips the approval modal. Read by {@link categoryBasedDecision} to
   * decide whether to set `reviewer.route='foreground-auto'`.
   */
  private interactiveAutoApprove: "off" | "low" = "off";
  /** CRITICAL 4.1: optional broadcast for memory-hit auto-approve disclosure */
  private broadcastUserApprovalHit: ((payload: UserApprovalHitPayload) => void) | null = null;

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
  }): void {
    this.reviewerClassifier = deps.classifier;
    this.verdictCache = deps.cache;
    this.deferredQueue = deps.deferredQueue;
    this.reviewerCacheScope = deps.cacheScope ?? {};
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
   * Called once at boot. When set, every R-2 memory hit emits
   * `lvis:permissions:user-approval-hit` to the renderer and a console.info log.
   */
  setBroadcastUserApprovalHit(fn: (payload: UserApprovalHitPayload) => void): void {
    this.broadcastUserApprovalHit = fn;
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

  setTrustOverride(toolName: string, trust: TrustLevel): void {
    this.trustOverrides.set(toolName, trust);
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
        return { decision: "deny", reason: `deny 규칙: ${rule.pattern}`, layer: 1 };
      }
    }

    const toolModeOverride = this.toolModeOverrides.get(toolName);
    if (toolModeOverride === "strict") {
      return { decision: "ask", reason: "MCP 서버 strict 모드", layer: 2 };
    }

    // Overlay-trigger origin override — write/shell/network 도구는 cached
    // allow rules / always-allowed / auto-mode 를 모두 우회하고
    // 항상 사용자 컨펌을 받음. read 는 자동 실행 OK.
    if (isOverlayTrigger && isMutating) {
      return {
        decision: "ask",
        reason: `overlay trigger 출처 (${overlayTriggerOrigin}) — 쓰기 도구는 사용자 컨펌 필수`,
        layer: 2,
      };
    }

    // strict mode is mode-first after immutable deny/overlay-trigger guards:
    // allow rules, always-allowed cache, per-tool overrides, and reviewer
    // automatic approval lanes must not downgrade it.
    if (this.mode === "strict") {
      return {
        decision: "ask",
        reason: `strict 모드 (trust: ${trust}, category: ${resolvedCategory})`,
        layer: 2,
        ...(context.headless === true && isMutating
          ? { reviewer: { route: "headless" as const } }
          : {}),
      };
    }

    if (context.headless === true && isMutating) {
      return this.categoryBasedDecision(toolName, trust, resolvedCategory, context);
    }

    // 3. Allow rules
    for (const rule of this.rules) {
      if (rule.action !== "allow") continue;
      if (rule.source && rule.source !== source) continue;
      if (globMatch(allowTarget, rule.pattern)) {
        return { decision: "allow", reason: `allow 규칙: ${rule.pattern}`, layer: 3 };
      }
    }

    // 5. Always-allowed (사용자 이전 승인)
    if (this.alwaysAllowed.has(allowTarget)) {
      return { decision: "allow", reason: "사용자 영구 승인", layer: 5 };
    }

    // 6. Layer 3 — Category × Source × Trust via registry descriptor
    return this.categoryBasedDecision(toolName, trust, resolvedCategory, context);
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

    const lookupKey = {
      toolName,
      source: input.source,
      category: input.category,
      pathFields: input.pathFields,
      trustOrigin: input.trustOrigin,
      approvalCacheKey: input.approvalCacheKey,
      finalInput: input.finalInput,
    };
    // Round-1 code-reviewer MINOR — include sandbox capability in the
    // cache scope so a future change to OS isolation (bubblewrap on
    // Linux, sandbox-exec on macOS) invalidates stale verdicts that
    // were produced under different sandbox assumptions. Until OS
    // detection lands this is a stable constant, so the scope is
    // unchanged in practice — but the wiring is correct ahead of time.
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

    // ── R-2 user-approval memory hit ─────────────────────────────────────
    // Check the user-approval store before consulting the LLM classifier.
    // A memory hit for a non-revoked approval bypasses the LLM call and
    // returns the rule-based verdict directly (the R-1 composition rule
    // still applies — sandbox/context quality can only raise, not lower).
    // HIGH-verdict approvals are intentionally included: if the user already
    // justified a HIGH action this session, re-running the LLM is wasteful.
    const userApproval = await lookupApproval(
      toolName,
      canonicalStringify(input.finalInput),
      input.source,
      input.trustOrigin,
      input.approvalCacheKey,
    ).catch(() => null); // storage failure must not block tool execution

    const cacheResult = cache.lookup(lookupKey, cacheCtx);
    let verdict: RiskVerdict;
    let userApprovalUsed: {
      memoryHit: boolean;
      nlJustification: string | null;
      verdictAtApproval: UserApprovalVerdict | null;
    } | null = null;

    // Cross-cutting root-cause fix: a legacy R-2 entry may carry
    // `null verdictAtApproval` (PR-A4 R3 added the field; entries
    // written before that PR pre-date it). A legacy null means
    // "the original verdict is unrecoverable" — NOT "medium".
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
      console.warn(
        `[permission] legacy R-2 entry without verdictAtApproval — rejecting memory hit, forcing fresh approval (tool=${toolName}, scope=${userApproval.scope})`,
      );
    }
    if (userApproval && userApproval.verdictAtApproval != null) {
      // Memory hit — use the rule-based verdict (cheaper + consistent).
      // We still run the rule classifier to get a fresh verdict; we just
      // skip the LLM call. The max(rule, stored) composition would allow
      // the LLM to downgrade — rule-only is the safe choice here.
      const ctx: ToolInvocationContext = {
        toolName,
        source: input.source,
        category: input.category,
        pathFields: input.pathFields,
        trustOrigin: input.trustOrigin,
        finalInput: input.finalInput,
        allowedDirectories: input.allowedDirectories,
        sensitivePathsAdjacent: input.sensitivePathsAdjacent,
        sandboxCapability: detectSandboxCapability(),
      };
      // Use the rule-based classifier for fast sync classification (no LLM call).
      // Take max(ruleVerdict, verdictAtApproval) so a stored HIGH approval cannot
      // be silently downgraded if the rule classifier now returns LOW/MEDIUM.
      const ruleClassifier = new RuleBasedRiskClassifier();
      const ruleVerdict = ruleClassifier.classify(ctx);
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
      verdict = cacheResult.verdict;
    } else {
      const ctx: ToolInvocationContext = {
        toolName,
        source: input.source,
        category: input.category,
        pathFields: input.pathFields,
        trustOrigin: input.trustOrigin,
        finalInput: input.finalInput,
        allowedDirectories: input.allowedDirectories,
        sensitivePathsAdjacent: input.sensitivePathsAdjacent,
        sandboxCapability: detectSandboxCapability(),
      };
      try {
        // MAJOR-1: pass abortSignal to LlmRiskClassifier.classify so user
        // cancellation aborts an in-flight LLM call. The RiskClassifier
        // interface is signal-agnostic; LlmRiskClassifier accepts the optional
        // second argument — other classifiers safely ignore extra arguments.
        const classified =
          classifier instanceof LlmRiskClassifier
            ? classifier.classify(ctx, { abortSignal: options?.abortSignal })
            : classifier.classify(ctx);
        verdict = classified instanceof Promise ? await classified : classified;
        // Persist for next time (HIGH cached too — re-deny is fast).
        await cache.store(lookupKey, cacheCtx, verdict);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        verdict = { level: "high", reason: `reviewer error — ${message}` };
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
        // For memory-hit path, ruleVerdict === finalVerdict (no LLM).
        ruleVerdict: verdict.level,
        llmVerdict: verdict.level,
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

  private resolveTrust(toolName: string, source?: ToolSource): TrustLevel {
    // 관리자 오버라이드
    const override = this.trustOverrides.get(toolName);
    if (override) return override;
    // 소스 기반
    return trustFromSource(source ?? "builtin");
  }

  /**
   * Permission policy Layer 3 — Category × Source × Mode via registry descriptor.
   *
   * The descriptor's `decisionFor()` returns one of:
   *   - "allow"    → permitted (with audit)
   *   - "ask"      → ApprovalGate round-trip
   *   - "deny"     → refused (used by future restricted categories)
   *   - "reviewer" → defer to Phase 3 reviewer agent (headless lane)
   *   - "override" → meta category — caller reads tool.decisionOverride
   *
   * The Phase 3 reviewer is not yet wired; until it lands, "reviewer"
   * is mapped to "ask" so the user is prompted instead of silently
   * permitting a headless write — fail-safe per design §1 principles.
   *
   * MCP (trust: low) tools are asked in default/auto modes regardless of
   * category; explicit allow mode is the only mode that bypasses this
   * trust-axis prompt after Layer 0/1 hard gates.
   */
  private categoryBasedDecision(
    toolName: string,
    trust: TrustLevel,
    category: ToolCategory,
    context: PermissionCheckContext,
  ): PermissionCheckResult {
    // strict 모드: 모든 것 ask (read 포함)
    if (this.mode === "strict") {
      return {
        decision: "ask",
        reason: `strict 모드 (trust: ${trust}, category: ${category})`,
        layer: 6,
      };
    }

    // allow mode: explicit user opt-in to allow every non-hard-blocked tool.
    // Layer 0 sensitive paths, Layer 1 allowed-directory checks, deny rules,
    // and overlay-trigger mutation guards run before this point.
    if (this.mode === "allow") {
      return {
        decision: "allow",
        reason: `전체 허용 모드 (trust: ${trust}, category: ${category})`,
        layer: 6,
      };
    }

    // LOW trust (MCP): 항상 ask — manifest integrity guard 가 없는 동안 trust override
    if (trust === "low") {
      return {
        decision: "ask",
        reason: `MCP 도구 strict 강제 (trust: low, category: ${category})`,
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
          reason: `${this.mode} 모드 (category: ${category}, trust: ${trust})`,
          layer: 6,
        };
      case "deny":
        return {
          decision: "deny",
          reason: `정책 거부 (category: ${category})`,
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
            reason: `headless ${category} — reviewer agent 라우팅 대상 (executor 가 dispatchReviewer 호출)`,
            layer: 6,
            reviewer: { route: "headless" },
          };
        }
        return {
          decision: "ask",
          reason: `headless ${category} — reviewer agent 미배치, 사용자 컨펌`,
          layer: 6,
          reviewer: { route: "headless" },
        };
      case "override":
        // meta category — executor handles via tool.decisionOverride
        return {
          decision: "allow",
          reason: `meta tool (category: ${category}) — decisionOverride 적용`,
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
          reason: `사용자 컨펌 필요 (category: ${category}, trust: ${trust})`,
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

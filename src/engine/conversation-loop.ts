/**
 * Conversation Query Loop — §4.5 핵심 에이전틱 사이클
 *
 * 사용자 입력 → KW분류 → 라우팅 → 컨텍스트 조립 → LLM 스트리밍
 * → tool_use 감지 → 도구 실행 → loop back → 응답 완료
 *
 * 벤더 추상화: LLMProvider 인터페이스를 통해 Claude/OpenAI/Gemini/Copilot 통일 처리.
 * LVIS 내부 turn-runtime contract 기반.
 */
import { ConversationHistory } from "./conversation-history.js";
import { ToolExecutor } from "../tools/executor.js";
import { isActiveSandboxFilesystemContainedForPluginEffects } from "../permissions/sandbox-capability.js";
import { HookRunner } from "../hooks/hook-runner.js";
import type { LifecycleHookEvent } from "../hooks/script-hook-types.js";
import {
  estimateRequestInputProjection,
  type RequestInputProjection,
} from "./request-input-projection.js";

import type {
  GenericMessage,
  LLMProvider,
  ToolSchema,
  TokenUsage,
} from "./llm/types.js";
import type { ReadableToolResult } from "../tools/tool-result-chunk.js";
import type { SessionKind } from "../memory/memory-manager.js";
import type { ActiveRolePrompt } from "../data/role-presets.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { ChatInputOrigin } from "../shared/chat-origin.js";
import type { AiProviderPingResult } from "../shared/ai-provider-ping.js";
import { isToolResultStubContent } from "../shared/tool-result-stub.js";
import { createTracer, type ConversationTracer } from "../observability/conversation-trace.js";
import { t } from "../i18n/index.js";
import { buildProvider, generateText, pingProvider, resolveVendorName, AI_PROVIDER_PING_TIMEOUT_MS } from "./turn/provider.js";
import { fireLifecycleEvent, fireUserPromptSubmit } from "./turn/lifecycle-hooks.js";
import {
  resolveToolScope,
  rebuildToolSchemas,
  shouldDeferToolSchemas,
  filterAllowedPluginIds,
  nextCarryForwardToolNames,
} from "./turn/tool-scope.js";
import { buildToolExposureMetrics, buildProviderRequestDiagnostics } from "./turn/tool-exposure.js";
import { handleCommand, handlePermissionCommand } from "./turn/commands.js";
import {
  newConversation,
  loadSession,
  resetAndResume,
  branchFromCheckpoint,
  startRoutineConversation,
} from "./turn/session.js";
import { manualCompact, runPreflightGuard, applyBoundaryToSession } from "./turn/compaction.js";
import { GUIDE_MAX_ENTRIES, GUIDE_MAX_CHARS } from "./turn/guidance-limits.js";
import { runTurn } from "./turn/run-turn.js";
import type {
  TurnCallbacks,
  TurnResult,
  ConversationLoopDeps,
  RequestProjectionContext,
  PreflightGuardOptions,
  ToolScope,
  ToolExposureMetrics,
  ProviderRequestDiagnostics,
} from "./turn/types.js";
export type { TurnCallbacks, TurnStopReason, TurnResult, ConversationLoopDeps } from "./turn/types.js";



// ─── Loop ───────────────────────────────────────────

export class ConversationLoop {
  readonly deps: ConversationLoopDeps;
  readonly history: ConversationHistory;
  readonly toolExecutor: ToolExecutor;
  readonly auditLogger: AuditLogger;
  provider: LLMProvider | null = null;
  sessionId: string = crypto.randomUUID();
  sessionKind: SessionKind = "main";
  sessionRoutineId: string | null = null;
  sessionRoutineTitle: string | null = null;
  /**
   * #811 m2 — the sessionId the `SessionStart` lifecycle event last fired for.
   * SessionStart must fire ONCE per session (not per turn): runTurn fires it on
   * the first turn whose sessionId differs from this, then records it here.
   * Reset by `newConversation` / `loadSession` so a switched-into session
   * re-announces its start.
   */
  sessionStartFiredFor: string | null = null;
  /** K4: §4.5 11-step trace — dev 모드 활성, 프로덕션 no-op */
  tracer: ConversationTracer = createTracer(this.sessionId);
  cumulativeUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  /**
   * 마지막 round 의 provider raw inputTokens. turn_summary.tokensIn 을 직접
   * 채우는 값이 아니라, 턴 종료 context-fill SOT 를 provider 값으로 보정하기
   * 위한 기준점이다.
   */
  lastRoundProviderInputTokens = 0;
  /**
   * Engine request-input projection for the exact request submitted to the
   * latest provider round. Includes system prompt, provider-wire messages, and
   * exposed tool schemas.
   */
  lastRoundInputProjection: RequestInputProjection | null = null;
  /**
   * Latest context-fill SOT. Successful turns store turn_summary.tokensIn here;
   * compact paths store their post-compact estimate. During an in-flight
   * multi-round turn it temporarily follows the latest provider raw input as a
   * calibration anchor until turn end recomputes the projected value.
   */
  lastContextInputTokens = 0;
  /** Local full-request projection corresponding to `lastContextInputTokens`. */
  lastContextInputProjectionTokens = 0;
  /** B4: current turn's AbortController — abortCurrentTurn() calls .abort() */
  currentAbortController: AbortController | null = null;
  /**
   * Lazy Tool Scoping — 직전 턴의 active plugin 집합.
   * Keyword miss (type==="general") 시 fallback으로 재사용한다.
   * null = 이전 턴 없음 → builtin-only scope.
   */
  lastTurnScope: Set<string> | null = null;
  /**
   * Tool-Level Deferral — 직전 턴에 로드된 plugin/mcp tool 이름 집합.
   * keyword-miss 후속 턴이 이미 promote/preload 된 도구를 계속 노출하도록
   * carry-forward 한다. null = 이전 턴 없음.
   */
  lastTurnToolNames: Set<string> | null = null;
  /** Session-wide total of request_plugin activations (cap MAX_SESSION_PLUGIN_EXPANSION). */
  sessionPluginExpansions = 0;
  /**
   * Session-scoped on-demand activation set — registry-DISABLED plugins that an
   * allow-listed (routine) session activated via request_plugin for THIS
   * session ONLY. {@link resolveToolScope} (Gate 3) skips the disabled-drop for
   * these ids so their already-registered tools stay in scope, WITHOUT ever
   * persisting `enabled=true` (setPluginEnabled is never called by this path —
   * the registry stays `enabled:false`). Empty for main chat, where
   * `allowedPluginIds === undefined` means Gate 2 never lets a disabled id reach
   * activation. NON-PERSISTENT: lives only for the loop instance's lifetime and
   * is cleared on session reset alongside `sessionPluginExpansions`.
   */
  sessionActivatedPluginIds = new Set<string>();
  /** Session-wide total of tool_search promotions (cap MAX_TOOL_SEARCH_PER_SESSION). */
  sessionToolSearches = 0;
  sessionAdditionalDirectories: string[] = [];
  /**
   * Turn-scope additional allowed directories. Populated when the user
   * chooses "이번 1회만" on an out-of-allowed-dir approval — kept alive
   * across all tool calls inside the same `runTurn` so a multi-step
   * agentic round (e.g. `bash ls` → `bash find` → `bash stat` on the
   * same directory) does not re-prompt the user for the same path on
   * every subsequent call. Cleared in `runTurn`'s finally so the grant
   * does not survive into the next user message.
   */
  turnAdditionalDirectories: string[] = [];
  /**
   * Single in-flight LLM compact lock per ConversationLoop.
   * 같은 instance 에서 두 turn 이 동시에 compact trigger 시 두 번째는 skip (race 방지).
   */
  isCompacting: boolean = false;
  /** LLM compact 가 #N 번째인지 추적하는 numbered checkpoint counter. */
  compactNum: number = 0;
  /**
   * Issue #910 / #900 약속 정합 — `context_error` / `stream_error` 발생 직
   * 후 user-facing 메시지가 "새 메시지를 보내면 자동 압축이 다시 시도됩니
   * 다" 라고 약속. 그러나 기본 `runPreflightGuard` 는 provider-reported
   * last input / estimateMessagesTokens 임계 기반인데, *Forbidden 시도는
   * provider usage 에 기록 안 됨* + estimate 가 chars/4 으로 15-25% 과소 → 다음 turn
   * preflight 가 미발동, compact 도 NOOP 반환 → 약속 깨짐. 이 flag 는
   * 다음 turn 의 preflight 가 임계 무시 + preserve=0 으로 force trigger
   * 하도록 한다. 성공/실패/NOOP 모두 finally 에서 clear.
   */
  contextErrorPending: boolean = false;
  /**
   * Force-recover 반복 횟수 — DoS 방어 (security round-4 MED). 사용자가
   * 반복적으로 context_error 유발 input 보내면 compact LLM API 호출이
   * 누적 cost. `MAX_FORCE_RECOVER_PER_SESSION` 초과 시 force-recover 진입
   * 차단 + user-facing 경고. 정상 사용자는 절대 도달하지 않는 임계 (3
   * 회 연속 force-recover = 3 turn 연속 모델 한도 초과).
   */
  contextErrorRecoveryCount: number = 0;
  /**
   * Issue #917 — budget 소진 후 compact API 호출을 완전 차단하는 persistent
   * flag. `MAX_FORCE_RECOVER_PER_SESSION` 횟수를 모두 소진하면 true 로 설정되며,
   * 이후 turn 에서 force-recover 뿐 아니라 *normal threshold compact 도*
   * 차단한다 (compact 가 context 를 줄이지 못하는 구조적 실패가 입증됐으므로).
   * 정상 turn (context_error 없이 완료) 이후 re-arm 가능하도록 reset.
   */
  recoveryExhausted: boolean = false;
  /**
   * TPM reactive compact is an error-boundary recovery, not a normal threshold
   * trigger. Try it once per error series and re-arm only after a clean turn so
   * repeated 429 responses cannot amplify compact API calls.
   */
  rateLimitRecoveryAttempted: boolean = false;
  /**
   * "Guide" utterance buffer — mid-stream direction adjustments that the
   * user typed while a turn is in flight. Drained at each round boundary in
   * `queryLoop` (BETWEEN tool execution and the next LLM stream) and
   * appended to history as a user message so the model sees it like any
   * other turn input.
   *
   * Non-interrupting: the current LLM call and tool round are NOT aborted.
   * Multiple guidance entries within one round boundary are joined with
   * blank lines so the model receives them as a single coherent message.
   *
   * Bounded by `GUIDE_MAX_ENTRIES` (entry count) and `GUIDE_MAX_CHARS`
   * (per-entry char count) — see `queueGuidance` rationale. Overflow is
   * rejected at enqueue so memory + history bloat is hard-capped against
   * runaway renderer / autorepeat keyboard pressure.
   */
  guidanceQueue: string[] = [];

  constructor(deps: ConversationLoopDeps) {
    this.deps = deps;
    this.history = new ConversationHistory();
    this.toolExecutor = new ToolExecutor(
      deps.toolRegistry,
      deps.hookRunner ?? new HookRunner(),
      deps.permissionManager,
      deps.bashAstValidator,
      deps.approvalGate,
      deps.scriptHookManager,
      deps.auditLogger,
      () => deps.settingsService.get("features")?.hostClassifiesRisk ?? false,
      // Couple the foreground plugin read-relaxation to the plugin worker
      // effect-boundary actually filesystem-containing off-hostApi residuals.
      // Windows host shells are ASRT-wrapped after setup, but plugin workers
      // are still unwrapped there, so the provider intentionally excludes
      // Windows until that substrate is upgraded.
      isActiveSandboxFilesystemContainedForPluginEffects,
    );
    this.auditLogger = deps.auditLogger ?? new AuditLogger();
    this.refreshProvider();
  }

  /** B1: PermissionManager 참조 — IPC bridge에서 mode 조회/변경에 사용 */
  get permissionManager(): import("../permissions/permission-manager.js").PermissionManager | undefined {
    return this.deps.permissionManager;
  }

  /**
   * HIGH: plugin disable 시 lastTurnScope에서 해당 pluginId 제거.
   * boot.ts의 onDisable 콜백에서 호출된다.
   */
  onPluginDisabled(pluginId: string): void {
    this.lastTurnScope?.delete(pluginId);
  }

  /** B4: Abort the current streaming turn. No-op if no turn in flight. */
  abortCurrentTurn(): void {
    this.currentAbortController?.abort(new Error("user cancelled turn"));
  }

  /**
   * Queue a mid-stream "guide" utterance for non-interrupting injection.
   *
   * The text is held in `guidanceQueue` and consumed at the next round
   * boundary in `queryLoop` (between tool execution and the next LLM
   * stream), where it is appended to history as a user message. The
   * currently-streaming round is NOT aborted; in-flight tool calls receive
   * the turn's abort signal only when the user explicitly stops the turn.
   *
   * Atomically checks `hasActiveTurn()` inline so the IPC handler cannot
   * race the turn's `finally` block and silently leak a queued guide
   * into the next turn (critic MAJOR #2 / code-reviewer MAJOR #3).
   *
   * Returns:
   *   - `"queued"` on success
   *   - `"no-active-turn"` if no turn is in flight (caller must surface
   *     this to the renderer so the user keeps their typed text)
   *   - `"queue-full"` if `GUIDE_MAX_ENTRIES` is reached (DoS bound)
   *   - `"too-long"` if `text` exceeds `GUIDE_MAX_CHARS` after trim
   *   - `"empty"` if `text` is empty after trim (no-op, returned for parity)
   */
  queueGuidance(text: string): "queued" | "no-active-turn" | "queue-full" | "too-long" | "empty" {
    const trimmed = text.trim();
    if (trimmed.length === 0) return "empty";
    if (trimmed.length > GUIDE_MAX_CHARS) return "too-long";
    if (this.currentAbortController === null) return "no-active-turn";
    if (this.guidanceQueue.length >= GUIDE_MAX_ENTRIES) return "queue-full";
    this.guidanceQueue.push(trimmed);
    return "queued";
  }

  /** True when a turn is currently in flight. Renderer-facing visibility. */
  hasActiveTurn(): boolean {
    return this.currentAbortController !== null;
  }

  /** 설정 변경 시 Provider 재생성 — 벤더별 API 키 조회 */
  refreshProvider(): void {
    this.provider = buildProvider(this.deps);
  }

  hasProvider(): boolean {
    return this.provider !== null;
  }

  /**
   * 플러그인 callLlm용 범용 텍스트 생성.
   * 독립적인 단발 LLM 호출 — 대화 히스토리와 무관.
   *
   * CTRL simplification: maxTokens 파라미터 제거. Vendor SDK 기본값 사용.
   * 호출 측 시그니처는 SettingsService get("llm").vendors[provider].model 만 사용.
   */
  async generateText(
    prompt: string,
    systemPrompt = t("be_conversationLoop.generateTextSystemPrompt"),
    abortSignal?: AbortSignal,
  ): Promise<string> {
    return generateText(this.provider, this.deps.settingsService, prompt, systemPrompt, abortSignal);
  }

  /**
   * Status-bar connectivity probe. This is intentionally independent from
   * chat history: a tiny one-shot LLM request proves the configured provider
   * can answer after activation/restart without adding a visible turn.
   */
  async pingProvider(timeoutMs = AI_PROVIDER_PING_TIMEOUT_MS): Promise<AiProviderPingResult> {
    return pingProvider(this.provider, this.deps.settingsService, timeoutMs);
  }

  /** 현재 벤더 이름 */
  getVendor(): string {
    return resolveVendorName(this.provider);
  }

  buildSystemPromptForScope(
    scope: ToolScope,
    originSource: string | null,
    rolePrompt?: ActiveRolePrompt,
    overlaySessionId = this.sessionId,
  ): string {
    this.deps.systemPromptBuilder.setToolScope?.(scope);
    this.deps.systemPromptBuilder.setOriginSource?.(originSource);
    this.deps.systemPromptBuilder.setActiveSessionId?.(overlaySessionId);
    this.deps.systemPromptBuilder.setActiveRolePrompt?.(rolePrompt ?? null);
    try {
      return this.deps.systemPromptBuilder.build();
    } finally {
      this.deps.systemPromptBuilder.setOriginSource?.(null);
      this.deps.systemPromptBuilder.setActiveSessionId?.(null);
      this.deps.systemPromptBuilder.setActiveRolePrompt?.(null);
    }
  }

  estimateCurrentRequestProjection(params: {
    systemPrompt: string;
    toolSchemas: ToolSchema[];
  }): RequestInputProjection {
    return estimateRequestInputProjection({
      systemPrompt: params.systemPrompt,
      messages: this.history.getMessages(),
      toolSchemas: params.toolSchemas,
    });
  }

  createRequestProjectionContext(
    scope: ToolScope,
    originSource: string | null,
    rolePrompt: ActiveRolePrompt | undefined,
    toolSchemas: ToolSchema[],
    overlaySessionId = this.sessionId,
  ): RequestProjectionContext {
    const buildSystemPrompt = () => this.buildSystemPromptForScope(
      scope,
      originSource,
      rolePrompt,
      overlaySessionId,
    );
    return {
      systemPrompt: buildSystemPrompt(),
      toolSchemas,
      estimateCurrent: () => this.estimateCurrentRequestProjection({
        systemPrompt: buildSystemPrompt(),
        toolSchemas,
      }),
    };
  }

  shouldAutoCompactForRateLimit(stream: {
    classification: string;
    providerError: {
      providerType?: string;
      providerCode?: string;
      rateLimit?: { kind: "tokens-per-minute" | "requests-per-minute" | "unknown" };
    };
  }): boolean {
    const providerCode = stream.providerError.providerCode;
    const providerType = stream.providerError.providerType;
    const rateLimitKind = stream.providerError.rateLimit?.kind;
    return (
      stream.classification === "rate-limit" &&
      providerCode === "rate_limit_exceeded" &&
      (providerType === "tokens" || rateLimitKind === "tokens-per-minute")
    );
  }

  rateLimitCompactMessage(stream: {
    providerError: {
      rateLimit?: { retryAfterSeconds?: number };
    };
  }): string {
    const retryAfter = stream.providerError.rateLimit?.retryAfterSeconds;
    const waitText = retryAfter !== undefined && Number.isFinite(retryAfter)
      ? t("be_conversationLoop.rateLimitWaitKnown", { seconds: Math.ceil(retryAfter) })
      : t("be_conversationLoop.rateLimitWaitUnknown");
    return t("be_conversationLoop.rateLimitCompactMessage", { waitText });
  }

  /** 대화 이력 초기화 (새 대화) — §4.5.7 */
  newConversation(kind: SessionKind = "main"): void {
    newConversation(this, kind);
  }

  addSessionAdditionalDirectory(path: string): void {
    if (!this.sessionAdditionalDirectories.includes(path)) {
      this.sessionAdditionalDirectories.push(path);
      // Round-3 fix: every callsite that mutates the session list must
      // notify multi-window PermissionsTab subscribers. The slash-dispatch
      // path also broadcasts (ipc/domains/permissions.ts) — this closes
      // the executor-callback path that was previously silent.
      this.deps.broadcastPermissionConfigChanged?.();
    }
  }

  addTurnAdditionalDirectory(path: string): void {
    if (!this.turnAdditionalDirectories.includes(path)) {
      this.turnAdditionalDirectories.push(path);
    }
  }

  getTurnAdditionalDirectories(): readonly string[] {
    return [
      ...(this.deps.getAdditionalDirectories?.() ?? this.deps.additionalDirectories ?? []),
      ...this.sessionAdditionalDirectories,
      ...this.turnAdditionalDirectories,
    ];
  }

  getHistory(): ConversationHistory {
    return this.history;
  }

  /**
   * Clear this session's on-demand plugin activations from PluginRuntime.
   * Call after the session ends so the per-session Map entry doesn't
   * accumulate as a stale entry from a discarded loop (e.g. after
   * RoutineEngine discards the routine's ConversationLoop).
   *
   * ConversationLoop's own resetSession paths already call
   * `clearSessionActivated(this.sessionId)` — this method covers the
   * routine-fire path where the loop is discarded without a resetSession.
   */
  cleanupSession(): void {
    this.deps.pluginRuntime?.clearSessionActivated?.(this.sessionId);
  }

  readToolResultForChunk(toolUseId: string): ReadableToolResult | null {
    const match = this.history
      .getMessages()
      .find((m): m is Extract<GenericMessage, { role: "tool_result" }> =>
        m.role === "tool_result" && m.toolUseId === toolUseId,
      );
    if (!match) return null;
    if (isToolResultStubContent(match.content)) {
      const artifact = match.meta?.artifactUnavailable
        ? null
        : this.deps.memoryManager.loadToolResultArtifact(this.sessionId, toolUseId);
      if (!artifact) return match;
      return {
        toolUseId: artifact.toolUseId,
        toolName: artifact.toolName ?? match.toolName,
        content: artifact.content,
        isError: match.isError,
        meta: { ...(match.meta ?? {}), truncated: artifact.truncated },
      };
    }
    return {
      toolUseId: match.toolUseId,
      toolName: match.toolName,
      content: match.content,
      isError: match.isError,
      meta: match.meta,
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionKind(): SessionKind {
    return this.sessionKind;
  }

  /**
   * Re-create the tracer keyed on the CURRENT `sessionId`. `tracer` is created
   * at field-init against the constructor UUID; any code path that rebinds
   * `sessionId` after construction (SubAgentRunner assigns the addressable
   * childSessionId directly, without going through `newConversation`) must call
   * this so dev traces are written under the live id. `newConversation` /
   * `loadSession` already re-init the tracer inline; this is the equivalent
   * seam for direct `sessionId` assignment.
   */
  rebindTracer(): void {
    this.tracer = createTracer(this.sessionId);
  }

  getSessionRoutineTitle(): string | null {
    return this.sessionRoutineTitle;
  }

  /**
   * Checkpoint view-mode — 체크포인트 #compactNum 의 슬라이스 끝 인덱스를 반환.
   * 렌더러가 visibleMessages = messages.slice(0, slicedRangeEnd) 로 view-mode 를 구현.
   * 해당 compactNum 체크포인트가 없으면 null 반환.
   */
  public enterViewMode(compactNum: number): { messageIndexAtCreation: number } | null {
    const checkpoints = this.deps.memoryManager.loadSessionMetadata(this.sessionId)?.checkpoints ?? [];
    const target = checkpoints.find((c) => c.compactNum === compactNum);
    if (!target) return null;
    return { messageIndexAtCreation: target.messageCountAtTrigger };
  }

  /**
   * Checkpoint view-mode 종료 audit hook.
   * 실제 engine 상태 변경 없음 (렌더러 state 만 reset). 추후 감사 로그 추가 가능.
   */
  public exitViewMode(): void {
    // no-op: renderer-side state reset only
  }

  /**
   * Checkpoint branch — 체크포인트 #compactNum 지점에서 새 세션을 fork.
   * history 를 slicing 하고 wire-serialize 후 disk 영속화. 새 sessionId 반환.
   */
  public async branchFromCheckpoint(compactNum: number): Promise<{
    newSessionId: string;
    lastMessageRole: GenericMessage["role"] | null;
    shouldAutoContinue: boolean;
  }> {
    return branchFromCheckpoint(this, compactNum);
  }

  getSessionRoutineId(): string | null {
    return this.sessionRoutineId;
  }

  /** K4: 현재 tracer 의 JSONL 파일 경로 (활성 시). 뷰어 UI 가 읽기에 사용. */
  getTraceFilePath(): string | undefined {
    return this.tracer.filePath;
  }

  /** K4: 테스트용 tracer 주입 — dev 모드 기본 동작을 override. */
  setTracer(tracer: ConversationTracer): void {
    this.tracer = tracer;
  }

  getCumulativeUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  isAutoCompactEnabled(): boolean {
    return this.deps.settingsService.get("chat").autoCompact ?? true;
  }

  /**
   * Fire a NON-BLOCKING lifecycle event (#811 milestone-2, design §5).
   * OBSERVE-ONLY: the dispatch result is discarded — a lifecycle hook's `deny`
   * is recorded in the manager's audit but NEVER affects the turn (mirrors
   * `PostToolUse`). Fail-soft: the manager never throws and we additionally
   * swallow any unexpected error so a misbehaving hook can never break a turn /
   * compaction. No-op when `scriptHookManager` is unwired (back-compat: no
   * hooks.json ⇒ no lifecycle dispatch, behavior identical to today).
   *
   * The matcher subject is the live `sessionId`; trustOrigin is propagated so a
   * hook can key on origin. No secrets pass through (env allowlist unchanged).
   */
  async fireLifecycleEvent(
    event: LifecycleHookEvent,
    payload: import("../hooks/script-hook-manager.js").LifecycleEventPayload = {},
    sessionIdOverride?: string,
  ): Promise<void> {
    return fireLifecycleEvent(this.deps, this.sessionId, event, payload, sessionIdOverride);
  }

  /**
   * Fire the ONE BLOCKING lifecycle event — `UserPromptSubmit` (#811 m2, design
   * §5) — and return its decision for the caller to RESPECT. Unlike
   * {@link fireLifecycleEvent} (observe-only, swallow-and-continue), this is
   * SECURITY-SENSITIVE and FAIL-CLOSED:
   *   - manager returns `deny` (a hook denied, or its dispatch failed closed) → deny
   *   - an UNEXPECTED throw here → deny (refuse), NEVER allow
   *
   * BACK-COMPAT: with NO `scriptHookManager` wired, returns `allow` so the turn
   * proceeds byte-identically to today (no hooks.json ⇒ never refused). The
   * manager itself also returns `allow` when no trusted hook matches, so the
   * "no hooks ⇒ proceeds" guarantee holds at both layers. `inputText` is
   * DLP-redacted inside the manager before it reaches any hook.
   */
  async fireUserPromptSubmit(
    payload: import("../hooks/script-hook-manager.js").UserPromptSubmitPayload,
    sessionIdOverride?: string,
  ): Promise<{ decision: "allow" | "deny"; reason: string }> {
    return fireUserPromptSubmit(this.deps, this.sessionId, payload, sessionIdOverride);
  }

  /** Non-secret session metadata for the SessionStart lifecycle payload. */
  sessionMetaForLifecycle(): Record<string, unknown> {
    return {
      sessionKind: this.sessionKind,
      ...(this.sessionRoutineId ? { routineId: this.sessionRoutineId } : {}),
      ...(this.sessionRoutineTitle ? { routineTitle: this.sessionRoutineTitle } : {}),
    };
  }

  /** 세션 목록 조회 — §4.5.7 */
  listSessions(limit?: number): Array<{ id: string; modifiedAt: Date; title: string }> {
    return this.deps.memoryManager.listSessions(limit).map((session) => ({
      id: session.id,
      modifiedAt: session.modifiedAt,
      title: session.title,
    }));
  }

  /** 기존 세션 복원 — §4.5.7 */
  loadSession(sessionId: string): boolean {
    return loadSession(this, sessionId);
  }

  async startRoutineConversation(routineId: string, routineTitle: string, routineFiredAt?: string): Promise<string> {
    return startRoutineConversation(this, routineId, routineTitle, routineFiredAt);
  }

  /**
   * §4.5.2 B1 — Session resume with full state reset.
   * Unlike loadSession (raw swap), also triggers auto-compact check.
   */
  resetAndResume(sessionId: string): {
    ok: boolean;
    compacted: boolean;
    compactedAt: string | null;
    removedMessageCount: number;
  } {
    return resetAndResume(this, sessionId);
  }

  /**
   * §4.5.4 — Manual compact trigger (`/compact` user command).
   *
   * 사용자가 명시적으로 trigger 한 강제 LLM compact 이므로 임계값 무시하고 진입 — 단 history 가
   * preserveRecentTokens 보다 작으면 no-op (압축할 내용 없음).
   *
   * Per-loop lock — 동시 compact race 방지.
   */
  async manualCompact(callbacks?: Pick<TurnCallbacks, "onCompactOccurred" | "onCompactStarted">): Promise<{
    compacted: boolean;
    compactedAt: string | null;
    summary: string;
    removedMessageCount: number;
  }> {
    return manualCompact(this, callbacks);
  }

  /**
   * 한 턴 실행 — §4.5 Core Cycle
   * @param abortSignal  B4: optional external abort signal; if omitted a fresh
   *                     AbortController is created and stored in
   *                     `currentAbortController` so `abortCurrentTurn()` works.
   * @param options      `originSource` enables the Overlay Trigger Origin
   *                     Guidance prompt section for this single turn. Set/
   *                     cleared synchronously around `build()` so concurrent
   *                     turns do not corrupt one another's guidance state.
   */
  async runTurn(
    input: string,
    callbacks?: TurnCallbacks,
    abortSignal?: AbortSignal,
    options?: {
      /**
       * Multimodal user content parts — appended after the text input as
       * additional content blocks (vision images, files). When omitted the
       * user message is a plain string (current behavior).
       */
      attachments?: import("./llm/types.js").UserContentPart[];
      originSource?: string | null;
      /**
       * C3(a): hard cap on assistant rounds for this turn. When set,
       * queryLoop terminates cleanly between rounds once the cap is hit
       * regardless of tool_use chains the LLM still wants to run. Used by
       * SubAgentRunner to enforce the host-assigned `maxRounds` budget at
       * the loop boundary instead of using user-cancel semantics.
       */
      maxRounds?: number;
      /**
       * C3(c): override session id used by the executor's
       * ToolExecutionContext.metadata.sessionId. SubAgentRunner threads
       * the child session id here so audit entries from the sub-agent's
       * tool calls are attributed to the child, not the parent.
       */
      sessionIdOverride?: string;
      /**
       * C3(b): spawn depth carried through to the executor's metadata.
       * Sub-agents see depth >= 1 and reject any nested agent_spawn call
       * before it reaches the LLM-visible registry.
       */
      spawnDepth?: number;
      inputOrigin: ChatInputOrigin;
      rolePrompt?: ActiveRolePrompt;
    },
  ): Promise<TurnResult> {
    return runTurn(this, input, callbacks, abortSignal, options);
  }
  /** Tool registry → LLM 이 받는 ToolSchema 배열로 변환. scope 필터 반영. */
  rebuildToolSchemas(scope: ToolScope): ToolSchema[] {
    return rebuildToolSchemas(this.deps.toolRegistry, scope);
  }

  buildToolExposureMetrics(
    scope: ToolScope,
    toolSchemas: ToolSchema[],
    projection: RequestInputProjection | null,
    promotedToolNames: readonly string[] = [],
  ): ToolExposureMetrics {
    return buildToolExposureMetrics(this.deps.toolRegistry, scope, toolSchemas, projection, promotedToolNames);
  }

  buildProviderRequestDiagnostics(
    params: Parameters<typeof buildProviderRequestDiagnostics>[1],
  ): ProviderRequestDiagnostics {
    return buildProviderRequestDiagnostics(this.sessionId, params);
  }

  nextCarryForwardToolNames(
    scope: ToolScope,
    toolCalls: Array<{ name: string }>,
  ): Set<string> {
    return nextCarryForwardToolNames(this.deps, scope, toolCalls);
  }

  /**
   * DRY helper — boundary 적용 공통 경로.
   *
   * `runPreflightGuard` (auto) 와 `manualCompact` (manual) 가 동일 동작을 공유:
   *   1. `compactNum` 증가
   *   2. `history` 교체 (boundary stub + recentVerbatim)
   *   3. `setSummaryPreamble` 로 prior-context summary 갱신
   *   4. context-size trackers reset to `estimatedAfter`
   *   5. checkpoint append + saveSessionMetadata 영속화
   *   6. `callbacks.onCompactOccurred` surface (사용자 가시 compact_notice)
   *
   * Checkpoint storage 실패는 대화 차단 금지 — warn 후 계속.
   */
  async applyBoundaryToSession(
    result: import("./structured-compact.js").CompactWithBoundaryResult,
    trigger: "auto-compact" | "manual",
    estimatedBefore: number,
    callbacks: TurnCallbacks | undefined,
    /** compact 직전 history 길이 — messageCountAtTrigger 에 기록 (origin count). */
    prevMessageCount: number,
    /** §C1: verbatim pre-compact messages — persisted as checkpoint snapshot for branchFromCheckpoint. */
    messagesBefore: import("./llm/types.js").GenericMessage[],
    projectionContext: RequestProjectionContext,
  ): Promise<void> {
    return applyBoundaryToSession(this, result, trigger, estimatedBefore, callbacks, prevMessageCount, messagesBefore, projectionContext);
  }

  /**
   * Token preflight guard for same-session checkpoint compaction.
   *
   * step 5 (HISTORY_APPEND) 직후 호출 — request-input projection
   * (system prompt + wire history + tool schemas) 이 getModelPreflightThreshold()
   * 에 도달하면 차단형 await 로 `compactWithBoundary` 실행. 결과:
   *   1. `compactNum` 증가
   *   2. `history` 교체 (boundary stub + recentVerbatim)
   *   3. `setSummaryPreamble` 로 prior-context summary 갱신
   *   4. context-size trackers reset to `estimatedAfter`
   *   5. `onCompactOccurred` 콜백 surface
   *
   * `isCompacting` lock per ConversationLoop instance. 동시 turn 에서
   * token preflight race 시 두번째는 silent skip.
   *
   * Mid-loop reactive compact retry is intentionally absent — context_error 도달 시
   * early-exit signal 만 전달하고 stream-collector 가 사용자 안내 처리.
   */
  async runPreflightGuard(
    projectionContext: RequestProjectionContext,
    abortSignal?: AbortSignal,
    callbacks?: TurnCallbacks,
    options?: PreflightGuardOptions,
  ): Promise<boolean> {
    return runPreflightGuard(this, projectionContext, abortSignal, callbacks, options);
  }

  // ─── Private: Memory Extraction (§4.5.5 Hook 3) ───
  // cycle 1 MED: extractMemory inline 로직 제거.
  // PostTurnHookChain의 memory-extract hook이 단일 진실 소스이며,
  // fallback 경로에서도 중복 추출을 수행하지 않는다.

  // ─── Private: Tool Scope Resolution (Lazy Tool Scoping) ───────────

  /**
   * 입력에서 활성 plugin 집합을 유도하여 ToolScope를 반환한다.
   *
   * - KeywordEngine.matchAllPluginIds() → 이번 턴 active plugin Set
   * - 매치 없음(일반 대화) → lastTurnScope fallback, 그마저 없으면 빈 Set (builtin-only)
   * - Builtins + MCP는 항상 포함 (host-side tool은 항시 사용 가능)
   * - Plugin/MCP schemas are still loaded only by activeToolNames.
   */
  resolveToolScope(input: string): ToolScope {
    return resolveToolScope(input, this.deps, {
      lastTurnScope: this.lastTurnScope,
      lastTurnToolNames: this.lastTurnToolNames,
      sessionActivatedPluginIds: this.sessionActivatedPluginIds,
    });
  }

  shouldDeferToolSchemas(activePluginIds: Set<string>): boolean {
    return shouldDeferToolSchemas(this.deps, activePluginIds);
  }

  filterAllowedPluginIds(pluginIds: string[]): string[] {
    return filterAllowedPluginIds(this.deps, pluginIds);
  }

  // ─── Private: Command Handler ─────────────────────

  async handleCommand(
    command: string,
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<TurnResult> {
    return handleCommand(this, command, args, inputOrigin, callbacks);
  }

  async handlePermissionCommand(
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<string> {
    return handlePermissionCommand(this, args, inputOrigin, callbacks);
  }

  // Compaction uses same-session checkpoints. Automatic session forks are not
  // part of the compact path; forks only happen through explicit user action.
}

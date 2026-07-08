



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
  type SessionProjectContext,
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
  sessionProjectRoot: string | null = null;
  sessionProjectName: string | null = null;
  sessionProjectIsDefault = false;
  /**
   * #811 m2 — the sessionId the `SessionStart` lifecycle event last fired for.
   * SessionStart must fire ONCE per session (not per turn): runTurn fires it on
   * the first turn whose sessionId differs from this, then records it here.
   * Reset by `newConversation` / `loadSession` so a switched-into session
   * re-announces its start.
   */
  sessionStartFiredFor: string | null = null;

  tracer: ConversationTracer = createTracer(this.sessionId);
  cumulativeUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };



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



  lastTurnScope: Set<string> | null = null;



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



  turnAdditionalDirectories: string[] = [];



  isCompacting: boolean = false;

  compactNum: number = 0;



  contextErrorPending: boolean = false;



  contextErrorRecoveryCount: number = 0;



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
      // Generic host-shell ASRT is not enough here; the provider accepts only
      // Tool.workerId calls that the host spawned and currently tracks as
      // ASRT-wrapped (mac/linux UDS or Windows holder-PID ACL grant).
      isActiveSandboxFilesystemContainedForPluginEffects,
    );
    this.auditLogger = deps.auditLogger ?? new AuditLogger();
    this.refreshProvider();
  }


  get permissionManager(): import("../permissions/permission-manager.js").PermissionManager | undefined {
    return this.deps.permissionManager;
  }




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


  refreshProvider(): void {
    this.provider = buildProvider(this.deps);
  }

  hasProvider(): boolean {
    return this.provider !== null;
  }




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


  newConversation(kind: SessionKind = "main", project?: SessionProjectContext): void {
    newConversation(this, kind, project ?? (kind === "main" ? this.deps.getDefaultProject?.() : undefined));
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

  getSessionProjectRoot(): string | null {
    return this.sessionProjectRoot;
  }

  getSessionProjectName(): string | null {
    return this.sessionProjectName;
  }

  /**
   * True when the session's project binding is the app-managed default
   * workspace root (no explicit project selection) rather than a user-picked
   * project directory. UI-facing callers (chat.new domain handler,
   * markMainActiveAfterTurn) use this to decide whether to persist
   * projectRoot/projectName into session metadata at all — a "no explicit
   * project" session's metadata omits them entirely (null is the normal
   * state), while the in-memory execution binding (sessionProjectRoot /
   * sessionAdditionalDirectories, set by applyProjectContext regardless of
   * this flag) is unaffected — the agent still gets the default directory
   * for tool access either way. See 2026-07 "remove Current Project
   * labeling" refinement.
   */
  getSessionProjectIsDefault(): boolean {
    return this.sessionProjectIsDefault;
  }

  getSessionProjectContext(): SessionProjectContext {
    return {
      ...(this.sessionProjectRoot ? { projectRoot: this.sessionProjectRoot } : {}),
      ...(this.sessionProjectName ? { projectName: this.sessionProjectName } : {}),
    };
  }

  getSessionMemoryProjectContext(): SessionProjectContext & { includeUnscoped?: boolean } {
    return {
      ...this.getSessionProjectContext(),
      ...(this.sessionProjectIsDefault ? { includeUnscoped: true } : {}),
    };
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




  public enterViewMode(compactNum: number): { messageIndexAtCreation: number } | null {
    const checkpoints = this.deps.memoryManager.loadSessionMetadata(this.sessionId)?.checkpoints ?? [];
    const target = checkpoints.find((c) => c.compactNum === compactNum);
    if (!target) return null;
    return { messageIndexAtCreation: target.messageCountAtTrigger };
  }




  public exitViewMode(): void {
    // no-op: renderer-side state reset only
  }




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


  getTraceFilePath(): string | undefined {
    return this.tracer.filePath;
  }


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
      ...(this.sessionProjectRoot ? { projectRoot: this.sessionProjectRoot } : {}),
      ...(this.sessionProjectName ? { projectName: this.sessionProjectName } : {}),
    };
  }


  listSessions(limit?: number): Array<{ id: string; modifiedAt: Date; title: string }> {
    return this.deps.memoryManager.listSessions(limit).map((session) => ({
      id: session.id,
      modifiedAt: session.modifiedAt,
      title: session.title,
    }));
  }


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




  async manualCompact(callbacks?: Pick<TurnCallbacks, "onCompactOccurred" | "onCompactStarted">): Promise<{
    compacted: boolean;
    compactedAt: string | null;
    summary: string;
    removedMessageCount: number;
  }> {
    return manualCompact(this, callbacks);
  }




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




  async applyBoundaryToSession(
    result: import("./structured-compact.js").CompactWithBoundaryResult,
    trigger: "auto-compact" | "manual",
    estimatedBefore: number,
    callbacks: TurnCallbacks | undefined,

    prevMessageCount: number,
    /** §C1: verbatim pre-compact messages — persisted as checkpoint snapshot for branchFromCheckpoint. */
    messagesBefore: import("./llm/types.js").GenericMessage[],
    projectionContext: RequestProjectionContext,
  ): Promise<void> {
    return applyBoundaryToSession(this, result, trigger, estimatedBefore, callbacks, prevMessageCount, messagesBefore, projectionContext);
  }




  async runPreflightGuard(
    projectionContext: RequestProjectionContext,
    abortSignal?: AbortSignal,
    callbacks?: TurnCallbacks,
    options?: PreflightGuardOptions,
  ): Promise<boolean> {
    return runPreflightGuard(this, projectionContext, abortSignal, callbacks, options);
  }

  // ─── Private: Memory Extraction (§4.5.5 Hook 3) ───



  // ─── Private: Tool Scope Resolution (Lazy Tool Scoping) ───────────




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

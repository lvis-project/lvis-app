/**
 * Conversation Query Loop — §4.5 핵심 에이전틱 사이클
 *
 * 사용자 입력 → KW분류 → 라우팅 → 컨텍스트 조립 → LLM 스트리밍
 * → tool_use 감지 → 도구 실행 → loop back → 응답 완료
 *
 * 벤더 추상화: LLMProvider 인터페이스를 통해 Claude/OpenAI/Gemini/Copilot 통일 처리.
 * claw-code harness 패턴 기반.
 */
import { ConversationHistory, normalizeToolPairInvariant } from "./conversation-history.js";
import { ToolExecutor, type ToolUseBlock } from "../tools/executor.js";
import { HookRunner } from "../hooks/hook-runner.js";
import { shouldCompact, compactMessages, getModelContextWindow, decideRotation, type CheckpointTriggerType } from "./auto-compact.js";
import { generateSummary } from "./summary-generator.js";
import { createProvider, secretKeyFor } from "./llm/provider-factory.js";
import { FallbackProvider } from "./llm/vercel/fallback-chain.js";
import type { LLMProvider, ToolSchema, TokenUsage } from "./llm/types.js";
import { collectRoundStream } from "./turn/stream-collector.js";
import {
  handleRequestPlugin,
  MAX_PLUGIN_EXPANSION,
  MAX_SESSION_PLUGIN_EXPANSION,
  REQUEST_PLUGIN_TOOL,
} from "./turn/plugin-expansion.js";
import { applyKnowledgeDepthCap } from "./turn/knowledge-cap.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { KeywordEngine } from "../core/keyword-engine.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SettingsService } from "../data/settings-store.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { RoutineEngine } from "../core/routine-engine.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ToolCallMeta } from "../tools/executor.js";
import { createTracer, type ConversationTracer } from "../observability/conversation-trace.js";
import { createLogger } from "../lib/logger.js";
const log = createLogger("lvis");

// ─── Types ──────────────────────────────────────────

export interface TurnCallbacks {
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onToolStart?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta) => void;
  onToolEnd?: (
    name: string,
    result: string,
    isError: boolean,
    meta: ToolCallMeta,
    uiPayload: import("../mcp/types.js").McpUiPayload | undefined,
    durationMs: number,
  ) => void;
  onAssistantRound?: (round: {
    roundIndex: number;
    text: string;
    thought: string;
    stopReason: "end_turn" | "tool_use";
    hasToolCalls: boolean;
  }) => void;
  onTurnComplete?: (fullText: string) => void;
  onError?: (error: string) => void;
  onCompactOccurred?: (result: {
    removedMessages: number;
    freedTokens: number;
    /**
     * 3-tier rotation tier when the compact was driven by `runRotationCheck`.
     * Absent for plain auto/reactive compaction (no rotation occurred).
     * Lets the renderer differentiate emergency vs voluntary checkpoints.
     */
    tier?: CheckpointTriggerType;
    /**
     * §457 Phase 3: parent session id from which the rotation forked. Allows
     * the renderer to surface a "여기로 되돌아가기" action that resumes the
     * pre-rotation session. Only set on rotation-driven compacts; absent for
     * plain auto/reactive compaction (no fork occurred).
     */
    revertSessionId?: string;
    /**
     * Rolling summary generated for rotation checkpoints. Undefined means no
     * user-facing summary is available; null summaries are intentionally not
     * sent because there is nothing useful to render.
     */
    summary?: string;
  }) => void;
  onFallback?: (from: string, to: string) => void;
  /**
   * Turn aggregate footer (§ chat transcript per-turn footer) — fires once
   * after the turn fully resolves with cumulative wall-clock / step-count /
   * token totals. Renderer maps the payload to a `kind: "turn_summary"`
   * chat entry placed under the final assistant message.
   *
   * `cumulativeToolMs` is the sum of per-tool durationMs when available;
   * 0 when the executor has not yet been instrumented (companion PR
   * `feat/tool-execution-duration-display` provides the missing field).
   * `breakdown` carries `{ count, ms }` per tool name; omitted when no
   * tools ran (the footer hides the expand affordance in that case).
   */
  onTurnSummary?: (summary: {
    turnDurationMs: number;
    toolCount: number;
    cumulativeToolMs: number;
    tokensIn: number;
    tokensOut: number;
    breakdown?: Record<string, { count: number; ms: number }>;
  }) => void;
}

export interface TurnResult {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  route: string;
  usage?: TokenUsage;
  stopReason?: "end_turn" | "tool_use" | "interrupted";
}

export interface ConversationLoopDeps {
  settingsService: SettingsService;
  systemPromptBuilder: SystemPromptBuilder;
  keywordEngine: KeywordEngine;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  memoryManager: MemoryManager;
  permissionManager?: import("../permissions/permission-manager.js").PermissionManager;
  routineEngine?: RoutineEngine;
  /** Agent 5: turn 완료 시 idle scheduler에 대화 신호 전송 (§6.1) */
  idleScheduler?: IdleSchedulerService;
  /** Agent 6: post-turn hook chain (compact → saveSession → extractMemory → audit → idle-poke) */
  postTurnHookChain?: PostTurnHookChain;
  /** Agent 6: Bash AST pre-validator — ToolExecutor Step 2.5에 주입 */
  bashAstValidator?: import("../main/bash-ast-validator.js").BashAstValidator;
  /** B1: 승인 게이트 — "ask" 결정 시 렌더러 모달로 round-trip */
  approvalGate?: import("../permissions/approval-gate.js").ApprovalGate;
  /**
   * Tier A4 (W3): pre-configured {@link HookRunner} — boot owns the lifecycle
   * so external command/http hooks loaded from `~/.lvis/hooks.json` +
   * admin-dir `hooks.json` are attached via
   * {@link HookRunner.setExternalExecutor} BEFORE the loop is constructed.
   * Defaults to a fresh runner with no hooks when omitted (preserves old
   * test harnesses that instantiate ConversationLoop directly).
   */
  hookRunner?: HookRunner;
  /**
   * Phase 1.5 Option C — plugin runtime reference used for:
   *   - request_plugin 메타 툴 pluginId 유효성 검증
   *   - inactive plugin 카탈로그 공급 (SystemPromptBuilder가 읽음)
   * Omitted in lightweight unit tests; scope expansion becomes a no-op.
   */
  pluginRuntime?: {
    listPluginIds(): string[];
  };
  /**
   * Sub-agent fixed tool-surface support. When a child loop receives a
   * pre-scoped registry containing plugin tools, lazy keyword matching may
   * not see the plugin keywords in the child instruction text. These plugin
   * ids are therefore always included in the child turn scope so the LLM gets
   * the actual structured tool schemas instead of only natural-language
   * instructions about available tools.
   */
  forcedActivePluginIds?: ReadonlySet<string>;
  /**
   * C2(c): per-session SkillOverlay handle. Cleared on `newConversation()`
   * so a brand-new session does not inherit a previous session's loaded
   * skills. Optional — legacy unit-test setups skip the overlay.
   */
  skillOverlay?: { clear(sessionId: string): void };
  /**
   * Session-scoped assistant TO-DO lifecycle. At the start of a new turn,
   * a fully completed prior plan is cleared so the next plan starts fresh.
   */
  sessionTodoStore?: { clearIfAllCompleted(sessionId: string): boolean };
  /**
   * Issue #260: optional system notification service. When supplied, the
   * loop fires a `turn-end` notification when runTurn resolves successfully
   * (not aborted, not interrupted). Routine / sub-agent / trigger loops
   * intentionally omit this so background turns don't spam the user.
   */
  notificationService?: import("../main/notification-service.js").NotificationService;
}

const MAX_TOOL_ROUNDS = 10;
/**
 * C3(a): per-round cap on the number of tool calls an assistant round can
 * issue. Pathological round-emitting many tool_use blocks at once would
 * otherwise execute every one in parallel before the maxRounds guard could
 * intervene. SubAgentRunner relies on this cap to keep a sub-agent's total
 * tool execution count bounded by `maxRounds * MAX_TOOL_CALLS_PER_ROUND`.
 */
const MAX_TOOL_CALLS_PER_ROUND = 10;

/** Phase 1 Lazy Tool Scoping — 매 턴 LLM에 노출할 도구 집합 정의. */
interface ToolScope {
  activePluginIds: Set<string>;
  includeBuiltins: boolean;
  includeMcp: boolean;
}

// ─── Loop ───────────────────────────────────────────

export class ConversationLoop {
  private readonly deps: ConversationLoopDeps;
  private readonly history: ConversationHistory;
  private readonly toolExecutor: ToolExecutor;
  private readonly auditLogger: AuditLogger;
  private provider: LLMProvider | null = null;
  private sessionId: string = crypto.randomUUID();
  private sessionRoutineId: string | null = null;
  /** K4: §4.5 11-step trace — dev 모드 활성, 프로덕션 no-op */
  private tracer: ConversationTracer = createTracer(this.sessionId);
  private cumulativeUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  /** PR-4: timestamp when the current session started (ms since epoch) — used by decideRotation */
  private sessionStartedAt: number = Date.now();
  // 2026-05-04 incident 후속: rotation 직후 한 turn 동안 다음 rotation 보류
  // (OpenCode 패턴 — 회전 결과 자체가 다시 회전 트리거되는 race 방지). next
  // runRotationCheck 가 호출되면 이 flag 를 보고 early-return + clear.
  private justRotated: boolean = false;
  /** PR-4: index into history marking where the last checkpoint rotation occurred */
  private lastCheckpointMessageIndex: number = 0;
  /** B4: current turn's AbortController — abortCurrentTurn() calls .abort() */
  currentAbortController: AbortController | null = null;
  /**
   * Phase 1 Lazy Tool Scoping — 직전 턴의 active plugin 집합.
   * Keyword miss (type==="general") 시 fallback으로 재사용한다.
   * null = 이전 턴 없음 → builtin-only scope.
   */
  private lastTurnScope: Set<string> | null = null;
  /** M2: Session-wide total of request_plugin activations (cap MAX_SESSION_PLUGIN_EXPANSION). */
  private sessionPluginExpansions = 0;

  constructor(deps: ConversationLoopDeps) {
    this.deps = deps;
    this.history = new ConversationHistory();
    this.toolExecutor = new ToolExecutor(
      deps.toolRegistry,
      deps.hookRunner ?? new HookRunner(),
      deps.permissionManager,
      deps.bashAstValidator,
      deps.approvalGate,
    );
    this.auditLogger = new AuditLogger();
    this.refreshProvider();
  }

  /** B1: PermissionManager 참조 — IPC bridge에서 mode 조회/변경에 사용 */
  get permissionManager(): import("../permissions/permission-manager.js").PermissionManager | undefined {
    return this.deps.permissionManager;
  }

  /**
   * HIGH-1: plugin disable 시 lastTurnScope에서 해당 pluginId 제거.
   * boot.ts의 onDisable 콜백에서 호출된다.
   */
  onPluginDisabled(pluginId: string): void {
    this.lastTurnScope?.delete(pluginId);
  }

  /** B4: Abort the current streaming turn. No-op if no turn in flight. */
  abortCurrentTurn(): void {
    this.currentAbortController?.abort();
  }

  /** 설정 변경 시 Provider 재생성 — 벤더별 API 키 조회 */
  refreshProvider(): void {
    const llmSettings = this.deps.settingsService.get("llm");
    const vendor = llmSettings.provider;
    const block = llmSettings.vendors[vendor];
    const apiKey = this.deps.settingsService.getSecret(secretKeyFor(vendor));

    // Vertex AI uses service account / ADC — apiKey not required, but project is.
    const isVertex = vendor === "vertex-ai";
    if (!apiKey && !isVertex) {
      this.provider = null;
      return;
    }
    if (isVertex && !block.vertexProject && !process.env.GOOGLE_CLOUD_PROJECT && !process.env.GCLOUD_PROJECT) {
      this.provider = null;
      return;
    }

    try {
      const primary = createProvider({
        vendor,
        apiKey: apiKey ?? "",
        model: block.model,
        ...(block.baseUrl ? { baseUrl: block.baseUrl } : {}),
        ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
        ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
      });
      const chain = llmSettings.fallbackChain.filter(
        (e) => e.provider && e.model,
      );
      this.provider =
        chain.length > 0
          ? new FallbackProvider(
              primary,
              chain,
              (v) => this.deps.settingsService.getSecret(secretKeyFor(v)) ?? "",
            )
          : primary;
    } catch {
      this.provider = null;
    }
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
    _maxTokensIgnored?: number,
    systemPrompt = "당신은 LVIS, 사용자의 AI 비서입니다.",
  ): Promise<string> {
    if (!this.provider) throw new Error("LLM provider not configured");
    let text = "";
    const llm = this.deps.settingsService.get("llm");
    for await (const ev of this.provider.streamTurn({
      systemPrompt,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      model: llm.vendors[llm.provider].model,
    })) {
      if (ev.type === "text_delta" && ev.text) text += ev.text;
      if (ev.type === "message_complete") break;
      if (ev.type === "error") throw new Error(`LLM stream error: ${ev.error}`);
    }
    return text.trim();
  }

  /** 현재 벤더 이름 */
  getVendor(): string {
    return this.provider?.vendor ?? "none";
  }

  /** 대화 이력 초기화 (새 대화) — §4.5.7 */
  newConversation(): void {
    if (this.history.length > 0) {
      this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages()).catch((err: unknown) => {
        log.warn("newConversation saveSession failed: %s", (err as Error).message);
      });
    }
    // C2(c): drop the previous session's loaded skills so a fresh chat
    // starts with a clean overlay. Tests / stubs without overlay omit this.
    this.deps.skillOverlay?.clear(this.sessionId);
    this.sessionId = crypto.randomUUID();
    this.sessionRoutineId = null;
    this.history.clear();
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.sessionStartedAt = Date.now();
    this.lastCheckpointMessageIndex = 0;
    this.sessionPluginExpansions = 0;
    this.tracer = createTracer(this.sessionId);
    // PR-4: clear rolling summary preamble for fresh session
    this.deps.systemPromptBuilder.setSummaryPreamble?.(null);
  }

  getHistory(): ConversationHistory {
    return this.history;
  }

  getSessionId(): string {
    return this.sessionId;
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

  private isAutoCompactEnabled(): boolean {
    return this.deps.settingsService.get("chat").autoCompact ?? true;
  }

  /** 세션 목록 조회 — §4.5.7 */
  listSessions(limit?: number): Array<{ id: string; modifiedAt: Date; title: string; preview: string }> {
    return this.deps.memoryManager.listSessions(limit);
  }

  listRoutineSessions(routineId: string, limit?: number): Array<{ id: string; modifiedAt: Date; title: string; preview: string }> {
    return this.deps.memoryManager.listSessionsByRoutine(routineId, limit);
  }

  /** 기존 세션 복원 — §4.5.7 */
  loadSession(sessionId: string): boolean {
    const messages = this.deps.memoryManager.loadSession(sessionId);
    if (!messages) return false;

    // 현재 세션 저장 후 전환
    if (this.history.length > 0) {
      this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages()).catch((err: unknown) => {
        log.warn("loadSession saveSession failed: %s", (err as Error).message);
      });
    }

    const normalized = normalizeToolPairInvariant(messages as import("./llm/types.js").GenericMessage[]);
    if (normalized.removedMessages > 0 || normalized.removedToolCalls > 0) {
      log.warn(
        `loadSession: repaired invalid tool history for ${sessionId} (removedMessages=${normalized.removedMessages}, removedToolCalls=${normalized.removedToolCalls})`,
      );
      void this.deps.memoryManager.saveSession(sessionId, normalized.messages).catch((err: unknown) => {
        log.warn("loadSession repair saveSession failed: %s", (err as Error).message);
      });
    }

    this.sessionId = sessionId;
    const sessionMeta = this.deps.memoryManager.loadSessionMetadata(sessionId);
    this.sessionRoutineId = sessionMeta?.routineId ?? null;
    this.history.clear();
    this.history.restore(normalized.messages);
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.sessionStartedAt = Date.now();
    this.lastCheckpointMessageIndex = 0;
    this.sessionPluginExpansions = 0;
    this.tracer = createTracer(this.sessionId);
    // PR-4: inject rolling summary preamble from loaded session metadata
    const preamble = sessionMeta?.summaryPreamble ?? null;
    this.deps.systemPromptBuilder.setSummaryPreamble?.(preamble);
    return true;
  }

  async startRoutineConversation(routineId: string, routineTitle: string): Promise<string> {
    this.newConversation();
    this.sessionRoutineId = routineId;
    await this.deps.memoryManager.saveSession(this.sessionId, []);
    await this.deps.memoryManager.saveSessionMetadata(this.sessionId, { routineId, routineTitle });
    return this.sessionId;
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
    const loaded = this.loadSession(sessionId);
    if (!loaded) {
      return { ok: false, compacted: false, compactedAt: null, removedMessageCount: 0 };
    }

    // Issue 1: loadSession resets cumulativeUsage to zero, so shouldCompact()
    // would never fire on resume. Estimate usage from loaded history instead.
    // Approximation: sum of content char lengths / 4 (same formula as estimateTokens).
    const estimatedInputTokens = this.history.getMessages().reduce((sum, msg) => {
      const content = typeof msg.content === "string" ? msg.content : "";
      return sum + Math.ceil(content.length / 4) + 1;
    }, 0);
    this.cumulativeUsage = { inputTokens: estimatedInputTokens, outputTokens: 0 };

    let compacted = false;
    let removedMessageCount = 0;
    if (this.isAutoCompactEnabled()) {
      const llmSettings = this.deps.settingsService.get("llm");
      if (shouldCompact(this.cumulativeUsage, getModelContextWindow(llmSettings.provider, llmSettings.vendors[llmSettings.provider].model))) {
        const { messages: compactedMsgs, result: cr } = compactMessages(this.history.getMessages());
        if (cr.compacted) {
          this.history.clear();
          this.history.restore(compactedMsgs);
          compacted = true;
          removedMessageCount = cr.removedMessages;
        }
      }
    }

    return {
      ok: true,
      compacted,
      compactedAt: compacted ? new Date().toISOString() : null,
      removedMessageCount,
    };
  }

  /**
   * §4.5.4 B1 — Manual compact trigger.
   * Forces compactMessages on current history and returns result metadata.
   */
  manualCompact(): {
    compacted: boolean;
    compactedAt: string | null;
    summary: string;
    removedMessageCount: number;
  } {
    const { messages: compactedMsgs, result: cr } = compactMessages(this.history.getMessages());
    if (cr.compacted) {
      this.history.clear();
      this.history.restore(compactedMsgs);
      // Issue 2: persist compacted state so next resume sees the compacted history.
      void Promise.resolve(
        this.deps.memoryManager?.saveSession(this.sessionId, this.history.getMessages()),
      ).catch((err: unknown) => {
        log.warn("manualCompact saveSession failed: %s", (err as Error).message);
      });
      return {
        compacted: true,
        compactedAt: new Date().toISOString(),
        summary: `${cr.removedMessages}개 메시지 요약됨, ~${cr.freedTokens} 토큰 확보`,
        removedMessageCount: cr.removedMessages,
      };
    }
    return {
      compacted: false,
      compactedAt: null,
      summary: "컴팩트 불필요: 메시지 수가 충분히 적습니다.",
      removedMessageCount: 0,
    };
  }

  /**
   * 한 턴 실행 — §4.5 Core Cycle
   * @param abortSignal  B4: optional external abort signal; if omitted a fresh
   *                     AbortController is created and stored in
   *                     `currentAbortController` so `abortCurrentTurn()` works.
   * @param options      P0 Brain: `originSource` enables the Proactive Origin
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
       * SubAgentRunner to enforce the agent_spawn `maxTurns` parameter at
       * the loop boundary instead of leaning on `abortCurrentTurn()` which
       * only halts the next streaming response.
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
    },
  ): Promise<TurnResult> {
    const effectiveSessionId = options?.sessionIdOverride ?? this.sessionId;
    this.deps.sessionTodoStore?.clearIfAllCompleted(effectiveSessionId);

    // §4.5.2 step 1 — REQUEST_ENTRY (main process 도달 시점)
    this.tracer.step("REQUEST_ENTRY", { inputLen: input.length });
    if (!this.provider) {
      const err = "LLM 프로바이더가 설정되지 않았습니다. 설정에서 벤더와 API 키를 확인해 주세요.";
      callbacks?.onError?.(err);
      throw new Error(err);
    }

    // Snapshot vendor/model now so audit attribution survives mid-turn
    // settings mutation (retry-effort patches thinking config and reverts
    // in finally; user can switch vendor while a turn is streaming).
    const llm = this.deps.settingsService.get("llm");
    const turnVendorProvider = llm.provider;
    const turnVendorModel = llm.vendors[llm.provider].model;

    // B4: set up abort controller for this turn
    const ac = new AbortController();
    this.currentAbortController = ac;
    if (abortSignal?.aborted) {
      ac.abort();
    } else {
      abortSignal?.addEventListener("abort", () => ac.abort(), { once: true });
    }
    const turnSignal = ac.signal;


    // §4.3 Step 1-2: 분류 + 라우팅
    // §4.5.2 step 2 — KEYWORD_CLASSIFY
    const classification = this.deps.keywordEngine.classify(input);
    this.tracer.step("KEYWORD_CLASSIFY", { type: classification.type });
    // §4.5.2 step 3 — ROUTE_RESOLVE
    const routeResult = this.deps.routeEngine.route(classification);
    this.tracer.step("ROUTE_RESOLVE", { route: routeResult.route });

    if (routeResult.route === "command") {
      this.currentAbortController = null;
      return this.handleCommand(routeResult.command, routeResult.args, callbacks);
    }

    // §4.5.2 step 4 — TURN_ORCHESTRATE
    this.tracer.step("TURN_ORCHESTRATE", { sessionId: this.sessionId });

    // Turn aggregate footer tracking — see TurnCallbacks.onTurnSummary.
    // Wrap the caller-supplied tool callbacks so per-call durationMs (when
    // available on the executor's `meta`) feeds into the cumulative slice
    // without forcing every caller to instrument tool callbacks. The
    // start-time map keys on `toolUseId` so parallel tool calls within a
    // round don't clobber each other. When the executor PR (companion)
    // attaches a `durationMs` field directly to `meta`, we prefer that;
    // otherwise we synthesize ms from start→end wall-clock.
    const turnStartedAt = Date.now();
    let turnTokensIn = 0;
    let turnTokensOut = 0;
    let turnToolCount = 0;
    let turnCumulativeToolMs = 0;
    const turnToolStarts = new Map<string, number>();
    const turnToolBreakdown = new Map<string, { count: number; ms: number }>();
    const wrappedCallbacks: TurnCallbacks | undefined = callbacks
      ? {
          ...callbacks,
          onToolStart: (name, input, meta) => {
            turnToolStarts.set(meta.toolUseId, Date.now());
            callbacks.onToolStart?.(name, input, meta);
          },
          onToolEnd: (name, result, isError, meta, uiPayload, durationMs) => {
            const startedAt = turnToolStarts.get(meta.toolUseId);
            turnToolStarts.delete(meta.toolUseId);
            // Prefer the executor-provided durationMs (companion PR
            // `feat/tool-execution-duration-display`, now merged); fall
            // back to wall-clock between start/end if absent. When start
            // was never recorded (mid-turn instrumentation) we contribute
            // 0 ms.
            const elapsed =
              typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0
                ? durationMs
                : startedAt !== undefined
                  ? Math.max(0, Date.now() - startedAt)
                  : 0;
            turnToolCount += 1;
            turnCumulativeToolMs += elapsed;
            const prev = turnToolBreakdown.get(name) ?? { count: 0, ms: 0 };
            turnToolBreakdown.set(name, { count: prev.count + 1, ms: prev.ms + elapsed });
            callbacks.onToolEnd?.(name, result, isError, meta, uiPayload, elapsed);
          },
        }
      : undefined;
    const callbacksForLoop = wrappedCallbacks ?? callbacks;

    const baseText = routeResult.route === "skill"
      ? `[스킬: ${routeResult.skillId}] ${input}`
      : input;
    const attachmentParts = options?.attachments ?? [];
    const userContent: string | import("./llm/types.js").UserContentPart[] =
      attachmentParts.length > 0
        ? [{ type: "text" as const, text: baseText }, ...attachmentParts]
        : baseText;

    this.history.append({ role: "user", content: userContent });
    // §4.5.2 step 5 — HISTORY_APPEND
    this.tracer.step("HISTORY_APPEND", { role: "user", historySize: this.history.length });

    // Phase 1 Lazy Tool Scoping — 이 턴에서 노출할 plugin 집합 결정.
    // SystemPromptBuilder Tool Schemas 섹션도 동일 scope로 필터링되도록
    // build() 호출 전에 setToolScope 수행.
    const scope = this.resolveToolScope(input);
    // Guard: test mocks may stub SystemPromptBuilder without this method.
    this.deps.systemPromptBuilder.setToolScope?.(scope);
    // Brain origin: set + clear synchronously around build() so concurrent
    // turns do not see each other's flag. SystemPromptBuilder has a single
    // `originSource` slot; if we straddled an await we'd race.
    this.deps.systemPromptBuilder.setOriginSource?.(options?.originSource ?? null);
    // C2(c): scope the SkillOverlay section to this session id. The setter
    // is optional on the prompt builder so legacy unit-test stubs without
    // skill overlay support keep working unchanged.
    this.deps.systemPromptBuilder.setActiveSessionId?.(this.sessionId);

    const systemPrompt = this.deps.systemPromptBuilder.build();
    // Clear immediately so any nested or follow-up build() inside the same
    // tick (or a concurrent runTurn that starts during the upcoming await)
    // sees a clean slate.
    this.deps.systemPromptBuilder.setOriginSource?.(null);
    this.deps.systemPromptBuilder.setActiveSessionId?.(null);
    // §4.5.2 step 6 — PROMPT_ASSEMBLE
    this.tracer.step("PROMPT_ASSEMBLE", { promptLen: systemPrompt.length, activePlugins: scope.activePluginIds.size });
    let result: Awaited<ReturnType<ConversationLoop["queryLoop"]>>;
    try {
      result = await this.queryLoop(
        systemPrompt,
        scope,
        callbacksForLoop,
        turnSignal,
        options?.originSource ?? null,
        {
          maxRounds: options?.maxRounds,
          sessionIdOverride: options?.sessionIdOverride,
          spawnDepth: options?.spawnDepth,
        },
      );
    } finally {
      // Always clear the controller, even when `queryLoop` throws (provider
      // error / abort / tool error). Otherwise the loop looks "mid-turn"
      // forever to anyone consulting `currentAbortController` (e.g.
      // TriggerExecutor's chat-busy guard), and a single failed chat turn
      // would permanently block trigger imports.
      this.currentAbortController = null;
    }
    // lastTurnScope must reflect any Option C request_plugin expansions so
    // the next turn's keyword-miss fallback keeps those plugins visible.
    this.lastTurnScope = new Set(scope.activePluginIds);

    // §4.5.2 step 11 — POST_TURN
    this.tracer.step("POST_TURN", {
      toolCallCount: result.toolCalls.length,
      stopReason: result.stopReason,
    });
    // §4.5.5 Post-Turn Hook Chain (Agent 6: compact → saveSession → extractMemory → detect-checkpoint → update-title → audit → idle-poke)
    if (this.deps.postTurnHookChain) {
      const hookResult = await this.deps.postTurnHookChain.run({
        sessionId: this.sessionId,
        messages: this.history.getMessages(),
        cumulativeUsage: this.cumulativeUsage,
        input,
        output: result.text,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, isError: false })),
        tokenUsage: result.usage,
        route: routeResult.route,
        vendorProvider: turnVendorProvider,
        vendorModel: turnVendorModel,
      });
      // compact가 발생했으면 history 교체
      if (hookResult.compactedMessages) {
        this.history.clear();
        this.history.restore(hookResult.compactedMessages);
      }
      // §PR-3: cleaned text (markers stripped) replaces raw output for caller
      if (hookResult.detector.cleanedText !== result.text) {
        result = { ...result, text: hookResult.detector.cleanedText };
      }
    } else {
      // fallback: PostTurnHookChain 미주입 시 기존 inline 로직 유지.
      // cycle 1 MED: extractMemory 중복 제거 — memory-extract hook이
      // PostTurnHookChain에서 이미 처리하므로 fallback에서도 호출하지 않는다.
      // PostTurnHookChain을 주입한 경우와 fallback 모두 memory 추출은
      // hook chain의 memory-extract 단계에서만 일어난다.
      const llmSettings = this.deps.settingsService.get("llm");
      if (this.isAutoCompactEnabled() && shouldCompact(this.cumulativeUsage, getModelContextWindow(llmSettings.provider, llmSettings.vendors[llmSettings.provider].model))) {
        const { messages: compacted, result: cr } = compactMessages(this.history.getMessages());
        if (cr.compacted) {
          this.history.clear();
          this.history.restore(compacted);
          if (process.env.NODE_ENV !== "production") log.info(`auto-compact: removed ${cr.removedMessages} msgs, freed ~${cr.freedTokens} tokens`);
          callbacks?.onCompactOccurred?.({ removedMessages: cr.removedMessages, freedTokens: cr.freedTokens });
        }
      }
      await this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages());
      // Mirror PostTurnHookChain's audit-route format so usage attribution
      // stays consistent across both code paths. SubAgentRunner constructs
      // child loops with `postTurnHookChain: undefined`, which would
      // otherwise log every sub-agent LLM turn as the bare `"llm"` route
      // and lose vendor/model granularity in `~/.lvis/audit.jsonl`.
      const auditRoute =
        routeResult.route === "llm"
          ? `${turnVendorProvider}/${turnVendorModel}`
          : routeResult.route;
      this.auditLogger.logTurn({
        sessionId: this.sessionId,
        input,
        output: result.text,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, isError: false })),
        tokenUsage: result.usage,
        route: auditRoute,
      });
      this.deps.idleScheduler?.signalConversation();
    }

    // PR-4: 3-tier rotation orchestration. 2026-05-04 incident 정정: turn
    // 이 *완전 종료* 됐을 때만 rotation. stopReason==="interrupted" /
    // empty text / 마지막이 tool_result 인 (LLM 이 도구 후 답을 못 한)
    // 케이스는 incomplete turn 으로 보고 회전 보류. notification (line 695-)
    // 와 동일한 turn-completeness 판정.
    await this.runRotationCheck(result.text, result.stopReason, callbacks);

    // Turn aggregate footer — see TurnCallbacks.onTurnSummary doc above.
    // Tokens come from the LLM provider's usage report (Vercel AI SDK
    // exposes prompt_tokens + completion_tokens via the provider's
    // streamText/onFinish equivalent — see `engine/llm/vercel/adapter.ts`
    // and `engine/llm/vercel/stream-mapper.ts` which forward the values
    // into the round stream's `usage` field). Suppressed for interrupted
    // turns and turns without a real assistant response (mirrors the
    // turn-end notification gate so dropped turns don't render footers).
    if (
      result.stopReason !== "interrupted" &&
      typeof result.text === "string" &&
      result.text.trim().length > 0
    ) {
      turnTokensIn = result.usage?.inputTokens ?? 0;
      turnTokensOut = result.usage?.outputTokens ?? 0;
      const breakdown =
        turnToolBreakdown.size > 0
          ? Object.fromEntries(turnToolBreakdown.entries())
          : undefined;
      try {
        callbacks?.onTurnSummary?.({
          turnDurationMs: Math.max(0, Date.now() - turnStartedAt),
          toolCount: turnToolCount,
          cumulativeToolMs: turnCumulativeToolMs,
          tokensIn: turnTokensIn,
          tokensOut: turnTokensOut,
          ...(breakdown ? { breakdown } : {}),
        });
      } catch {
        // Summary emission must never break turn completion.
      }
    }

    callbacks?.onTurnComplete?.(result.text);

    // Issue #260 — fire system notification on turn-end. Skip if the turn
    // was interrupted (user aborted) or produced no assistant text (rare
    // tool-only termination). Body is the leading slice of the assistant
    // response — NotificationService caps + ellipses it.
    if (
      result.stopReason !== "interrupted" &&
      typeof result.text === "string" &&
      result.text.trim().length > 0
    ) {
      try {
        this.deps.notificationService?.fire({
          kind: "turn-end",
          title: "응답 완료",
          body: result.text,
          contextRef: { sessionId: this.sessionId },
        });
      } catch {
        // notification failure must never block turn completion
      }
    }

    return { ...result, route: routeResult.route };
  }

  // ─── Private: Query Loop (벤더 추상화) ────────────

  private async queryLoop(
    systemPrompt: string,
    scope: ToolScope,
    callbacks?: TurnCallbacks,
    abortSignal?: AbortSignal,
    proactiveOrigin?: string | null,
    bounds?: {
      maxRounds?: number;
      sessionIdOverride?: string;
      spawnDepth?: number;
    },
  ): Promise<{ text: string; toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>; usage?: TokenUsage; stopReason?: "end_turn" | "tool_use" | "interrupted" }> {
    const llmSettings = this.deps.settingsService.get("llm");
    const activeBlock = llmSettings.vendors[llmSettings.provider];
    const model = activeBlock.model;
    // Wire per-turn onFallback callback into FallbackProvider when available.
    if (this.provider instanceof FallbackProvider) {
      this.provider.setCallbacks({ onFallback: callbacks?.onFallback });
    }
    // Phase 1.5 Option C: scope is mutable within the turn. Mutating the
    // caller's Set directly means the next turn's fallback sees every plugin
    // that was activated here.
    let toolSchemas: ToolSchema[] = this.rebuildToolSchemas(scope);
    const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
    let turnUsage: TokenUsage | undefined;
    let pluginExpansions = 0;
    let knowledgeCallCount = 0;
    let roundIndex = 0;
    // Reactive compact recovery: turn당 1회만 허용
    let reactiveCompacted = false;
    // C3(a): assistant-round counter — used by the maxRounds break below.
    let assistantRoundsRun = 0;
    // C3(a): effective round budget. Default = MAX_TOOL_ROUNDS (10); when a
    // caller supplies maxRounds (sub-agent runner) clamp to it. Negative or
    // zero falls back to default so legacy callers keep working unchanged.
    const requestedMaxRounds = bounds?.maxRounds;
    const effectiveMaxRounds =
      typeof requestedMaxRounds === "number" && Number.isFinite(requestedMaxRounds) && requestedMaxRounds > 0
        ? Math.min(MAX_TOOL_ROUNDS, Math.floor(requestedMaxRounds))
        : MAX_TOOL_ROUNDS;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // C3(a): hard guard between rounds — if we have already executed
      // `effectiveMaxRounds` assistant turns, stop cleanly and return the
      // last text. This is the loop-boundary defense the agent_spawn
      // turn-cap leans on (callbacks calling abortCurrentTurn only halts
      // the next streaming response, not pending tool execution).
      if (assistantRoundsRun >= effectiveMaxRounds) {
        return {
          text: allToolCalls.length > 0
            ? `(round cap ${effectiveMaxRounds} reached — last assistant text: ${this.history.getMessages().filter((m) => m.role === "assistant").slice(-1)[0]?.content ?? ""})`
            : `(round cap ${effectiveMaxRounds} reached without assistant output)`,
          toolCalls: allToolCalls,
          usage: turnUsage,
        };
      }
      // §4.5.2 step 7 — LLM_STREAM
      this.tracer.step("LLM_STREAM", { round, model, toolCount: toolSchemas.length });

      const repaired = this.history.repairToolPairInvariant();
      if (repaired.removedMessages > 0 || repaired.removedToolCalls > 0) {
        log.warn(
          `queryLoop: repaired invalid tool history before provider call (removedMessages=${repaired.removedMessages}, removedToolCalls=${repaired.removedToolCalls})`,
        );
      }

      // ─── Stream 1차 시도 → context-length 에러면 reactive compact 후 재시도 ───
      let stream = await collectRoundStream({
        provider: this.provider!,
        model,
        systemPrompt,
        messages: this.history.getMessages(),
        toolSchemas,
        llmSettings: { ...activeBlock, streamSmoothing: llmSettings.streamSmoothing },
        abortSignal,
        onReasoningDelta: callbacks?.onReasoningDelta,
        onTextDelta: callbacks?.onTextDelta,
        reactiveCompacted,
      });

      if (stream.kind === "context_error" && !reactiveCompacted) {
        reactiveCompacted = true;
        const retried = this.tryReactiveCompact(callbacks);
        if (retried) {
          stream = await collectRoundStream({
            provider: this.provider!,
            model,
            systemPrompt,
            messages: this.history.getMessages(),
            toolSchemas,
            llmSettings: { ...activeBlock, streamSmoothing: llmSettings.streamSmoothing },
            abortSignal,
            onReasoningDelta: callbacks?.onReasoningDelta,
            onTextDelta: callbacks?.onTextDelta,
            reactiveCompacted,
          });
        } else {
          throw new Error(stream.errorMessage);
        }
      }

      if (stream.kind === "stream_error") {
        callbacks?.onError?.(stream.userMessage);
        this.history.append({ role: "assistant", content: stream.userMessage });
        return { text: stream.userMessage, toolCalls: allToolCalls, usage: turnUsage };
      }

      if (stream.kind === "interrupted") {
        const savedText = (stream.text ?? "") + "\n\n[중단됨]";
        this.history.append({ role: "assistant", content: savedText });
        callbacks?.onTextDelta?.("\n\n[중단됨]");
        return { text: savedText, toolCalls: allToolCalls, usage: turnUsage, stopReason: "interrupted" };
      }

      // stream.kind === "context_error" 이면서 reactiveCompacted=true 인 경우는 위 재시도 분기에서 이미 재할당.
      if (stream.kind === "context_error") {
        throw new Error(stream.errorMessage);
      }

      // stream.kind === "ok" — usage 반영 + assistant round commit
      if (stream.usage) {
        turnUsage = stream.usage;
        this.cumulativeUsage.inputTokens += stream.usage.inputTokens;
        this.cumulativeUsage.outputTokens += stream.usage.outputTokens;
      }

      const { text: textContent, thought: thoughtContent, thinkingBlocks: roundThinkingBlocks, toolCalls: pendingToolCalls, stopReason } = stream;

      // R2-CR-1: cap BEFORE persisting to history. Anthropic + OpenAI strict
      // APIs reject mismatches between assistant.tool_use blocks and the
      // tool_result blocks in the next user turn. If we keep the un-capped
      // pendingToolCalls in history, blocks 11..N never receive a matching
      // tool_result (executor only runs the capped slice) and the next
      // request 400s. Persist only what will be answered.
      let pendingToolCallsCapped = pendingToolCalls;
      const wasCapped = pendingToolCalls.length > MAX_TOOL_CALLS_PER_ROUND;
      if (wasCapped) {
        log.warn(
          `conversation-loop: round ${roundIndex} emitted ${pendingToolCalls.length} tool_use blocks, capping to ${MAX_TOOL_CALLS_PER_ROUND}`,
        );
        pendingToolCallsCapped = pendingToolCalls.slice(0, MAX_TOOL_CALLS_PER_ROUND);
      }

      // thinkingBlocks는 tool_use 체인이 이어지는 다음 요청에만 signature 그대로 포함되어야 Anthropic이 수락한다.
      const preserveThinkingBlocks = stopReason === "tool_use" && pendingToolCallsCapped.length > 0;
      this.history.append({
        role: "assistant",
        content: wasCapped ? `${textContent}\n\n[capped at ${MAX_TOOL_CALLS_PER_ROUND} of ${pendingToolCalls.length} tool_use blocks]` : textContent,
        ...(thoughtContent && { thought: thoughtContent }),
        ...(preserveThinkingBlocks && roundThinkingBlocks.length > 0 && { thinkingBlocks: roundThinkingBlocks }),
        // R2-CR-1: persist only the capped slice — these are the only blocks
        // that will receive a matching tool_result. Streaming UI still sees
        // the un-capped count below via the assistant-round callback so the
        // user can observe the original LLM intent (and the cap message).
        ...(pendingToolCallsCapped.length > 0 && { toolCalls: pendingToolCallsCapped }),
      });

      // §4.5.2 step 8 — REASONING_ACCUMULATE
      if (thoughtContent.length > 0) {
        this.tracer.step("REASONING_ACCUMULATE", { round: roundIndex, thoughtLen: thoughtContent.length });
      }
      callbacks?.onAssistantRound?.({
        roundIndex,
        text: textContent,
        thought: thoughtContent,
        stopReason,
        // The UI / telemetry callback receives the un-capped count so the
        // user sees the LLM's full intent — only persisted history is capped.
        hasToolCalls: pendingToolCalls.length > 0,
      });
      // §4.5.2 step 10 — ROUND_COMMIT
      this.tracer.step("ROUND_COMMIT", {
        round: roundIndex,
        stopReason,
        textLen: textContent.length,
        toolCallCount: pendingToolCalls.length,
      });
      roundIndex += 1;
      // C3(a): a "round" for cap purposes is any assistant message we
      // committed to history — `end_turn` and `tool_use` both count.
      assistantRoundsRun += 1;

      if (pendingToolCalls.length === 0 || stopReason === "end_turn") {
        return { text: textContent, toolCalls: allToolCalls, usage: turnUsage };
      }

      // §4.5.6 tool execution — request_plugin 가로채기 + knowledge depth cap + executor 호출
      // (cap already applied above before history commit; pendingToolCallsCapped is the
      //  authoritative slice that flows through executor and produces tool_result blocks.)
      const toolUses: ToolUseBlock[] = pendingToolCallsCapped.map((tc) => ({
        id: tc.id, name: tc.name, input: tc.input,
      }));

      const prevToolCount = toolSchemas.length;
      const pluginOutcome = handleRequestPlugin(toolUses, {
        turnExpansions: pluginExpansions,
        sessionExpansions: this.sessionPluginExpansions,
        activePluginIds: scope.activePluginIds,
        availablePluginIds: this.deps.pluginRuntime?.listPluginIds() ?? [],
      });
      pluginExpansions = pluginOutcome.nextTurnExpansions;
      this.sessionPluginExpansions = pluginOutcome.nextSessionExpansions;

      // 활성화 성공했으면 tool schema 재빌드 + 추가된 tool 수 보고
      const rebuiltAfterPlugin = pluginOutcome.activatedPluginIds.length > 0;
      if (rebuiltAfterPlugin) {
        toolSchemas = this.rebuildToolSchemas(scope);
      }
      const addedToolCount = Math.max(0, toolSchemas.length - prevToolCount);
      for (const rr of pluginOutcome.results) {
        const finalContent = !rr.is_error && rebuiltAfterPlugin
          ? `${rr.content} ${addedToolCount}개 도구 추가됨 (현재 ${toolSchemas.length}개 사용 가능).`
          : rr.content;
        this.history.append({
          role: "tool_result",
          toolUseId: rr.tool_use_id,
          toolName: REQUEST_PLUGIN_TOOL,
          content: finalContent,
          ...(rr.is_error && { isError: true }),
        });
      }
      for (const activated of pluginOutcome.activatedPluginIds) {
        allToolCalls.push({
          name: REQUEST_PLUGIN_TOOL,
          input: { pluginId: activated },
          result: `activated:${activated}`,
        });
      }

      // request_plugin만 있으면 다음 round 로 — 성공 시 round 예산 돌려받기 (C9)
      if (pluginOutcome.remaining.length === 0) {
        if (pluginOutcome.activatedPluginIds.length > 0) round--;
        continue;
      }

      // §11 knowledge depth cap
      const capResult = applyKnowledgeDepthCap(pluginOutcome.remaining, knowledgeCallCount);
      knowledgeCallCount = capResult.nextCount;

      // §4.5.2 step 9 — TOOL_EXECUTE
      this.tracer.step("TOOL_EXECUTE", {
        round: roundIndex,
        toolNames: capResult.allowed.map((tu) => tu.name),
        capped: capResult.blocked.length,
      });
      const toolResults = await this.toolExecutor.executeAll(
        capResult.allowed,
        {
          onToolStart: callbacks?.onToolStart,
          onToolEnd: callbacks?.onToolEnd,
        },
        // C3(c): sub-agents pass their childSessionId so audit attribution
        // for tool calls flows to the child, not the parent. Falls back to
        // this loop's sessionId for normal interactive turns.
        bounds?.sessionIdOverride ?? this.sessionId,
        // Forward the turn's proactive origin so write/dangerous tools
        // bypass `allow-always` cache and force a user-confirmation
        // modal — the hard gate for the brain's "propose-only" contract.
        proactiveOrigin ?? null,
        // C3(b): carry spawn depth into ToolExecutionContext.metadata.
        // The executor uses this to refuse `agent_spawn` calls inside an
        // already-spawned sub-agent (depth >= 1).
        bounds?.spawnDepth,
        // Threading the turn's abort signal lets long-blocking tools
        // (`ask_user_question`) honor the user's 중단 button instead of
        // hanging until their internal timeout.
        abortSignal,
      );

      for (let i = 0; i < capResult.allowed.length; i++) {
        allToolCalls.push({
          name: capResult.allowed[i].name,
          input: capResult.allowed[i].input,
          result: toolResults[i]?.content ?? "(missing)",
        });
      }
      for (const blocked of capResult.blocked) {
        const origTool = pluginOutcome.remaining.find((tu) => tu.id === blocked.tool_use_id);
        if (origTool) {
          allToolCalls.push({ name: origTool.name, input: origTool.input, result: blocked.content });
        }
      }

      // tool_result 히스토리 append → loop back
      const allResults = [...toolResults, ...capResult.blocked];
      for (const tr of allResults) {
        this.history.append({
          role: "tool_result",
          toolUseId: tr.tool_use_id,
          toolName: pluginOutcome.remaining.find((tu) => tu.id === tr.tool_use_id)?.name,
          content: tr.content,
          ...(tr.is_error && { isError: true }),
        });
      }
    }

    return { text: "(도구 실행 라운드 한도 초과)", toolCalls: allToolCalls, usage: turnUsage };
  }

  /** Tool registry → LLM 이 받는 ToolSchema 배열로 변환. scope 필터 반영. */
  private rebuildToolSchemas(scope: ToolScope): ToolSchema[] {
    const raw = this.deps.toolRegistry.getToolSchemasForScope(scope);
    const result: ToolSchema[] = [];
    for (const s of raw) {
      try {
        result.push({
          name: s.name,
          description: s.description,
          inputSchema: s.input_schema as ToolSchema["inputSchema"],
        });
      } catch (err) {
        log.warn(`rebuildToolSchemas: tool '${s.name}' schema 변환 실패, 건너뜀: %s`, err);
      }
    }
    return result;
  }

  /**
   * Reactive compact — context-length 초과 시 history 를 압축한다.
   * 성공했으면 true 반환 (호출자가 stream 재시도). 실패 시 false.
   */
  private tryReactiveCompact(callbacks?: TurnCallbacks): boolean {
    try {
      const { messages: compactedMsgs, result: cr } = compactMessages(this.history.getMessages(), undefined, "reactive");
      if (!cr.compacted) return false;
      this.history.clear();
      this.history.restore(compactedMsgs);
      if (process.env.NODE_ENV !== "production") {
        log.info(`reactive-compact: removed ${cr.removedMessages} msgs, freed ~${cr.freedTokens} tokens`);
      }
      callbacks?.onCompactOccurred?.({ removedMessages: cr.removedMessages, freedTokens: cr.freedTokens });
      return true;
    } catch (compactErr) {
      log.warn("reactive-compact: compactMessages threw, skipping retry: %s", compactErr);
      return false;
    }
  }

  // ─── Private: Memory Extraction (§4.5.5 Hook 3) ───
  // cycle 1 MED: extractMemory inline 로직 제거.
  // PostTurnHookChain의 memory-extract hook이 단일 진실 소스이며,
  // fallback 경로에서도 중복 추출을 수행하지 않는다.

  // ─── Private: Tool Scope Resolution (Phase 1 Lazy Tool Scoping) ───

  /**
   * 입력에서 활성 plugin 집합을 유도하여 ToolScope를 반환한다.
   *
   * - KeywordEngine.matchAllPluginIds() → 이번 턴 active plugin Set
   * - 매치 없음(일반 대화) → lastTurnScope fallback, 그마저 없으면 빈 Set (builtin-only)
   * - Builtins + MCP는 항상 포함 (host-side tool은 항시 사용 가능)
   */
  private resolveToolScope(input: string): ToolScope {
    const matched = this.deps.keywordEngine.matchAllPluginIds(input);
    const activePluginIds = new Set(matched.size > 0
      ? matched
      : (this.lastTurnScope ?? new Set<string>()));
    for (const pluginId of this.deps.forcedActivePluginIds ?? []) {
      activePluginIds.add(pluginId);
    }
    return {
      activePluginIds,
      includeBuiltins: true,
      includeMcp: true,
    };
  }

  // ─── Private: Command Handler ─────────────────────

  private async handleCommand(
    command: string,
    args: string,
    callbacks?: TurnCallbacks,
  ): Promise<TurnResult> {
    let result: string;

    switch (command) {
      case "new":
        this.newConversation();
        result = "새 대화를 시작합니다.";
        break;
      case "remember": {
        if (!args.trim()) { result = "사용법: /remember 기억할 내용"; break; }
        const title = args.slice(0, 40).replace(/\n/g, " ");
        await this.deps.memoryManager.saveMemory(title, args);
        result = `메모 저장됨: ${title}`;
        break;
      }
      case "memory": {
        const memories = this.deps.memoryManager.listMemoryEntries();
        result = memories.length === 0
          ? "저장된 메모 없음."
          : memories.map((n) => `- ${n.title} (${n.filename})`).join("\n");
        break;
      }
      case "sessions": {
        const sessions = this.listSessions(10);
        if (sessions.length === 0) { result = "저장된 세션 없음."; break; }
        const current = this.sessionId;
        result = sessions.slice(0, 10).map((s) => {
          const marker = s.id === current ? " ← 현재" : "";
          const date = s.modifiedAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
          return `- ${s.id.slice(0, 8)}… (${date})${marker}`;
        }).join("\n");
        result = `세션 목록 (최근 10개):\n${result}\n\n세션 전환: /load <세션ID>`;
        break;
      }
      case "load": {
        if (!args.trim()) { result = "사용법: /load <세션ID>"; break; }
        const targetId = args.trim();
        // 부분 ID 매칭
        const sessions = this.listSessions();
        const match = sessions.find((s) => s.id.startsWith(targetId));
        if (!match) { result = `세션을 찾을 수 없습니다: ${targetId}`; break; }
        const loaded = this.loadSession(match.id);
        result = loaded
          ? `세션 복원됨: ${match.id.slice(0, 8)}… (${this.history.length}개 메시지)`
          : `세션 로드 실패: ${match.id}`;
        break;
      }
      case "vendor":
        result = `현재 벤더: ${this.getVendor()}\n세션: ${this.sessionId.slice(0, 8)}…\n누적 토큰: 입력 ${this.cumulativeUsage.inputTokens}, 출력 ${this.cumulativeUsage.outputTokens}`;
        break;
      case "compact": {
        const { messages: compacted, result: cr } = compactMessages(this.history.getMessages());
        if (cr.compacted) {
          this.history.clear();
          this.history.restore(compacted);
          void this.deps.memoryManager?.saveSession(this.sessionId, this.history.getMessages())
            .catch((e: Error) => log.warn("/compact saveSession: %s", e.message));
          result = `컴팩트 완료: ${cr.removedMessages}개 메시지 제거, ~${cr.freedTokens} 토큰 확보`;
        } else {
          result = "컴팩트 불필요: 메시지 수가 충분히 적습니다.";
        }
        break;
      }
      case "tools": {
        const tools = this.deps.toolRegistry.getVisibleTools();
        result = tools.map((t) => `${t.name} [${t.source}]`).join("\n") || "등록된 도구 없음";
        break;
      }
      case "help":
        result = `LVIS 명령어:
/new — 새 대화 시작
/sessions — 저장된 세션 목록
/load <ID> — 세션 복원
/compact — 대화 이력 압축
/remember <내용> — 메모 저장
/memory — 사용자 메모 목록
/vendor — 현재 벤더/토큰 정보
/tools — 등록된 도구 목록
/help — 이 도움말`;
        break;
      default:
        result = `알 수 없는 명령어: /${command}\n사용 가능: /new, /sessions, /load, /compact, /remember, /memory, /vendor, /tools, /help`;
    }

    callbacks?.onTextDelta?.(result);
    callbacks?.onTurnComplete?.(result);
    return { text: result, toolCalls: [], route: "command" };
  }

  // ─── PR-4: 3-Tier Rotation ────────────────────────

  /**
   * 매 턴 종료 후 호출. 3-tier rotation 결정 트리를 평가하고
   * 필요 시 summary 생성 → checkpoint 기록 → child session으로 전환.
   */
  private async runRotationCheck(
    lastAssistantText: string,
    stopReason: "end_turn" | "tool_use" | "interrupted" | undefined,
    callbacks?: TurnCallbacks,
  ): Promise<void> {
    if (!this.provider) return;

    // 2026-05-04 incident: turn-completeness guards. 4 케이스에서 rotation 보류:
    //
    //   (A1) stopReason === "interrupted": 사용자가 abort 한 turn — 이어서
    //        하려는 작업이 아직 남아있을 가능성이 큼.
    //   (A2) lastAssistantText.trim() === "": LLM 이 도구 호출 후 빈 답변으로
    //        end_turn — incident 의 직접 원인. assistant 가 사용자에게 final
    //        answer 를 못 준 상태.
    //   (A3) 마지막 history msg.role === "tool_result": tool 후 follow-up
    //        assistant text 가 없음 — A2 와 같은 incomplete state 의 다른
    //        측면 (history 관점). 둘 다 잡으면 좀 더 robust.
    //   (B)  this.justRotated === true: 직전 turn 에서 회전 → 이번 turn 은
    //        skip (OpenCode 패턴 — 회전 직후 즉시 또 회전 트리거되는 race 방지).
    //
    // 어느 하나라도 hit 하면 사용자가 본 *답변 미완료 + 체크포인트 표시*
    // incident 가 차단됨. 첫 두 가드만으로도 직접 원인 막히지만, 4 가드
    // 묶으면 비슷한 latent 케이스 (사용자 abort, race, etc.) 까지 함께 잡힘.
    if (this.justRotated) {
      this.justRotated = false; // one-shot — 다음 turn 부터는 정상 검사
      return;
    }
    if (stopReason === "interrupted") return;
    if (lastAssistantText.trim().length === 0) return;
    const messages = this.history.getMessages();
    if (messages.at(-1)?.role === "tool_result") return;

    const llmSettings = this.deps.settingsService.get("llm");
    const contextWindow = getModelContextWindow(llmSettings.provider, llmSettings.vendors[llmSettings.provider].model);
    const ctxUsage = contextWindow > 0
      ? Math.min(1.0, this.cumulativeUsage.inputTokens / contextWindow)
      : 0;

    const features = this.deps.settingsService.get("features");
    const continuousBackendEnabled = features?.experimentalContinuousBackend ?? false;
    const devMode = process.env.LVIS_DEV === "1";
    const decision = decideRotation({
      ctxUsage,
      sessionAgeMs: Date.now() - this.sessionStartedAt,
      semanticHint: lastAssistantText.includes("[checkpoint-suggested]"),
      continuousBackendEnabled,
      devMode,
    });

    if (!decision.shouldRotate) return;

    try {
      // 마지막 체크포인트 이후 메시지만 요약
      const messagesSinceCheckpoint = messages.slice(this.lastCheckpointMessageIndex);

      const userModel = llmSettings.vendors[llmSettings.provider].model;
      const summary = decision.shouldSkipSummary
        ? null
        : await generateSummary(this.provider, messagesSinceCheckpoint, { model: userModel });

      // 현재 세션 메타데이터에 checkpoint 기록
      const existingMeta = this.deps.memoryManager.loadSessionMetadata(this.sessionId) ?? {};
      const checkpointEntry = {
        id: crypto.randomUUID(),
        triggeredAt: new Date().toISOString(),
        trigger: decision.trigger!,
        ctxUsageAtTrigger: ctxUsage,
        summary,
        messageCountAtTrigger: messages.length,
      };
      const updatedMeta = this.deps.memoryManager.appendCheckpoint(existingMeta, checkpointEntry);
      await this.deps.memoryManager.saveSessionMetadata(this.sessionId, updatedMeta);

      // §457 Phase 3: capture the parent session id BEFORE rotateActive
      // swaps `this.sessionId` to the child. The renderer's revert action
      // resumes the parent — i.e., the pre-rotation conversation surface.
      const parentSessionId = this.sessionId;
      // child session으로 전환
      const childId = await this.createChildSession(this.sessionId, summary);
      // §457 PR-A: notify the renderer with `messagesSinceCheckpoint.length`,
      // not `messages.length`. Only the slice since the previous checkpoint
      // was rolled into this rotation's summary; the older portion was
      // already summarized in a prior checkpoint and is not being "removed"
      // again. Showing the full parent count would inflate the displayed
      // figure on multi-rotation sessions.
      const removedMessageCount = messagesSinceCheckpoint.length;
      this.rotateActive(childId, summary);

      // Notify renderer so the chat surface can render a CheckpointDivider with
      // tier-aware label/color. Reuses `compact_notice` since the user-facing
      // semantic is identical: "older messages were rolled into a summary".
      // freedTokens is best-effort estimated using the same length/4 + 1 formula
      // as estimateTokens() in auto-compact.ts; we keep it inline to avoid an
      // import cycle and to keep this rotation path independent of the
      // serialization layer.
      const freedTokens = messagesSinceCheckpoint.reduce((sum, m) => {
        const c = (m as { content?: unknown }).content;
        const len = typeof c === "string" ? c.length : 0;
        return sum + Math.ceil(len / 4) + 1;
      }, 0);
      callbacks?.onCompactOccurred?.({
        removedMessages: removedMessageCount,
        freedTokens,
        tier: decision.trigger,
        revertSessionId: parentSessionId,
        ...(summary ? { summary } : {}),
      });

      if (process.env.NODE_ENV !== "production") {
        log.info(`rotation: trigger=${decision.trigger} ctxUsage=${ctxUsage.toFixed(2)} childSession=${childId.slice(0, 8)}`);
      }
    } catch (err) {
      // rotation 실패는 대화를 차단하지 않음 — 로그만 남기고 계속
      log.warn("rotation failed: %s", (err as Error).message);
    }
  }

  /**
   * 부모 세션을 기반으로 새 child session을 생성하고 ID를 반환.
   * child session의 metadata에 parentSessionId, summaryPreamble,
   * 그리고 부모의 routineId/routineTitle을 propagate한다.
   */
  private async createChildSession(parentSessionId: string, summary: string | null): Promise<string> {
    const childId = crypto.randomUUID();
    await this.deps.memoryManager.saveSession(childId, []);

    // Propagate routine context from parent so the child session remains
    // associated with the same routine (if any).
    const parentMeta = this.deps.memoryManager.loadSessionMetadata(parentSessionId) ?? {};
    const routineFields: { routineId?: string; routineTitle?: string } = {};
    if (parentMeta.routineId) routineFields.routineId = parentMeta.routineId;
    if (parentMeta.routineTitle) routineFields.routineTitle = parentMeta.routineTitle;

    const baseMeta = { parentSessionId, ...routineFields };
    const childMeta = summary
      ? this.deps.memoryManager.setSummaryPreamble(baseMeta, summary)
      : baseMeta;
    await this.deps.memoryManager.saveSessionMetadata(childId, childMeta);

    return childId;
  }

  /**
   * 현재 활성 세션을 child session으로 전환.
   * - sessionId 교체
   * - history 클리어 (이전 세션은 이미 영속화됨)
   * - cumulativeUsage 리셋
   * - sessionStartedAt 리셋
   * - lastCheckpointMessageIndex 리셋
   * - tracer 리셋 (session-scoped observability state)
   * - sessionPluginExpansions 리셋
   * - summaryPreamble 주입
   */
  private rotateActive(childSessionId: string, summary: string | null): void {
    this.sessionId = childSessionId;
    this.history.clear();
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.sessionStartedAt = Date.now();
    this.lastCheckpointMessageIndex = 0;
    // Reset all session-scoped helpers so the new session starts clean.
    this.tracer = createTracer(childSessionId);
    this.sessionPluginExpansions = 0;
    // 2026-05-04 incident 후속: 회전 직후 한 turn 동안 다음 회전 보류 (one-shot).
    // 막 만들어진 child session 의 첫 user turn 이 끝나도 즉시 또 회전 트리거
    // 되는 race 방지. runRotationCheck 진입부에서 read + clear 됨.
    this.justRotated = true;
    // rolling summary preamble 주입 — 다음 턴부터 LLM context에 포함됨
    this.deps.systemPromptBuilder.setSummaryPreamble?.(summary);
  }
}

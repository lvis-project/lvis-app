/**
 * Conversation Query Loop — §4.5 핵심 에이전틱 사이클
 *
 * 사용자 입력 → KW분류 → 라우팅 → 컨텍스트 조립 → LLM 스트리밍
 * → tool_use 감지 → 도구 실행 → loop back → 응답 완료
 *
 * 벤더 추상화: LLMProvider 인터페이스를 통해 Claude/OpenAI/Gemini/Copilot 통일 처리.
 * claw-code harness 패턴 기반.
 */
import { ConversationHistory } from "./conversation-history.js";
import { ToolExecutor, type ToolUseBlock } from "../tools/executor.js";
import { HookRunner } from "../hooks/hook-runner.js";
import { shouldCompact, compactMessages, getModelContextWindow } from "./auto-compact.js";
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

// ─── Types ──────────────────────────────────────────

export interface TurnCallbacks {
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onToolStart?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta) => void;
  onToolEnd?: (name: string, result: string, isError: boolean, meta: ToolCallMeta, uiPayload?: import("../mcp/types.js").McpUiPayload) => void;
  onAssistantRound?: (round: {
    roundIndex: number;
    text: string;
    thought: string;
    stopReason: "end_turn" | "tool_use";
    hasToolCalls: boolean;
  }) => void;
  onTurnComplete?: (fullText: string) => void;
  onError?: (error: string) => void;
  onCompactOccurred?: (result: { removedMessages: number; freedTokens: number }) => void;
  onFallback?: (from: string, to: string) => void;
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
}

const MAX_TOOL_ROUNDS = 10;

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
    const apiKey = this.deps.settingsService.getSecret(secretKeyFor(vendor));

    // Vertex AI uses service account / ADC — apiKey not required, but project is.
    const isVertex = vendor === "vertex-ai";
    if (!apiKey && !isVertex) {
      this.provider = null;
      return;
    }
    if (isVertex && !llmSettings.vertexProject && !process.env.GOOGLE_CLOUD_PROJECT && !process.env.GCLOUD_PROJECT) {
      this.provider = null;
      return;
    }

    try {
      const baseUrl = llmSettings.baseUrls?.[vendor];
      const primary = createProvider({
        vendor,
        apiKey: apiKey ?? "",
        model: llmSettings.model,
        ...(baseUrl ? { baseUrl } : {}),
        ...(llmSettings.vertexProject ? { vertexProject: llmSettings.vertexProject } : {}),
        ...(llmSettings.vertexLocation ? { vertexLocation: llmSettings.vertexLocation } : {}),
      });
      const chain = (llmSettings.fallbackChain ?? []).filter(
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
   */
  async generateText(
    prompt: string,
    maxTokens = 400,
    systemPrompt = "당신은 LVIS, 사용자의 AI 비서입니다.",
  ): Promise<string> {
    if (!this.provider) throw new Error("LLM provider not configured");
    let text = "";
    for await (const ev of this.provider.streamTurn({
      systemPrompt,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      model: this.deps.settingsService.get("llm").model,
      maxTokens,
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
        console.warn("[lvis] newConversation saveSession failed:", (err as Error).message);
      });
    }
    this.sessionId = crypto.randomUUID();
    this.sessionRoutineId = null;
    this.history.clear();
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.sessionPluginExpansions = 0;
    this.tracer = createTracer(this.sessionId);
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
        console.warn("[lvis] loadSession saveSession failed:", (err as Error).message);
      });
    }

    this.sessionId = sessionId;
    this.sessionRoutineId = this.deps.memoryManager.loadSessionMetadata(sessionId)?.routineId ?? null;
    this.history.clear();
    this.history.restore(messages as import("./llm/types.js").GenericMessage[]);
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.sessionPluginExpansions = 0;
    this.tracer = createTracer(this.sessionId);
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
      if (shouldCompact(this.cumulativeUsage, getModelContextWindow(llmSettings.provider, llmSettings.model))) {
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
        console.warn("[lvis] manualCompact saveSession failed:", (err as Error).message);
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
   */
  async runTurn(input: string, callbacks?: TurnCallbacks, abortSignal?: AbortSignal): Promise<TurnResult> {
    // §4.5.2 step 1 — REQUEST_ENTRY (main process 도달 시점)
    this.tracer.step("REQUEST_ENTRY", { inputLen: input.length });
    if (!this.provider) {
      const err = "LLM 프로바이더가 설정되지 않았습니다. 설정에서 벤더와 API 키를 확인해 주세요.";
      callbacks?.onError?.(err);
      throw new Error(err);
    }

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

    const userContent = routeResult.route === "skill"
      ? `[스킬: ${routeResult.skillId}] ${input}`
      : input;

    this.history.append({ role: "user", content: userContent });
    // §4.5.2 step 5 — HISTORY_APPEND
    this.tracer.step("HISTORY_APPEND", { role: "user", historySize: this.history.length });

    // Phase 1 Lazy Tool Scoping — 이 턴에서 노출할 plugin 집합 결정.
    // SystemPromptBuilder Tool Schemas 섹션도 동일 scope로 필터링되도록
    // build() 호출 전에 setToolScope 수행.
    const scope = this.resolveToolScope(input);
    // Guard: test mocks may stub SystemPromptBuilder without this method.
    this.deps.systemPromptBuilder.setToolScope?.(scope);

    const systemPrompt = this.deps.systemPromptBuilder.build();
    // §4.5.2 step 6 — PROMPT_ASSEMBLE
    this.tracer.step("PROMPT_ASSEMBLE", { promptLen: systemPrompt.length, activePlugins: scope.activePluginIds.size });
    const result = await this.queryLoop(systemPrompt, scope, callbacks, turnSignal);
    // B4: clear controller once the turn is done (regardless of how it ended)
    this.currentAbortController = null;
    // lastTurnScope must reflect any Option C request_plugin expansions so
    // the next turn's keyword-miss fallback keeps those plugins visible.
    this.lastTurnScope = new Set(scope.activePluginIds);

    // §4.5.2 step 11 — POST_TURN
    this.tracer.step("POST_TURN", {
      toolCallCount: result.toolCalls.length,
      stopReason: result.stopReason,
    });
    // §4.5.5 Post-Turn Hook Chain (Agent 6: compact → saveSession → extractMemory → audit → idle-poke)
    if (this.deps.postTurnHookChain) {
      const compactedMessages = await this.deps.postTurnHookChain.run({
        sessionId: this.sessionId,
        messages: this.history.getMessages(),
        cumulativeUsage: this.cumulativeUsage,
        input,
        output: result.text,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, isError: false })),
        tokenUsage: result.usage,
        route: routeResult.route,
      });
      // compact가 발생했으면 history 교체
      if (compactedMessages) {
        this.history.clear();
        this.history.restore(compactedMessages);
      }
    } else {
      // fallback: PostTurnHookChain 미주입 시 기존 inline 로직 유지.
      // cycle 1 MED: extractMemory 중복 제거 — memory-extract hook이
      // PostTurnHookChain에서 이미 처리하므로 fallback에서도 호출하지 않는다.
      // PostTurnHookChain을 주입한 경우와 fallback 모두 memory 추출은
      // hook chain의 memory-extract 단계에서만 일어난다.
      const llmSettings = this.deps.settingsService.get("llm");
      if (this.isAutoCompactEnabled() && shouldCompact(this.cumulativeUsage, getModelContextWindow(llmSettings.provider, llmSettings.model))) {
        const { messages: compacted, result: cr } = compactMessages(this.history.getMessages());
        if (cr.compacted) {
          this.history.clear();
          this.history.restore(compacted);
          if (process.env.NODE_ENV !== "production") console.log(`[lvis] auto-compact: removed ${cr.removedMessages} msgs, freed ~${cr.freedTokens} tokens`);
          callbacks?.onCompactOccurred?.({ removedMessages: cr.removedMessages, freedTokens: cr.freedTokens });
        }
      }
      await this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages());
      this.auditLogger.logTurn({
        sessionId: this.sessionId,
        input,
        output: result.text,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, isError: false })),
        tokenUsage: result.usage,
        route: routeResult.route,
      });
      this.deps.idleScheduler?.signalConversation();
    }

    callbacks?.onTurnComplete?.(result.text);

    return { ...result, route: routeResult.route };
  }

  // ─── Private: Query Loop (벤더 추상화) ────────────

  private async queryLoop(
    systemPrompt: string,
    scope: ToolScope,
    callbacks?: TurnCallbacks,
    abortSignal?: AbortSignal,
  ): Promise<{ text: string; toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>; usage?: TokenUsage; stopReason?: "end_turn" | "tool_use" | "interrupted" }> {
    const llmSettings = this.deps.settingsService.get("llm");
    const model = llmSettings.model;
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

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // §4.5.2 step 7 — LLM_STREAM
      this.tracer.step("LLM_STREAM", { round, model, toolCount: toolSchemas.length });

      // ─── Stream 1차 시도 → context-length 에러면 reactive compact 후 재시도 ───
      let stream = await collectRoundStream({
        provider: this.provider!,
        model,
        systemPrompt,
        messages: this.history.getMessages(),
        toolSchemas,
        llmSettings,
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
            llmSettings,
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

      // thinkingBlocks는 tool_use 체인이 이어지는 다음 요청에만 signature 그대로 포함되어야 Anthropic이 수락한다.
      const preserveThinkingBlocks = stopReason === "tool_use" && pendingToolCalls.length > 0;
      this.history.append({
        role: "assistant",
        content: textContent,
        ...(thoughtContent && { thought: thoughtContent }),
        ...(preserveThinkingBlocks && roundThinkingBlocks.length > 0 && { thinkingBlocks: roundThinkingBlocks }),
        ...(pendingToolCalls.length > 0 && { toolCalls: pendingToolCalls }),
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

      if (pendingToolCalls.length === 0 || stopReason === "end_turn") {
        return { text: textContent, toolCalls: allToolCalls, usage: turnUsage };
      }

      // §4.5.6 tool execution — request_plugin 가로채기 + knowledge depth cap + executor 호출
      const toolUses: ToolUseBlock[] = pendingToolCalls.map((tc) => ({
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
      const toolResults = await this.toolExecutor.executeAll(capResult.allowed, {
        onToolStart: callbacks?.onToolStart,
        onToolEnd: callbacks?.onToolEnd,
      }, this.sessionId);

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
        console.warn(`[lvis] rebuildToolSchemas: tool '${s.name}' schema 변환 실패, 건너뜀:`, err);
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
        console.log(`[lvis] reactive-compact: removed ${cr.removedMessages} msgs, freed ~${cr.freedTokens} tokens`);
      }
      callbacks?.onCompactOccurred?.({ removedMessages: cr.removedMessages, freedTokens: cr.freedTokens });
      return true;
    } catch (compactErr) {
      console.warn("[lvis] reactive-compact: compactMessages threw, skipping retry:", compactErr);
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
    const activePluginIds = matched.size > 0
      ? matched
      : (this.lastTurnScope ?? new Set<string>());
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
      case "briefing": {
        const engine = this.deps.routineEngine;
        if (!engine) { result = "RoutineEngine이 초기화되지 않았습니다."; break; }
        const briefing = await engine.generateTextBriefing();
        result = `📋 LVIS 데일리 브리핑 (${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })})\n\n${briefing.summary}`;
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
            .catch((e: Error) => console.warn("[lvis] /compact saveSession:", e.message));
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
/briefing — 데일리 브리핑
/remember <내용> — 메모 저장
/memory — 사용자 메모 목록
/vendor — 현재 벤더/토큰 정보
/tools — 등록된 도구 목록
/help — 이 도움말`;
        break;
      default:
        result = `알 수 없는 명령어: /${command}\n사용 가능: /new, /sessions, /load, /compact, /briefing, /remember, /memory, /vendor, /tools, /help`;
    }

    callbacks?.onTextDelta?.(result);
    callbacks?.onTurnComplete?.(result);
    return { text: result, toolCalls: [], route: "command" };
  }
}

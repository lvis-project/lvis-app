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
import { shouldCompact, compactMessages, isContextLengthError, getModelContextWindow } from "./auto-compact.js";
import { createProvider, secretKeyFor } from "./llm/provider-factory.js";
import type { LLMProvider, StreamEvent, ToolCallBlock, ToolSchema, GenericMessage, TokenUsage, ThinkingBlock } from "./llm/types.js";
import { classifyProviderError } from "./llm/error-classifier.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { KeywordEngine } from "../core/keyword-engine.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SettingsService } from "../data/settings-store.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { ProactiveEngine } from "../core/proactive-engine.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ToolCallMeta } from "../tools/executor.js";

// ─── Types ──────────────────────────────────────────

export interface TurnCallbacks {
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onToolStart?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta) => void;
  onToolEnd?: (name: string, result: string, isError: boolean, meta: ToolCallMeta) => void;
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
}

export interface TurnResult {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  route: string;
  usage?: TokenUsage;
}

export interface ConversationLoopDeps {
  settingsService: SettingsService;
  systemPromptBuilder: SystemPromptBuilder;
  keywordEngine: KeywordEngine;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  memoryManager: MemoryManager;
  permissionManager?: import("../permissions/permission-manager.js").PermissionManager;
  proactiveEngine?: ProactiveEngine;
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

/** Phase 1.5 Option C — LLM 요청 기반 plugin 활성화 턴당 최대 횟수. */
const MAX_PLUGIN_EXPANSION = 2;

/**
 * M2: Session-wide hard cap on total `request_plugin` expansions across
 * every turn. Prevents a long-running conversation from eventually scoping
 * every plugin through repeated single-shot activations.
 */
const MAX_SESSION_PLUGIN_EXPANSION = 6;

/** Phase 1.5 Option C — 메타 툴 이름. scope filter와 무관히 항상 노출. */
const REQUEST_PLUGIN_TOOL = "request_plugin";

/** Phase 1 Lazy Tool Scoping — 매 턴 LLM에 노출할 도구 집합 정의. */
interface ToolScope {
  activePluginIds: Set<string>;
  includeBuiltins: boolean;
  includeMcp: boolean;
}

// §11 리스크: LLM agentic 토큰 폭발 방지 — knowledge 도구 turn당 호출 횟수 hard cap
const KNOWLEDGE_DEPTH_CAP = 3;
const KNOWLEDGE_TOOL_NAMES = new Set([
  "knowledge_search",
  "document_list",
  "document_structure",
  "document_page_content",
]);

// ─── Loop ───────────────────────────────────────────

export class ConversationLoop {
  private readonly deps: ConversationLoopDeps;
  private readonly history: ConversationHistory;
  private readonly toolExecutor: ToolExecutor;
  private readonly auditLogger: AuditLogger;
  private provider: LLMProvider | null = null;
  private sessionId: string = crypto.randomUUID();
  private cumulativeUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
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

  /** 설정 변경 시 Provider 재생성 — 벤더별 API 키 조회 */
  refreshProvider(): void {
    const llmSettings = this.deps.settingsService.get("llm");
    const vendor = llmSettings.provider;
    const apiKey = this.deps.settingsService.getSecret(secretKeyFor(vendor));

    if (!apiKey) {
      this.provider = null;
      return;
    }

    try {
      this.provider = createProvider({ vendor, apiKey, model: llmSettings.model });
    } catch {
      this.provider = null;
    }
  }

  hasProvider(): boolean {
    return this.provider !== null;
  }

  /** 앱 시작 시 비서 스타일 데일리 브리핑 생성 — 항목 없으면 null 반환 */
  async generateBriefing(): Promise<string | null> {
    const engine = this.deps.proactiveEngine;
    if (!engine || !this.provider) return null;

    const now = new Date();
    const items = engine.collectBriefingItems(now);
    if (items.length === 0) return null;

    const briefingData = engine.getBriefingPromptData(items, now);
    const today = new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" });

    const prompt = `당신은 LVIS, 사용자의 AI 비서입니다. 아침 브리핑을 보고합니다.
오늘 날짜: ${today}

${briefingData}

위 데이터를 바탕으로 비서가 상사에게 보고하듯 자연스럽고 간결하게 브리핑해주세요.
- 2~5문장 내외로 핵심만
- 긴급/중요 항목은 먼저
- 친근하지만 프로페셔널한 말투
- 마크다운 없이 자연스러운 대화체
- "안녕하세요" 인사로 시작`;

    let text = "";
    try {
      for await (const ev of this.provider.streamTurn({
        systemPrompt: "당신은 LVIS, 사용자의 AI 비서입니다.",
        messages: [{ role: "user", content: prompt }],
        tools: [],
        model: this.deps.settingsService.get("llm").model,
        maxTokens: 400,
      })) {
        if (ev.type === "text_delta" && ev.text) text += ev.text;
        if (ev.type === "message_complete") break;
      }
    } catch {
      return null;
    }

    return text.trim() || null;
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
      this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages());
    }
    this.sessionId = crypto.randomUUID();
    this.history.clear();
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.sessionPluginExpansions = 0;
  }

  getHistory(): ConversationHistory {
    return this.history;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getCumulativeUsage(): TokenUsage {
    return { ...this.cumulativeUsage };
  }

  private isAutoCompactEnabled(): boolean {
    return this.deps.settingsService.get("chat").autoCompact ?? true;
  }

  /** 세션 목록 조회 — §4.5.7 */
  listSessions(): Array<{ id: string; modifiedAt: Date }> {
    return this.deps.memoryManager.listSessions();
  }

  /** 기존 세션 복원 — §4.5.7 */
  loadSession(sessionId: string): boolean {
    const messages = this.deps.memoryManager.loadSession(sessionId);
    if (!messages) return false;

    // 현재 세션 저장 후 전환
    if (this.history.length > 0) {
      this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages());
    }

    this.sessionId = sessionId;
    this.history.clear();
    this.history.restore(messages as import("./llm/types.js").GenericMessage[]);
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.sessionPluginExpansions = 0;
    return true;
  }

  /**
   * 한 턴 실행 — §4.5 Core Cycle
   */
  async runTurn(input: string, callbacks?: TurnCallbacks): Promise<TurnResult> {
    if (!this.provider) {
      const err = "LLM 프로바이더가 설정되지 않았습니다. 설정에서 벤더와 API 키를 확인해 주세요.";
      callbacks?.onError?.(err);
      throw new Error(err);
    }

    // §4.3 Step 1-2: 분류 + 라우팅
    const classification = this.deps.keywordEngine.classify(input);
    const routeResult = this.deps.routeEngine.route(classification);

    if (routeResult.route === "command") {
      return this.handleCommand(routeResult.command, routeResult.args, callbacks);
    }

    const userContent = routeResult.route === "skill"
      ? `[스킬: ${routeResult.skillId}] ${input}`
      : input;

    this.history.append({ role: "user", content: userContent });

    // Phase 1 Lazy Tool Scoping — 이 턴에서 노출할 plugin 집합 결정.
    // SystemPromptBuilder Tool Schemas 섹션도 동일 scope로 필터링되도록
    // build() 호출 전에 setToolScope 수행.
    const scope = this.resolveToolScope(input);
    // Guard: test mocks may stub SystemPromptBuilder without this method.
    this.deps.systemPromptBuilder.setToolScope?.(scope);

    const systemPrompt = this.deps.systemPromptBuilder.build();
    const result = await this.queryLoop(systemPrompt, scope, callbacks);
    // lastTurnScope must reflect any Option C request_plugin expansions so
    // the next turn's keyword-miss fallback keeps those plugins visible.
    this.lastTurnScope = new Set(scope.activePluginIds);

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
      this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages());
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
  ): Promise<{ text: string; toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>; usage?: TokenUsage }> {
    const llmSettings = this.deps.settingsService.get("llm");
    const model = llmSettings.model;
    // Phase 1.5 Option C: scope is mutable within the turn — request_plugin
    // tool_use results add to scope.activePluginIds, and toolSchemas are
    // rebuilt each round. Mutating the caller's Set directly means the
    // next turn's fallback sees every plugin that was activated here.
    const mutableScope = scope;
    let pluginExpansions = 0;
    const rebuildToolSchemas = (): ToolSchema[] => {
      const raw = this.deps.toolRegistry.getToolSchemasForScope(mutableScope);
      const result: ToolSchema[] = [];
      for (const s of raw) {
        try {
          result.push({
            name: s.name,
            description: s.description,
            // Tool.toJsonSchema() returns `unknown` (may be Zod-generated or raw
            // plugin/MCP schema); LLM providers all expect the flat
            // `{type: "object", properties, required?}` shape.
            inputSchema: s.input_schema as ToolSchema["inputSchema"],
          });
        } catch (err) {
          console.warn(`[lvis] rebuildToolSchemas: tool '${s.name}' schema 변환 실패, 건너뜀:`, err);
        }
      }
      return result;
    };
    let toolSchemas: ToolSchema[] = rebuildToolSchemas();
    const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
    let turnUsage: TokenUsage | undefined;
    // turn당 knowledge 도구 호출 횟수 카운터 (depth ≤ 3 hard cap)
    let knowledgeCallCount = 0;
    let roundIndex = 0;
    // Reactive compact recovery: context-length 오류 발생 시 1회 compact 후 재시도
    // turn당 1회만 허용 — for 루프 밖에 선언
    let reactiveCompacted = false;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // §4.5.3: 벤더 추상화 스트리밍
      let textContent = "";
      let thoughtContent = "";
      let roundThinkingBlocks: ThinkingBlock[] = [];
      const pendingToolCalls: ToolCallBlock[] = [];
      let stopReason: "end_turn" | "tool_use" = "end_turn";

      const collectStream = async (messages: ReturnType<typeof this.history.getMessages>) => {
        textContent = "";
        thoughtContent = "";
        roundThinkingBlocks = [];
        pendingToolCalls.length = 0;
        stopReason = "end_turn";
        // Snapshot cumulativeUsage so a partial stream that errors mid-flight
        // does not double-count tokens when we retry after reactive compact.
        const usageSnapshot = {
          inputTokens: this.cumulativeUsage.inputTokens,
          outputTokens: this.cumulativeUsage.outputTokens,
        };
        const restoreUsage = () => {
          this.cumulativeUsage.inputTokens = usageSnapshot.inputTokens;
          this.cumulativeUsage.outputTokens = usageSnapshot.outputTokens;
        };

        const llmSettings = this.deps.settingsService.get("llm");
        for await (const event of this.provider!.streamTurn({
          model,
          systemPrompt,
          messages,
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          maxTokens: 4096,
          enableThinking: llmSettings.enableThinking,
          thinkingBudgetTokens: llmSettings.thinkingBudgetTokens,
        })) {
          switch (event.type) {
            case "reasoning_delta":
              thoughtContent += event.text;
              callbacks?.onReasoningDelta?.(event.text);
              break;
            case "text_delta":
              textContent += event.text;
              callbacks?.onTextDelta?.(event.text);
              break;
            case "tool_call":
              pendingToolCalls.push({ id: event.id, name: event.name, input: event.input });
              break;
            case "message_complete":
              stopReason = event.stopReason;
              if (event.thinkingBlocks && event.thinkingBlocks.length > 0) {
                roundThinkingBlocks = event.thinkingBlocks;
              }
              if (event.usage) {
                turnUsage = event.usage;
                this.cumulativeUsage.inputTokens += event.usage.inputTokens;
                this.cumulativeUsage.outputTokens += event.usage.outputTokens;
              }
              break;
            case "error":
              // context-length 오류를 stream event로 수신한 경우 → compact + retry
              if (isContextLengthError(event.error) && !reactiveCompacted) {
                restoreUsage();
                return { earlyReturn: false as const, streamContextError: event.error };
              }
              // Classify before notifying so renderer toast + history both
              // see the same user-friendly Korean message.
              const classified = classifyProviderError(event.error);
              const userMsg = reactiveCompacted && isContextLengthError(event.error)
                ? `오류: 대화 기록을 압축한 뒤에도 모델 컨텍스트 한도를 초과했습니다. 새 세션을 시작하거나 이전 첨부를 정리해 주세요 (원인: ${event.error})`
                : `오류: ${classified.userMessage}`;
              callbacks?.onError?.(userMsg);
              this.history.append({ role: "assistant", content: userMsg });
              return { earlyReturn: true as const, text: userMsg };
          }
        }
        return { earlyReturn: false as const };
      };

      // Snapshot at outer scope too: catch-path throws bypass collectStream's restoreUsage.
      const outerUsageSnapshot = {
        inputTokens: this.cumulativeUsage.inputTokens,
        outputTokens: this.cumulativeUsage.outputTokens,
      };
      let streamResult = await collectStream(this.history.getMessages()).catch((err: unknown) => {
        if (isContextLengthError(err)) {
          // throw-path did not hit the restoreUsage inside collectStream; do it here
          this.cumulativeUsage.inputTokens = outerUsageSnapshot.inputTokens;
          this.cumulativeUsage.outputTokens = outerUsageSnapshot.outputTokens;
          return { earlyReturn: false as const, contextError: err };
        }
        throw err;
      });

      // context-length 오류 → compact 후 1회 재시도 (throw 경로 또는 stream event 경로)
      const throwCtxError = !streamResult.earlyReturn && (streamResult as { contextError?: unknown }).contextError;
      const streamCtxError = !streamResult.earlyReturn && (streamResult as { streamContextError?: string }).streamContextError;
      if ((throwCtxError || streamCtxError) && !reactiveCompacted) {
        reactiveCompacted = true;
        let compacted = false;
        try {
          const { messages: compactedMsgs, result: cr } = compactMessages(this.history.getMessages(), undefined, "reactive");
          if (cr.compacted) {
            compacted = true;
            this.history.clear();
            this.history.restore(compactedMsgs);
            if (process.env.NODE_ENV !== "production") console.log(`[lvis] reactive-compact: removed ${cr.removedMessages} msgs, freed ~${cr.freedTokens} tokens`);
            callbacks?.onCompactOccurred?.({ removedMessages: cr.removedMessages, freedTokens: cr.freedTokens });
          }
        } catch (compactErr) {
          console.warn("[lvis] reactive-compact: compactMessages threw, skipping retry:", compactErr);
        }
        if (compacted) {
          streamResult = await collectStream(this.history.getMessages());
        } else {
          // compact가 아무것도 하지 않았으면 재시도해도 의미 없음 — 원래 오류 재전파
          if (throwCtxError) throw (streamResult as { contextError?: unknown }).contextError;
          throw new Error((streamResult as { streamContextError?: string }).streamContextError);
        }
      }

      if (streamResult.earlyReturn) {
        return { text: streamResult.text, toolCalls: allToolCalls, usage: turnUsage };
      }

      // assistant 응답을 히스토리에 추가 — thinkingBlocks는 tool_use 체인이
      // 이어지는 다음 요청에만 signature 그대로 포함되어야 Anthropic이 수락한다.
      const preserveThinkingBlocks = (stopReason as string) === "tool_use" && pendingToolCalls.length > 0;
      this.history.append({
        role: "assistant",
        content: textContent,
        ...(thoughtContent && { thought: thoughtContent }),
        ...(preserveThinkingBlocks && roundThinkingBlocks.length > 0 && { thinkingBlocks: roundThinkingBlocks }),
        ...(pendingToolCalls.length > 0 && { toolCalls: pendingToolCalls }),
      });
      callbacks?.onAssistantRound?.({
        roundIndex,
        text: textContent,
        thought: thoughtContent,
        stopReason,
        hasToolCalls: pendingToolCalls.length > 0,
      });
      roundIndex += 1;

      // tool_use 없으면 루프 종료
      if (pendingToolCalls.length === 0 || stopReason === "end_turn") {
        return { text: textContent, toolCalls: allToolCalls, usage: turnUsage };
      }

      // §4.5.6: 도구 실행
      const toolUses: ToolUseBlock[] = pendingToolCalls.map((tc) => ({
        id: tc.id, name: tc.name, input: tc.input,
      }));

      // Phase 1.5 Option C — request_plugin 메타 툴 가로채기.
      // 실제 tool executor에 넘기지 않고 scope를 확장한 뒤 합성된 tool_result를
      // 히스토리에 추가한다. 다음 round에서 rebuildToolSchemas()로 새 plugin의
      // tool이 LLM에 노출된다. MAX_PLUGIN_EXPANSION 초과 시 에러 결과 반환.
      const requestPluginResults: Array<{ tool_use_id: string; content: string; is_error: boolean }> = [];
      const remainingToolUses: ToolUseBlock[] = [];
      for (const tu of toolUses) {
        if (tu.name !== REQUEST_PLUGIN_TOOL) {
          remainingToolUses.push(tu);
          continue;
        }
        const pluginId = (tu.input as { pluginId?: unknown })?.pluginId;
        const availableIds = this.deps.pluginRuntime?.listPluginIds() ?? [];
        if (typeof pluginId !== "string" || pluginId.length === 0) {
          requestPluginResults.push({
            tool_use_id: tu.id,
            content: `request_plugin 오류: pluginId (string) 필수. Available: ${availableIds.join(", ") || "(none)"}`,
            is_error: true,
          });
        } else if (!availableIds.includes(pluginId)) {
          requestPluginResults.push({
            tool_use_id: tu.id,
            content: `알 수 없는 플러그인 ID '${pluginId}'. 사용 가능: ${availableIds.join(", ") || "(없음)"}`,
            is_error: true,
          });
        } else if (pluginExpansions >= MAX_PLUGIN_EXPANSION) {
          requestPluginResults.push({
            tool_use_id: tu.id,
            content: `request_plugin 한도 초과 (턴당 최대 ${MAX_PLUGIN_EXPANSION}회). '${pluginId}' 활성화 거부.`,
            is_error: true,
          });
        } else if (this.sessionPluginExpansions >= MAX_SESSION_PLUGIN_EXPANSION) {
          // M2: session-wide cap — independent of per-turn cap above.
          console.warn(
            `[lvis] request_plugin session cap reached (${MAX_SESSION_PLUGIN_EXPANSION}). ` +
            `Rejecting '${pluginId}'.`,
          );
          requestPluginResults.push({
            tool_use_id: tu.id,
            content: `request_plugin 세션 한도 초과 (세션당 최대 ${MAX_SESSION_PLUGIN_EXPANSION}회). '${pluginId}' 활성화 거부.`,
            is_error: true,
          });
        } else {
          const prevToolCount = toolSchemas.length;
          mutableScope.activePluginIds.add(pluginId);
          pluginExpansions += 1;
          this.sessionPluginExpansions += 1;
          toolSchemas = rebuildToolSchemas();
          const addedToolCount = Math.max(0, toolSchemas.length - prevToolCount);
          requestPluginResults.push({
            tool_use_id: tu.id,
            content: `플러그인 '${pluginId}' 활성화됨. ${addedToolCount}개 도구 추가됨 (현재 ${toolSchemas.length}개 사용 가능).`,
            is_error: false,
          });
          allToolCalls.push({
            name: tu.name,
            input: tu.input,
            result: `activated:${pluginId}`,
          });
        }
      }

      // request_plugin tool_result를 히스토리에 추가 (executor 우회)
      for (const rr of requestPluginResults) {
        this.history.append({
          role: "tool_result",
          toolUseId: rr.tool_use_id,
          toolName: REQUEST_PLUGIN_TOOL,
          content: rr.content,
          ...(rr.is_error && { isError: true }),
        });
      }

      // request_plugin만 있고 실제 실행할 tool이 없으면 다음 round로 진입
      // (LLM이 새로 활성화된 plugin의 tool을 호출할 수 있도록).
      // C9: request_plugin 전용 round는 MAX_TOOL_ROUNDS 카운트에서 제외.
      // Copilot: 활성화에 실제로 성공한 경우에만 round를 되돌린다. 실패한
      // request_plugin(unknown id, over-limit)만 반복되면 round 예산이 정상
      // 소모되어야 무한 루프가 발생하지 않는다.
      if (remainingToolUses.length === 0) {
        const successfulActivation = requestPluginResults.some((r) => !r.is_error);
        if (successfulActivation) round--;
        continue;
      }

      // §11 depth cap: knowledge 도구 turn당 최대 KNOWLEDGE_DEPTH_CAP 회
      const cappedToolUses: ToolUseBlock[] = [];
      const capBlockResults: Array<{ tool_use_id: string; content: string; is_error: boolean }> = [];
      for (const tu of remainingToolUses) {
        if (KNOWLEDGE_TOOL_NAMES.has(tu.name)) {
          if (knowledgeCallCount >= KNOWLEDGE_DEPTH_CAP) {
            capBlockResults.push({
              tool_use_id: tu.id,
              content: `[depth cap] ${tu.name} 도구는 turn당 최대 ${KNOWLEDGE_DEPTH_CAP}회만 호출 가능합니다.`,
              is_error: true,
            });
            continue;
          }
          knowledgeCallCount++;
        }
        cappedToolUses.push(tu);
      }

      const toolResults = await this.toolExecutor.executeAll(cappedToolUses, {
        onToolStart: callbacks?.onToolStart,
        onToolEnd: callbacks?.onToolEnd,
      }, this.sessionId);

      // cap 차단된 결과를 toolResults에 병합
      const allResults = [...toolResults, ...capBlockResults];

      // 1:1 안전 접근 — toolResults가 짧을 수 있으므로 ?.content 가드
      for (let i = 0; i < cappedToolUses.length; i++) {
        allToolCalls.push({
          name: cappedToolUses[i].name,
          input: cappedToolUses[i].input,
          result: toolResults[i]?.content ?? "(missing)",
        });
      }
      // cap 차단 결과도 audit trail에 포함 (depth cap 감사 근거 누락 방지)
      for (const blocked of capBlockResults) {
        const origTool = remainingToolUses.find((tu) => tu.id === blocked.tool_use_id);
        if (origTool) {
          allToolCalls.push({
            name: origTool.name,
            input: origTool.input,
            result: blocked.content,
          });
        }
      }

      // tool_result를 히스토리에 추가 → loop back
      for (const tr of allResults) {
        this.history.append({
          role: "tool_result",
          toolUseId: tr.tool_use_id,
          toolName: remainingToolUses.find((tu) => tu.id === tr.tool_use_id)?.name,
          content: tr.content,
          ...(tr.is_error && { isError: true }),
        });
      }
    }

    return { text: "(도구 실행 라운드 한도 초과)", toolCalls: allToolCalls, usage: turnUsage };
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
        this.deps.memoryManager.saveNote(title, args);
        result = `메모 저장됨: ${title}`;
        break;
      }
      case "notes": {
        const notes = this.deps.memoryManager.listNotes();
        result = notes.length === 0
          ? "저장된 메모 없음."
          : notes.map((n) => `- ${n.title} (${n.filename})`).join("\n");
        break;
      }
      case "sessions": {
        const sessions = this.listSessions();
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
        const engine = this.deps.proactiveEngine;
        if (!engine) { result = "Proactive Engine이 초기화되지 않았습니다."; break; }
        const briefing = engine.generateTextBriefing();
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
/notes — 메모 목록
/vendor — 현재 벤더/토큰 정보
/tools — 등록된 도구 목록
/help — 이 도움말`;
        break;
      default:
        result = `알 수 없는 명령어: /${command}\n사용 가능: /new, /sessions, /load, /compact, /briefing, /remember, /notes, /vendor, /tools, /help`;
    }

    callbacks?.onTextDelta?.(result);
    callbacks?.onTurnComplete?.(result);
    return { text: result, toolCalls: [], route: "command" };
  }
}

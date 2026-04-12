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
import { ToolExecutor, type ToolUseBlock } from "./tool-executor.js";
import { HookRunner } from "./hook-runner.js";
import { shouldCompact, compactMessages } from "./auto-compact.js";
import { createProvider, secretKeyFor } from "./llm/provider-factory.js";
import type { LLMProvider, StreamEvent, ToolCallBlock, ToolSchema, GenericMessage, TokenUsage } from "./llm/types.js";
import type { SystemPromptBuilder } from "./system-prompt-builder.js";
import type { KeywordEngine } from "../core/keyword-engine.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../core/tool-registry.js";
import type { MemoryManager } from "../core/memory-manager.js";
import type { SettingsService } from "../data/settings-store.js";
import { AuditLogger } from "./audit-logger.js";
import type { ProactiveEngine } from "../core/proactive-engine.js";

// ─── Types ──────────────────────────────────────────

export interface TurnCallbacks {
  onTextDelta?: (text: string) => void;
  onToolStart?: (name: string, input: Record<string, unknown>) => void;
  onToolEnd?: (name: string, result: string, isError: boolean) => void;
  onTurnComplete?: (fullText: string) => void;
  onError?: (error: string) => void;
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
  permissionManager?: import("../core/permission-manager.js").PermissionManager;
  proactiveEngine?: ProactiveEngine;
}

const MAX_TOOL_ROUNDS = 10;

// ─── Loop ───────────────────────────────────────────

export class ConversationLoop {
  private readonly deps: ConversationLoopDeps;
  private readonly history: ConversationHistory;
  private readonly toolExecutor: ToolExecutor;
  private readonly auditLogger: AuditLogger;
  private provider: LLMProvider | null = null;
  private sessionId: string = crypto.randomUUID();
  private cumulativeUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(deps: ConversationLoopDeps) {
    this.deps = deps;
    this.history = new ConversationHistory();
    this.toolExecutor = new ToolExecutor(deps.toolRegistry, new HookRunner(), deps.permissionManager);
    this.auditLogger = new AuditLogger();
    this.refreshProvider();
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

    const systemPrompt = this.deps.systemPromptBuilder.build();
    const result = await this.queryLoop(systemPrompt, callbacks);

    // §4.5.5 Post-Turn Hooks (5개 중 4개 구현)
    // 1. Auto-Compact (§4.5.4)
    if (shouldCompact(this.cumulativeUsage)) {
      const { messages: compacted, result: cr } = compactMessages(this.history.getMessages());
      if (cr.compacted) {
        this.history.clear();
        this.history.restore(compacted);
        console.log(`[lvis] auto-compact: removed ${cr.removedMessages} msgs, freed ~${cr.freedTokens} tokens`);
      }
    }
    // 2. 세션 영속화 (§4.5.7)
    this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages());
    // 3. Memory Extraction — 어시스턴트 응답에서 기억할 내용 자동 추출
    this.extractMemory(result.text, input);
    // 4. Audit Log — §14.2 Governance 대비 구조화된 로깅
    this.auditLogger.logTurn({
      sessionId: this.sessionId,
      input,
      output: result.text,
      toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, isError: false })),
      tokenUsage: result.usage,
      route: routeResult.route,
    });

    callbacks?.onTurnComplete?.(result.text);
    return { ...result, route: routeResult.route };
  }

  // ─── Private: Query Loop (벤더 추상화) ────────────

  private async queryLoop(
    systemPrompt: string,
    callbacks?: TurnCallbacks,
  ): Promise<{ text: string; toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>; usage?: TokenUsage }> {
    const model = this.deps.settingsService.get("llm").model;
    const toolSchemas: ToolSchema[] = this.deps.toolRegistry.getToolSchemas().map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.input_schema,
    }));
    const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
    let turnUsage: TokenUsage | undefined;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // §4.5.3: 벤더 추상화 스트리밍
      let textContent = "";
      const pendingToolCalls: ToolCallBlock[] = [];
      let stopReason: "end_turn" | "tool_use" = "end_turn";

      for await (const event of this.provider!.streamTurn({
        model,
        systemPrompt,
        messages: this.history.getMessages(),
        tools: toolSchemas.length > 0 ? toolSchemas : undefined,
        maxTokens: 4096,
      })) {
        switch (event.type) {
          case "text_delta":
            textContent += event.text;
            callbacks?.onTextDelta?.(event.text);
            break;
          case "tool_call":
            pendingToolCalls.push({ id: event.id, name: event.name, input: event.input });
            break;
          case "message_complete":
            stopReason = event.stopReason;
            if (event.usage) {
              turnUsage = event.usage;
              this.cumulativeUsage.inputTokens += event.usage.inputTokens;
              this.cumulativeUsage.outputTokens += event.usage.outputTokens;
            }
            break;
          case "error":
            callbacks?.onError?.(event.error);
            this.history.append({ role: "assistant", content: `오류: ${event.error}` });
            return { text: `오류: ${event.error}`, toolCalls: allToolCalls, usage: turnUsage };
        }
      }

      // assistant 응답을 히스토리에 추가
      this.history.append({
        role: "assistant",
        content: textContent,
        ...(pendingToolCalls.length > 0 && { toolCalls: pendingToolCalls }),
      });

      // tool_use 없으면 루프 종료
      if (pendingToolCalls.length === 0 || stopReason === "end_turn") {
        return { text: textContent, toolCalls: allToolCalls, usage: turnUsage };
      }

      // §4.5.6: 도구 실행
      const toolUses: ToolUseBlock[] = pendingToolCalls.map((tc) => ({
        id: tc.id, name: tc.name, input: tc.input,
      }));

      const toolResults = await this.toolExecutor.executeAll(toolUses, {
        onToolStart: callbacks?.onToolStart,
        onToolEnd: callbacks?.onToolEnd,
      }, this.sessionId);

      for (let i = 0; i < toolUses.length; i++) {
        allToolCalls.push({
          name: toolUses[i].name,
          input: toolUses[i].input,
          result: toolResults[i].content,
        });
      }

      // tool_result를 히스토리에 추가 → loop back
      for (const tr of toolResults) {
        this.history.append({
          role: "tool_result",
          toolUseId: tr.tool_use_id,
          toolName: toolUses.find((tu) => tu.id === tr.tool_use_id)?.name,
          content: tr.content,
          ...(tr.is_error && { isError: true }),
        });
      }
    }

    return { text: "(도구 실행 라운드 한도 초과)", toolCalls: allToolCalls, usage: turnUsage };
  }

  // ─── Private: Memory Extraction (§4.5.5 Hook 3) ───

  /** 어시스턴트 응답에서 기억 요청을 감지하여 자동 저장 */
  private extractMemory(assistantText: string, userInput: string): void {
    try {
      // 사용자가 "기억해", "remember" 등을 요청했는지 탐지
      const memoryPatterns = /기억해|기억하|잊지\s*마|remember|don't forget|메모해/i;
      if (!memoryPatterns.test(userInput)) return;

      // 어시스턴트가 기억하겠다고 응답한 경우 자동 저장
      const confirmPatterns = /기억하겠|메모.*저장|기록.*했|noted|remembered|saved/i;
      if (!confirmPatterns.test(assistantText)) return;

      const title = userInput.slice(0, 40).replace(/\n/g, " ").trim();
      if (title.length < 3) return;

      this.deps.memoryManager.saveNote(
        `자동-${title}`,
        `[사용자 요청]\n${userInput}\n\n[어시스턴트 응답]\n${assistantText.slice(0, 500)}`,
      );
      console.log(`[lvis] memory-extraction: auto-saved note "${title}"`);
    } catch {
      // Memory extraction 실패가 대화를 차단하면 안 됨
    }
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
      default:
        result = `알 수 없는 명령어: /${command}\n사용 가능: /new, /sessions, /load, /briefing, /remember, /notes, /vendor`;
    }

    callbacks?.onTextDelta?.(result);
    callbacks?.onTurnComplete?.(result);
    return { text: result, toolCalls: [], route: "command" };
  }
}

import { ConversationHistory } from "../engine/conversation-history.js";
import { ToolExecutor, type ToolUseBlock, type ToolCallMeta } from "../tools/executor.js";
import { HookRunner } from "../hooks/hook-runner.js";
import { shouldCompact, compactMessages } from "../engine/auto-compact.js";
import { secretKeyFor } from "../engine/llm/provider-factory.js";
import { LLM_DEFAULT_MODELS, type ToolSchema, type TokenUsage, type LLMVendor } from "../engine/llm/types.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { KeywordEngine } from "../core/keyword-engine.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SettingsService, LLMSettings } from "../data/settings-store.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { ProactiveEngine } from "../core/proactive-engine.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import { ChatServiceManager, type ChatTurnRequest, type ChatTurnResponse } from "./service-manager.js";

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
}

export interface TurnResult {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  route: string;
  usage?: TokenUsage;
}

export interface ChatRuntimeDeps {
  settingsService: SettingsService;
  systemPromptBuilder: SystemPromptBuilder;
  keywordEngine: KeywordEngine;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  memoryManager: MemoryManager;
  chatService?: ChatServiceManager;
  permissionManager?: import("../permissions/permission-manager.js").PermissionManager;
  proactiveEngine?: ProactiveEngine;
  idleScheduler?: IdleSchedulerService;
  postTurnHookChain?: PostTurnHookChain;
  bashAstValidator?: import("../main/bash-ast-validator.js").BashAstValidator;
  approvalGate?: import("../permissions/approval-gate.js").ApprovalGate;
  hookRunner?: HookRunner;
}

const MAX_TOOL_ROUNDS = 10;
const KNOWLEDGE_DEPTH_CAP = 3;
const FALLBACK_VENDORS: LLMVendor[] = ["claude", "openai", "gemini", "copilot"];
const KNOWLEDGE_TOOL_NAMES = new Set([
  "knowledge_search",
  "document_list",
  "document_structure",
  "document_page_content",
]);

export class ChatRuntime {
  private readonly deps: ChatRuntimeDeps;
  private readonly history: ConversationHistory;
  private readonly toolExecutor: ToolExecutor;
  private readonly auditLogger: AuditLogger;
  private sessionId: string = crypto.randomUUID();
  private cumulativeUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  constructor(deps: ChatRuntimeDeps) {
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
  }

  get permissionManager(): import("../permissions/permission-manager.js").PermissionManager | undefined {
    return this.deps.permissionManager;
  }

  refreshProvider(): void {}

  hasProvider(): boolean {
    if (!this.deps.chatService) return false;
    return this.getProviderCandidates().length > 0;
  }

  async close(): Promise<void> {
    await this.deps.chatService?.stop();
  }

  async generateBriefing(): Promise<string | null> {
    const engine = this.deps.proactiveEngine;
    if (!engine || !this.hasProvider() || !this.deps.chatService) return null;

    const items = engine.collectBriefingItems();
    if (items.length === 0) return null;

    const briefingData = engine.getBriefingPromptData();
    const today = new Date().toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

    const prompt = `당신은 LVIS, 사용자의 AI 비서입니다. 오늘 브리핑을 보고합니다.
오늘 날짜: ${today}

${briefingData}

위 데이터를 바탕으로 비서가 업무를 요약하듯 간결하게 브리핑해 주세요.
- 2~5문장
- 급한 항목 먼저
- 과장 없이 실무적인 톤
- 마크다운 없이 자연어 문장`;

    try {
      const response = await this.invokeWithFallback({
        systemPrompt: "당신은 LVIS, 사용자의 AI 비서입니다.",
        messages: [{ role: "user", content: prompt }],
        tools: [],
        maxTokens: 400,
      });
      return response.text.trim() || null;
    } catch {
      return null;
    }
  }

  getVendor(): string {
    return this.deps.settingsService.get("llm").provider;
  }

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

  listSessions(): Array<{ id: string; modifiedAt: Date }> {
    return this.deps.memoryManager.listSessions();
  }

  loadSession(sessionId: string): boolean {
    const messages = this.deps.memoryManager.loadSession(sessionId);
    if (!messages) return false;
    if (this.history.length > 0) {
      this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages());
    }
    this.sessionId = sessionId;
    this.history.clear();
    this.history.restore(messages as import("../engine/llm/types.js").GenericMessage[]);
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    return true;
  }

  async runTurn(input: string, callbacks?: TurnCallbacks): Promise<TurnResult> {
    if (!this.hasProvider() || !this.deps.chatService) {
      const err = "Python LangGraph chat service 또는 LLM API 키가 준비되지 않았습니다.";
      callbacks?.onError?.(err);
      throw new Error(err);
    }

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
      if (compactedMessages) {
        this.history.clear();
        this.history.restore(compactedMessages);
      }
    } else {
      if (shouldCompact(this.cumulativeUsage)) {
        const { messages: compacted, result: compactResult } = compactMessages(this.history.getMessages());
        if (compactResult.compacted) {
          this.history.clear();
          this.history.restore(compacted);
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

  private async queryLoop(
    systemPrompt: string,
    callbacks?: TurnCallbacks,
  ): Promise<{ text: string; toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>; usage?: TokenUsage }> {
    if (!this.deps.chatService) {
      throw new Error("chat service unavailable");
    }

    const toolSchemas: ToolSchema[] = this.deps.toolRegistry.getToolSchemas().map((schema) => ({
      name: schema.name,
      description: schema.description,
      inputSchema: schema.input_schema as ToolSchema["inputSchema"],
    }));

    const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
    let turnUsage: TokenUsage | undefined;
    let knowledgeCallCount = 0;
    let roundIndex = 0;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      let response: ChatTurnResponse;
      try {
        response = await this.invokeWithFallback({
          systemPrompt,
          messages: this.history.getMessages(),
          tools: toolSchemas.length > 0 ? toolSchemas : undefined,
          maxTokens: 4096,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        callbacks?.onError?.(message);
        this.history.append({ role: "assistant", content: `오류: ${message}` });
        return { text: `오류: ${message}`, toolCalls: allToolCalls, usage: turnUsage };
      }

      if (response.thought) callbacks?.onReasoningDelta?.(response.thought);
      if (response.text) callbacks?.onTextDelta?.(response.text);

      if (response.usage) {
        turnUsage = response.usage;
        this.cumulativeUsage.inputTokens += response.usage.inputTokens;
        this.cumulativeUsage.outputTokens += response.usage.outputTokens;
      }

      this.history.append({
        role: "assistant",
        content: response.text,
        ...(response.thought ? { thought: response.thought } : {}),
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      });
      callbacks?.onAssistantRound?.({
        roundIndex,
        text: response.text,
        thought: response.thought ?? "",
        stopReason: response.stopReason,
        hasToolCalls: response.toolCalls.length > 0,
      });
      roundIndex += 1;

      if (response.toolCalls.length === 0 || response.stopReason === "end_turn") {
        return { text: response.text, toolCalls: allToolCalls, usage: turnUsage };
      }

      const toolUses: ToolUseBlock[] = response.toolCalls.map((toolCall) => ({
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.input,
      }));

      const cappedToolUses: ToolUseBlock[] = [];
      const capBlockResults: Array<{ tool_use_id: string; content: string; is_error: boolean }> = [];
      for (const toolUse of toolUses) {
        if (KNOWLEDGE_TOOL_NAMES.has(toolUse.name)) {
          if (knowledgeCallCount >= KNOWLEDGE_DEPTH_CAP) {
            capBlockResults.push({
              tool_use_id: toolUse.id,
              content: `[depth cap] ${toolUse.name} tool is limited to ${KNOWLEDGE_DEPTH_CAP} calls per turn.`,
              is_error: true,
            });
            continue;
          }
          knowledgeCallCount++;
        }
        cappedToolUses.push(toolUse);
      }

      const toolResults = await this.toolExecutor.executeAll(cappedToolUses, {
        onToolStart: callbacks?.onToolStart,
        onToolEnd: callbacks?.onToolEnd,
      }, this.sessionId);
      const allResults = [...toolResults, ...capBlockResults];

      for (let index = 0; index < cappedToolUses.length; index++) {
        allToolCalls.push({
          name: cappedToolUses[index].name,
          input: cappedToolUses[index].input,
          result: toolResults[index]?.content ?? "(missing)",
        });
      }
      for (const blocked of capBlockResults) {
        const originalTool = toolUses.find((toolUse) => toolUse.id === blocked.tool_use_id);
        if (originalTool) {
          allToolCalls.push({
            name: originalTool.name,
            input: originalTool.input,
            result: blocked.content,
          });
        }
      }

      for (const toolResult of allResults) {
        this.history.append({
          role: "tool_result",
          toolUseId: toolResult.tool_use_id,
          toolName: toolUses.find((toolUse) => toolUse.id === toolResult.tool_use_id)?.name,
          content: toolResult.content,
          ...(toolResult.is_error ? { isError: true } : {}),
        });
      }
    }

    return { text: "(tool round limit exceeded)", toolCalls: allToolCalls, usage: turnUsage };
  }

  private async handleCommand(command: string, args: string, callbacks?: TurnCallbacks): Promise<TurnResult> {
    let result: string;

    switch (command) {
      case "new":
        this.newConversation();
        result = "새 대화를 시작합니다.";
        break;
      case "remember": {
        if (!args.trim()) {
          result = "사용법: /remember 기억할 내용";
          break;
        }
        const title = args.slice(0, 40).replace(/\n/g, " ");
        this.deps.memoryManager.saveNote(title, args);
        result = `메모 저장: ${title}`;
        break;
      }
      case "notes": {
        const notes = this.deps.memoryManager.listNotes();
        result = notes.length === 0
          ? "저장된 메모가 없습니다."
          : notes.map((note) => `- ${note.title} (${note.filename})`).join("\n");
        break;
      }
      case "sessions": {
        const sessions = this.listSessions();
        if (sessions.length === 0) {
          result = "저장된 세션이 없습니다.";
          break;
        }
        const current = this.sessionId;
        const rows = sessions.slice(0, 10).map((session) => {
          const marker = session.id === current ? " <- 현재" : "";
          const date = session.modifiedAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
          return `- ${session.id.slice(0, 8)}… (${date})${marker}`;
        }).join("\n");
        result = `세션 목록 (최근 10개):\n${rows}\n\n세션 전환: /load <세션ID>`;
        break;
      }
      case "load": {
        if (!args.trim()) {
          result = "사용법: /load <세션ID>";
          break;
        }
        const targetId = args.trim();
        const match = this.listSessions().find((session) => session.id.startsWith(targetId));
        if (!match) {
          result = `세션을 찾을 수 없습니다: ${targetId}`;
          break;
        }
        const loaded = this.loadSession(match.id);
        result = loaded
          ? `세션 복원: ${match.id.slice(0, 8)}… (${this.history.length}개 메시지)`
          : `세션 로드 실패: ${match.id}`;
        break;
      }
      case "briefing": {
        const engine = this.deps.proactiveEngine;
        if (!engine) {
          result = "Proactive Engine이 초기화되지 않았습니다.";
          break;
        }
        const briefing = engine.generateTextBriefing();
        result = `LVIS 데일리 브리핑 (${new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })})\n\n${briefing.summary}`;
        break;
      }
      case "vendor":
        result = `현재 벤더: ${this.getVendor()}\n세션: ${this.sessionId.slice(0, 8)}…\n누적 토큰: 입력 ${this.cumulativeUsage.inputTokens}, 출력 ${this.cumulativeUsage.outputTokens}`;
        break;
      case "compact": {
        const { messages: compacted, result: compactResult } = compactMessages(this.history.getMessages());
        if (compactResult.compacted) {
          this.history.clear();
          this.history.restore(compacted);
          result = `컴팩트 완료: ${compactResult.removedMessages}개 메시지 정리, 약 ${compactResult.freedTokens} 토큰 절약`;
        } else {
          result = "컴팩트할 만큼 대화가 길지 않습니다.";
        }
        break;
      }
      case "tools": {
        const tools = this.deps.toolRegistry.getVisibleTools();
        result = tools.map((tool) => `${tool.name} [${tool.source}]`).join("\n") || "등록된 도구가 없습니다.";
        break;
      }
      case "help":
        result = `LVIS 명령어
/new 새 대화 시작
/sessions 저장된 세션 목록
/load <ID> 세션 복원
/compact 대화 압축
/briefing 데일리 브리핑
/remember <내용> 메모 저장
/notes 메모 목록
/vendor 현재 벤더/토큰 정보
/tools 등록된 도구 목록
/help 도움말`;
        break;
      default:
        result = `알 수 없는 명령어: /${command}\n사용 가능: /new, /sessions, /load, /compact, /briefing, /remember, /notes, /vendor, /tools, /help`;
    }

    callbacks?.onTextDelta?.(result);
    callbacks?.onTurnComplete?.(result);
    return { text: result, toolCalls: [], route: "command" };
  }

  private getProviderCandidates(): Array<{ vendor: LLMVendor; apiKey: string; model: string }> {
    const llmSettings = this.deps.settingsService.get("llm");
    const ordered = [
      llmSettings.provider,
      ...FALLBACK_VENDORS.filter((vendor) => vendor !== llmSettings.provider),
    ];

    const candidates: Array<{ vendor: LLMVendor; apiKey: string; model: string }> = [];
    for (const vendor of ordered) {
      if (vendor === "lgenie") continue;
      const apiKey = this.deps.settingsService.getSecret(secretKeyFor(vendor));
      if (!apiKey) continue;
      const model = vendor === llmSettings.provider
        ? llmSettings.model
        : LLM_DEFAULT_MODELS[vendor];
      candidates.push({ vendor, apiKey, model });
    }
    return candidates;
  }

  private async invokeWithFallback(
    request: Omit<ChatTurnRequest, "vendor" | "apiKey" | "model">,
  ): Promise<ChatTurnResponse> {
    if (!this.deps.chatService) {
      throw new Error("chat service unavailable");
    }

    const candidates = this.getProviderCandidates();
    if (candidates.length === 0) {
      const llm = this.deps.settingsService.get("llm");
      throw new Error(`missing API key for ${llm.provider} and no fallback provider is configured`);
    }

    let firstError: Error | null = null;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      try {
        if (index > 0) {
          console.warn(`[lvis] chat fallback -> ${candidate.vendor} (${candidate.model})`);
        }
        return await this.deps.chatService.turn({
          ...request,
          vendor: candidate.vendor,
          apiKey: candidate.apiKey,
          model: candidate.model,
        });
      } catch (error) {
        const resolved = error instanceof Error ? error : new Error(String(error));
        if (!firstError) firstError = resolved;
        console.warn(`[lvis] chat provider failed: ${candidate.vendor}: ${resolved.message}`);
      }
    }

    throw firstError ?? new Error("all chat providers failed");
  }
}

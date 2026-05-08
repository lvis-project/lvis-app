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
import { markStaleToolResults, estimateMessagesTokens, getModelPreflightThreshold, getModelUsableContext } from "./auto-compact.js";
import { compactWithBoundary, renderBoundaryAsPreamble } from "./structured-compact.js";
import { stubMarkedToolResults } from "./wire-serialize.js";
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
     * Compact tier — `"auto-compact"` (Layer 0 preflight) | `"manual"` (`/compact`).
     * UI CheckpointDivider 가 색상/라벨 결정에 사용 (`lib/chat-stream-state.ts:CheckpointTier`).
     */
    tier?: "auto-compact" | "manual";
    /**
     * Rolling summary — Layer 2 의 `renderBoundaryAsPreamble()` 결과. 사용자 가시성용.
     */
    summary?: string;
    /**
     * §PR-5: compact sequence number — passed to CheckpointDivider to enable
     * view-mode and branch-from-checkpoint actions.
     */
    compactNum?: number;
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
    /**
     * `tokensIn` = the LAST round's raw input tokens (prompt size at turn
     * end, includes cache reads). Used by TokenProgressRing to render the
     * "context window fill" indicator — cache reads still occupy context
     * window slots, so the ring needs the full size.
     */
    tokensIn: number;
    /**
     * `freshInputTokens` = turn-aggregate fresh input (sum across rounds of
     * `inputTokens − cacheReadTokens − cacheWriteTokens`). This is the
     * billing-weight number the TokenCostBadge needs — fresh tokens are
     * billed at full input price, while cached reads are billed at 10%.
     * Splitting `tokensIn` (last-round raw, for size) from `freshInputTokens`
     * (turn-aggregate fresh, for billing) avoids the prior bug where the
     * badge subtracted whole-turn cache from one round's input and ended up
     * showing 0 fresh on multi-round (tool-using) turns.
     */
    freshInputTokens: number;
    tokensOut: number;
    /**
     * Cache breakdown — Anthropic prompt cache (read 90% 할인 / write 25% 가산).
     * Vercel AI SDK v6 의 inputTokens 는 cached 포함 정규화이므로 이 두 값을
     * 별도로 surface 해야 사용자가 fresh vs cached 비용 차이 인지 가능.
     * Reference: Kilo Code OpenCode session.ts:355 패턴.
     */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    breakdown?: Record<string, { count: number; ms: number }>;
  }) => void;
}

export interface TurnResult {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  route: string;
  usage?: TokenUsage;
  stopReason?: "end_turn" | "tool_use" | "interrupted" | "context-error";
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

// 사용자가 *26 step* 작업에서 cap hit 으로 *조용히 끊긴* 사례 (2026-05-07) 후
// 10 → 30 으로 상향. 사용자 task 의 자연 round 분포 (~13 rounds for 26 steps) 를
// 수용하면서 *진정한 무한 루프* 는 여전히 차단. SubAgentRunner 는 자기 maxRounds
// 로 clamp 하므로 영향 없음 (line 902 `Math.min`).
const MAX_TOOL_ROUNDS = 30;
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
  /**
   * 마지막 round 의 raw inputTokens — turn_summary.tokensIn 으로 forward.
   * "이번 turn 의 prompt 가 얼마나 컸나" (size 의도). queryLoop 에서 매 round
   * overwrite, runTurn 의 turn_summary emit 시 read. billing 합산 (turnUsage)
   * 와 다른 metric.
   */
  private lastRoundInputTokens = 0;
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
  /**
   * PR-2-C R14 mitigation — single in-flight Layer 2 compact lock per ConversationLoop.
   * 같은 instance 에서 두 turn 이 동시에 Layer 0 trigger 시 두 번째는 skip (race 방지).
   */
  private isCompacting: boolean = false;
  /** PR-2-C — Layer 2 compact 가 #N 번째인지 (numbered checkpoint chain, Copilot 패턴). */
  private compactNum: number = 0;

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
      this.deps.memoryManager.saveSession(this.sessionId, stubMarkedToolResults(this.history.getMessages())).catch((err: unknown) => {
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
    this.sessionPluginExpansions = 0;
    this.compactNum = 0;
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

  /**
   * §PR-5 Layer 3 View-Mode — 체크포인트 #compactNum 의 슬라이스 끝 인덱스를 반환.
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
   * §PR-5 Layer 3 View-Mode — view-mode 종료 audit hook.
   * 실제 engine 상태 변경 없음 (렌더러 state 만 reset). 추후 감사 로그 추가 가능.
   */
  public exitViewMode(): void {
    // no-op: renderer-side state reset only
  }

  /**
   * §PR-5 Layer 3 Branch — 체크포인트 #compactNum 지점에서 새 세션을 fork.
   * history 를 slicing 하고 wire-serialize 후 disk 영속화. 새 sessionId 반환.
   */
  public async branchFromCheckpoint(compactNum: number): Promise<{ newSessionId: string }> {
    const checkpoints = this.deps.memoryManager.loadSessionMetadata(this.sessionId)?.checkpoints ?? [];
    const target = checkpoints.find((c) => c.compactNum === compactNum);
    if (!target) throw new Error(`Checkpoint #${compactNum} not found in session ${this.sessionId}`);

    // §PR-5: Load the pre-compact snapshot saved at compaction time.
    // The main session JSONL is overwritten by PostTurnHookChain.saveSession with the
    // post-compact history after each turn, so it cannot be used to reconstruct the
    // pre-checkpoint transcript. saveCheckpointSnapshot() persists messagesBefore to
    // a checkpoint-specific file (.checkpoints/{sessionId}/{N}.jsonl) before the turn completes.
    const snapshotMessages = this.deps.memoryManager.loadCheckpointSnapshot?.(this.sessionId, compactNum);
    if (!snapshotMessages) {
      throw new Error(
        `branchFromCheckpoint: no snapshot found for checkpoint #${compactNum} in session ${this.sessionId}. ` +
        `Snapshots are only available for checkpoints created after this feature was introduced.`,
      );
    }
    if (snapshotMessages.length < target.messageCountAtTrigger) {
      throw new Error(
        `branchFromCheckpoint: snapshot length ${snapshotMessages.length} < checkpoint messageCountAtTrigger ${target.messageCountAtTrigger} for session ${this.sessionId}`,
      );
    }

    const newSessionId = crypto.randomUUID();
    const sliced = (snapshotMessages as import("./llm/types.js").GenericMessage[]).slice(0, target.messageCountAtTrigger);

    // §PR-5 round-8: repair tool-pair invariant — loadCheckpointSnapshot skips malformed JSONL
    // lines, which can leave orphaned tool_call or tool_result entries in the slice.
    const { messages: repaired, removedMessages, removedToolCalls } = normalizeToolPairInvariant(sliced);
    if (removedMessages > 0 || removedToolCalls > 0) {
      log.warn(
        `branchFromCheckpoint: repaired ${removedMessages} messages + ${removedToolCalls} tool calls from snapshot (session ${this.sessionId} compact #${compactNum})`,
      );
    }

    // wire-serialize: markStaleToolResults 된 verbatim history 를 stub 치환 후 영속화
    await this.deps.memoryManager.saveSession(newSessionId, stubMarkedToolResults(repaired));

    // 브랜치 세션 metadata — parentSessionId + 브랜치 provenance
    await this.deps.memoryManager.saveSessionMetadata(newSessionId, {
      parentSessionId: this.sessionId,
      branchedFromCompactNum: compactNum,
      branchedAt: new Date().toISOString(),
    });

    log.info(`branchFromCheckpoint: new session ${newSessionId} from ${this.sessionId} @ compact #${compactNum}`);
    return { newSessionId };
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
      this.deps.memoryManager.saveSession(this.sessionId, stubMarkedToolResults(this.history.getMessages())).catch((err: unknown) => {
        log.warn("loadSession saveSession failed: %s", (err as Error).message);
      });
    }

    const normalized = normalizeToolPairInvariant(messages as import("./llm/types.js").GenericMessage[]);
    if (normalized.removedMessages > 0 || normalized.removedToolCalls > 0) {
      log.warn(
        `loadSession: repaired invalid tool history for ${sessionId} (removedMessages=${normalized.removedMessages}, removedToolCalls=${normalized.removedToolCalls})`,
      );
      void this.deps.memoryManager.saveSession(sessionId, stubMarkedToolResults(normalized.messages)).catch((err: unknown) => {
        log.warn("loadSession repair saveSession failed: %s", (err as Error).message);
      });
    }

    this.sessionId = sessionId;
    const sessionMeta = this.deps.memoryManager.loadSessionMetadata(sessionId);
    this.sessionRoutineId = sessionMeta?.routineId ?? null;
    this.history.clear();
    this.history.restore(normalized.messages);
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.sessionPluginExpansions = 0;
    this.compactNum = sessionMeta?.checkpoints?.length ?? 0;
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

    // PR-2-F-4: loadSession 후 auto-compact 제거 — Layer 0 preflight 가 next user turn
    // 진입 시 estimateMessagesTokens 평가 + 도달 시 Layer 2 LLM compact 처리. resume-time
    // sync compact 는 redundant. cumulativeUsage 만 추정값으로 set 하여 Layer 0 가
    // 정확한 ratio 평가 가능하도록 함.
    this.cumulativeUsage = {
      inputTokens: estimateMessagesTokens(this.history.getMessages()),
      outputTokens: 0,
    };

    return {
      ok: true,
      compacted: false,
      compactedAt: null,
      removedMessageCount: 0,
    };
  }

  /**
   * §4.5.4 — Manual compact trigger (`/compact` user command).
   *
   * PR-2-F-4 정정: extractive `compactMessages` → LLM-based `compactWithBoundary` 마이그레이션.
   * 사용자가 명시적으로 trigger 한 강제 압축이므로 임계값 무시하고 진입 — 단 history 가
   * preserveRecentTokens 보다 작으면 no-op (압축할 내용 없음).
   *
   * R14 lock — 동시 compact race 방지.
   */
  async manualCompact(callbacks?: Pick<TurnCallbacks, "onCompactOccurred">): Promise<{
    compacted: boolean;
    compactedAt: string | null;
    summary: string;
    removedMessageCount: number;
  }> {
    if (!this.provider) {
      return {
        compacted: false,
        compactedAt: null,
        summary: "LLM provider 미구성 — 압축 실행 불가.",
        removedMessageCount: 0,
      };
    }
    if (this.isCompacting) {
      return {
        compacted: false,
        compactedAt: null,
        summary: "이미 다른 압축이 진행 중입니다.",
        removedMessageCount: 0,
      };
    }

    const llmSettings = this.deps.settingsService.get("llm");
    const provider = llmSettings.provider;
    const model = llmSettings.vendors[provider].model;
    const preflight = getModelPreflightThreshold(provider, model);
    const preserveRecentTokens = Math.max(1_000, Math.floor(preflight * 0.4));

    this.isCompacting = true;
    try {
      const messagesBefore = this.history.getMessages();
      const result = await compactWithBoundary({
        messages: messagesBefore,
        llm: this.provider,
        model,
        preserveRecentTokens,
        compactNum: this.compactNum + 1,
      });

      if (result === null || result.removedCount === 0) {
        return {
          compacted: false,
          compactedAt: null,
          summary: "컴팩트 불필요: 메시지 수가 충분히 적습니다.",
          removedMessageCount: 0,
        };
      }

      const estimated = estimateMessagesTokens(messagesBefore);
      await this.applyBoundaryToSession(result, "manual", estimated, callbacks, messagesBefore.length);

      // 영속화 — manualCompact 완료 시점에 즉시 disk 반영. saveSession 실패는
      // 사용자 가시 결과에 영향 X (next turn 에서도 compact 결과 보존됨).
      void Promise.resolve(
        this.deps.memoryManager?.saveSession(this.sessionId, stubMarkedToolResults(this.history.getMessages())),
      ).catch((err: unknown) => {
        log.warn("manualCompact saveSession failed: %s", (err as Error).message);
      });

      return {
        compacted: true,
        compactedAt: result.boundary.createdAt,
        summary: `${result.removedCount}개 메시지 요약됨 (compact #${this.compactNum})`,
        removedMessageCount: result.removedCount,
      };
    } catch (err) {
      log.error("manualCompact failed: %s", (err as Error).message);
      // Return safe result rather than bubbling — prevents unhandled IPC rejection.
      // `/compact` command handler and callers get a user-visible failure message.
      return {
        compacted: false,
        compactedAt: null,
        summary: `압축 실패: ${(err as Error).message}`,
        removedMessageCount: 0,
      };
    } finally {
      this.isCompacting = false;
    }
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
    // queryLoop 가 별 method 라 마지막 round 의 raw inputTokens 를 instance
    // field 로 share. queryLoop 가 매 round set, runTurn 이 turn_summary
    // emit 시 read. 의도: "이번 turn 의 prompt size" 사용자 직관 (사용자
    // 보고 2026-05-07: 합산은 10× over-count 처럼 보임).
    this.lastRoundInputTokens = 0;
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

    // ─── Layer 0 — Pre-flight Guard (`infinity-session-redesign-v3.md` §4.1) ───
    // step 5 (HISTORY_APPEND) 직후 / step 6 (PROMPT_ASSEMBLE) 직전. estimateMessagesTokens
    // 가 model 의 preflight threshold 도달 시 차단형으로 Layer 2 (compactWithBoundary) 실행.
    // 결과: ⑧ slot 갱신 + history 교체 + cumulativeUsage reset → 후속 step 6 build() 가
    // 새 compact 결과를 반영. mid-loop reactive compact 영구 예방 (R13 sync chain + R14 lock).
    if (this.provider) {
      await this.runPreflightGuard(turnSignal, callbacks);
    }

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
        const beforeCount = this.history.getMessages().length;
        const afterCount = hookResult.compactedMessages.length;
        log.info(
          `post-turn: history mutation — ${beforeCount} → ${afterCount} msgs (compact applied to history reference)`,
        );
        this.history.clear();
        this.history.restore(hookResult.compactedMessages);
      }
      // §PR-3: cleaned text (markers stripped) replaces raw output for caller
      if (hookResult.detector.cleanedText !== result.text) {
        result = { ...result, text: hookResult.detector.cleanedText };
      }
    } else {
      // fallback: PostTurnHookChain 미주입 시 기존 inline 로직 유지.
      // SubAgentRunner 의 child loop 가 이 경로를 사용 (`postTurnHookChain: undefined`)
      // — isolation contract 보존 (parent session 의 audit/extractMemory/idle-poke 미터치) +
      // Layer 1 markStaleToolResults 만 child 에도 적용하여 child tool_result 가 parent
      // 로 surface 되어 history 부풀리는 문제 방지 (v3 PR-1c).
      // cycle 1 MED: extractMemory 중복 제거 — memory-extract hook이
      // PostTurnHookChain에서 이미 처리하므로 fallback에서도 호출하지 않는다.
      // PostTurnHookChain을 주입한 경우와 fallback 모두 memory 추출은
      // hook chain의 memory-extract 단계에서만 일어난다.
      if (this.isAutoCompactEnabled()) {
        // Layer 1 part marking — 항상 실행, 저비용. child loop 에서도 작동.
        // PR-2-F-3: Stage 1b 제거 — Layer 0 preflight (next turn) 가 동등 압축 처리.
        // child loop 은 fire-and-forget 이라 turn budget 짧음 → markStaleToolResults 만으로 충분.
        const { messages: afterMark, result: mr } = markStaleToolResults(this.history.getMessages());
        if (mr.marked) {
          this.history.clear();
          this.history.restore(afterMark);
          if (process.env.NODE_ENV !== "production") {
            log.info(`mark-stale (fallback): marked ${mr.markedCount} tool_results, ~${mr.freedCharsOnSerialize} chars saved on serialize`);
          }
        }
      }
      await this.deps.memoryManager.saveSession(this.sessionId, stubMarkedToolResults(this.history.getMessages()));
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

    // PR-2-F-2: rotation orchestration 폐지. Layer 2 의 same-session checkpoint chain
    // (`runPreflightGuard` 안의 appendCheckpoint) 으로 대체 — fork 없음, sessionId 불변.
    // Turn 종료 후 별도 hook 불필요: Layer 0 가 다음 turn 진입 시 다시 평가.

    // Turn aggregate footer — see TurnCallbacks.onTurnSummary doc above.
    // Tokens come from the LLM provider's usage report (Vercel AI SDK
    // exposes prompt_tokens + completion_tokens via the provider's
    // streamText/onFinish equivalent — see `engine/llm/vercel/adapter.ts`
    // and `engine/llm/vercel/stream-mapper.ts` which forward the values
    // into the round stream's `usage` field). Suppressed for interrupted
    // turns and turns without a real assistant response (mirrors the
    // turn-end notification gate so dropped turns don't render footers).
    // Production diagnostic — turn_summary 가 사용자 UI (TokenCostBadge 배지
     // + TokenProgressRing) 의 단일 source 라 *emit 되지 않으면* 두 표면 모두
     // 0 표시. 어느 단계에서 끊겼는지 정확히 가시화.
    const willEmitSummary =
      result.stopReason !== "interrupted" &&
      result.stopReason !== "context-error" &&
      typeof result.text === "string" &&
      result.text.trim().length > 0;
    log.info(
      `turn_summary: emit decision — stopReason="${result.stopReason}" textLen=${result.text?.trim().length ?? 0} usage=${result.usage ? `in=${result.usage.inputTokens} out=${result.usage.outputTokens}` : "MISSING"} → willEmit=${willEmitSummary}`,
    );
    if (willEmitSummary) {
      // tokensIn = 마지막 round 의 prompt size (TokenProgressRing 의 "컨텍스트
      //   윈도우 fill" 표시용 — cache 읽기도 컨텍스트 슬롯을 차지하므로 raw 가
      //   맞음).
      // tokensOut / cacheRead / cacheWrite = turn 전체 합산 (billing 누적).
      // freshInputTokens = turn 전체 fresh 합산 (TokenCostBadge headline +
      //   cost 계산용 — 라운드별 (inputTokens − cacheRead − cacheWrite) 의 합).
      //   `result.usage` 는 turn-aggregate (queryLoop:1098 turnUsage), 그러므로
      //   여기서 단순 산수만 하면 정확. 이전 badge 버그는 last-round raw 와
      //   turn-aggregate cache 를 빼느라 음수 → 0 으로 잘리던 mismatch.
      turnTokensIn = this.lastRoundInputTokens;
      turnTokensOut = result.usage?.outputTokens ?? 0;
      const turnCacheRead = result.usage?.cacheReadTokens ?? 0;
      const turnCacheWrite = result.usage?.cacheWriteTokens ?? 0;
      const turnFreshInput = Math.max(
        0,
        (result.usage?.inputTokens ?? 0) - turnCacheRead - turnCacheWrite,
      );
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
          freshInputTokens: turnFreshInput,
          tokensOut: turnTokensOut,
          ...(turnCacheRead > 0 ? { cacheReadTokens: turnCacheRead } : {}),
          ...(turnCacheWrite > 0 ? { cacheWriteTokens: turnCacheWrite } : {}),
          ...(breakdown ? { breakdown } : {}),
        });
      } catch {
        // Summary emission must never break turn completion.
      }
    }

    callbacks?.onTurnComplete?.(result.text);

    // Issue #260 — fire system notification on turn-end. Skip if the turn
    // was interrupted (user aborted), hit context_error, or produced no
    // assistant text (rare tool-only termination). Body is the leading slice
    // of the assistant response — NotificationService caps + ellipses it.
    if (
      result.stopReason !== "interrupted" &&
      result.stopReason !== "context-error" &&
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
  ): Promise<{ text: string; toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>; usage?: TokenUsage; stopReason?: "end_turn" | "tool_use" | "interrupted" | "context-error" }> {
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
        // EARLY-EXIT #1: round cap hit. 이 자리에서 *조용히* synthetic 텍스트
        // 를 반환하면 사용자는 "왜 갑자기 끊겼지?" 의문. WARN 로그 + UI 콜백으로
        // 명시적 신호.
        log.warn(
          `queryLoop: EARLY-EXIT(round-cap) — assistantRoundsRun=${assistantRoundsRun} effectiveMaxRounds=${effectiveMaxRounds} totalToolCalls=${allToolCalls.length}`,
        );
        callbacks?.onError?.(
          `라운드 한도 (${effectiveMaxRounds}) 도달 — 작업이 중단됐습니다. 더 진행하려면 새 메시지를 보내세요.`,
        );
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

      // ─── Stream attempt — Layer 0 preflight 가 사전 압축 처리하므로 mid-loop retry 없음 ───
      const stream = await collectRoundStream({
        provider: this.provider!,
        model,
        systemPrompt,
        messages: this.history.getMessages(),
        toolSchemas,
        llmSettings: { ...activeBlock, streamSmoothing: llmSettings.streamSmoothing },
        abortSignal,
        onReasoningDelta: callbacks?.onReasoningDelta,
        onTextDelta: callbacks?.onTextDelta,
      });

      // EARLY-EXIT (R6 safety net): Layer 0 estimator drift 로 context_error 도달 시
      // 사용자 안내 + turn 종료. retry 없음 — mid-loop history mutation 으로 LLM tool-chain
      // 손상되던 silent failure 패턴 영구 제거.
      if (stream.kind === "context_error") {
        log.warn(
          `queryLoop: EARLY-EXIT(context_error after Layer 0) — round=${roundIndex} err="${(stream.errorMessage ?? "").slice(0, 100)}" (estimator drift suspected)`,
        );
        const userMsg =
          "대화 이력이 모델 한도를 초과했습니다. 새 메시지를 보내면 자동 압축이 다시 시도됩니다.";
        callbacks?.onError?.(userMsg);
        this.history.append({ role: "assistant", content: userMsg });
        return { text: userMsg, toolCalls: allToolCalls, usage: turnUsage, stopReason: "context-error" };
      }

      if (stream.kind === "stream_error") {
        // EARLY-EXIT #2: provider stream error. 이미 onError 콜백 + history 에
        // 메시지 push. 추가 진단 로그로 빈도 추적.
        log.warn(
          `queryLoop: EARLY-EXIT(stream-error) — round=${roundIndex} userMessage="${stream.userMessage.slice(0, 100)}"`,
        );
        callbacks?.onError?.(stream.userMessage);
        this.history.append({ role: "assistant", content: stream.userMessage });
        return { text: stream.userMessage, toolCalls: allToolCalls, usage: turnUsage };
      }

      if (stream.kind === "interrupted") {
        // EARLY-EXIT #3: 사용자 abort. abortCurrentTurn() 또는 외부 abortSignal.
        // 정상 케이스이지만 빈도 추적용 로그.
        log.info(
          `queryLoop: EARLY-EXIT(interrupted) — round=${roundIndex} priorTextLen=${(stream.text ?? "").length}`,
        );
        const savedText = (stream.text ?? "") + "\n\n[중단됨]";
        this.history.append({ role: "assistant", content: savedText });
        callbacks?.onTextDelta?.("\n\n[중단됨]");
        return { text: savedText, toolCalls: allToolCalls, usage: turnUsage, stopReason: "interrupted" };
      }

      // stream.kind === "ok" — usage 반영 + assistant round commit
      //
      // Kilo Code OpenCode session.ts:355 패턴 적용:
      //   "AI SDK v6 normalized inputTokens to include cached tokens across
      //    all providers — subtract cacheRead/cacheWrite to get fresh input."
      //
      // 1) turnUsage 는 모든 round 합산 (이전: `=` 으로 마지막 round 만 보존
      //    → multi-round turn 의 turn_summary 가 under-report 되던 버그).
      // 2) cumulativeUsage.inputTokens 는 fresh input 만 누적 (cached 빼서)
      //    → long session 에서 cached prefix 가 매 turn 누적되어 ctxUsage 가
      //    조기에 100% 도달, auto-compact 가 premature 발화하던 root cause 해소.
      // 3) cache read/write 는 별도 누적 — 비용 계산은 다른 가중치 (read 0.1×,
      //    write 1.25×) 적용 가능하도록 분리 보존.
      if (stream.usage) {
        const u = stream.usage;
        const cacheRead = u.cacheReadTokens ?? 0;
        const cacheWrite = u.cacheWriteTokens ?? 0;
        const adjustedIn = Math.max(0, u.inputTokens - cacheRead - cacheWrite);

        // Last-round overwrite (instance field — runTurn 의 turn_summary
        // emit 이 read). turn_summary.tokensIn 의 size 의도. billing 합산은
        // turnUsage.inputTokens / cumulativeUsage 가 별도 추적.
        this.lastRoundInputTokens = u.inputTokens;

        turnUsage = {
          inputTokens: (turnUsage?.inputTokens ?? 0) + u.inputTokens,
          outputTokens: (turnUsage?.outputTokens ?? 0) + u.outputTokens,
          cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + cacheRead,
          cacheWriteTokens: (turnUsage?.cacheWriteTokens ?? 0) + cacheWrite,
        };

        this.cumulativeUsage.inputTokens += adjustedIn;
        this.cumulativeUsage.outputTokens += u.outputTokens;
        this.cumulativeUsage.cacheReadTokens =
          (this.cumulativeUsage.cacheReadTokens ?? 0) + cacheRead;
        this.cumulativeUsage.cacheWriteTokens =
          (this.cumulativeUsage.cacheWriteTokens ?? 0) + cacheWrite;
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
        // EARLY-EXIT #4: turn 종료. 정상 케이스는 stopReason === "end_turn"
        // 또는 LLM 이 tool 없이 final 답을 내놓은 케이스. *비정상 silent
        // truncation* (예: max_tokens / unknown stopReason 으로 0 tools 반환)
        // 도 같은 분기로 떨어지므로 stopReason 이 end_turn 이 *아닌데* 0 tools
        // 면 WARN 로 명시적 진단 — 28-step abandonment 의 가능한 원인.
        if (stopReason !== "end_turn" && pendingToolCalls.length === 0) {
          log.warn(
            `queryLoop: EARLY-EXIT(suspect-truncation) — stopReason="${stopReason}" pendingTools=0 textLen=${textContent.length} round=${roundIndex}`,
          );
          callbacks?.onError?.(
            `응답이 ${stopReason ?? "알 수 없는 이유"} 로 조기 종료됐습니다 (round ${roundIndex}). 추가 응답 필요 시 후속 메시지로 요청하세요.`,
          );
        }
        return { text: textContent, toolCalls: allToolCalls, usage: turnUsage, stopReason };
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
   * DRY helper — boundary 적용 공통 경로.
   *
   * `runPreflightGuard` (auto) 와 `manualCompact` (manual) 가 동일 동작을 공유:
   *   1. `compactNum` 증가
   *   2. `history` 교체 (boundary stub + recentVerbatim)
   *   3. `setSummaryPreamble` 로 ⑧ slot 갱신 (P1 sync chain)
   *   4. `cumulativeUsage.inputTokens = estimatedAfter` reset
   *   5. Layer 3 checkpoint append + saveSessionMetadata 영속화
   *   6. `callbacks.onCompactOccurred` surface (사용자 가시 compact_notice)
   *
   * Layer 3 storage 실패는 대화 차단 금지 — warn 후 계속.
   */
  private async applyBoundaryToSession(
    result: import("./structured-compact.js").CompactWithBoundaryResult,
    trigger: "auto-compact" | "manual",
    estimatedBefore: number,
    callbacks: TurnCallbacks | undefined,
    /** compact 직전 history 길이 — messageCountAtTrigger 에 기록 (origin count). */
    prevMessageCount: number,
  ): Promise<void> {
    this.compactNum = result.boundary.compactNum;
    this.history.clear();
    this.history.restore([...result.newHistory]);
    const preamble = renderBoundaryAsPreamble(result.boundary);
    this.deps.systemPromptBuilder.setSummaryPreamble?.(preamble);
    this.cumulativeUsage = {
      inputTokens: result.estimatedAfter,
      outputTokens: this.cumulativeUsage.outputTokens,
      ...(this.cumulativeUsage.cacheReadTokens !== undefined && { cacheReadTokens: 0 }),
      ...(this.cumulativeUsage.cacheWriteTokens !== undefined && { cacheWriteTokens: 0 }),
    };

    // Layer 3 — same-session checkpoint chain (§4.4).
    // PR-2-E (#608) 정정: ctxUsageAtTrigger 분모는 *usable context window* (Cline buffer 적용).
    try {
      const llmSettings = this.deps.settingsService.get("llm");
      const provider = llmSettings.provider;
      const model = llmSettings.vendors[provider].model;
      const usable = getModelUsableContext(provider, model);
      const ctxUsageAtTrigger = usable > 0 ? Math.min(1.0, estimatedBefore / usable) : 0;
      const checkpointEntry: import("../memory/memory-manager.js").Checkpoint = {
        id: crypto.randomUUID(),
        triggeredAt: result.boundary.createdAt,
        trigger,
        ctxUsageAtTrigger,
        summary: preamble,
        messageCountAtTrigger: prevMessageCount,
        compactNum: this.compactNum,
      };
      const existingMeta = this.deps.memoryManager.loadSessionMetadata(this.sessionId) ?? {};
      const updatedMeta = this.deps.memoryManager.appendCheckpoint(existingMeta, checkpointEntry);
      await this.deps.memoryManager.saveSessionMetadata(this.sessionId, {
        ...updatedMeta,
        summaryPreamble: preamble,
      });
    } catch (storageErr) {
      log.warn(`applyBoundaryToSession: Layer 3 checkpoint persist 실패 — ${(storageErr as Error).message}`);
    }

    callbacks?.onCompactOccurred?.({
      removedMessages: result.removedCount,
      freedTokens: Math.max(0, estimatedBefore - result.estimatedAfter),
      tier: trigger,
      summary: preamble,
    });
  }

  /**
   * Layer 0 — Pre-flight Guard (`infinity-session-redesign-v3.md` §4.1, P1 sync chain).
   *
   * step 5 (HISTORY_APPEND) 직후 호출 — `estimateMessagesTokens(history) >= getModelPreflightThreshold()`
   * 시 차단형 await 로 Layer 2 (`compactWithBoundary`) 실행. 결과:
   *   1. `compactNum` 증가
   *   2. `history` 교체 (boundary stub + recentVerbatim)
   *   3. `setSummaryPreamble` 로 ⑧ slot 갱신 (P1 — step 6 진입 전 반드시 set)
   *   4. `cumulativeUsage.inputTokens = estimatedAfter` (의미 정합 reset)
   *   5. `onCompactOccurred` 콜백 surface
   *
   * R14 mitigation — `isCompacting` lock per ConversationLoop instance. 동시 turn 에서
   * Layer 0 진입 race 시 두번째는 silent skip.
   *
   * mid-loop reactive compact 는 PR-2-F-1 에서 영구 제거됨 — context_error 도달 시
   * early-exit signal 만 전달하고 stream-collector 가 사용자 안내 처리.
   */
  private async runPreflightGuard(
    abortSignal?: AbortSignal,
    callbacks?: TurnCallbacks,
  ): Promise<void> {
    if (!this.isAutoCompactEnabled()) {
      log.debug("runPreflightGuard: skipped (autoCompact 설정 OFF)");
      return;
    }
    if (this.isCompacting) {
      log.info("preflight: SKIPPED — isCompacting lock held (concurrent turn race avoided)");
      return;
    }
    if (!this.provider) return;

    const llmSettings = this.deps.settingsService.get("llm");
    const provider = llmSettings.provider;
    const model = llmSettings.vendors[provider].model;
    const preflight = getModelPreflightThreshold(provider, model);
    if (preflight <= 0) return;

    const messagesBefore = this.history.getMessages();
    const estimated = estimateMessagesTokens(messagesBefore);
    if (estimated < preflight) return;

    this.isCompacting = true;
    try {
      log.info(
        `preflight: TRIGGER — estimated=${estimated} >= preflight=${preflight} (model=${provider}/${model}) → Layer 2 compact #${this.compactNum + 1}`,
      );
      // preserve budget = preflight 의 40% — Cline preserve-recent-tokens 휴리스틱 (per-model 추가 조정 가능).
      const preserveRecentTokens = Math.max(1_000, Math.floor(preflight * 0.4));
      const compactResult = await compactWithBoundary({
        messages: messagesBefore,
        llm: this.provider,
        model,
        preserveRecentTokens,
        compactNum: this.compactNum + 1,
        ...(abortSignal !== undefined && { abortSignal }),
      });

      if (compactResult === null || compactResult.removedCount === 0) {
        log.info("preflight: Layer 2 returned removedCount=0 (preserveRecentTokens covered all) — no mutation");
        return;
      }

      // P1 sync chain — 다음 step 6 PROMPT_ASSEMBLE 가 새 boundary 를 read 해야 함.
      await this.applyBoundaryToSession(compactResult, "auto-compact", estimated, callbacks, messagesBefore.length);

      log.info(
        `preflight: APPLIED — removed=${compactResult.removedCount} estimatedAfter=${compactResult.estimatedAfter} compactNum=${this.compactNum}`,
      );
      callbacks?.onCompactOccurred?.({
        removedMessages: compactResult.removedCount,
        freedTokens: estimated - compactResult.estimatedAfter,
        tier: "auto-compact",
        compactNum: this.compactNum,
      });
    } catch (err) {
      // Layer 2 실패 시 turn 자체는 계속 진행 — Layer 0 미적용 history 로 stream attempt.
      // context_error 도달 시 stream-collector 의 safety net 이 사용자 안내 처리.
      log.warn(`preflight: Layer 2 failed — ${(err as Error).message}. context_error safety net 으로 위임.`);
    } finally {
      this.isCompacting = false;
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
        // PR-2-F-4: extractive compactMessages → LLM-based compactWithBoundary 마이그레이션.
        // manualCompact 가 Layer 2 path 를 사용 (12-section structured summary + freezeBoundary +
        // ⑧ slot 갱신 + summaryPreamble 영속화 + Layer 3 checkpoint append 포함).
        // callbacks 전달 — onCompactOccurred 가 renderer 에 compact_notice 이벤트 전달 가능.
        const r = await this.manualCompact(callbacks);
        result = r.summary;
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

  // PR-2-F-2: 3-tier rotation 폐지 — Layer 0/2/3 가 same-session checkpoint chain
  // (Copilot 패턴) 으로 대체. `runRotationCheck`, `createChildSession`, `rotateActive`,
  // `decideRotation` 모두 제거. fork 없음 — sessionId 불변.
}

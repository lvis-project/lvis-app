/**
 * Conversation Query Loop — §4.5 핵심 에이전틱 사이클
 *
 * 사용자 입력 → KW분류 → 라우팅 → 컨텍스트 조립 → LLM 스트리밍
 * → tool_use 감지 → 도구 실행 → loop back → 응답 완료
 *
 * 벤더 추상화: LLMProvider 인터페이스를 통해 Claude/OpenAI/Gemini/Copilot 통일 처리.
 * LVIS 내부 turn-runtime contract 기반.
 */
import { ConversationHistory, normalizeToolPairInvariant } from "./conversation-history.js";
import { ToolExecutor, type ToolResult, type ToolUseBlock } from "../tools/executor.js";
import { isActiveSandboxFilesystemContained } from "../permissions/sandbox-capability.js";
import { HookRunner } from "../hooks/hook-runner.js";
import type { LifecycleHookEvent } from "../hooks/script-hook-types.js";
import { markStaleToolResults, estimateMessagesTokens, estimateTokens, getModelPreflightThreshold, getModelUsableContext, isContextLengthError } from "./auto-compact.js";
import {
  estimateRequestInputProjection,
  projectNextTurnInputTokens,
  type RequestInputProjection,
} from "./request-input-projection.js";

/**
 * 사용자가 반복적으로 context_error 유발 input 보낼 때 compact API 호출
 * 폭주 방어 (Issue #910 round-4 security MEDIUM). 정상 사용자는 도달하지
 * 않는 임계 — 3 회 연속 force-recover 는 *compact 가 reduce 못 하는*
 * pathological 상태이거나 *adversarial input* 신호.
 */
const MAX_FORCE_RECOVER_PER_SESSION = 3;
import { compactWithBoundary, DEFAULT_PRESERVE_RECENT_TURNS, renderBoundaryAsPreamble } from "./structured-compact.js";
import { CompressionStatus } from "../shared/compact-status.js";
import { EAGER_TOOL_EXPOSURE_CEILING } from "../shared/tool-exposure-policy.js";
import { stripSuggestedReplies } from "./suggested-replies.js";
import { createProvider, secretKeyFor } from "./llm/provider-factory.js";
import { FallbackProvider, type FallbackStatus } from "./llm/vercel/fallback-chain.js";
import { normalizeAiSdkUsageForCost } from "./llm/pricing.js";
import type {
  GenericMessage,
  LLMVendor,
  LLMProvider,
  MessageMeta,
  ProviderConfig,
  ToolSchema,
  TokenUsage,
  TokenUsageByModel,
} from "./llm/types.js";
import { collectRoundStream } from "./turn/stream-collector.js";
import { vendorSupportsLengthContinuation } from "./llm/vendor-capabilities.js";
import { rejectedToolNameFromError, withoutDroppedTools } from "./llm/rejected-tool-schema.js";
import {
  handleRequestPlugin,
  REQUEST_PLUGIN_TOOL,
} from "./turn/plugin-expansion.js";
import {
  handleToolSearch,
  TOOL_SEARCH_TOOL,
} from "./turn/tool-search.js";
import { applyKnowledgeDepthCap } from "./turn/knowledge-cap.js";
import type { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type { KeywordEngine } from "../core/keyword-engine.js";
import type { RouteEngine } from "../core/route-engine.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolSource, ToolTrustOrigin } from "../tools/types.js";
import type { ReadableToolResult } from "../tools/tool-result-chunk.js";
import type { MemoryManager, SessionKind } from "../memory/memory-manager.js";
import type { SettingsService } from "../data/settings-store.js";
import type { ActiveRolePrompt } from "../data/role-presets.js";
import type { HookTrustCommandOptions } from "../hooks/hook-trust-commands.js";
import { AuditLogger } from "../audit/audit-logger.js";
import type { RoutineEngine } from "../core/routine-engine.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import { PostTurnHookChain } from "../hooks/post-turn-hook-chain.js";
import type { ToolCallMeta } from "../tools/executor.js";
import type { ChatInputOrigin } from "../shared/chat-origin.js";
import { isUserKeyboardOrigin } from "../shared/chat-origin.js";
import type { AiProviderPingResult } from "../shared/ai-provider-ping.js";
import type { PermissionReviewEvent } from "../shared/permission-review-status.js";
import { parseImportedTriggerEnvelopePayload } from "../shared/overlay-trigger-source.js";
import { stripLeadingSlash } from "../shared/slash-sanitizer.js";
import { isToolResultStubContent } from "../shared/tool-result-stub.js";
import { createTracer, type ConversationTracer } from "../observability/conversation-trace.js";
import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
const log = createLogger("lvis");

interface RequestProjectionContext {
  systemPrompt: string;
  toolSchemas: ToolSchema[];
  estimateCurrent: () => RequestInputProjection;
}

const INLINE_PASTED_TEXT_RE = /(^|\n)-{5} Pasted text #\d+ \(\d+ lines\) -{5}\n/;
const SESSION_ID_REGEX = /^[a-zA-Z0-9_\-]+$/;
const AI_PROVIDER_PING_TIMEOUT_MS = 8_000;

type ToolSourceCounts = Record<ToolSource, number>;

function isSafeSessionId(sessionId: unknown): sessionId is string {
  return typeof sessionId === "string" && SESSION_ID_REGEX.test(sessionId);
}

function isBuiltinToolInventoryQuestion(input: string): boolean {
  const text = input.toLowerCase();
  const mentionsTool = /tool|툴|도구/.test(text);
  const mentionsBuiltin = /builtin|built-in|빌트인|내장|기본/.test(text);
  const mentionsNonBuiltin = /plugin|플러그인|mcp/.test(text);
  return mentionsTool && mentionsBuiltin && !mentionsNonBuiltin;
}

function emptyToolSourceCounts(): ToolSourceCounts {
  return { builtin: 0, plugin: 0, mcp: 0 };
}

function incrementToolSourceCounts(
  counts: ToolSourceCounts,
  source: ToolSource,
): void {
  counts[source] += 1;
}

function toolProvenanceLabel(tool: {
  source: ToolSource;
  pluginId?: string;
  mcpServerId?: string;
}): string {
  if (tool.source === "plugin") return `plugin:${tool.pluginId ?? "unknown"}`;
  if (tool.source === "mcp") return `mcp:${tool.mcpServerId ?? "unknown"}`;
  return "builtin";
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

function latestPersistedContextTokens(messages: GenericMessage[]): number {
  let latestTurnSummaryTokens = 0;
  let latestTurnSummaryCreatedAt = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const contextTokensAfter = messages[i]?.meta?.checkpointMeta?.contextTokensAfter;
    if (
      typeof contextTokensAfter === "number" &&
      Number.isFinite(contextTokensAfter) &&
      contextTokensAfter > 0
    ) {
      const compactedAt = messages[i]?.meta?.createdAt;
      if (
        latestTurnSummaryTokens > 0 &&
        typeof compactedAt === "number" &&
        Number.isFinite(compactedAt) &&
        latestTurnSummaryCreatedAt > compactedAt
      ) {
        return latestTurnSummaryTokens;
      }
      return Math.floor(contextTokensAfter);
    }
    const tokensIn = messages[i]?.meta?.turnSummary?.tokensIn;
    if (typeof tokensIn === "number" && Number.isFinite(tokensIn) && tokensIn > 0) {
      latestTurnSummaryTokens = Math.floor(tokensIn);
      const createdAt = messages[i]?.meta?.createdAt;
      latestTurnSummaryCreatedAt =
        typeof createdAt === "number" && Number.isFinite(createdAt) ? createdAt : 0;
    }
  }
  return latestTurnSummaryTokens;
}

function compactedHistoryWithContextCarrier(
  messages: GenericMessage[],
  contextTokensAfter: number,
): GenericMessage[] {
  let contextCarrierAttached = false;
  return messages.map((message) => {
    const meta = message.meta;
    if (!meta) return message;
    const nextMeta: MessageMeta = { ...meta };
    delete nextMeta.turnSummary;
    if (!contextCarrierAttached && nextMeta.checkpointMeta) {
      nextMeta.checkpointMeta = {
        ...nextMeta.checkpointMeta,
        contextTokensAfter,
      };
      contextCarrierAttached = true;
    }
    return { ...message, meta: nextMeta };
  });
}

function contentTruncatedHistoryWithContextCarrier(params: {
  messages: GenericMessage[];
  compactNum: number;
  trigger: "auto-compact" | "manual";
  removedCount: number;
  freedTokens: number;
  estimatedAfter: number;
  truncatedDir?: string;
}): { history: GenericMessage[]; contextTokensAfter: number; createdAt: string } {
  const createdAt = new Date().toISOString();
  const checkpointContent = `[compact #${params.compactNum}: content truncated]`;
  const checkpoint: GenericMessage = {
    role: "user",
    content: checkpointContent,
    meta: {
      compactBoundary: true,
      compactNum: params.compactNum,
      removedCount: params.removedCount,
      compactedAt: createdAt,
      createdAt: new Date(createdAt).getTime(),
      checkpointMeta: {
        removedMessages: params.removedCount,
        freedTokens: params.freedTokens,
        compactNum: params.compactNum,
        trigger: params.trigger,
        compactStatus: CompressionStatus.CONTENT_TRUNCATED,
        summary: t("be_conversationLoop.contentTruncatedSummary", { count: params.removedCount }),
        ...(params.truncatedDir !== undefined ? { truncatedDir: params.truncatedDir } : {}),
      },
    },
  };
  const contextTokensAfter = params.estimatedAfter + estimateMessagesTokens([checkpoint]);
  return {
    history: compactedHistoryWithContextCarrier([checkpoint, ...params.messages], contextTokensAfter),
    contextTokensAfter,
    createdAt,
  };
}
const FILE_CONTENT_RESULT_TOOLS = new Set([
  "read_file",
  "grep_files",
]);

function initialToolTrustOrigin(inputOrigin: ChatInputOrigin, turnInput: string): ToolTrustOrigin {
  if (inputOrigin === "file-content" || INLINE_PASTED_TEXT_RE.test(turnInput)) {
    return "file-content";
  }
  if (inputOrigin === "plugin-emitted") {
    return "plugin-emitted";
  }
  return "llm-tool-arg";
}

function summarizePermissionUserIntent(
  inputOrigin: ChatInputOrigin,
  turnInput: string,
): string | undefined {
  if (!isUserKeyboardOrigin(inputOrigin) && inputOrigin !== "queue-auto") {
    return undefined;
  }
  const cleaned = turnInput
    .replace(/<[^>]*>/g, " ")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.startsWith("/")) return undefined;
  return cleaned.length > 500 ? `${cleaned.slice(0, 499)}…` : cleaned;
}

function nextToolTrustOrigin(
  current: ToolTrustOrigin,
  toolUses: readonly ToolUseBlock[],
  toolResults: readonly ToolResult[],
): ToolTrustOrigin {
  if (current === "file-content") return current;
  const successful = new Set(
    toolResults
      .filter((result) => !result.is_error)
      .map((result) => result.tool_use_id),
  );
  return toolUses.some((toolUse) => successful.has(toolUse.id) && FILE_CONTENT_RESULT_TOOLS.has(toolUse.name))
    ? "file-content"
    : current;
}

// ─── Types ──────────────────────────────────────────

export interface TurnCallbacks {
  onReasoningDelta?: (text: string) => void;
  onTextDelta?: (text: string) => void;
  onToolStart?: (name: string, input: Record<string, unknown>, meta: ToolCallMeta) => void;
  onPermissionReview?: (event: PermissionReviewEvent) => void;
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
    stopReason: "end_turn" | "tool_use" | "max_tokens";
    hasToolCalls: boolean;
  }) => void;
  onTurnComplete?: (fullText: string) => void;
  onPermissionModeChanged?: (mode: "default" | "strict" | "auto" | "allow") => void;
  onError?: (error: string, systemNotice?: "context-error" | "stream-error") => void;
  onCompactOccurred?: (result: {
    removedMessages: number;
    freedTokens: number;
    /** Post-compact history token estimate (estimateMessagesTokens after the
     *  boundary applied). Renderer uses this as the SOT for the ring;
     *  freedTokens alone undercounts when only one small message was summarized. */
    estimatedAfter: number;
    /**
     * Compact trigger — `"auto-compact"` (token preflight) | `"manual"` (`/compact`).
     * UI CheckpointDivider uses this to choose the auto/manual label.
     */
    trigger?: "auto-compact" | "manual";
    /**
     * Rolling summary — `renderBoundaryAsPreamble()` 결과. 사용자 가시성용.
     */
    summary?: string;
    /**
     * Compact sequence number — passed to CheckpointDivider to enable
     * view-mode and branch-from-checkpoint actions.
     */
    compactNum?: number;
    /**
     * Gemini-style status. Renderer 가 status 별로 다른 banner
     * variant (색상/아이콘/메시지) 를 표시한다. SUMMARIZED 가 정상 경로,
     * CONTENT_TRUNCATED / REDUCED_INSUFFICIENT_FORCED 는 fail-loud UX.
     */
    compactStatus?: CompressionStatus;
    /**
     * Compact archive directory for per-message, reverse-budget, or forced drops.
     * `~/.lvis/sessions/<sessionId>/truncated/` — 사용자가 banner footnote
     * 에서 원본 archive 위치 확인 가능. plumb 누락 방지를 위해 명시 필드.
     */
    truncatedDir?: string;
  }) => void;
  /**
   * Fired at the start of a pre-turn auto-compact (token preflight) so the
   * renderer can show a "자동 압축 중..." indicator before the potentially
   * long-running LLM compaction finishes. Complementary to `onCompactOccurred`
   * which fires on completion.
   */
  onCompactStarted?: (info: {
    triggerSource: CompactTriggerSource;
    estimatedBefore: number;
    preflight: number;
  }) => void;
  /**
   * Fired when force-recover budget is exhausted (#917). Renderer must surface
   * a persistent banner informing the user that auto-compact can no longer
   * recover the session and manual intervention (model change / chat reset) is
   * required.
   */
  onRecoveryExhausted?: () => void;
  onFallback?: (from: string, to: string) => void;
  onLlmStatus?: (status: FallbackStatus) => void;
  /**
   * Fired once per round boundary when a "guide" utterance was queued via
   * `ConversationLoop.queueGuidance` and is now being injected into history
   * as a user message ahead of the next LLM stream. Renderer uses this to
   * render an inline "방향 지시 적용됨" note in the transcript so the user
   * has visible feedback that the queued guidance landed (vs silently
   * affecting the next assistant turn).
   */
  onGuidanceInjected?: (text: string) => void;
  /**
   * Fired once at turn end if any queued guide utterances never reached a
   * round boundary (single-round turn — typical of short text-only
   * answers). Renderer surfaces this so the user knows their direction-
   * adjustment was NOT applied, otherwise the silent-drop UX is worse
   * than the pre-redesign abort-and-restart behavior (critic MAJOR #3).
   */
  onGuidanceDropped?: (text: string) => void;
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
     * `tokensIn` = engine-projected next request input. This is the
     * provider-calibrated input size the next request would carry after the
     * final assistant output/tool results have been appended, including the
     * system prompt and exposed tool schemas. TokenProgressRing and the turn
     * footer both use this same context-fill SOT.
     */
    tokensIn: number;
    /**
     * `freshInputTokens` = turn-aggregate fresh input (sum across rounds of
     * `inputTokens − cacheReadTokens − cacheWriteTokens`). This is the
     * billing-weight number the TokenCostBadge needs — fresh tokens are
     * billed at full input price, while cached reads are billed at 10%.
     * Splitting `tokensIn` (context-fill SOT) from `freshInputTokens`
     * (turn-aggregate fresh, for billing) keeps the ring/footer context number
     * separate from cost arithmetic.
     */
    freshInputTokens: number;
    tokensOut: number;
    /**
     * Cache breakdown — Anthropic prompt cache (read 90% 할인 / write 25% 가산).
     * Vercel AI SDK v6 의 inputTokens 는 cached 포함 정규화이므로 이 두 값을
     * 별도로 surface 해야 사용자가 fresh vs cached 비용 차이 인지 가능.
     * LVIS invariant: surface raw context usage and fresh billable input separately.
     */
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    /**
     * Provider/model that actually served this turn after fallback resolution.
     * Persisted with turn_summary so historical cost badges never re-price old
     * turns with the user's current settings.
     */
    vendorProvider?: LLMVendor;
    vendorModel?: string;
    usageByModel?: TokenUsageByModel[];
    breakdown?: Record<string, { count: number; ms: number }>;
  }) => void;
}

/**
 * Why the turn ended. Centralized so the queryLoop return type, TurnResult,
 * and the willEmit/notification gates all reference one source — adding a new
 * reason later means changing one union (and then auditing the gates).
 */
export type TurnStopReason =
  | "end_turn"
  | "tool_use"
  // Output-token cap hit. After the continuation loop exhausts its cap
  // (MAX_LENGTH_CONTINUATIONS) the turn returns with this reason so the
  // UI/notification gates surface the residual truncation explicitly.
  | "max_tokens"
  | "interrupted"
  | "context-error"
  | "stream-error"
  // #811 m2 — a trusted UserPromptSubmit hook (or its fail-closed dispatch)
  // REFUSED the prompt before queryLoop ran. The turn never reached the LLM.
  | "blocked";

export interface TurnResult {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
  route: string;
  usage?: TokenUsage;
  usageByModel?: TokenUsageByModel[];
  stopReason?: TurnStopReason;
}

export interface ConversationLoopDeps {
  settingsService: SettingsService;
  systemPromptBuilder: SystemPromptBuilder;
  keywordEngine: KeywordEngine;
  routeEngine: RouteEngine;
  toolRegistry: ToolRegistry;
  memoryManager: MemoryManager;
  /**
   * Notify all renderer windows that the directory config mutated.
   * Wired by boot from `ipc/domains/permissions.ts`. Called by
   * `addSessionAdditionalDirectory` so dialog-driven (executor-side)
   * grants reach the PermissionsTab subscribers, not only slash-dispatch
   * grants. Closes the round-3 architect Q5 / critic M1 / security Q6 gap.
   */
  broadcastPermissionConfigChanged?: () => void;
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
   * In-process hook runner used by focused unit tests and old internal
   * extension points. Production Permission policy script hooks are carried by
   * scriptHookManager, not by hooks.json external loading.
   */
  hookRunner?: HookRunner;
  /**
   * Option C — plugin runtime reference used for:
   *   - request_plugin 메타 툴 pluginId 유효성 검증
   *   - inactive plugin 카탈로그 공급 (SystemPromptBuilder가 읽음)
   * Omitted in lightweight unit tests; scope expansion becomes a no-op.
   */
  pluginRuntime?: {
    listPluginIds(): string[];
    /**
     * #1176 — whether a loaded plugin is active (its tools may be exposed).
     * `enabled !== false` in the registry; absent → active (migration-safe).
     * Used by {@link resolveToolScope} to drop inactive plugins from scope.
     */
    isPluginEnabled?(pluginId: string): boolean;
    /**
     * Record a plugin as session-activated so the execution delegate
     * ({@link pluginRuntimeToolDelegate} Gate 4) can allow its tool calls.
     * Called immediately after on-demand activation of a registry-disabled
     * plugin. NEVER persists enabled state — `setPluginEnabled` is NOT called.
     */
    setSessionActivated?(pluginId: string): void;
    /**
     * Clear all session activations. Mirrors every
     * `sessionActivatedPluginIds.clear()` so the execution gate never leaks
     * activated state across sessions.
     */
    clearSessionActivated?(): void;
  };
  /**
   * Fixed-scope support for callers that already made a plugin-scope decision.
   * These plugin ids are always eligible for catalog/preload checks even when
   * the child/routine instruction text does not repeat a plugin keyword.
   */
  forcedActivePluginIds?: ReadonlySet<string>;
  /**
   * Explicit tool-schema allowlist for fixed-surface callers such as
   * sub-agents. These names enter `tools[]` directly even when no keyword
   * preloads them.
   */
  forcedActiveToolNames?: ReadonlySet<string>;
  /**
   * Sub-agent model override. When set, `refreshProvider()` uses this model
   * ID for the primary provider instead of the active vendor block's model.
   * `SubAgentRunner.resolveSubAgentModel` only ever sets this to a model the
   * active vendor can actually serve — a complexity-tier-resolved ID, or an
   * explicit ID validated against LLM_VENDOR_MODEL_OPTIONS. An unresolvable
   * or unavailable value resolves to undefined so the child simply runs on
   * the parent vendor block's model. The override therefore never feeds the
   * provider a model-not-found that the (non-retryable) fallback chain would
   * refuse to recover from.
   */
  modelOverride?: string;
  /**
   * Hard plugin allowlist for scoped callers such as routines. When set,
   * keyword matches, forced plugins, and request_plugin expansions are all
   * intersected with this set.
   */
  allowedPluginIds?: ReadonlySet<string>;
  /** Background/routine loop: write tools must ask and cannot rely on auto/allow cache. */
  headless?: boolean;
  /** Additional filesystem roots explicitly granted to this loop. */
  additionalDirectories?: readonly string[];
  /** Live reader for foreground settings-backed additional directories. */
  getAdditionalDirectories?: () => readonly string[];
  /**
   * Script hooks. Boot owns discovery/trust and injects the manager;
   * the executor only invokes the already-trusted generic hook contract.
   */
  scriptHookManager?: import("../hooks/script-hook-manager.js").ScriptHookManager;
  /** Hook trust command storage override. Production uses default hook paths. */
  hookTrustCommandOptions?: Omit<HookTrustCommandOptions, "manager">;
  /** Disable normal ~/.lvis/sessions persistence for isolated child loops. */
  disableSessionPersistence?: boolean;
  /**
   * Current-turn SkillOverlay handle. Cleared at user-turn start/end so skill
   * bodies never persist as ambient session context.
   */
  skillOverlay?: { clear(sessionId: string): void };
  /**
   * Session-scoped assistant TO-DO lifecycle — execute side. At the start of a
   * new turn the loop unconditionally drops any plan the post-turn hook marked
   * as completed (`markForClearIfCompleted`), so a finished plan clears at the
   * turn boundary regardless of input origin. Unfinished plans stay visible.
   */
  sessionTodoStore?: { clearIfPending(sessionId: string): boolean };
  /**
   * Issue #260: optional system notification service. When supplied, the
   * loop fires a `turn-end` notification when runTurn resolves successfully
   * (not aborted, not interrupted). Routine / sub-agent / trigger loops
   * intentionally omit this so background turns don't spam the user.
   */
  notificationService?: import("../main/notification-service.js").NotificationService;
  /** Shared boot audit logger. Tool execution audit writes to this HMAC chain. */
  auditLogger?: AuditLogger;
  /** Rebuilds reviewer classifier/cache bindings after `/permission reviewer ...`. */
  rewireReviewerAgent?: () => void;
  /** Main-process fetch implementation for Azure Foundry private-endpoint calls. */
  llmFetch?: typeof fetch;
}

// 사용자가 *26 step* 작업에서 cap hit 으로 *조용히 끊긴* 사례 (2026-05-07) 후
// 10 → 30 으로 상향. 사용자 task 의 자연 round 분포 (~13 rounds for 26 steps) 를
// 수용하면서 *진정한 무한 루프* 는 여전히 차단. SubAgentRunner 는 자기 maxRounds
// 로 clamp 하므로 영향 없음 (line 902 `Math.min`).
const MAX_TOOL_ROUNDS = 30;
/**
 * Hard cap on finish_reason=length CONTINUATIONS per logical assistant answer.
 * Codex/Anthropic/OpenAI guidance converge on 2–3. AND-ed with: (a) a
 * zero-progress break (a round adding no text AND no reasoning ends the chain),
 * (b) the global MAX_TOOL_ROUNDS budget, and (c) the per-iteration `round < 30`
 * for-bound. Any one tripping stops the chain — defense against a model that
 * always returns "max_tokens".
 */
const MAX_LENGTH_CONTINUATIONS = 3;
/**
 * Defensive cap on provider-as-oracle tool drops per turn. Termination is
 * already guaranteed structurally (each drop strictly shrinks the finite tool
 * set and we only drop a tool the provider named AND that is still present),
 * so this is belt-and-suspenders against pathological churn: if more than this
 * many distinct tools each 400 in one turn, stop dropping and let the error
 * surface normally rather than burning rounds.
 */
const MAX_TOOL_SCHEMA_DROPS_PER_TURN = 5;
/**
 * C3(a): per-round cap on the number of tool calls an assistant round can
 * issue. Pathological round-emitting many tool_use blocks at once would
 * otherwise execute every one in parallel before the maxRounds guard could
 * intervene. SubAgentRunner relies on this cap to keep a sub-agent's total
 * tool execution count bounded by `maxRounds * MAX_TOOL_CALLS_PER_ROUND`.
 */
const MAX_TOOL_CALLS_PER_ROUND = 10;

// Intra-turn tool-result stubbing — deep tool loops (e.g. indexer turns of
// 11~19 rounds) otherwise resend the full accumulated tool_result history on
// every round, blowing past the model's per-minute token budget. Between
// rounds we mark older tool_results stale (memory stays verbatim; the wire
// serializer stubs them on the next send), keeping the current + previous
// round's results intact so chained tool calls can still reference recent
// output. The window is count-based to match the markStaleToolResults
// contract: 2 rounds worth of results (current + previous).
const INTRA_TURN_PRESERVE_RECENT_RESULTS = 2 * MAX_TOOL_CALLS_PER_ROUND;
// Only micro-compact between rounds once the projected per-round input is
// already large enough to matter — half the model's preflight threshold —
// so short turns don't pay the mark overhead.
const MICRO_COMPACT_FLOOR_FACTOR = 0.5;

type CompactTriggerSource = "estimate" | "context-tokens" | "manual" | "force-recover" | "rate-limit";

interface PreflightGuardOptions {
  forceReason?: "rate-limit";
}

/** Lazy Tool Scoping — 매 턴 LLM에 노출할 도구 집합 정의. */
interface ToolScope {
  activePluginIds: Set<string>;
  /**
   * Tool-Level Deferral — 개별적으로 preload/promote 된 plugin+mcp tool 이름.
   * Builtins/meta-tools are loaded separately by `includeBuiltins`.
   */
  activeToolNames: Set<string>;
  /** Tools loaded because this turn's text directly matched tool keywords. */
  preloadedToolNames: Set<string>;
  /** Tools kept visible by an explicit fixed-surface allowlist. */
  forcedToolNames: Set<string>;
  includeBuiltins: boolean;
  includeMcp: boolean;
  /**
   * #1176 deferral gate. `false` → eager full-schema exposure of every
   * in-scope plugin/MCP tool (no `tool_search` discovery). `true` → per-tool
   * deferral where only `activeToolNames` load and the rest live in the compact
   * catalog. Set by {@link resolveToolScope} from the eligible tool count vs
   * {@link EAGER_TOOL_EXPOSURE_CEILING}.
   */
  deferral: boolean;
}

interface ToolExposureMetrics {
  loadedToolCount: number;
  loadedToolSourceCounts: ToolSourceCounts;
  deferredCatalogCount: number;
  deferredCatalogSourceCounts: Pick<ToolSourceCounts, "plugin" | "mcp">;
  promotedToolNames: string[];
  loadedPluginIds: string[];
  loadedMcpServerIds: string[];
  deferredPluginIds: string[];
  deferredMcpServerIds: string[];
  toolSchemaTokens: number;
  projectedRequestInputTokens: number | null;
  /**
   * Deferral effectiveness signal for the default-on dogfood gate. Counts only
   * deferral-eligible (plugin + MCP) tools — builtins are never deferred so
   * they would otherwise dilute the ratio. `deferralEligibleLoadedCount` is the
   * plugin/MCP slice of the loaded schemas; `deferredLoadedRatio` is
   * deferred / (deferred + loaded-eligible), structurally bounded to [0, 1]
   * (the numerator `catalogEntries.length` is a strict subset of the
   * denominator, so no clamp is needed). Null when no deferral-eligible tool
   * exists this turn (denominator is zero, ratio is undefined).
   */
  deferralEligibleLoadedCount: number;
  deferredLoadedRatio: number | null;
}

interface ProviderRequestDiagnostics {
  sessionId: string;
  round: number;
  assistantRoundIndex: number;
  inputOrigin: ChatInputOrigin;
  configuredProvider: LLMVendor;
  model: string;
  preflightThresholdTokens: number;
  promptChars: number;
  messageCount: number;
  messageRoleCounts: Record<GenericMessage["role"], number>;
  projection: RequestInputProjection;
  toolResultCount: number;
  toolResultChars: number;
  toolResultTokens: number;
  compactedToolResultCount: number;
  truncatedToolResultCount: number;
  serializedStubToolResultCount: number;
  assistantToolCallCount: number;
  loadedToolNames: string[];
  loadedToolNamesTruncated: number;
  activePluginIds: string[];
  toolExposure: ToolExposureMetrics;
}

// ─── Loop ───────────────────────────────────────────

export class ConversationLoop {
  private readonly deps: ConversationLoopDeps;
  private readonly history: ConversationHistory;
  private readonly toolExecutor: ToolExecutor;
  private readonly auditLogger: AuditLogger;
  private provider: LLMProvider | null = null;
  private sessionId: string = crypto.randomUUID();
  private sessionKind: SessionKind = "main";
  private sessionRoutineId: string | null = null;
  private sessionRoutineTitle: string | null = null;
  /**
   * #811 m2 — the sessionId the `SessionStart` lifecycle event last fired for.
   * SessionStart must fire ONCE per session (not per turn): runTurn fires it on
   * the first turn whose sessionId differs from this, then records it here.
   * Reset by `newConversation` / `loadSession` so a switched-into session
   * re-announces its start.
   */
  private sessionStartFiredFor: string | null = null;
  /** K4: §4.5 11-step trace — dev 모드 활성, 프로덕션 no-op */
  private tracer: ConversationTracer = createTracer(this.sessionId);
  private cumulativeUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  /**
   * 마지막 round 의 provider raw inputTokens. turn_summary.tokensIn 을 직접
   * 채우는 값이 아니라, 턴 종료 context-fill SOT 를 provider 값으로 보정하기
   * 위한 기준점이다.
   */
  private lastRoundProviderInputTokens = 0;
  /**
   * Engine request-input projection for the exact request submitted to the
   * latest provider round. Includes system prompt, provider-wire messages, and
   * exposed tool schemas.
   */
  private lastRoundInputProjection: RequestInputProjection | null = null;
  /**
   * Latest context-fill SOT. Successful turns store turn_summary.tokensIn here;
   * compact paths store their post-compact estimate. During an in-flight
   * multi-round turn it temporarily follows the latest provider raw input as a
   * calibration anchor until turn end recomputes the projected value.
   */
  private lastContextInputTokens = 0;
  /** Local full-request projection corresponding to `lastContextInputTokens`. */
  private lastContextInputProjectionTokens = 0;
  /** B4: current turn's AbortController — abortCurrentTurn() calls .abort() */
  currentAbortController: AbortController | null = null;
  /**
   * Lazy Tool Scoping — 직전 턴의 active plugin 집합.
   * Keyword miss (type==="general") 시 fallback으로 재사용한다.
   * null = 이전 턴 없음 → builtin-only scope.
   */
  private lastTurnScope: Set<string> | null = null;
  /**
   * Tool-Level Deferral — 직전 턴에 로드된 plugin/mcp tool 이름 집합.
   * keyword-miss 후속 턴이 이미 promote/preload 된 도구를 계속 노출하도록
   * carry-forward 한다. null = 이전 턴 없음.
   */
  private lastTurnToolNames: Set<string> | null = null;
  /** Session-wide total of request_plugin activations (cap MAX_SESSION_PLUGIN_EXPANSION). */
  private sessionPluginExpansions = 0;
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
  private sessionActivatedPluginIds = new Set<string>();
  /** Session-wide total of tool_search promotions (cap MAX_TOOL_SEARCH_PER_SESSION). */
  private sessionToolSearches = 0;
  private sessionAdditionalDirectories: string[] = [];
  /**
   * Turn-scope additional allowed directories. Populated when the user
   * chooses "이번 1회만" on an out-of-allowed-dir approval — kept alive
   * across all tool calls inside the same `runTurn` so a multi-step
   * agentic round (e.g. `bash ls` → `bash find` → `bash stat` on the
   * same directory) does not re-prompt the user for the same path on
   * every subsequent call. Cleared in `runTurn`'s finally so the grant
   * does not survive into the next user message.
   */
  private turnAdditionalDirectories: string[] = [];
  /**
   * Single in-flight LLM compact lock per ConversationLoop.
   * 같은 instance 에서 두 turn 이 동시에 compact trigger 시 두 번째는 skip (race 방지).
   */
  private isCompacting: boolean = false;
  /** LLM compact 가 #N 번째인지 추적하는 numbered checkpoint counter. */
  private compactNum: number = 0;
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
  private contextErrorPending: boolean = false;
  /**
   * Force-recover 반복 횟수 — DoS 방어 (security round-4 MED). 사용자가
   * 반복적으로 context_error 유발 input 보내면 compact LLM API 호출이
   * 누적 cost. `MAX_FORCE_RECOVER_PER_SESSION` 초과 시 force-recover 진입
   * 차단 + user-facing 경고. 정상 사용자는 절대 도달하지 않는 임계 (3
   * 회 연속 force-recover = 3 turn 연속 모델 한도 초과).
   */
  private contextErrorRecoveryCount: number = 0;
  /**
   * Issue #917 — budget 소진 후 compact API 호출을 완전 차단하는 persistent
   * flag. `MAX_FORCE_RECOVER_PER_SESSION` 횟수를 모두 소진하면 true 로 설정되며,
   * 이후 turn 에서 force-recover 뿐 아니라 *normal threshold compact 도*
   * 차단한다 (compact 가 context 를 줄이지 못하는 구조적 실패가 입증됐으므로).
   * 정상 turn (context_error 없이 완료) 이후 re-arm 가능하도록 reset.
   */
  private recoveryExhausted: boolean = false;
  /**
   * TPM reactive compact is an error-boundary recovery, not a normal threshold
   * trigger. Try it once per error series and re-arm only after a clean turn so
   * repeated 429 responses cannot amplify compact API calls.
   */
  private rateLimitRecoveryAttempted: boolean = false;
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
  private guidanceQueue: string[] = [];
  /** Max queued guide utterances at one boundary (security-reviewer M1). */
  private static readonly GUIDE_MAX_ENTRIES = 16;
  /** Max chars per queued guide utterance (security-reviewer M1). */
  private static readonly GUIDE_MAX_CHARS = 8_000;
  /**
   * Max chars of the JOINED guide message at one boundary (critic round 2
   * M3). Caps the wall the LLM sees in a single user message even when
   * the queue is full of max-size entries. Older entries are dropped with
   * a leading "[일부 방향 지시 생략 — 길이 초과]" marker so the user
   * understands the truncation, rather than the model silently seeing
   * the most recent few.
   */
  private static readonly GUIDE_JOINED_MAX_CHARS = 16_000;

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
      // Couple the foreground plugin read-relaxation to the active OS sandbox
      // FILESYSTEM-CONTAINING the host: the relaxation relies on the
      // effect-boundary, which only contains the off-hostApi `node:fs` WRITE
      // residual when the sandbox filesystem-contains. On a degraded,
      // sandbox-off, or Windows network-only host (`confines.filesystem ===
      // false`) this is false → the relaxation does not fire and the pre-exec
      // ask stands (see ToolExecutor.sandboxFsContainedProvider).
      isActiveSandboxFilesystemContained,
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
    if (trimmed.length > ConversationLoop.GUIDE_MAX_CHARS) return "too-long";
    if (this.currentAbortController === null) return "no-active-turn";
    if (this.guidanceQueue.length >= ConversationLoop.GUIDE_MAX_ENTRIES) return "queue-full";
    this.guidanceQueue.push(trimmed);
    return "queued";
  }

  /** True when a turn is currently in flight. Renderer-facing visibility. */
  hasActiveTurn(): boolean {
    return this.currentAbortController !== null;
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
      const createLoopProvider = (config: ProviderConfig): LLMProvider =>
        createProvider({
          ...config,
          ...(config.vendor === "azure-foundry" && this.deps.llmFetch
            ? { fetch: this.deps.llmFetch }
            : {}),
        });

      const primary = createLoopProvider({
        vendor,
        apiKey: apiKey ?? "",
        // Sub-agent model override takes precedence over the vendor block's
        // configured model; falls back to block.model when no override is set
        // (parent loops and sub-agents without a resolved profile model).
        model: this.deps.modelOverride ?? block.model,
        ...(block.baseUrl ? { baseUrl: block.baseUrl } : {}),
        ...(block.vertexProject ? { vertexProject: block.vertexProject } : {}),
        ...(block.vertexLocation ? { vertexLocation: block.vertexLocation } : {}),
      });
      const chain = llmSettings.fallbackChain
        .filter((e) => e.provider && e.model)
        .map((entry) => {
          const fallbackBlock = llmSettings.vendors[entry.provider];
          return {
            ...entry,
            ...(fallbackBlock?.baseUrl ? { baseUrl: fallbackBlock.baseUrl } : {}),
            ...(fallbackBlock?.vertexProject ? { vertexProject: fallbackBlock.vertexProject } : {}),
            ...(fallbackBlock?.vertexLocation ? { vertexLocation: fallbackBlock.vertexLocation } : {}),
          };
        });
      this.provider = new FallbackProvider(
        primary,
        chain,
        (v) => this.deps.settingsService.getSecret(secretKeyFor(v)) ?? "",
        createLoopProvider,
      );
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
    systemPrompt = t("be_conversationLoop.generateTextSystemPrompt"),
    abortSignal?: AbortSignal,
  ): Promise<string> {
    if (!this.provider) throw new Error("LLM provider not configured");
    if (abortSignal?.aborted) throw new Error("LLM generation aborted");
    let text = "";
    const llm = this.deps.settingsService.get("llm");
    for await (const ev of this.provider.streamTurn({
      systemPrompt,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      model: llm.vendors[llm.provider].model,
      abortSignal,
    })) {
      if (abortSignal?.aborted) throw new Error("LLM generation aborted");
      if (ev.type === "text_delta" && ev.text) text += ev.text;
      if (ev.type === "message_complete") break;
      if (ev.type === "error") throw new Error(`LLM stream error: ${ev.error}`);
    }
    // Plugins and routines consume generateText() return verbatim — strip the
    // suggested-replies block so it never reaches non-chat-stream callers.
    return stripSuggestedReplies(text).trim();
  }

  /**
   * Status-bar connectivity probe. This is intentionally independent from
   * chat history: a tiny one-shot LLM request proves the configured provider
   * can answer after activation/restart without adding a visible turn.
   */
  async pingProvider(timeoutMs = AI_PROVIDER_PING_TIMEOUT_MS): Promise<AiProviderPingResult> {
    const llm = this.deps.settingsService.get("llm");
    const vendor = llm.provider;
    const model = llm.vendors[vendor]?.model ?? "";
    if (!this.provider) {
      return {
        configured: false,
        online: false,
        vendor,
        ...(model ? { model } : {}),
        error: "not-configured",
      };
    }

    const startedAt = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      for await (const ev of this.provider.streamTurn({
        systemPrompt: "You are a connectivity probe. Reply with PONG only.",
        messages: [{ role: "user", content: "ping" }],
        tools: [],
        model,
        abortSignal: ctrl.signal,
      })) {
        if (ev.type === "error") {
          return {
            configured: true,
            online: false,
            vendor,
            model,
            error: ev.error,
            latencyMs: Date.now() - startedAt,
          };
        }
        if (ev.type === "message_complete") {
          return {
            configured: true,
            online: true,
            vendor,
            model,
            latencyMs: Date.now() - startedAt,
          };
        }
      }
      return {
        configured: true,
        online: false,
        vendor,
        model,
        error: "stream-ended",
        latencyMs: Date.now() - startedAt,
      };
    } catch (err) {
      return {
        configured: true,
        online: false,
        vendor,
        model,
        error: ctrl.signal.aborted ? "timeout" : (err as Error).message,
        latencyMs: Date.now() - startedAt,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 현재 벤더 이름 */
  getVendor(): string {
    return this.provider?.vendor ?? "none";
  }

  private buildSystemPromptForScope(
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

  private estimateCurrentRequestProjection(params: {
    systemPrompt: string;
    toolSchemas: ToolSchema[];
  }): RequestInputProjection {
    return estimateRequestInputProjection({
      systemPrompt: params.systemPrompt,
      messages: this.history.getMessages(),
      toolSchemas: params.toolSchemas,
    });
  }

  private createRequestProjectionContext(
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

  private shouldAutoCompactForRateLimit(stream: {
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

  private rateLimitCompactMessage(stream: {
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
    if (this.history.length > 0) {
      this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages()).catch((err: unknown) => {
        log.warn("newConversation saveSession failed: %s", (err as Error).message);
      });
    }
    // C2(c): drop the previous session's loaded skills so a fresh chat
    // starts with a clean overlay. Tests / stubs without overlay omit this.
    this.deps.skillOverlay?.clear(this.sessionId);
    this.sessionId = crypto.randomUUID();
    this.sessionKind = kind;
    this.sessionRoutineId = null;
    this.sessionRoutineTitle = null;
    // #811 m2 — new session ⇒ SessionStart must re-fire on the next turn.
    this.sessionStartFiredFor = null;
    this.sessionAdditionalDirectories = [];
    this.turnAdditionalDirectories = [];
    this.history.clear();
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.lastRoundProviderInputTokens = 0;
    this.lastRoundInputProjection = null;
    this.lastContextInputTokens = 0;
    this.lastContextInputProjectionTokens = 0;
    this.sessionPluginExpansions = 0;
    this.sessionToolSearches = 0;
    this.sessionActivatedPluginIds.clear();
    this.deps.pluginRuntime?.clearSessionActivated?.();
    this.lastTurnToolNames = null;
    this.compactNum = 0;
    this.rateLimitRecoveryAttempted = false;
    this.tracer = createTracer(this.sessionId);
    // Clear rolling summary preamble for fresh session.
    this.deps.systemPromptBuilder.setSummaryPreamble?.(null);
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

  private getTurnAdditionalDirectories(): readonly string[] {
    return [
      ...(this.deps.getAdditionalDirectories?.() ?? this.deps.additionalDirectories ?? []),
      ...this.sessionAdditionalDirectories,
      ...this.turnAdditionalDirectories,
    ];
  }

  getHistory(): ConversationHistory {
    return this.history;
  }

  private readToolResultForChunk(toolUseId: string): ReadableToolResult | null {
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
    const checkpoints = this.deps.memoryManager.loadSessionMetadata(this.sessionId)?.checkpoints ?? [];
    const target = checkpoints.find((c) => c.compactNum === compactNum);
    if (!target) throw new Error(`Checkpoint #${compactNum} not found in session ${this.sessionId}`);

    // Load the pre-compact snapshot saved at compaction time.
    // The main session JSONL is overwritten by PostTurnHookChain.saveSession with the
    // post-compact history after each turn, so it cannot be used to reconstruct the
    // pre-checkpoint transcript. saveCheckpointSnapshot() persists messagesBefore to
    // a checkpoint-specific file (.checkpoints/{sessionId}/{N}.jsonl) before the turn completes.
    const snapshotMessages = this.deps.memoryManager.loadCheckpointSnapshot(this.sessionId, compactNum);
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

    // Repair tool-pair invariant — loadCheckpointSnapshot skips malformed JSONL.
    // lines, which can leave orphaned tool_call or tool_result entries in the slice.
    const { messages: repaired, removedMessages, removedToolCalls } = normalizeToolPairInvariant(sliced);
    if (removedMessages > 0 || removedToolCalls > 0) {
      log.warn(
        `branchFromCheckpoint: repaired ${removedMessages} messages + ${removedToolCalls} tool calls from snapshot (session ${this.sessionId} compact #${compactNum})`,
      );
    }

    const forkMessages = this.deps.memoryManager.rehydrateToolResultArtifacts(this.sessionId, repaired) as GenericMessage[];
    await this.deps.memoryManager.saveSession(newSessionId, forkMessages);

    // 브랜치 세션 metadata — checkpoint/fork provenance + prior summary.
    await this.deps.memoryManager.saveSessionMetadata(newSessionId, {
      sessionKind: this.sessionKind,
      ...(this.sessionRoutineId ? { routineId: this.sessionRoutineId } : {}),
      ...(this.sessionRoutineTitle ? { routineTitle: this.sessionRoutineTitle } : {}),
      parentSessionId: this.sessionId,
      ...(target.summary ? { summaryPreamble: target.summary } : {}),
      branchedFromCompactNum: compactNum,
      branchedAt: new Date().toISOString(),
    });

    const lastMessageRole = forkMessages[forkMessages.length - 1]?.role ?? null;
    const shouldAutoContinue = lastMessageRole === "user";

    log.info(`branchFromCheckpoint: new session ${newSessionId} from ${this.sessionId} @ compact #${compactNum}`);
    return { newSessionId, lastMessageRole, shouldAutoContinue };
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
  private async fireLifecycleEvent(
    event: LifecycleHookEvent,
    payload: import("../hooks/script-hook-manager.js").LifecycleEventPayload = {},
    sessionIdOverride?: string,
  ): Promise<void> {
    const manager = this.deps.scriptHookManager;
    if (!manager) return;
    try {
      await manager.runLifecycleEvent(
        event,
        sessionIdOverride ?? this.sessionId,
        // Lifecycle events are session-scoped, not tied to a single user input;
        // attribute to the canonical "unknown" hook origin like other
        // non-user-keyboard dispatches (no enrollment/mutation path here).
        "unknown",
        payload,
      );
    } catch (err) {
      log.warn(
        `lifecycle event ${event} dispatch failed (non-blocking, ignored): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
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
  private async fireUserPromptSubmit(
    payload: import("../hooks/script-hook-manager.js").UserPromptSubmitPayload,
    sessionIdOverride?: string,
  ): Promise<{ decision: "allow" | "deny"; reason: string }> {
    const manager = this.deps.scriptHookManager;
    // No manager ⇒ no hooks.json ⇒ proceed exactly as today.
    if (!manager) return { decision: "allow", reason: "no script hook manager" };
    try {
      const result = await manager.runUserPromptSubmit(
        sessionIdOverride ?? this.sessionId,
        // The prompt's input origin is propagated into the payload; for the
        // hook trustOrigin we attribute to "unknown" like other non-keyboard
        // dispatches (no enrollment/mutation path through this event).
        "unknown",
        payload,
      );
      return { decision: result.decision, reason: result.reason };
    } catch (err) {
      // FAIL-CLOSED: a blocking event must DENY on an unexpected error — the
      // turn is refused rather than silently allowed.
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        `UserPromptSubmit dispatch threw — failing closed (deny): ${message}`,
      );
      return {
        decision: "deny",
        reason: `UserPromptSubmit dispatch error (fail-closed → deny): ${message}`,
      };
    }
  }

  /** Non-secret session metadata for the SessionStart lifecycle payload. */
  private sessionMetaForLifecycle(): Record<string, unknown> {
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
    if (!isSafeSessionId(sessionId)) {
      log.warn({ sessionId }, "loadSession rejected unsafe sessionId");
      return false;
    }
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
    // #811 m2 — switched-into session ⇒ SessionStart re-fires on its next turn.
    this.sessionStartFiredFor = null;
    const sessionMeta = this.deps.memoryManager.loadSessionMetadata(sessionId);
    this.sessionKind = sessionMeta?.sessionKind ?? "main";
    this.sessionRoutineId = sessionMeta?.routineId ?? null;
    this.sessionRoutineTitle = sessionMeta?.routineTitle ?? null;
    this.history.clear();
    this.history.restore(normalized.messages);
    this.cumulativeUsage = { inputTokens: 0, outputTokens: 0 };
    this.lastRoundProviderInputTokens = 0;
    this.lastRoundInputProjection = null;
    this.lastContextInputTokens = latestPersistedContextTokens(normalized.messages);
    this.lastContextInputProjectionTokens = 0;
    this.sessionPluginExpansions = 0;
    this.sessionToolSearches = 0;
    this.sessionActivatedPluginIds.clear();
    this.deps.pluginRuntime?.clearSessionActivated?.();
    this.lastTurnToolNames = null;
    this.sessionAdditionalDirectories = [];
    this.turnAdditionalDirectories = [];
    // Use max compactNum across all checkpoints (monotonic guarantee).
    // Using array length would produce a stale value when normalizeCheckpoint drops
    // invalid entries — next compact would reuse an already-used compactNum.
    this.compactNum = sessionMeta?.checkpoints?.reduce(
      (max, c) => Math.max(max, c.compactNum ?? 0),
      0,
    ) ?? 0;
    this.tracer = createTracer(this.sessionId);
    // Inject rolling summary preamble from loaded session metadata.
    const preamble = sessionMeta?.summaryPreamble ?? null;
    this.deps.systemPromptBuilder.setSummaryPreamble?.(preamble);
    return true;
  }

  async startRoutineConversation(routineId: string, routineTitle: string, routineFiredAt?: string): Promise<string> {
    this.newConversation("routine");
    this.sessionRoutineId = routineId;
    this.sessionRoutineTitle = routineTitle;
    await this.deps.memoryManager.saveSession(this.sessionId, []);
    await this.deps.memoryManager.saveSessionMetadata(this.sessionId, {
      sessionKind: "routine",
      routineId,
      routineTitle,
      ...(routineFiredAt ? { routineFiredAt } : {}),
    });
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

    // Session resume does not compact immediately. The next user turn computes
    // a full request-input projection from the live prompt/tool scope before
    // deciding whether compact is needed.
    this.cumulativeUsage = {
      inputTokens: estimateMessagesTokens(this.history.getMessages()),
      outputTokens: 0,
    };
    this.lastRoundProviderInputTokens = 0;
    this.lastRoundInputProjection = null;
    this.rateLimitRecoveryAttempted = false;

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
    if (!this.provider) {
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactNoProvider"),
        removedMessageCount: 0,
      };
    }
    if (this.isCompacting) {
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactAlreadyRunning"),
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
      const scope = this.resolveToolScope("");
      const toolSchemas = this.rebuildToolSchemas(scope);
      const projectionContext = this.createRequestProjectionContext(scope, null, undefined, toolSchemas);
      const requestProjection = estimateRequestInputProjection({
        systemPrompt: projectionContext.systemPrompt,
        messages: messagesBefore,
        toolSchemas,
      });
      // Mirror runPreflightGuard's pre-compact UX hint so slash-`/compact`
      // also lights up the "자동 압축 중..." StatusBar indicator during the
      // potentially long-running LLM summarization.
      callbacks?.onCompactStarted?.({
        triggerSource: "manual",
        estimatedBefore: requestProjection.totalTokens,
        preflight,
      });
      // ── #811 m2: PreCompact (NON-BLOCKING) ── manual `/compact` path.
      await this.fireLifecycleEvent("PreCompact", {
        reason: "manual",
        tokenEstimate: requestProjection.totalTokens,
      });
      const messagesBeforeCount = messagesBefore.length;
      const tokensBefore = requestProjection.totalTokens;
      const result = await compactWithBoundary({
        messages: messagesBefore,
        llm: this.provider,
        model,
        preserveRecentTokens,
        preserveRecentTurns: DEFAULT_PRESERVE_RECENT_TURNS,
        compactNum: this.compactNum + 1,
        sessionId: this.sessionId,
        preflightTokens: preflight,
      });

      if (result.status === CompressionStatus.NOOP) {
        return {
          compacted: false,
          compactedAt: null,
          summary: t("be_conversationLoop.manualCompactNoop"),
          removedMessageCount: 0,
        };
      }

      await this.applyBoundaryToSession(
        result,
        "manual",
        requestProjection.totalTokens,
        callbacks,
        messagesBefore.length,
        messagesBefore,
        projectionContext,
      );

      // ── #811 m2: PostCompact (NON-BLOCKING) ── manual path, after apply.
      await this.fireLifecycleEvent("PostCompact", {
        messagesBefore: messagesBeforeCount,
        messagesAfter: this.history.getMessages().length,
        tokensBefore,
        tokensAfter: this.lastContextInputTokens,
      });

      // 영속화 — manualCompact 완료 시점에 즉시 disk 반영.
      void Promise.resolve(
        this.deps.memoryManager?.saveSession(this.sessionId, this.history.getMessages()),
      ).catch((err: unknown) => {
        log.warn("manualCompact saveSession failed: %s", (err as Error).message);
      });

      const compactedAt = result.boundary?.createdAt ?? new Date().toISOString();
      const summary = result.status === CompressionStatus.CONTENT_TRUNCATED
        ? t("be_conversationLoop.manualCompactSummaryTruncated", { count: result.removedCount })
        : result.status === CompressionStatus.REDUCED_INSUFFICIENT_FORCED
        ? t("be_conversationLoop.manualCompactSummaryForced", { count: result.removedCount, num: this.compactNum })
        : t("be_conversationLoop.manualCompactSummarySummarized", { count: result.removedCount, num: this.compactNum });
      return {
        compacted: true,
        compactedAt,
        summary,
        removedMessageCount: result.removedCount,
      };
    } catch (err) {
      log.error("manualCompact failed: %s", (err as Error).message);
      // Return safe result rather than bubbling — prevents unhandled IPC rejection.
      // `/compact` command handler and callers get a user-visible failure message.
      return {
        compacted: false,
        compactedAt: null,
        summary: t("be_conversationLoop.manualCompactFailed", { message: (err as Error).message }),
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
       * SubAgentRunner to enforce the agent_spawn `maxTurns` parameter at
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
    const effectiveSessionId = options?.sessionIdOverride ?? this.sessionId;
    if (!options?.inputOrigin) {
      throw new Error("ConversationLoop.runTurn requires an explicit inputOrigin");
    }
    const inputOrigin: ChatInputOrigin = options.inputOrigin;
    const turnInput = isUserKeyboardOrigin(inputOrigin) ? input : stripLeadingSlash(input);
    const toolTrustOrigin = initialToolTrustOrigin(inputOrigin, turnInput);
    const permissionUserIntent = summarizePermissionUserIntent(inputOrigin, turnInput);
    const permissionExplicitAuthorizationIntent = isUserKeyboardOrigin(inputOrigin)
      ? permissionUserIntent
      : undefined;
    // Deterministic completed-plan clear: execute any clear the post-turn hook
    // marked for this session. Unconditional (no input-origin gate) so
    // routine/headless turns clear too; unfinished plans were never marked.
    this.deps.sessionTodoStore?.clearIfPending?.(effectiveSessionId);
    this.deps.skillOverlay?.clear(effectiveSessionId);

    // §4.5.2 step 1 — REQUEST_ENTRY (main process 도달 시점)
    this.tracer.step("REQUEST_ENTRY", { inputLen: turnInput.length, inputOrigin });
    if (!this.provider) {
      const err = t("be_conversationLoop.llmProviderNotConfigured");
      callbacks?.onError?.(err);
      throw new Error(err);
    }

    // B4: set up abort controller for this turn
    const ac = new AbortController();
    this.currentAbortController = ac;
    if (abortSignal?.aborted) {
      ac.abort(abortSignal.reason ?? new Error("parent aborted turn"));
    } else {
      abortSignal?.addEventListener(
        "abort",
        () => ac.abort(abortSignal.reason ?? new Error("parent aborted turn")),
        { once: true },
      );
    }
    const turnSignal = ac.signal;


    // §4.3 Step 1-2: 분류 + 라우팅
    // §4.5.2 step 2 — KEYWORD_CLASSIFY
    const classification = this.deps.keywordEngine.classify(turnInput);
    this.tracer.step("KEYWORD_CLASSIFY", { type: classification.type });
    // §4.5.2 step 3 — ROUTE_RESOLVE
    const routeResult = this.deps.routeEngine.route(classification);
    this.tracer.step("ROUTE_RESOLVE", { route: routeResult.route });

    if (routeResult.route === "command") {
      this.currentAbortController = null;
      return this.handleCommand(routeResult.command, routeResult.args, inputOrigin, callbacks);
    }

    // §4.5.2 step 4 — TURN_ORCHESTRATE
    this.tracer.step("TURN_ORCHESTRATE", { sessionId: this.sessionId });

    // ── #811 m2: SessionStart (NON-BLOCKING) ──
    // Fired ONCE per session, on its first real conversation turn (past the
    // command-route short-circuit). OBSERVE-ONLY — the dispatch result is
    // discarded. The once-per-session guard keeps "SessionStart" semantics even
    // though runTurn runs every turn.
    if (this.sessionStartFiredFor !== effectiveSessionId) {
      this.sessionStartFiredFor = effectiveSessionId;
      await this.fireLifecycleEvent(
        "SessionStart",
        { sessionMeta: this.sessionMetaForLifecycle() },
        effectiveSessionId,
      );
    }

    // ── #811 m2: UserPromptSubmit (BLOCKING, FAIL-CLOSED) ──
    // Fired AFTER classify/route (above) and BEFORE queryLoop. A trusted
    // `hooks.json` UserPromptSubmit hook can REFUSE this prompt: on a `deny`
    // (or a fail-closed timeout/error/bad-json/spawn-error) the turn is refused
    // and queryLoop NEVER runs. With NO matching trusted hook the dispatch
    // returns `allow` and the turn proceeds byte-identically to today.
    const promptGate = await this.fireUserPromptSubmit({
      inputText: turnInput,
      inputOrigin,
      route: routeResult.route,
      classification: classification.type,
    }, effectiveSessionId);
    if (promptGate.decision === "deny") {
      // Refuse the turn. Mirror handleCommand's blocked return: surface the
      // refusal text to the renderer, append nothing to history (the prompt
      // was not accepted), and return a TurnResult marked `blocked`. queryLoop
      // is never entered.
      this.currentAbortController = null;
      const refusal = t("be_conversationLoop.userPromptBlocked", {
        reason: promptGate.reason,
      });
      callbacks?.onTextDelta?.(refusal);
      callbacks?.onTurnComplete?.(refusal);
      log.warn(
        `runTurn: UserPromptSubmit hook REFUSED the prompt (turn blocked) — ${promptGate.reason}`,
      );
      return {
        text: refusal,
        toolCalls: [],
        route: routeResult.route,
        stopReason: "blocked",
      };
    }

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
    // queryLoop 가 별 method 라 마지막 round 의 provider inputTokens 와
    // request-input projection 을 instance field 로 share. runTurn 은 이
    // provider 값에 post-turn projection delta 를 더해 context-fill SOT 를 만든다.
    this.lastRoundProviderInputTokens = 0;
    this.lastRoundInputProjection = null;
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
      ? t("be_conversationLoop.skillRoutePrefix", { skillId: routeResult.skillId, input: turnInput })
      : turnInput;
    const attachmentParts = options?.attachments ?? [];
    const userContent: string | import("./llm/types.js").UserContentPart[] =
      attachmentParts.length > 0
        ? [{ type: "text" as const, text: baseText }, ...attachmentParts]
        : baseText;
    const personaPromptMeta = options?.rolePrompt?.id
      ? {
          id: options.rolePrompt.id,
          name: options.rolePrompt.name,
        }
      : undefined;
    const importedTrigger = inputOrigin === "plugin-emitted"
      ? parseImportedTriggerEnvelopePayload(turnInput)
      : null;
    const userMeta: MessageMeta = {
      ...(personaPromptMeta ? { activePersonaPrompt: personaPromptMeta } : {}),
      ...(routeResult.route === "skill"
        ? { displayText: turnInput, routeSkill: { skillId: routeResult.skillId } }
        : {}),
      ...(importedTrigger
        ? {
            displayText: importedTrigger.body,
            importedTrigger: {
              sessionId: `history-imported-${this.sessionId}-${turnStartedAt}`,
              source: importedTrigger.source,
              prompt: turnInput,
              summary: importedTrigger.body,
              toolCallCount: 0,
              importedAt: new Date(turnStartedAt).toISOString(),
            },
          }
        : {}),
    };

    this.history.append({
      role: "user",
      content: userContent,
      ...(Object.keys(userMeta).length > 0 ? { meta: userMeta } : {}),
    });
    // §4.5.2 step 5 — HISTORY_APPEND
    this.tracer.step("HISTORY_APPEND", { role: "user", historySize: this.history.length });

    // Lazy Tool Scoping — 이 턴에서 노출할 plugin 집합 결정.
    // SystemPromptBuilder Tool Schemas 섹션도 동일 scope로 필터링되도록
    // build() 호출 전에 setToolScope 수행.
    const scope = this.resolveToolScope(input);
    const initialToolSchemas = this.rebuildToolSchemas(scope);

    // ─── Token Preflight (same-session checkpoint compaction) ───
    // step 5 (HISTORY_APPEND) 직후 / step 6 (PROMPT_ASSEMBLE) 직전. The
    // projection is built from the same system prompt, provider-wire history,
    // and tool schemas that the provider request will carry. If compaction
    // mutates the summary preamble/history, prompt assembly runs again below.
    if (this.provider && !this.deps.disableSessionPersistence) {
      await this.runPreflightGuard(
        this.createRequestProjectionContext(
          scope,
          options?.originSource ?? null,
          options?.rolePrompt,
          initialToolSchemas,
          effectiveSessionId,
        ),
        turnSignal,
        callbacks,
      );
    }

    const systemPrompt = this.buildSystemPromptForScope(
      scope,
      options?.originSource ?? null,
      options?.rolePrompt,
      effectiveSessionId,
    );
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
          inputOrigin,
          toolTrustOrigin,
          permissionUserIntent,
          permissionExplicitAuthorizationIntent,
          rolePrompt: options?.rolePrompt,
        },
      );
    } finally {
      // Always clear the controller, even when `queryLoop` throws (provider
      // error / abort / tool error). Otherwise the loop looks "mid-turn"
      // forever to anyone consulting `currentAbortController` (e.g.
      // TriggerExecutor's chat-busy guard), and a single failed chat turn
      // would permanently block trigger imports.
      this.currentAbortController = null;
      // "이번 1회만" out-of-allowed-dir grants live only for the duration
      // of one user message. Clearing here (queryLoop terminal regardless
      // of success/error/abort) ensures the next turn re-prompts for the
      // same path — the user's "1회" intent.
      this.turnAdditionalDirectories = [];
      this.deps.skillOverlay?.clear(effectiveSessionId);
      // Drain any guidance that never reached a round boundary (single-
      // round turn, or guidance queued after the last round closed). It
      // cannot be applied to a future turn safely — the next turn's user
      // intent should not be silently prefixed with stale mid-stream
      // guidance — so drop and surface to the renderer via
      // `onGuidanceDropped` (critic MAJOR #3) so the user knows their
      // direction-adjustment was NOT applied. A `log.warn` alone made the
      // drop invisible to end users and worse-UX than the old abort-and-
      // restart flow.
      if (this.guidanceQueue.length > 0) {
        const droppedJoined = this.guidanceQueue.join("\n\n");
        log.warn(
          `runTurn: ${this.guidanceQueue.length} guide utterance(s) queued but never reached a round boundary — dropping`,
        );
        this.guidanceQueue = [];
        callbacks?.onGuidanceDropped?.(droppedJoined);
      }
    }
    // lastTurnScope must reflect any Option C request_plugin expansions so
    // the next turn's keyword-miss fallback keeps those plugins visible.
    this.lastTurnScope = new Set(scope.activePluginIds);
    // Tool-Level Deferral — carry only intentional plugin/MCP tool surface
    // forward. Unused tool_search promotions should not stick to unrelated
    // follow-up/meta questions as if they were builtins.
    this.lastTurnToolNames = this.nextCarryForwardToolNames(scope, result.toolCalls);
    const postTurnToolExposure = this.buildToolExposureMetrics(
      scope,
      result.finalToolSchemas,
      estimateRequestInputProjection({
        systemPrompt,
        messages: this.history.getMessages(),
        toolSchemas: result.finalToolSchemas,
      }),
      result.promotedToolNames,
    );

    // ── #811 m2: Stop (NON-BLOCKING) ──
    // Fired when the turn's query loop has resolved, BEFORE the internal
    // post-turn hook chain — a user lifecycle hook must never block the
    // hardcoded persistence chain (design §1.4). OBSERVE-ONLY: result discarded.
    // Payload: stopReason, toolCount, durationMs.
    await this.fireLifecycleEvent(
      "Stop",
      {
        ...(result.stopReason !== undefined ? { stopReason: result.stopReason } : {}),
        toolCount: result.toolCalls.length,
        durationMs: Math.max(0, Date.now() - turnStartedAt),
      },
      effectiveSessionId,
    );

    // §4.5.2 step 11 — POST_TURN
    this.tracer.step("POST_TURN", {
      toolCallCount: result.toolCalls.length,
      stopReason: result.stopReason,
      ...postTurnToolExposure,
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
        usageByModel: result.usageByModel,
        toolExposure: postTurnToolExposure,
        route: routeResult.route,
        vendorProvider: result.vendorProvider,
        vendorModel: result.vendorModel,
      });
      // PostTurnHookChain owns the durable transcript projection: mark-stale
      // compaction plus marker-stripped assistant output. Keep in-memory history
      // aligned before the turn_summary final save, otherwise that final save can
      // reintroduce raw <title>/[checkpoint] output over the cleaned transcript.
      const shouldRestoreHookHistory =
        hookResult.compactedMessages !== null ||
        hookResult.detector.cleanedText !== result.text;
      if (shouldRestoreHookHistory) {
        const beforeCount = this.history.getMessages().length;
        const afterCount = hookResult.messagesForPersistence.length;
        log.info(
          `post-turn: history mutation — ${beforeCount} → ${afterCount} msgs (canonical persistence applied to history reference)`,
        );
        this.history.clear();
        this.history.restore(hookResult.messagesForPersistence);
      }
      // Cleaned text (markers stripped) replaces raw output for caller.
      if (hookResult.detector.cleanedText !== result.text) {
        result = { ...result, text: hookResult.detector.cleanedText };
      }
    } else {
      // fallback: PostTurnHookChain 미주입 시 기존 inline 로직 유지.
      // SubAgentRunner 의 child loop 가 이 경로를 사용 (`postTurnHookChain: undefined`)
      // — isolation contract 보존 (parent session 의 audit/extractMemory/idle-poke 미터치) +
      // markStaleToolResults 만 child 에도 적용하여 child tool_result 가 parent
      // 로 surface 되어 history 부풀리는 문제 방지.
      // cycle 1 MED: extractMemory 중복 제거 — memory-extract hook이
      // PostTurnHookChain에서 이미 처리하므로 fallback에서도 호출하지 않는다.
      // PostTurnHookChain을 주입한 경우와 fallback 모두 memory 추출은
      // hook chain의 memory-extract 단계에서만 일어난다.
      // Tool-result marking — 항상 실행, 저비용. child loop 에서도 작동.
      // token preflight (next turn) 가 동등 압축 처리.
      // child loop 은 fire-and-forget 이라 turn budget 짧음 → markStaleToolResults 만으로 충분.
      const { messages: afterMark, result: mr } = markStaleToolResults(this.history.getMessages());
      if (mr.marked) {
        this.history.clear();
        this.history.restore(afterMark);
        if (process.env.NODE_ENV !== "production") {
          log.info(`mark-stale (fallback): marked ${mr.markedCount} tool_results, ~${mr.freedCharsOnSerialize} chars saved on serialize`);
        }
      }
      if (!this.deps.disableSessionPersistence) {
        await this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages());
      }
      // Mirror PostTurnHookChain's audit-route format so usage attribution
      // stays consistent across both code paths. SubAgentRunner constructs
      // child loops with `postTurnHookChain: undefined`, which would
      // otherwise log every sub-agent LLM turn as the bare `"llm"` route
      // and lose vendor/model granularity in `~/.lvis/audit.jsonl`.
      const auditRoute =
        result.usage
          ? `${result.vendorProvider}/${result.vendorModel}`
          : routeResult.route;
      const auditTokenUsage = normalizeAiSdkUsageForCost(result.usage, result.vendorProvider);
      const auditUsageByModel = result.usageByModel?.map((segment) => ({
        ...segment,
        tokenUsage: normalizeAiSdkUsageForCost(segment.tokenUsage, segment.vendorProvider),
      }));
      this.auditLogger.logTurn({
        sessionId: this.sessionId,
        input,
        output: result.text,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, isError: false })),
        tokenUsage: auditTokenUsage,
        usageByModel: auditUsageByModel,
        toolExposure: postTurnToolExposure,
        route: auditRoute,
      });
      this.deps.idleScheduler?.signalConversation();
    }

    // Same-session compact checkpoints run inside `runPreflightGuard`.
    // No post-turn hook is needed; the next user turn re-evaluates token usage.

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
      // Stream errors push an *error* message as the assistant content;
      // attaching turn-aggregate stats to it would render a TokenCostBadge
      // under a user-facing failure notice with stats that belong to the
      // PARTIAL (failed) round, not a completed turn. Exclude explicitly.
      result.stopReason !== "stream-error" &&
      typeof result.text === "string" &&
      result.text.trim().length > 0;
    log.info(
      `turn_summary: emit decision — stopReason="${result.stopReason}" textLen=${result.text?.trim().length ?? 0} usage=${result.usage ? `in=${result.usage.inputTokens} out=${result.usage.outputTokens}` : "MISSING"} → willEmit=${willEmitSummary}`,
    );
    if (willEmitSummary) {
      // tokensIn = turn-end projected context input. It is calibrated from
      //   provider-truth last-round raw input plus the local wire-shape delta
      //   produced after that provider request. This is the single context-fill
      //   SOT used by both TokenProgressRing and the footer.
      // tokensOut / cacheRead / cacheWrite = turn 전체 합산 (billing 누적).
      // freshInputTokens = turn 전체 fresh 합산 (TokenCostBadge headline +
      //   cost 계산용 — 라운드별 (inputTokens − cacheRead − cacheWrite) 의 합).
      //   `result.usage` 는 turn-aggregate (queryLoop:1098 turnUsage), 그러므로
      //   여기서 단순 산수만 하면 정확. 이전 badge 버그는 last-round raw 와
      //   turn-aggregate cache 를 빼느라 음수 → 0 으로 잘리던 mismatch.
      const postTurnProjection = estimateRequestInputProjection({
        systemPrompt,
        messages: this.history.getMessages(),
        toolSchemas: result.finalToolSchemas,
      });
      const lastRoundProjection = this.lastRoundInputProjection ?? postTurnProjection;
      turnTokensIn = projectNextTurnInputTokens({
        providerInputTokens: this.lastRoundProviderInputTokens,
        lastRoundProjection,
        postTurnProjection,
      });
      this.lastContextInputTokens = turnTokensIn;
      this.lastContextInputProjectionTokens = postTurnProjection.totalTokens;
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
      const uniqueUsageModelKeys = new Set(
        result.usageByModel?.map((segment) => `${segment.vendorProvider}\u0000${segment.vendorModel}`) ?? [],
      );
      const singleUsageModel =
        uniqueUsageModelKeys.size === 1 && result.usageByModel?.[0]
          ? result.usageByModel[0]
          : undefined;
      const turnSummaryPayload = {
        turnDurationMs: Math.max(0, Date.now() - turnStartedAt),
        toolCount: turnToolCount,
        cumulativeToolMs: turnCumulativeToolMs,
        tokensIn: turnTokensIn,
        freshInputTokens: turnFreshInput,
        tokensOut: turnTokensOut,
        ...(turnCacheRead > 0 ? { cacheReadTokens: turnCacheRead } : {}),
        ...(turnCacheWrite > 0 ? { cacheWriteTokens: turnCacheWrite } : {}),
        ...(singleUsageModel
          ? {
              vendorProvider: singleUsageModel.vendorProvider,
              vendorModel: singleUsageModel.vendorModel,
            }
          : {}),
        ...(result.usageByModel.length > 0 ? { usageByModel: result.usageByModel } : {}),
        ...(breakdown ? { breakdown } : {}),
      };
      // Persist turn-aggregate stats onto the turn-final assistant message so
      // a reload reconstructs the same TokenCostBadge / TurnSummaryFooter
      // numbers without re-running the loop. historyToEntries reads this
      // meta and emits a `kind: "turn_summary"` ChatEntry after the last
      // assistant entry of the turn. Silent on history with no assistant
      // (rare tool-only termination) — nothing to attach to.
      let attachedTurnSummary = false;
      try {
        attachedTurnSummary = this.history.attachTurnSummaryToLastAssistant(turnSummaryPayload);
      } catch {
        // Meta attach must never break turn completion either.
      }
      let turnSummaryDurable =
        attachedTurnSummary && this.deps.disableSessionPersistence === true;
      if (attachedTurnSummary && !this.deps.disableSessionPersistence) {
        try {
          await this.deps.memoryManager.saveSession(this.sessionId, this.history.getMessages());
          turnSummaryDurable = true;
        } catch (err) {
          log.warn("turn_summary final save failed: %s", err);
        }
      }
      if (turnSummaryDurable) {
        try {
          callbacks?.onTurnSummary?.(turnSummaryPayload);
        } catch {
          // Summary emission must never break turn completion.
        }
      }
    }

    callbacks?.onTurnComplete?.(result.text);

    // Re-arm recovery budgets after a clean turn. If the turn completed
    // without a context_error / stream_error, the structural failure that
    // exhausted force-recover or TPM recovery is resolved.
    if (
      result.stopReason !== "context-error" &&
      result.stopReason !== "stream-error" &&
      result.stopReason !== "interrupted"
    ) {
      // A genuinely-completed turn (not interrupted/aborted, not a
      // context/stream error) means the structural failure that drove
      // force-recover / TPM recovery is resolved. Reset the CONSECUTIVE
      // force-recover counter so separate, each-recovered context errors over a
      // long session do NOT accumulate to the cap and permanently block
      // compaction. (Previously this reset was also gated behind
      // recoveryExhausted||rateLimitRecoveryAttempted — which a single
      // successful recovery never sets — so the counter stuck and 3 separate
      // recoveries exhausted the budget mid-session.) Interrupted turns are
      // EXCLUDED so a user / misbehaving UI cannot abort turns to reset the
      // force-recover DoS hard-cap budget.
      this.contextErrorRecoveryCount = 0;
      if (this.recoveryExhausted || this.rateLimitRecoveryAttempted) {
        const wasRecoveryExhausted = this.recoveryExhausted;
        this.recoveryExhausted = false;
        this.rateLimitRecoveryAttempted = false;
        log.info(
          wasRecoveryExhausted
            ? "runTurn: recoveryExhausted reset — clean turn, recovery re-armed"
            : "runTurn: rate-limit recovery reset — clean turn, recovery re-armed",
        );
      }
    }

    // Issue #260 — fire system notification on turn-end. Skip if the turn
    // was interrupted (user aborted), hit context_error / stream_error, or
    // produced no assistant text (rare tool-only termination). Body is the
    // leading slice of the assistant response — NotificationService caps +
    // ellipses it.
    if (
      result.stopReason !== "interrupted" &&
      result.stopReason !== "context-error" &&
      result.stopReason !== "stream-error" &&
      typeof result.text === "string" &&
      result.text.trim().length > 0
    ) {
      try {
        this.deps.notificationService?.fire({
          kind: "turn-end",
          title: t("be_conversationLoop.notificationTurnEndTitle"),
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
    initialSystemPrompt: string,
    scope: ToolScope,
    callbacks: TurnCallbacks | undefined,
    abortSignal: AbortSignal | undefined,
    overlayTriggerOrigin: string | null,
    bounds: {
      maxRounds?: number;
      sessionIdOverride?: string;
      spawnDepth?: number;
      inputOrigin: ChatInputOrigin;
      toolTrustOrigin: ToolTrustOrigin;
      permissionUserIntent?: string;
      permissionExplicitAuthorizationIntent?: string;
      rolePrompt?: ActiveRolePrompt;
    },
  ): Promise<{
    text: string;
    toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
    usage?: TokenUsage;
    stopReason?: TurnStopReason;
    usageByModel: TokenUsageByModel[];
    vendorProvider: LLMVendor;
    vendorModel: string;
    finalToolSchemas: ToolSchema[];
    promotedToolNames: string[];
  }> {
    const llmSettings = this.deps.settingsService.get("llm");
    const activeBlock = llmSettings.vendors[llmSettings.provider];
    const model = activeBlock.model;
    let systemPrompt = initialSystemPrompt;
    let servingVendorProvider: LLMVendor = llmSettings.provider;
    let servingVendorModel = model;
    const usageByModel: TokenUsageByModel[] = [];
    const addUsageForServingModel = (usage: TokenUsage): void => {
      usageByModel.push({
        vendorProvider: servingVendorProvider,
        vendorModel: servingVendorModel,
        tokenUsage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          ...(usage.cacheReadTokens !== undefined ? { cacheReadTokens: usage.cacheReadTokens } : {}),
          ...(usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteTokens } : {}),
        },
      });
    };
    // Provider-as-oracle: tools the provider 400'd on (invalid_function_parameters)
    // and we dropped this turn. Turn-scoped — resets naturally each queryLoop call.
    const droppedToolSchemaNames = new Set<string>();
    // Option C: scope is mutable within the turn. Mutating the caller's Set
    // directly means the next turn's fallback sees every plugin that was
    // activated here. Route EVERY turn rebuild through this so already-dropped
    // tools stay excluded — a mid-turn rebuild (request_plugin / tool_search)
    // must not reintroduce a tool the provider already rejected and re-break
    // the turn.
    const rebuildTurnToolSchemas = (): ToolSchema[] =>
      withoutDroppedTools(this.rebuildToolSchemas(scope), droppedToolSchemaNames);
    let toolSchemas: ToolSchema[] = rebuildTurnToolSchemas();
    const withServingIdentity = (
      result: {
        text: string;
        toolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }>;
        usage?: TokenUsage;
        stopReason?: TurnStopReason;
      },
    ) => ({
      ...result,
      usageByModel: [...usageByModel],
      vendorProvider: servingVendorProvider,
      vendorModel: servingVendorModel,
      finalToolSchemas: [...toolSchemas],
      promotedToolNames: [...new Set(promotedToolNamesForTurn)],
    });
    const turnProvider = this.provider instanceof FallbackProvider
      ? this.provider.withCallbacks({
        onFallback: callbacks?.onFallback,
        onStatus: (status) => {
          if (
            (status.phase === "attempt" || status.phase === "retry") &&
            status.provider &&
            status.model
          ) {
            servingVendorProvider = status.provider;
            servingVendorModel = status.model;
          }
          callbacks?.onLlmStatus?.(status);
        },
      })
      : this.provider!;
    const allToolCalls: Array<{ name: string; input: Record<string, unknown>; result: string }> = [];
    const toolMetaByUseId = new Map<string, ToolCallMeta>();
    let turnUsage: TokenUsage | undefined;
    let pluginExpansions = 0;
    // Tool-Level Deferral — per-turn tool_search counter (mirror pluginExpansions).
    let toolSearches = 0;
    const promotedToolNamesForTurn: string[] = [];
    let knowledgeCallCount = 0;
    let roundIndex = 0;
    let toolTrustOrigin = bounds.toolTrustOrigin;
    // C3(a): assistant-round counter — used by the maxRounds break below.
    let assistantRoundsRun = 0;
    // finish_reason=length CONTINUATION carry. While a logical answer is being
    // continued across rounds we accumulate its raw text + reasoning here and
    // DEFER the history append + onAssistantRound until the chain terminates —
    // so the user sees ONE coherent answer and history holds ONE assistant
    // message. `continuationPrefillText !== undefined` ⇒ next round continues.
    let continuationsRun = 0;
    let continuationCarryText = "";
    let continuationCarryThought = "";
    let continuationPrefillText: string | undefined = undefined;
    // C3(a): effective round budget. Default = MAX_TOOL_ROUNDS (30); when a
    // caller supplies maxRounds (sub-agent runner) clamp to it. Negative or
    // zero falls back to default so callers keep working unchanged.
    const requestedMaxRounds = bounds?.maxRounds;
    const effectiveMaxRounds =
      typeof requestedMaxRounds === "number" && Number.isFinite(requestedMaxRounds) && requestedMaxRounds > 0
        ? Math.min(MAX_TOOL_ROUNDS, Math.floor(requestedMaxRounds))
        : MAX_TOOL_ROUNDS;

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      // C3(a): hard guard between rounds — if we have already executed
      // `effectiveMaxRounds` assistant turns, stop cleanly and return the
      // last text. This is the loop-boundary defense for agent_spawn
      // turn caps; abortCurrentTurn remains the user-cancel path.
      if (assistantRoundsRun >= effectiveMaxRounds) {
        // EARLY-EXIT #1: round cap hit. 이 자리에서 *조용히* synthetic 텍스트
        // 를 반환하면 사용자는 "왜 갑자기 끊겼지?" 의문. WARN 로그 + UI 콜백으로
        // 명시적 신호.
        log.warn(
          `queryLoop: EARLY-EXIT(round-cap) — assistantRoundsRun=${assistantRoundsRun} effectiveMaxRounds=${effectiveMaxRounds} totalToolCalls=${allToolCalls.length}`,
        );
        callbacks?.onError?.(
          t("be_conversationLoop.roundCapError", { max: effectiveMaxRounds }),
        );
        return withServingIdentity({
          text: allToolCalls.length > 0
            ? `(round cap ${effectiveMaxRounds} reached — last assistant text: ${this.history.getMessages().filter((m) => m.role === "assistant").slice(-1)[0]?.content ?? ""})`
            : `(round cap ${effectiveMaxRounds} reached without assistant output)`,
          toolCalls: allToolCalls,
          usage: turnUsage,
        });
      }
      // Round-boundary guidance inject — drain any "guide" utterances
      // queued via `ConversationLoop.queueGuidance` while the previous
      // round was running. Only fires when `round > 0` so the user's
      // initial turn input is never preempted by a stale queue (round 0
      // is the user's original prompt; queue is empty there because
      // `queueGuidance` requires `currentAbortController !== null`, which
      // is set just before the queryLoop starts but a fresh runTurn
      // always starts with the queue drained on the prior turn's finally).
      //
      // Race ordering (critic MAJOR #2): both `queueGuidance` (from IPC
      // handler thread) and this drain run on Node's single-threaded
      // event loop. `queryLoop` awaits between rounds inside
      // `collectRoundStream`, giving the IPC handler an injection point.
      // The atomic `currentAbortController` check inside `queueGuidance`
      // closes the only true race.
      // Do not interrupt an in-flight length-continuation with queued guidance:
      // it would push a user message after the assistant prefill and break the
      // continue_final_message "last message is assistant" precondition.
      if (round > 0 && this.guidanceQueue.length > 0 && continuationPrefillText === undefined) {
        // Truncate from the head — preserve the user's MOST RECENT guides
        // since older queued items may have been superseded. Worst case
        // (16 × 8000 chars = 128KB joined) is capped at
        // `GUIDE_JOINED_MAX_CHARS` and the truncation is surfaced via a
        // leading marker so the LLM doesn't get confused by missing
        // context.
        let joined = this.guidanceQueue.join("\n\n");
        let truncatedCount = 0;
        const kept = [...this.guidanceQueue];
        while (joined.length > ConversationLoop.GUIDE_JOINED_MAX_CHARS && kept.length > 1) {
          kept.shift();
          truncatedCount += 1;
          joined = kept.join("\n\n");
        }
        if (truncatedCount > 0) {
          joined = t("be_conversationLoop.guidanceTruncationMarker", { count: truncatedCount, joined });
        }
        this.guidanceQueue = [];
        const injectedContent = t("be_conversationLoop.guidanceInjectionHeader", { joined });
        // Critic round 2 M1: run preflight BEFORE appending the guide so
        // compaction targets the older history and never accidentally
        // summarizes-away the just-injected guide marker. `joined` is
        // capped at GUIDE_MAX_ENTRIES × GUIDE_MAX_CHARS = 128KB chars
        // (≈ 30K tokens worst case) but typical use is < 1K tokens —
        // well below the post-compact preserveRecent budget, so the
        // next round's prompt-assembly will fit.
        if (this.provider && !this.deps.disableSessionPersistence) {
          const compacted = await this.runPreflightGuard(
            {
              systemPrompt,
              toolSchemas,
              estimateCurrent: () => this.estimateCurrentRequestProjection({
                systemPrompt: this.buildSystemPromptForScope(
                  scope,
                  overlayTriggerOrigin,
                  bounds.rolePrompt,
                  bounds.sessionIdOverride ?? this.sessionId,
                ),
                toolSchemas,
              }),
            },
            abortSignal,
            callbacks,
          );
          if (compacted) {
            systemPrompt = this.buildSystemPromptForScope(
              scope,
              overlayTriggerOrigin,
              bounds.rolePrompt,
              bounds.sessionIdOverride ?? this.sessionId,
            );
          }
        }
        this.history.append({
          role: "user",
          content: injectedContent,
        });
        callbacks?.onGuidanceInjected?.(joined);
        this.tracer.step("GUIDANCE_INJECTED", { round, len: joined.length });
      }

      const repaired = this.history.repairToolPairInvariant();
      if (repaired.removedMessages > 0 || repaired.removedToolCalls > 0) {
        log.warn(
          `queryLoop: repaired invalid tool history before provider call (removedMessages=${repaired.removedMessages}, removedToolCalls=${repaired.removedToolCalls})`,
        );
      }

      // ─── Stream attempt — token preflight 가 사전 압축 처리하므로 mid-loop retry 없음 ───
      const baseMessagesForRound = this.history.getMessages();
      // finish_reason=length CONTINUATION: when continuing, append a WIRE-ONLY
      // partial assistant turn (NOT persisted to history) as the final message.
      // The openai-compatible adapter pairs this with continue_final_message so
      // vLLM resumes it verbatim. For mid-<think> truncation the prefill text is
      // `<think>\n…` (open, no closing tag) so the model finishes reasoning
      // before answering; add_generation_prompt:false blocks a 2nd auto <think>.
      const messagesForRound =
        continuationPrefillText !== undefined
          ? [
              ...baseMessagesForRound,
              { role: "assistant" as const, content: continuationPrefillText },
            ]
          : baseMessagesForRound;
      this.lastRoundInputProjection = estimateRequestInputProjection({
        systemPrompt,
        messages: messagesForRound,
        toolSchemas,
      });
      const toolExposure = this.buildToolExposureMetrics(
        scope,
        toolSchemas,
        this.lastRoundInputProjection,
        promotedToolNamesForTurn,
      );
      const requestDiagnostics = this.buildProviderRequestDiagnostics({
        round,
        assistantRoundIndex: roundIndex,
        inputOrigin: bounds.inputOrigin,
        configuredProvider: llmSettings.provider,
        model,
        systemPrompt,
        messages: messagesForRound,
        toolSchemas,
        activePluginIds: [...scope.activePluginIds],
        projection: this.lastRoundInputProjection,
        toolExposure,
      });
      // §4.5.2 step 7 — LLM_STREAM
      this.tracer.step("LLM_STREAM", {
        round,
        assistantRoundIndex: roundIndex,
        model,
        toolCount: toolSchemas.length,
        ...toolExposure,
        request: requestDiagnostics,
      });
      const stream = await collectRoundStream({
        provider: turnProvider,
        model,
        systemPrompt,
        messages: messagesForRound,
        toolSchemas,
        llmSettings: { ...activeBlock, streamSmoothing: llmSettings.streamSmoothing },
        abortSignal,
        continuationPrefill: continuationPrefillText !== undefined,
        onReasoningDelta: callbacks?.onReasoningDelta,
        onTextDelta: callbacks?.onTextDelta,
      });
      // One-shot: clear so a following tool round or terminal round does not
      // re-inject the prefill. The continuation branch below re-sets it when the
      // chain extends. (Carry text/thought persist independently for stitching.)
      continuationPrefillText = undefined;

      // EARLY-EXIT (safety net): token estimator drift 로 context_error 도달 시
      // 사용자 안내 + turn 종료. retry 없음 — mid-loop history mutation 으로 LLM tool-chain
      // 손상되던 silent failure 패턴 영구 제거.
      if (stream.kind === "context_error") {
        log.warn(
          `queryLoop: EARLY-EXIT(context_error after token preflight) — round=${roundIndex} err="${(stream.errorMessage ?? "").slice(0, 100)}" (estimator drift suspected)`,
        );
        // `stream.kind === "context_error"` 는 `stream-collector.ts` 의
        // `isContextLengthError(raw)` 가 *이미* true 를 판정한 신호 — 이
        // 분기 도달 raw 는 context-window 초과로 확정. TPM rate-limit raw
        // 는 `isContextLengthError` 패턴 (prompt is too long / maximum
        // context length / context window / input token count) 어느 것
        // 에도 매치되지 않으므로 *별도 경로* (`stream_error`, line 1582)
        // 로 도달 — 그쪽에서 새 `classifyProviderError` 가 정확한 TPM
        // 메시지를 전달함 (issue #900).
        const userMsg =
          t("be_conversationLoop.contextErrorUserMessage");
        callbacks?.onError?.(userMsg, "context-error");
        // Issue #911: mark as systemNotice so the UI renders a destructive
        // banner (red border + warning icon) instead of a normal assistant
        // reply. Without this marker the user cannot distinguish a real LLM
        // turn from a host-emitted error notice.
        this.history.append({
          role: "assistant",
          content: userMsg,
          meta: { systemNotice: "context-error" },
        });
        // Issue #910 follow-up — the user-facing message promises "새 메시지를
        // 보내면 자동 압축이 다시 시도됩니다". Set a pending flag so the next
        // runPreflightGuard force-triggers compact regardless of threshold.
        this.contextErrorPending = true;
        return withServingIdentity({ text: userMsg, toolCalls: allToolCalls, usage: turnUsage, stopReason: "context-error" });
      }

      if (stream.kind === "stream_error") {
        // EARLY-EXIT #2: provider stream error. 이미 onError 콜백 + history 에
        // 메시지 push. 추가 진단 로그로 빈도 추적.
        const streamErrorMeta = {
          round,
          assistantRoundIndex: roundIndex,
          classification: stream.classification,
          providerError: stream.providerError,
          request: requestDiagnostics,
        };
        log.warn(
          {
            sessionId: this.sessionId,
            ...streamErrorMeta,
          },
          `queryLoop: EARLY-EXIT(stream-error) — round=${roundIndex} userMessage="${stream.userMessage.slice(0, 100)}"`,
        );
        this.tracer.step("LLM_STREAM_ERROR", streamErrorMeta);

        // Provider-as-oracle recovery (#1182). The provider is the source of
        // truth for "is this tool schema acceptable": when it rejects the whole
        // request with a strict-mode 400 (invalid_function_parameters) naming
        // one offending function, drop just that tool and retry the round with
        // the reduced set — no hand-rolled mirror of the provider's rules. The
        // plugin-load lint catches the common case for free; this catches the
        // rest. `rejectedToolNameFromError` only returns a name still present in
        // `toolSchemas`, so the drop strictly shrinks a finite set and the loop
        // is guaranteed to terminate (the cap is just defensive).
        const rejectedTool = rejectedToolNameFromError(
          stream.providerError,
          toolSchemas.map((s) => s.name),
        );
        if (
          rejectedTool &&
          !droppedToolSchemaNames.has(rejectedTool) &&
          droppedToolSchemaNames.size < MAX_TOOL_SCHEMA_DROPS_PER_TURN
        ) {
          droppedToolSchemaNames.add(rejectedTool);
          toolSchemas = toolSchemas.filter((s) => s.name !== rejectedTool);
          log.warn(
            {
              sessionId: this.sessionId,
              toolName: rejectedTool,
              providerCode: stream.providerError?.providerCode,
              remainingTools: toolSchemas.length,
            },
            `queryLoop: provider rejected tool inputSchema — dropping '${rejectedTool}' and retrying round (provider-as-oracle)`,
          );
          this.tracer.step("TOOL_SCHEMA_REJECTED", {
            round,
            assistantRoundIndex: roundIndex,
            toolName: rejectedTool,
            providerError: stream.providerError,
          });
          // Retry the round with the offending tool removed. Does NOT count as
          // an assistant round (assistantRoundsRun is unchanged); the for-loop
          // `round` counter + MAX_TOOL_ROUNDS still bound total iterations.
          continue;
        }

        if (
          this.shouldAutoCompactForRateLimit(stream) &&
          !this.rateLimitRecoveryAttempted &&
          this.provider &&
          !this.deps.disableSessionPersistence
        ) {
          this.rateLimitRecoveryAttempted = true;
          const compacted = await this.runPreflightGuard(
            {
              systemPrompt,
              toolSchemas,
              estimateCurrent: () => this.estimateCurrentRequestProjection({
                systemPrompt,
                toolSchemas,
              }),
            },
            abortSignal,
            callbacks,
            { forceReason: "rate-limit" },
          );
          if (compacted) {
            const recoveredMessage = this.rateLimitCompactMessage(stream);
            callbacks?.onTextDelta?.(recoveredMessage);
            this.history.append({
              role: "assistant",
              content: recoveredMessage,
            });
            return withServingIdentity({
              text: recoveredMessage,
              toolCalls: allToolCalls,
              usage: turnUsage,
              stopReason: "stream-error",
            });
          }
        }
        callbacks?.onError?.(stream.userMessage, "stream-error");
        this.history.append({
          role: "assistant",
          content: stream.userMessage,
          meta: { systemNotice: "stream-error" },
        });
        // Issue #910 round-4 security MED — stream_error covers network /
        // auth / rate-limit / 5xx in addition to context-length. Only set
        // the force-recover flag when the underlying message *actually*
        // matches a context-length pattern; for other stream errors
        // forcing a destructive (preserve=0) compact would just drop the
        // user's working history for no benefit.
        if (isContextLengthError(stream.userMessage)) {
          this.contextErrorPending = true;
        }
        return withServingIdentity({ text: stream.userMessage, toolCalls: allToolCalls, usage: turnUsage, stopReason: "stream-error" });
      }

      if (stream.kind === "interrupted") {
        // EARLY-EXIT #3: 사용자 abort. abortCurrentTurn() 또는 외부 abortSignal.
        // 정상 케이스이지만 빈도 추적용 로그.
        log.info(
          `queryLoop: EARLY-EXIT(interrupted) — round=${roundIndex} priorTextLen=${(stream.text ?? "").length}`,
        );
        // Strip suggested-replies block before persistence — otherwise raw
        // `<suggested_replies>` tags would land in ~/.lvis/sessions/*.jsonl
        // and be fed back to the LLM on every subsequent turn.
        //
        // interrupted is *user-initiated* not a host error, so we do NOT
        // attach systemNotice — the assistant content that was streamed
        // before the abort is real model output and stays styled normally;
        // only the "[중단됨]" suffix marks the boundary.
        const interruptedSuffix = t("be_conversationLoop.interruptedSuffix");
        // length-continuation: if the user aborts mid-chain, prepend the raw
        // accumulated prefix so the persisted + returned text is the full
        // partial answer, not just the last continuation round. Strip the
        // suggested-replies block ONCE on the merged raw text (carry is "" on a
        // non-continued turn ⇒ identical to the prior behavior).
        const savedText = stripSuggestedReplies(continuationCarryText + (stream.text ?? "")) + interruptedSuffix;
        this.history.append({ role: "assistant", content: savedText });
        callbacks?.onTextDelta?.(interruptedSuffix);
        return withServingIdentity({ text: savedText, toolCalls: allToolCalls, usage: turnUsage, stopReason: "interrupted" });
      }

      // stream.kind === "ok" — usage 반영 + assistant round commit
      //
      // LVIS usage accounting invariant:
      //   AI SDK v6 normalized inputTokens include cached tokens across
      //   providers, so subtract cacheRead/cacheWrite to get fresh input.
      //
      // 1) turnUsage 는 모든 round 의 AI SDK normalized usage 합산
      //    (이전: `=` 으로 마지막 round 만 보존
      //    → multi-round turn 의 turn_summary 가 under-report 되던 버그).
      // 2) cumulativeUsage.inputTokens 는 fresh input 만 누적 (cached 빼서)
      //    → long session 에서 cached prefix 가 매 turn 누적되어 ctxUsage 가
      //    조기에 100% 도달, auto-compact 가 premature 발화하던 root cause 해소.
      // 3) cache read/write 는 별도 누적 — 비용 계산은 다른 가중치 (read 0.1×,
      //    write 1.25×) 적용 가능하도록 분리 보존. Audit/UsageDashboard
      //    경계에서는 `normalizeAiSdkUsageForCost` 로 computeCost 계약에 맞춘다.
      if (stream.usage) {
        const u = stream.usage;
        const cacheRead = u.cacheReadTokens ?? 0;
        const cacheWrite = u.cacheWriteTokens ?? 0;
        const adjustedIn = Math.max(0, u.inputTokens - cacheRead - cacheWrite);

        // Last-round overwrite. runTurn uses this as the provider-calibration
        // anchor for turn_summary.tokensIn; billing 합산은 turnUsage.inputTokens /
        // cumulativeUsage 가 별도 추적.
        this.lastRoundProviderInputTokens = u.inputTokens;
        this.lastContextInputTokens = u.inputTokens;
        this.lastContextInputProjectionTokens = this.lastRoundInputProjection?.totalTokens ?? 0;

        turnUsage = {
          inputTokens: (turnUsage?.inputTokens ?? 0) + u.inputTokens,
          outputTokens: (turnUsage?.outputTokens ?? 0) + u.outputTokens,
          cacheReadTokens: (turnUsage?.cacheReadTokens ?? 0) + cacheRead,
          cacheWriteTokens: (turnUsage?.cacheWriteTokens ?? 0) + cacheWrite,
        };
        addUsageForServingModel({
          inputTokens: u.inputTokens,
          outputTokens: u.outputTokens,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: cacheWrite,
        });

        this.cumulativeUsage.inputTokens += adjustedIn;
        this.cumulativeUsage.outputTokens += u.outputTokens;
        this.cumulativeUsage.cacheReadTokens =
          (this.cumulativeUsage.cacheReadTokens ?? 0) + cacheRead;
        this.cumulativeUsage.cacheWriteTokens =
          (this.cumulativeUsage.cacheWriteTokens ?? 0) + cacheWrite;
      }

      const { text: streamText, thought: thoughtContent, thinkingBlocks: roundThinkingBlocks, toolCalls: pendingToolCalls, stopReason } = stream;
      // Strip the suggested-replies block at the single chokepoint between the
      // raw stream and every downstream consumer (history, callbacks, return
      // value). Keeping this stripped here protects: (a) persisted session
      // JSONL — the tag would otherwise be fed back as context on every
      // subsequent turn, (b) sub-agent summaries — sub-agent results flow
      // back to the parent via runTurn's return value, (c) plugin/routine
      // generateText callers — orthogonal strip is also applied in
      // generateText() but defense in depth.
      // finish_reason=length CONTINUATION: carry the RAW (un-stripped) text
      // across rounds so the wire prefill resumes vLLM verbatim — zero seam,
      // trailing whitespace preserved (stripSuggestedReplies trimEnd would
      // otherwise eat the boundary whitespace between a truncated round and its
      // continuation). The suggested-replies block is stripped ONCE on the fully
      // merged answer below — a max_tokens-truncated round never holds a
      // complete block. With no continuation in flight the carry is "" so
      // mergedRawText === streamText and mergedText === stripSuggestedReplies(
      // streamText); every non-continuation path is byte-for-byte unchanged.
      const mergedRawText = continuationCarryText + streamText;
      const mergedThought = continuationCarryThought + thoughtContent;
      const mergedText = stripSuggestedReplies(mergedRawText);

      // ─── finish_reason=length CONTINUATION ──────────────────────────────────
      // A truncated round (stopReason "max_tokens") with NO tool calls is not a
      // finished turn. Instead of terminating (cut-off answer + suspect-
      // truncation notice), re-invoke the model to CONTINUE the partial answer.
      // We DEFER the history append + onAssistantRound here so deltas keep
      // streaming into the SAME open UI card and history ends up with ONE merged
      // assistant message. (`madeProgress` is the zero-progress break.)
      const madeProgress = streamText.length > 0 || thoughtContent.length > 0;
      const willContinue =
        stopReason === "max_tokens" &&
        pendingToolCalls.length === 0 &&
        vendorSupportsLengthContinuation(llmSettings.provider) &&
        continuationsRun < MAX_LENGTH_CONTINUATIONS &&
        assistantRoundsRun + 1 < effectiveMaxRounds &&
        madeProgress;

      if (willContinue) {
        continuationCarryText = mergedRawText;
        continuationCarryThought = mergedThought;
        // Wire prefill for the next round. If the answer body has started
        // (mergedRawText non-empty) continue it verbatim — vLLM already split
        // any reasoning into reasoning_content. If we truncated INSIDE <think>
        // (no answer text yet) re-open the think block; the model emits its own
        // closing </think> before answering.
        continuationPrefillText =
          mergedRawText.length > 0 ? mergedRawText : `<think>\n${mergedThought}`;
        continuationsRun += 1;
        assistantRoundsRun += 1; // counts against the global round budget
        this.tracer.step("LENGTH_CONTINUATION", {
          round: roundIndex,
          continuationsRun,
          carryTextLen: continuationCarryText.length,
          reopenedThink: mergedRawText.length === 0,
        });
        // roundIndex is intentionally NOT incremented — the continuation is the
        // SAME logical assistant round from the UI's perspective, and we must
        // NOT fire onAssistantRound (it would close the streaming card and the
        // renderer would drop every subsequent delta).
        continue;
      }

      // Cap BEFORE persisting to history. Anthropic + OpenAI strict
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
      // Persist the MERGED answer (carry + this round). Non-continued turns have
      // empty carries ⇒ original single-round content.
      this.history.append({
        role: "assistant",
        content: wasCapped ? `${mergedText}\n\n[capped at ${MAX_TOOL_CALLS_PER_ROUND} of ${pendingToolCalls.length} tool_use blocks]` : mergedText,
        ...(mergedThought && { thought: mergedThought }),
        ...(preserveThinkingBlocks && roundThinkingBlocks.length > 0 && { thinkingBlocks: roundThinkingBlocks }),
        // Persist only the capped slice — these are the only blocks
        // that will receive a matching tool_result. Streaming UI still sees
        // the un-capped count below via the assistant-round callback so the
        // user can observe the original LLM intent (and the cap message).
        ...(pendingToolCallsCapped.length > 0 && { toolCalls: pendingToolCallsCapped }),
      });
      // Continuation chain (if any) terminates HERE — merged message committed.
      continuationCarryText = "";
      continuationCarryThought = "";

      // §4.5.2 step 8 — REASONING_ACCUMULATE
      if (thoughtContent.length > 0) {
        this.tracer.step("REASONING_ACCUMULATE", { round: roundIndex, thoughtLen: thoughtContent.length });
      }
      callbacks?.onAssistantRound?.({
        roundIndex,
        text: mergedText,
        thought: mergedThought,
        stopReason,
        // The UI / telemetry callback receives the un-capped count so the
        // user sees the LLM's full intent — only persisted history is capped.
        hasToolCalls: pendingToolCalls.length > 0,
      });
      // §4.5.2 step 10 — ROUND_COMMIT
      this.tracer.step("ROUND_COMMIT", {
        round: roundIndex,
        stopReason,
        textLen: mergedText.length,
        toolCallCount: pendingToolCalls.length,
      });
      roundIndex += 1;
      // C3(a): a "round" for cap purposes is any assistant message we
      // committed to history — `end_turn` and `tool_use` both count.
      assistantRoundsRun += 1;

      if (pendingToolCalls.length === 0 || stopReason === "end_turn") {
        // BEFORE returning — "방향 지시는 end-turn 전에 영향을 미치는 거"
        // (user spec). If guide is queued, do NOT end the turn; fall
        // through to another iteration so the round-boundary inject site
        // drains the queue and the LLM gets one more round to respond to
        // the guidance. Round-cap still applies — if we're at the cap, we
        // can't add another round; drop-on-end will surface to the user.
        if (this.guidanceQueue.length > 0 && assistantRoundsRun < effectiveMaxRounds) {
          this.tracer.step("GUIDANCE_INJECTED", {
            round: roundIndex,
            note: "extending turn — guide queued at end-turn boundary",
          });
          continue;
        }
        // EARLY-EXIT #4: turn 종료. 정상 케이스는 stopReason === "end_turn"
        // 또는 LLM 이 tool 없이 final 답을 내놓은 케이스. *비정상 silent
        // truncation* (예: max_tokens / unknown stopReason 으로 0 tools 반환)
        // 도 같은 분기로 떨어지므로 stopReason 이 end_turn 이 *아닌데* 0 tools
        // 면 WARN 로 명시적 진단 — 28-step abandonment 의 가능한 원인.
        if (stopReason !== "end_turn" && pendingToolCalls.length === 0) {
          log.warn(
            `queryLoop: EARLY-EXIT(suspect-truncation) — stopReason="${stopReason}" pendingTools=0 textLen=${mergedText.length} round=${roundIndex}`,
          );
          callbacks?.onError?.(
            t("be_conversationLoop.suspectTruncationError", { reason: stopReason ?? "unknown reason", round: roundIndex }),
          );
        }
        return withServingIdentity({ text: mergedText, toolCalls: allToolCalls, usage: turnUsage, stopReason });
      }

      // §4.5.6 tool execution — request_plugin 가로채기 + knowledge depth cap + executor 호출
      // (cap already applied above before history commit; pendingToolCallsCapped is the
      //  authoritative slice that flows through executor and produces tool_result blocks.)
      const toolUses: ToolUseBlock[] = pendingToolCallsCapped.map((tc) => ({
        id: tc.id, name: tc.name, input: tc.input,
      }));

      // Snapshot the session-activation set so we can audit exactly the
      // disabled plugins this turn newly session-activated (one event each).
      const sessionActivatedBefore = new Set(this.sessionActivatedPluginIds);
      const pluginOutcome = handleRequestPlugin(toolUses, {
        turnExpansions: pluginExpansions,
        sessionExpansions: this.sessionPluginExpansions,
        activePluginIds: scope.activePluginIds,
        availablePluginIds: this.filterAllowedPluginIds(
          (this.deps.pluginRuntime?.listPluginIds() ?? [])
            // A registry-DISABLED plugin is normally excluded, but a
            // session-scoped allow-list (routine `allowedPluginIds`) may
            // on-demand activate it for THIS session. Main chat has
            // `allowedPluginIds === undefined`, so the right-hand side is
            // always false and disabled plugins stay excluded (unchanged).
            .filter((pluginId) =>
              this.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false ||
              this.deps.allowedPluginIds?.has(pluginId) === true),
        ),
        sessionActivatedPluginIds: this.sessionActivatedPluginIds,
        isPluginEnabled: (pluginId) =>
          this.deps.pluginRuntime?.isPluginEnabled?.(pluginId) !== false,
      });
      pluginExpansions = pluginOutcome.nextTurnExpansions;
      this.sessionPluginExpansions = pluginOutcome.nextSessionExpansions;

      // Audit each NEW session-scoped activation of a registry-DISABLED plugin.
      // This path never persists enabled state (setPluginEnabled is not called),
      // so the audit trail is the only durable record that a disabled plugin was
      // exposed for the session — valuable for the permission/scope review.
      for (const activated of this.sessionActivatedPluginIds) {
        if (!sessionActivatedBefore.has(activated)) {
          // Mirror into PluginRuntime so Gate 4 (plugin-runtime-delegate) allows
          // this plugin's tool calls for the remainder of the session. This is
          // the ONLY way a registry-disabled plugin's tools become executable —
          // setPluginEnabled is deliberately NOT called (non-persistence invariant).
          this.deps.pluginRuntime?.setSessionActivated?.(activated);
          this.auditLogger.log({
            timestamp: new Date().toISOString(),
            sessionId: this.sessionId,
            type: "info",
            input: `session_activated_disabled_plugin pluginId=${activated} (non-persistent; registry stays enabled:false)`,
          });
        }
      }

      // 활성화 성공했으면 tool schema 재빌드 + 추가된 tool 수 보고
      const rebuiltAfterPlugin = pluginOutcome.activatedPluginIds.length > 0;
      if (rebuiltAfterPlugin) {
        scope.deferral = this.shouldDeferToolSchemas(scope.activePluginIds);
        toolSchemas = rebuildTurnToolSchemas();
      }
      const catalogCountAfterPlugin = this.deps.toolRegistry.getToolCatalogForScope(scope).length;
      for (const rr of pluginOutcome.results) {
        // #1176 — in eager mode the activated plugin's full tool suite is
        // already loaded, so there is nothing to discover; tell the model it is
        // ready instead of pointing it at tool_search. Deferred mode keeps the
        // catalog-search guidance.
        const finalContent = !rr.is_error && rebuiltAfterPlugin
          ? scope.deferral
            ? t("be_conversationLoop.pluginToolsDeferred", { content: rr.content, catalogCount: catalogCountAfterPlugin, loadedCount: toolSchemas.length })
            : t("be_conversationLoop.pluginToolsEager", { content: rr.content, loadedCount: toolSchemas.length })
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

      // Tool-Level Deferral — tool_search 가로채기. request_plugin 과 동일
      // 패턴: catalog 매치 → activeToolNames promote → schema rebuild →
      // tool_result 합성 (tool-pair invariant) + round 예산 환불.
      let toolUsesForExecutor: ToolUseBlock[] = pluginOutcome.remaining;
      let searchPromotedThisRound = false;
      const prevToolCountForSearch = toolSchemas.length;
      const searchOutcome = handleToolSearch(pluginOutcome.remaining, {
        turnSearches: toolSearches,
        sessionSearches: this.sessionToolSearches,
        activeToolNames: scope.activeToolNames,
        loadedToolNames: new Set(toolSchemas.map((tool) => tool.name)),
        loadedTools: toolSchemas.map((tool) => ({
          name: tool.name,
          description: tool.description,
        })),
        catalog: this.deps.toolRegistry.getToolCatalogForScope(scope),
      });
      toolSearches = searchOutcome.nextTurnSearches;
      this.sessionToolSearches = searchOutcome.nextSessionSearches;
      toolUsesForExecutor = searchOutcome.remaining;
      searchPromotedThisRound = searchOutcome.promotedToolNames.length > 0;
      promotedToolNamesForTurn.push(...searchOutcome.promotedToolNames);

      const rebuiltAfterSearch = searchOutcome.promotedToolNames.length > 0;
      if (rebuiltAfterSearch) {
        toolSchemas = rebuildTurnToolSchemas();
      }
      const addedBySearch = Math.max(0, toolSchemas.length - prevToolCountForSearch);
      for (const rr of searchOutcome.results) {
        const finalContent = !rr.is_error && rebuiltAfterSearch
          ? t("be_conversationLoop.searchToolLoaded", { content: rr.content, loadedCount: toolSchemas.length, added: addedBySearch })
          : rr.content;
        this.history.append({
          role: "tool_result",
          toolUseId: rr.tool_use_id,
          toolName: TOOL_SEARCH_TOOL,
          content: finalContent,
          ...(rr.is_error && { isError: true }),
        });
      }
      for (const promoted of searchOutcome.promotedToolNames) {
        allToolCalls.push({
          name: TOOL_SEARCH_TOOL,
          input: { promoted },
          result: `loaded:${promoted}`,
        });
      }

      // meta-tool (request_plugin / tool_search) 만 있으면 다음 round 로 —
      // 성공 시 round 예산 돌려받기 (C9). 둘 중 하나라도 promote 했으면 환불.
      if (toolUsesForExecutor.length === 0) {
        const promotedSomething =
          pluginOutcome.activatedPluginIds.length > 0 || searchPromotedThisRound;
        if (promotedSomething) round--;
        continue;
      }

      // §11 knowledge depth cap
      const capResult = applyKnowledgeDepthCap(toolUsesForExecutor, knowledgeCallCount);
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
          callbacks: {
            onToolStart: (name, input, meta) => {
              toolMetaByUseId.set(meta.toolUseId, meta);
              callbacks?.onToolStart?.(name, input, meta);
            },
            onPermissionReview: callbacks?.onPermissionReview,
            onToolEnd: (name, result, isError, meta, uiPayload, durationMs) => {
              toolMetaByUseId.set(meta.toolUseId, meta);
              callbacks?.onToolEnd?.(name, result, isError, meta, uiPayload, durationMs);
            },
          },
          // C3(c): sub-agents pass their childSessionId so audit attribution
          // for tool calls flows to the child, not the parent. Falls back to
          // this loop's sessionId for normal interactive turns.
          sessionId: bounds?.sessionIdOverride ?? this.sessionId,
          // Forward the turn's overlay trigger origin so write/shell/network tools
          // bypass `allow-always` cache and force a user-confirmation
          // modal — the hard gate for the overlay trigger's propose-only contract.
          overlayTriggerOrigin: overlayTriggerOrigin ?? null,
          // C3(b): carry spawn depth into ToolExecutionContext.metadata.
          // The executor uses this to refuse `agent_spawn` calls inside an
          // already-spawned sub-agent (depth >= 1).
          spawnDepth: bounds?.spawnDepth,
          // Threading the turn's abort signal lets long-blocking tools
          // (`ask_user_question`) honor the user's 중단 button instead of
          // hanging until their internal timeout.
          abortSignal,
          toolResultChunkReader: (toolUseId) => this.readToolResultForChunk(toolUseId),
          permissionContext: {
            headless: this.deps.headless,
            allowedPluginIds: new Set(scope.activePluginIds),
            additionalDirectories: this.getTurnAdditionalDirectories(),
            getAdditionalDirectories: () => this.getTurnAdditionalDirectories(),
            trustOrigin: toolTrustOrigin,
            ...(bounds.permissionUserIntent ? { userIntent: bounds.permissionUserIntent } : {}),
            ...(bounds.permissionExplicitAuthorizationIntent
              ? { explicitAuthorizationIntent: bounds.permissionExplicitAuthorizationIntent }
              : {}),
            onTurnDirectoryGrant: (path) => this.addTurnAdditionalDirectory(path),
            onSessionDirectoryGrant: (path) => this.addSessionAdditionalDirectory(path),
          },
        },
      );
      toolTrustOrigin = nextToolTrustOrigin(toolTrustOrigin, capResult.allowed, toolResults);

      for (let i = 0; i < capResult.allowed.length; i++) {
        allToolCalls.push({
          name: capResult.allowed[i].name,
          input: capResult.allowed[i].input,
          result: toolResults[i]?.content ?? "(missing)",
        });
      }
      for (const blocked of capResult.blocked) {
        const origTool = toolUsesForExecutor.find((tu) => tu.id === blocked.tool_use_id);
        if (origTool) {
          allToolCalls.push({ name: origTool.name, input: origTool.input, result: blocked.content });
        }
      }

      // tool_result 히스토리 append → loop back
      const allResults = [...toolResults, ...capResult.blocked];
      for (const tr of allResults) {
        const meta = toolMetaByUseId.get(tr.tool_use_id);
        const toolDisplay = "durationMs" in tr
          ? {
              durationMs: tr.durationMs,
              ...(meta?.source ? { source: meta.source } : {}),
              ...(meta?.category ? { category: meta.category } : {}),
              ...(meta?.pluginId ? { pluginId: meta.pluginId } : {}),
              ...(meta?.mcpServerId ? { mcpServerId: meta.mcpServerId } : {}),
              ...("uiPayload" in tr && tr.uiPayload ? { uiPayload: tr.uiPayload } : {}),
            }
          : undefined;
        this.history.append({
          role: "tool_result",
          toolUseId: tr.tool_use_id,
          toolName: toolUsesForExecutor.find((tu) => tu.id === tr.tool_use_id)?.name,
          content: tr.content,
          ...(tr.is_error && { isError: true }),
          ...(toolDisplay ? { meta: { toolDisplay } } : {}),
        });
      }
      if (abortSignal?.aborted) {
        log.info(
          `queryLoop: EARLY-EXIT(tool-abort) — round=${roundIndex} toolResults=${allResults.length}`,
        );
        const savedText = t("be_conversationLoop.interruptedText");
        this.history.append({ role: "assistant", content: savedText });
        callbacks?.onTextDelta?.(t("be_conversationLoop.interruptedSuffix"));
        return withServingIdentity({
          text: savedText,
          toolCalls: allToolCalls,
          usage: turnUsage,
          stopReason: "interrupted",
        });
      }
      // Intra-turn micro-compact — mark older tool_results stale before the
      // next round assembles its request (`messagesForRound`), so the next
      // provider send stubs them on the wire. Mirrors the sub-agent fallback
      // mark (clear()/restore() atomic swap). Gated on the already-computed
      // per-round projection to skip short turns; the threshold SOT is
      // getModelPreflightThreshold so no literal is introduced.
      const microCompactFloor = Math.floor(
        getModelPreflightThreshold(llmSettings.provider, model) * MICRO_COMPACT_FLOOR_FACTOR,
      );
      if (
        microCompactFloor > 0 &&
        (this.lastRoundInputProjection?.totalTokens ?? 0) >= microCompactFloor
      ) {
        const { messages: afterMark, result: mr } = markStaleToolResults(
          this.history.getMessages(),
          { preserveRecentToolResults: INTRA_TURN_PRESERVE_RECENT_RESULTS },
        );
        if (mr.marked) {
          this.history.clear();
          this.history.restore(afterMark);
          if (process.env.NODE_ENV !== "production") {
            log.info(
              `mark-stale (intra-turn): marked ${mr.markedCount} tool_results, ~${mr.freedCharsOnSerialize} chars saved on serialize`,
            );
          }
        }
      }
      if (capResult.allowed.some((tu) => tu.name === "skill_load")) {
        systemPrompt = this.buildSystemPromptForScope(
          scope,
          overlayTriggerOrigin,
          bounds.rolePrompt,
          bounds.sessionIdOverride ?? this.sessionId,
        );
      }
    }

    return withServingIdentity({ text: t("be_conversationLoop.toolRoundLimitExceeded"), toolCalls: allToolCalls, usage: turnUsage });
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

  private buildToolExposureMetrics(
    scope: ToolScope,
    toolSchemas: ToolSchema[],
    projection: RequestInputProjection | null,
    promotedToolNames: readonly string[] = [],
  ): ToolExposureMetrics {
    const loadedEntries = this.deps.toolRegistry.getToolSchemasForScope(scope);
    const catalogEntries = this.deps.toolRegistry.getToolCatalogForScope(scope);
    const loadedToolSourceCounts = emptyToolSourceCounts();
    for (const entry of loadedEntries) incrementToolSourceCounts(loadedToolSourceCounts, entry.source);
    const deferredCatalogSourceCounts = { plugin: 0, mcp: 0 };
    for (const entry of catalogEntries) {
      if (entry.source === "plugin") deferredCatalogSourceCounts.plugin += 1;
      if (entry.source === "mcp") deferredCatalogSourceCounts.mcp += 1;
    }
    // Deferral effectiveness — only plugin/MCP tools are deferral-eligible;
    // builtins always load so they must not enter the ratio. The denominator
    // is the full deferral-eligible universe (loaded + still-deferred).
    const deferralEligibleLoadedCount = loadedToolSourceCounts.plugin + loadedToolSourceCounts.mcp;
    const deferralEligibleTotal = deferralEligibleLoadedCount + catalogEntries.length;
    const deferredLoadedRatio =
      deferralEligibleTotal > 0 ? catalogEntries.length / deferralEligibleTotal : null;
    return {
      loadedToolCount: toolSchemas.length,
      loadedToolSourceCounts,
      deferredCatalogCount: catalogEntries.length,
      deferredCatalogSourceCounts,
      promotedToolNames: [...new Set(promotedToolNames)],
      loadedPluginIds: uniqueDefined(loadedEntries.map((entry) => entry.pluginId)),
      loadedMcpServerIds: uniqueDefined(loadedEntries.map((entry) => entry.mcpServerId)),
      deferredPluginIds: uniqueDefined(catalogEntries.map((entry) => entry.pluginId)),
      deferredMcpServerIds: uniqueDefined(catalogEntries.map((entry) => entry.mcpServerId)),
      toolSchemaTokens: projection?.toolSchemaTokens
        ?? estimateTokens(JSON.stringify({ tools: toolSchemas })),
      projectedRequestInputTokens: projection?.totalTokens ?? null,
      deferralEligibleLoadedCount,
      deferredLoadedRatio,
    };
  }

  private buildProviderRequestDiagnostics(params: {
    round: number;
    assistantRoundIndex: number;
    inputOrigin: ChatInputOrigin;
    configuredProvider: LLMVendor;
    model: string;
    systemPrompt: string;
    messages: GenericMessage[];
    toolSchemas: ToolSchema[];
    activePluginIds: string[];
    projection: RequestInputProjection;
    toolExposure: ToolExposureMetrics;
  }): ProviderRequestDiagnostics {
    const messageRoleCounts: Record<GenericMessage["role"], number> = {
      user: 0,
      assistant: 0,
      tool_result: 0,
    };
    let toolResultChars = 0;
    let compactedToolResultCount = 0;
    let truncatedToolResultCount = 0;
    let serializedStubToolResultCount = 0;
    let assistantToolCallCount = 0;
    const toolResultMessages: GenericMessage[] = [];

    for (const message of params.messages) {
      messageRoleCounts[message.role] += 1;
      if (message.role === "assistant") {
        assistantToolCallCount += message.toolCalls?.length ?? 0;
      }
      if (message.role === "tool_result") {
        toolResultMessages.push(message);
        toolResultChars += message.content.length;
        if (message.meta?.compactedAt !== undefined) compactedToolResultCount += 1;
        if (message.meta?.truncated !== undefined) truncatedToolResultCount += 1;
        if (message.meta?.serializedStub === true) serializedStubToolResultCount += 1;
      }
    }

    const loadedToolNames = params.toolSchemas.map((schema) => schema.name);
    const visibleLoadedToolNames = loadedToolNames.slice(0, 40);
    return {
      sessionId: this.sessionId,
      round: params.round,
      assistantRoundIndex: params.assistantRoundIndex,
      inputOrigin: params.inputOrigin,
      configuredProvider: params.configuredProvider,
      model: params.model,
      preflightThresholdTokens: getModelPreflightThreshold(
        params.configuredProvider,
        params.model,
      ),
      promptChars: params.systemPrompt.length,
      messageCount: params.messages.length,
      messageRoleCounts,
      projection: params.projection,
      toolResultCount: toolResultMessages.length,
      toolResultChars,
      toolResultTokens: estimateMessagesTokens(toolResultMessages),
      compactedToolResultCount,
      truncatedToolResultCount,
      serializedStubToolResultCount,
      assistantToolCallCount,
      loadedToolNames: visibleLoadedToolNames,
      loadedToolNamesTruncated: Math.max(0, loadedToolNames.length - visibleLoadedToolNames.length),
      activePluginIds: params.activePluginIds,
      toolExposure: params.toolExposure,
    };
  }

  private nextCarryForwardToolNames(
    scope: ToolScope,
    toolCalls: Array<{ name: string }>,
  ): Set<string> {
    const inScopeToolNames = this.scopedToolNameSet(scope.activePluginIds);
    const next = new Set<string>();

    for (const name of scope.preloadedToolNames) {
      if (inScopeToolNames.has(name)) next.add(name);
    }
    for (const name of scope.forcedToolNames) {
      if (inScopeToolNames.has(name)) next.add(name);
    }
    for (const call of toolCalls) {
      if (inScopeToolNames.has(call.name)) next.add(call.name);
    }

    return next;
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
  private async applyBoundaryToSession(
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
    // CONTENT_TRUNCATED 경로 — LLM summary boundary 는 없지만 reload/branch
    // parity 를 위해 lightweight checkpoint carrier 를 삽입한다. Truncation 은
    // 메시지를 stub 으로 대체하지 않고 in-place clip 이므로 boundary preamble
    // 변경 불필요. 그러나 chain consistency 위해 compactNum 은 bump (M-Critic-2).
    // cacheReadTokens/cacheWriteTokens 는 보존 — boundary 가 없으므로 provider
    // cache prefix 가 여전히 유효 (M-Critic-4 fix). reset 하면 다음 turn 의
    // 빌링이 부풀려진다.
    if (result.boundary === null) {
      this.compactNum += 1;
      let truncated = contentTruncatedHistoryWithContextCarrier({
        messages: result.newHistory,
        compactNum: this.compactNum,
        trigger,
        removedCount: result.removedCount,
        estimatedAfter: result.estimatedAfter,
        freedTokens: Math.max(0, estimatedBefore - result.estimatedAfter),
        ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
      });
      this.history.clear();
      this.history.restore(truncated.history);
      const contextTokensAfter = projectionContext.estimateCurrent().totalTokens;
      const freedTokens = Math.max(0, estimatedBefore - contextTokensAfter);
      truncated = contentTruncatedHistoryWithContextCarrier({
        messages: result.newHistory,
        compactNum: this.compactNum,
        trigger,
        removedCount: result.removedCount,
        freedTokens,
        estimatedAfter: contextTokensAfter,
        ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
      });
      try {
        await this.deps.memoryManager.saveCheckpointSnapshot(
          this.sessionId,
          this.compactNum,
          messagesBefore,
        );
        const llmSettings = this.deps.settingsService.get("llm");
        const provider = llmSettings.provider;
        const model = llmSettings.vendors[provider].model;
        const usable = getModelUsableContext(provider, model);
        const ctxUsageAtTrigger = usable > 0 ? Math.min(1.0, estimatedBefore / usable) : 0;
        const checkpointEntry: import("../memory/memory-manager.js").Checkpoint = {
          id: crypto.randomUUID(),
          triggeredAt: truncated.createdAt,
          trigger,
          ctxUsageAtTrigger,
          summary: t("be_conversationLoop.contentTruncatedSummary", { count: result.removedCount }),
          messageCountAtTrigger: prevMessageCount,
          compactNum: this.compactNum,
        };
        const existingMeta = this.deps.memoryManager.loadSessionMetadata(this.sessionId) ?? {};
        const updatedMeta = this.deps.memoryManager.appendCheckpoint(existingMeta, checkpointEntry);
        await this.deps.memoryManager.saveSessionMetadata(this.sessionId, updatedMeta);
      } catch (storageErr) {
        log.warn(`applyBoundaryToSession: content-truncated checkpoint persist failed — ${(storageErr as Error).message}`);
      }
      this.history.clear();
      this.history.restore(truncated.history);
      this.cumulativeUsage = {
        ...this.cumulativeUsage,
        inputTokens: truncated.contextTokensAfter,
      };
      this.lastContextInputTokens = truncated.contextTokensAfter;
      this.lastContextInputProjectionTokens = truncated.contextTokensAfter;
      callbacks?.onCompactOccurred?.({
        removedMessages: result.removedCount,
        freedTokens,
        trigger,
        compactNum: this.compactNum,
        summary: t("be_conversationLoop.contentTruncatedSummary", { count: result.removedCount }),
        estimatedAfter: truncated.contextTokensAfter,
        compactStatus: result.status,
        ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
      });
      return;
    }

    this.compactNum = result.boundary.compactNum;

    // Persist pre-compact history so branchFromCheckpoint can replay. saveCheckpointSnapshot
    // owns JSONL stubbing and file-backed artifacts for oversized tool results.
    // Failure is non-fatal — warn and continue; branch-from-checkpoint will surface the
    // "no snapshot found" error at use-time rather than silently corrupting a compact.
    try {
      await this.deps.memoryManager.saveCheckpointSnapshot(
        this.sessionId,
        this.compactNum,
        messagesBefore,
      );
    } catch (snapshotErr) {
      log.warn(`applyBoundaryToSession: saveCheckpointSnapshot failed — ${(snapshotErr as Error).message}`);
    }

    const preamble = renderBoundaryAsPreamble(result.boundary);
    let compactedHistory = compactedHistoryWithContextCarrier(result.newHistory, result.estimatedAfter);
    this.history.clear();
    this.history.restore(compactedHistory);
    this.deps.systemPromptBuilder.setSummaryPreamble?.(preamble);
    const contextTokensAfter = projectionContext.estimateCurrent().totalTokens;
    compactedHistory = compactedHistoryWithContextCarrier(result.newHistory, contextTokensAfter);
    this.history.clear();
    this.history.restore(compactedHistory);
    this.cumulativeUsage = {
      inputTokens: contextTokensAfter,
      outputTokens: this.cumulativeUsage.outputTokens,
      ...(this.cumulativeUsage.cacheReadTokens !== undefined && { cacheReadTokens: 0 }),
      ...(this.cumulativeUsage.cacheWriteTokens !== undefined && { cacheWriteTokens: 0 }),
    };
    this.lastContextInputTokens = contextTokensAfter;
    this.lastContextInputProjectionTokens = contextTokensAfter;

    // Same-session checkpoint chain.
    // ctxUsageAtTrigger 분모는 *usable context window* (LVIS reservation 적용).
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
      log.warn(`applyBoundaryToSession: checkpoint persist failed — ${(storageErr as Error).message}`);
    }

    callbacks?.onCompactOccurred?.({
      removedMessages: result.removedCount,
      freedTokens: Math.max(0, estimatedBefore - contextTokensAfter),
      estimatedAfter: contextTokensAfter,
      trigger,
      summary: preamble,
      compactNum: this.compactNum,
      compactStatus: result.status,
      ...(result.truncatedDir !== undefined ? { truncatedDir: result.truncatedDir } : {}),
    });
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
  private async runPreflightGuard(
    projectionContext: RequestProjectionContext,
    abortSignal?: AbortSignal,
    callbacks?: TurnCallbacks,
    options?: PreflightGuardOptions,
  ): Promise<boolean> {
    // Issue #910 follow-up — prior turn ended with context_error / stream_error
    // and the user-facing message promised auto-compact on the next send.
    // Force-trigger compact regardless of threshold + autoCompact setting:
    // the host's promise overrides the user's compact-off preference for this
    // single recovery cycle (otherwise the conversation is unrecoverable
    // without manual /compact). Flag clears in `finally` so every path
    // (success / NOOP / throw) keeps the "single cycle = single clear"
    // invariant.
    //
    // DoS guard (round-4 security MED): if the same session has already
    // burned through MAX_FORCE_RECOVER_PER_SESSION recovery attempts without
    // the user being able to make progress, stop force-triggering — the
    // failure is structural (compact cannot reduce, or input pattern keeps
    // hitting the limit) and further attempts just multiply API cost.
    const overRecoveryBudget = this.contextErrorRecoveryCount >= MAX_FORCE_RECOVER_PER_SESSION;
    const forceRecover = this.contextErrorPending && !overRecoveryBudget;
    const forceRateLimit = options?.forceReason === "rate-limit";
    if (this.contextErrorPending && overRecoveryBudget) {
      log.warn(
        `preflight: force-recover BUDGET EXHAUSTED (count=${this.contextErrorRecoveryCount}/${MAX_FORCE_RECOVER_PER_SESSION}) — blocking all compact API calls`,
      );
      // Issue #917: budget 소진은 compact 가 context 를 줄이지 못하는 구조적
      // 실패이므로 이후 API 호출을 완전 차단한다 (force + normal 모두). 이전
      // 코드는 normal threshold gate 로 fallthrough 해서 여전히 compactWithBoundary
      // 를 호출했는데 이는 DoS hard-cap 을 무력화하는 갭.
      this.contextErrorPending = false;
      this.recoveryExhausted = true;
      callbacks?.onRecoveryExhausted?.();
      return false;
    }
    // Budget 소진 상태면 compact 완전 차단 (re-arm 은 정상 turn 완료 후 reset).
    if (this.recoveryExhausted) {
      log.warn("preflight: recoveryExhausted — all compact API calls blocked until normal turn completes");
      return false;
    }
    if (!forceRecover && !forceRateLimit && !this.isAutoCompactEnabled()) {
      log.debug("runPreflightGuard: skipped (autoCompact 설정 OFF)");
      return false;
    }
    if (this.isCompacting) {
      log.info("preflight: SKIPPED — isCompacting lock held (concurrent turn race avoided)");
      return false;
    }
    if (!this.provider) return false;

    const llmSettings = this.deps.settingsService.get("llm");
    const provider = llmSettings.provider;
    const model = llmSettings.vendors[provider].model;
    const preflight = getModelPreflightThreshold(provider, model);
    if (!forceRecover && !forceRateLimit && preflight <= 0) return false;

    const messagesBefore = this.history.getMessages();
    const requestProjection = estimateRequestInputProjection({
      systemPrompt: projectionContext.systemPrompt,
      messages: messagesBefore,
      toolSchemas: projectionContext.toolSchemas,
    });
    const estimated = requestProjection.totalTokens;
    // Two-signal preflight: local request projection can drift from provider
    // tokenization. Pair it with the latest provider-calibrated context-fill
    // SOT. Do not use cumulativeUsage here: session billing sums grow every
    // turn and are not a context-window fill metric.
    const pendingInputDelta = this.lastContextInputProjectionTokens > 0
      ? Math.max(0, estimated - this.lastContextInputProjectionTokens)
      : 0;
    const contextTokensIn = this.lastContextInputTokens > 0
      ? this.lastContextInputTokens + pendingInputDelta
      : estimated;
    if (!forceRecover && !forceRateLimit && estimated < preflight && contextTokensIn < preflight) return false;
    const triggerSource: Exclude<CompactTriggerSource, "manual"> = forceRecover
      ? "force-recover"
      : forceRateLimit
        ? "rate-limit"
        : estimated >= preflight
          ? "estimate"
          : "context-tokens";

    this.isCompacting = true;
    // Notify renderer immediately so it can show a "자동 압축 중..." indicator
    // before the blocking LLM compaction call. `onCompactOccurred` fires on
    // completion; this fires at start so there is no silent wait.
    callbacks?.onCompactStarted?.({
      triggerSource,
      estimatedBefore: estimated,
      preflight,
    });
    try {
      log.info(
        `preflight: TRIGGER — source=${triggerSource} estimated=${estimated} contextTokensIn=${contextTokensIn} preflight=${preflight} (model=${provider}/${model}) → LLM compact #${this.compactNum + 1}`,
      );
      // Adaptive token-budget preserve — usagePct 가 높을수록 줄인다. 별도 invariant 로
      // compactWithBoundary 가 최근 5 user turn (+ 현재 pending user question)
      // 을 verbatim 보존한다.
      //
      // forceRecover (context_error pending) 및 rate-limit 복구도 동일하게
      // preserve=0 — provider 가
      // 직접 거부한 상황이므로 보수적 preserve 가 의미 없음. 약속한 compact
      // 를 가장 공격적으로 수행하는 게 사용자 약속 정합.
      const preflightPressure = Math.max(estimated, contextTokensIn);
      const usagePct = preflight > 0 ? preflightPressure / preflight : 0;
      const basePreserveRecentTokens = forceRecover || forceRateLimit || usagePct >= 1.0
        ? 0
        : usagePct >= 0.8
          ? Math.max(1_000, Math.floor(preflight * 0.2))
          : Math.max(1_000, Math.floor(preflight * 0.4));
      const latestMessage = messagesBefore.at(-1);
      const currentUserPreserveTokens = latestMessage?.role === "user"
        ? Math.max(1, estimateMessagesTokens([latestMessage]))
        : 0;
      // Step 5 appends the current user turn before preflight runs. Even in
      // red-zone / force-recover compaction, that just-entered user message is
      // part of the visible transcript contract and must survive as verbatim
      // context; otherwise the UI can show an assistant answer with no question.
      const preserveRecentTokens = Math.max(basePreserveRecentTokens, currentUserPreserveTokens);
      // ── #811 m2: PreCompact (NON-BLOCKING) ──
      // Fired right before the blocking LLM compaction. OBSERVE-ONLY — the
      // dispatch result is discarded; a hook can never veto compaction.
      // Payload: reason (auto-compact threshold here) + tokenEstimate.
      await this.fireLifecycleEvent("PreCompact", {
        reason: "auto-compact",
        tokenEstimate: estimated,
      });
      const messagesBeforeCount = messagesBefore.length;
      const tokensBefore = estimated;
      const compactResult = await compactWithBoundary({
        messages: messagesBefore,
        llm: this.provider,
        model,
        preserveRecentTokens,
        preserveRecentTurns: DEFAULT_PRESERVE_RECENT_TURNS,
        compactNum: this.compactNum + 1,
        sessionId: this.sessionId,
        preflightTokens: preflight,
        ...(abortSignal !== undefined && { abortSignal }),
      });

      if (compactResult.status === CompressionStatus.NOOP) {
        log.info("preflight: LLM compact returned NOOP (history within preserveRecentTokens) — no mutation");
        this.lastContextInputTokens = contextTokensIn;
        this.lastContextInputProjectionTokens = estimated;
        // NOOP ⇒ no compaction applied ⇒ no PostCompact (mirrors onCompactOccurred,
        // which only emits when applyBoundaryToSession runs).
        return false;
      }

      // 다음 prompt assembly 가 새 boundary 를 read 해야 함.
      // onCompactOccurred (compactNum 포함) 은 applyBoundaryToSession 안에서 단일 emit.
      // 여기서 두 번째 emit 을 제거해 CheckpointDivider 중복 방지.
      await this.applyBoundaryToSession(
        compactResult,
        "auto-compact",
        estimated,
        callbacks,
        messagesBefore.length,
        messagesBefore,
        projectionContext,
      );

      log.info(
        `preflight: APPLIED — removed=${compactResult.removedCount} estimatedAfter=${compactResult.estimatedAfter} compactNum=${this.compactNum}`,
      );
      // ── #811 m2: PostCompact (NON-BLOCKING) ──
      // Fired AFTER auto-compact applied. OBSERVE-ONLY. Payload: before/after
      // message + token counts. After-counts are read post-mutation.
      await this.fireLifecycleEvent("PostCompact", {
        messagesBefore: messagesBeforeCount,
        messagesAfter: this.history.getMessages().length,
        tokensBefore,
        tokensAfter: this.lastContextInputTokens,
      });
      return true;
    } catch (err) {
      // LLM compact 실패 시 turn 자체는 계속 진행 — compact 미적용 history 로 stream attempt.
      // context_error 도달 시 stream-collector 의 safety net 이 사용자 안내 처리.
      log.warn(`preflight: LLM compact failed — ${(err as Error).message}. context_error safety net 으로 위임.`);
      return false;
    } finally {
      this.isCompacting = false;
      // Single-cycle invariant — every force-recover attempt (success /
      // NOOP / throw) clears the flag and bumps the recovery counter.
      // Without this in `finally`, a `compactWithBoundary` throw would
      // leave the flag set and the next turn would force-recover again
      // → indistinguishable from infinite retry (round-4 architect MAJOR).
      if (forceRecover) {
        this.contextErrorPending = false;
        this.contextErrorRecoveryCount += 1;
      }
    }
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
  private resolveToolScope(input: string): ToolScope {
    const matched = this.deps.keywordEngine.matchAllPluginIds(input);
    const resetCarryForward = isBuiltinToolInventoryQuestion(input);
    const activePluginIds = new Set(matched.size > 0
      ? matched
      : (resetCarryForward ? new Set<string>() : (this.lastTurnScope ?? new Set<string>())));
    for (const pluginId of this.deps.forcedActivePluginIds ?? []) {
      activePluginIds.add(pluginId);
    }
    const allowed = this.deps.allowedPluginIds;
    if (allowed) {
      const effectiveAllowed = new Set(allowed);
      for (const pluginId of this.deps.forcedActivePluginIds ?? []) {
        effectiveAllowed.add(pluginId);
      }
      for (const pluginId of [...activePluginIds]) {
        if (!effectiveAllowed.has(pluginId)) activePluginIds.delete(pluginId);
      }
    }

    // #1176 active/inactive — a plugin toggled inactive stays loaded but its
    // tools are hidden from the model. Drop inactive plugins from scope here so
    // their tools vanish next turn with no runtime reload. `enabled !== false`
    // is the active predicate (undefined → active, migration-safe).
    const pluginRuntime = this.deps.pluginRuntime;
    if (pluginRuntime?.isPluginEnabled) {
      for (const pluginId of [...activePluginIds]) {
        // Session-scoped on-demand activation — a disabled plugin that this
        // session activated via request_plugin keeps its tools in scope for
        // the session lifetime (its tools are already in getVisibleTools).
        // The registry stays `enabled:false`; this is NON-PERSISTENT.
        if (
          !pluginRuntime.isPluginEnabled(pluginId) &&
          !this.sessionActivatedPluginIds.has(pluginId)
        ) {
          activePluginIds.delete(pluginId);
        }
      }
    }

    // #1176 deferral gate — eligible tools are active-plugin + in-scope MCP
    // tools only (builtins/meta-tools are always eager and never counted).
    // Below the ceiling the turn exposes every eligible tool's full schema so
    // the model needs zero `tool_search` discovery rounds; at/above it the turn
    // falls back to deferral so a very large surface does not flood context.
    const deferral = this.shouldDeferToolSchemas(activePluginIds);

    // (B) keyword→tool preload ∪ carried-forward loaded tools ∪ explicit
    // fixed-surface allowlist. Keyword/carry-forward entries are restricted to
    // tools whose owning plugin is in scope, so a keyword can never load a tool
    // the plugin-scope path would have hidden.
    const activeToolNames = new Set<string>();
    const preloadedToolNames = new Set<string>();
    const forcedToolNames = new Set<string>();
    const inScopeToolNames = this.scopedToolNameSet(activePluginIds);
    const preloaded = this.deps.keywordEngine.matchToolNames(
      input,
      (name) => inScopeToolNames.has(name),
    );
    for (const name of preloaded) {
      activeToolNames.add(name);
      preloadedToolNames.add(name);
    }
    for (const name of resetCarryForward ? [] : (this.lastTurnToolNames ?? [])) {
      if (inScopeToolNames.has(name)) activeToolNames.add(name);
    }
    const registeredToolNames = new Set(this.deps.toolRegistry.getVisibleTools().map((tool) => tool.name));
    for (const name of this.deps.forcedActiveToolNames ?? []) {
      if (registeredToolNames.has(name)) {
        activeToolNames.add(name);
        forcedToolNames.add(name);
      }
    }

    return {
      activePluginIds,
      activeToolNames,
      preloadedToolNames,
      forcedToolNames,
      includeBuiltins: true,
      includeMcp: this.deps.headless !== true,
      deferral,
    };
  }

  /**
   * Tool-Level Deferral — names of plugin/MCP tools that are *in scope* this
   * turn (owning plugin active, or MCP included). Builtins/meta-tools are
   * excluded — they are never deferred. Used as the `isToolName` resolver for
   * keyword preload and to clamp carried-forward loaded tools to current scope.
   */
  private scopedToolNameSet(activePluginIds: Set<string>): Set<string> {
    const includeMcp = this.deps.headless !== true;
    const names = new Set<string>();
    for (const tool of this.deps.toolRegistry.getVisibleTools()) {
      if (tool.source === "plugin") {
        if (tool.pluginId && activePluginIds.has(tool.pluginId)) names.add(tool.name);
      } else if (tool.source === "mcp" && includeMcp) {
        names.add(tool.name);
      }
    }
    return names;
  }

  private shouldDeferToolSchemas(activePluginIds: Set<string>): boolean {
    return this.scopedToolNameSet(activePluginIds).size >= EAGER_TOOL_EXPOSURE_CEILING;
  }

  private filterAllowedPluginIds(pluginIds: string[]): string[] {
    const allowed = this.deps.allowedPluginIds;
    if (!allowed) return pluginIds;
    const effectiveAllowed = new Set(allowed);
    for (const pluginId of this.deps.forcedActivePluginIds ?? []) {
      effectiveAllowed.add(pluginId);
    }
    return pluginIds.filter((id) => effectiveAllowed.has(id));
  }

  // ─── Private: Command Handler ─────────────────────

  private async handleCommand(
    command: string,
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<TurnResult> {
    if (!isUserKeyboardOrigin(inputOrigin)) {
      const result = t("be_conversationLoop.nonKeyboardSlashCommandBlocked");
      callbacks?.onTextDelta?.(result);
      callbacks?.onTurnComplete?.(result);
      return { text: result, toolCalls: [], route: "command" };
    }
    let result: string;

    switch (command) {
      case "new":
        this.newConversation();
        result = t("be_conversationLoop.cmdNewConversation");
        break;
      case "remember": {
        if (!args.trim()) { result = t("be_conversationLoop.cmdRememberUsage"); break; }
        const title = args.slice(0, 40).replace(/\n/g, " ");
        await this.deps.memoryManager.saveMemory(title, args);
        result = t("be_conversationLoop.cmdRememberSaved", { title });
        break;
      }
      case "memory": {
        const memories = this.deps.memoryManager.listMemoryEntries();
        result = memories.length === 0
          ? t("be_conversationLoop.cmdMemoryEmpty")
          : memories.map((n) => `- ${n.title} (${n.filename})`).join("\n");
        break;
      }
      case "sessions": {
        const sessions = this.listSessions(10);
        if (sessions.length === 0) { result = t("be_conversationLoop.cmdSessionsEmpty"); break; }
        const current = this.sessionId;
        const sessionListLines = sessions.slice(0, 10).map((s) => {
          const marker = s.id === current ? t("be_conversationLoop.cmdSessionMarkerCurrent") : "";
          const date = s.modifiedAt.toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
          return `- ${s.id.slice(0, 8)}… (${date})${marker}`;
        }).join("\n");
        result = t("be_conversationLoop.cmdSessionsList", { max: 10, list: sessionListLines });
        break;
      }
      case "load": {
        if (!args.trim()) { result = t("be_conversationLoop.cmdLoadUsage"); break; }
        const targetId = args.trim();
        // 부분 ID 매칭
        const sessions = this.listSessions();
        const match = sessions.find((s) => s.id.startsWith(targetId));
        if (!match) { result = t("be_conversationLoop.cmdLoadNotFound", { id: targetId }); break; }
        const loaded = this.loadSession(match.id);
        result = loaded
          ? t("be_conversationLoop.cmdLoadSuccess", { id: match.id.slice(0, 8), count: this.history.length })
          : t("be_conversationLoop.cmdLoadFailed", { id: match.id });
        break;
      }
      case "vendor":
        result = t("be_conversationLoop.cmdVendorInfo", { vendor: this.getVendor(), session: this.sessionId.slice(0, 8), input: this.cumulativeUsage.inputTokens, output: this.cumulativeUsage.outputTokens });
        break;
      case "compact": {
        // manualCompact uses the LLM compact path (12-section structured summary +
        // freezeBoundary + summaryPreamble persistence + checkpoint append).
        // callbacks 전달 — onCompactOccurred 가 renderer 에 compact_notice 이벤트 전달 가능.
        const r = await this.manualCompact(callbacks);
        result = r.summary;
        break;
      }
      case "tools": {
        const tools = this.deps.toolRegistry.getVisibleTools();
        result = tools.map((tool) => `${tool.name} [${toolProvenanceLabel(tool)}]`).join("\n") || t("be_conversationLoop.cmdToolsEmpty");
        break;
      }
      case "permission": {
        result = await this.handlePermissionCommand(args, inputOrigin, callbacks);
        break;
      }
      case "help":
        result = t("be_conversationLoop.cmdHelp");
        break;
      default:
        result = t("be_conversationLoop.cmdUnknown", { command });
    }

    callbacks?.onTextDelta?.(result);
    callbacks?.onTurnComplete?.(result);
    return { text: result, toolCalls: [], route: "command" };
  }

  private async handlePermissionCommand(
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<string> {
    const {
      dispatchPermissionAuditCommand,
      dispatchPermissionDirCommand,
      dispatchPermissionHooksCommand,
      dispatchPermissionReviewerCommandWithRewire,
      dispatchPermissionSlash,
    } = await import("../permissions/permission-slash.js");
    const raw = args.trim().length > 0 ? `/permission ${args.trim()}` : "/permission";
    const outcome = dispatchPermissionSlash(
      raw,
      inputOrigin,
    );
    if (outcome.kind === "parse-error") return t("be_conversationLoop.permissionParseError", { error: outcome.error });
    if (outcome.kind === "show-current") {
      const mode = this.deps.permissionManager?.getMode() ?? "default";
      return t("be_conversationLoop.permissionShowCurrent", { mode });
    }
    if (outcome.kind === "dir") {
      const result = await dispatchPermissionDirCommand(outcome.cmd);
      if (!result.ok) {
        const warnings = result.warnings?.length ? t("be_conversationLoop.permissionDirWarnings", { warnings: result.warnings.map((w) => `- ${w}`).join("\n") }) : "";
        const ack = result.requiresAcknowledgement ? t("be_conversationLoop.permissionDirAckRequired") : "";
        return t("be_conversationLoop.permissionDirError", { error: result.error, warnings, ack });
      }
      if (result.verb === "list") {
        return [
          t("be_conversationLoop.permissionDirListHeader"),
          result.defaults.length ? t("be_conversationLoop.permissionDirListDefaults", { list: result.defaults.join(", ") }) : t("be_conversationLoop.permissionDirListDefaultsEmpty"),
          result.userAdditions.length ? t("be_conversationLoop.permissionDirListAdditions", { list: result.userAdditions.join(", ") }) : t("be_conversationLoop.permissionDirListAdditionsEmpty"),
          result.effective.length ? t("be_conversationLoop.permissionDirListEffective", { list: result.effective.join(", ") }) : t("be_conversationLoop.permissionDirListEffectiveEmpty"),
        ].join("\n");
      }
      if (result.verb === "allow") {
        if (result.sessionOnly && result.sessionDirectory) {
          this.addSessionAdditionalDirectory(result.sessionDirectory);
          return t("be_conversationLoop.permissionDirSessionAllowed", { dir: result.sessionDirectory });
        }
        return t("be_conversationLoop.permissionDirAllowed", { list: result.persisted.map((d) => `- ${d}`).join("\n") });
      }
      return t("be_conversationLoop.permissionDirDenied", { list: result.persisted.length ? result.persisted.map((d) => `- ${d}`).join("\n") : t("be_conversationLoop.permissionDirDeniedEmpty") });
    }
    if (outcome.kind === "reviewer") {
      const result = await dispatchPermissionReviewerCommandWithRewire(
        outcome.cmd,
        this.deps.rewireReviewerAgent,
      );
      if (!result.ok) return t("be_conversationLoop.permissionReviewerError", { error: result.error });
      const { mode, fallbackOnError, interactive } = result.settings;
      return [
        t("be_conversationLoop.permissionReviewerSettings"),
        `mode=${mode}`,
        "provider/model=active LLM settings",
        `fallbackOnError=${fallbackOnError}`,
        `interactiveAutoApprove=${interactive.autoApprove}`,
      ].join("\n");
    }
    if (outcome.kind === "audit") {
      const auditLogger = this.deps.auditLogger;
      if (!auditLogger) return t("be_conversationLoop.permissionAuditNoLogger");
      const result = dispatchPermissionAuditCommand(outcome.cmd, {
        auditDir: auditLogger.getAuditDir(),
        secret: auditLogger.getPermissionAuditSecret(),
        sealStore: auditLogger.getPermissionAuditSealStore() ?? undefined,
      });
      if (!result.ok) return t("be_conversationLoop.permissionAuditError", { error: result.error });
      if (result.verb === "verify") {
        return [
          `Audit verify: ${result.intact ? "intact" : "broken"}`,
          `files=${result.totalFiles}`,
          `entries=${result.totalEntries}`,
          ...(result.firstBrokenFile ? [`firstBrokenFile=${result.firstBrokenFile}`] : []),
        ].join("\n");
      }
      return [
        t("be_conversationLoop.permissionAuditRecent", { count: result.entries.length }),
        ...result.entries.map((entry) => JSON.stringify(entry)),
      ].join("\n");
    }
    if (outcome.kind === "mode") {
      const pm = this.deps.permissionManager;
      if (!pm) return t("be_conversationLoop.permissionModeNoManager");
      const { applyPermissionModeCommand } = await import("../permissions/permission-mode-apply.js");
      const result = await applyPermissionModeCommand(outcome.cmd, {
        permissionManager: pm,
        approvalGate: this.deps.approvalGate,
        auditLogger: this.deps.auditLogger,
        approvalBypass: {
          source: "builtin-slash",
          trustOrigin: "user-keyboard",
          explicitUserAction: true,
        },
      });
      if (!result.ok) return t("be_conversationLoop.permissionModeCancelled", { message: result.message ?? result.error });
      callbacks?.onPermissionModeChanged?.(result.mode);
      return t("be_conversationLoop.permissionModeChanged", {
        previous: result.previous,
        mode: result.mode,
        durability: result.durable ? t("be_conversationLoop.permissionModeDurable") : t("be_conversationLoop.permissionModeSession"),
      });
    }
    if (outcome.kind === "rules") {
      const pm = this.deps.permissionManager;
      if (!pm) return t("be_conversationLoop.permissionRulesNoManager");
      if (outcome.cmd.sub === "add") {
        if (outcome.cmd.action === "allow") {
          await pm.addAlwaysAllowedPersist(outcome.cmd.pattern);
        } else {
          await pm.addAlwaysDeniedPersist(outcome.cmd.pattern);
        }
        this.deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
        return t("be_conversationLoop.permissionRuleAdded", { action: outcome.cmd.action, pattern: outcome.cmd.pattern });
      }
      if (outcome.cmd.sub === "remove") {
        await pm.removeRule(outcome.cmd.pattern, outcome.cmd.action);
        this.deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
        return t("be_conversationLoop.permissionRuleRemoved", { action: outcome.cmd.action, pattern: outcome.cmd.pattern });
      }
      const rules = await pm.listPersistedRules();
      return rules.length
        ? rules.map((rule) => `- ${rule.action} ${rule.pattern}${rule.source ? ` [${rule.source}]` : ""}`).join("\n")
        : t("be_conversationLoop.permissionRulesEmpty");
    }
    if (outcome.kind !== "hooks") {
      return t("be_conversationLoop.permissionUnhandled", { kind: outcome.kind });
    }

    const result = await dispatchPermissionHooksCommand(outcome.cmd, {
      ...this.deps.hookTrustCommandOptions,
      manager: this.deps.scriptHookManager,
    });
    if (!result.ok) return t("be_conversationLoop.hookTrustError", { error: result.error });
    if (result.verb === "list") {
      const active = result.active.length === 0
        ? t("be_conversationLoop.hookListActiveEmpty")
        : result.active.map((h) => `- active ${h.fileName} [${h.state}]`).join("\n");
      const disabled = result.disabled.length === 0
        ? t("be_conversationLoop.hookListDisabledEmpty")
        : result.disabled.map((h) => `- disabled ${h.fileName}`).join("\n");
      return t("be_conversationLoop.hookTrustStatus", { active, disabled });
    }
    // accept|disable|reject mutated hook trust state. Mirror the IPC hook-trust
    // handlers (ipc/domains/permissions.ts) and notify multi-window
    // PermissionsTab subscribers so the quarantine banner live-refreshes
    // instead of waiting for tab re-entry. `list` is a no-op read above and
    // does not broadcast; failed commands already returned earlier.
    this.deps.broadcastPermissionConfigChanged?.();
    if (result.verb === "accept") {
      return t("be_conversationLoop.hookAccepted", { fileName: result.accepted.fileName, count: result.trusted.length });
    }
    if (result.verb === "disable") {
      return t("be_conversationLoop.hookDisabled", { fileName: result.disabled.fileName, count: result.trusted.length });
    }
    return t("be_conversationLoop.hookRejected", { fileName: result.rejected.fileName, count: result.trusted.length });
  }

  // Compaction uses same-session checkpoints. Automatic session forks are not
  // part of the compact path; forks only happen through explicit user action.
}

/**
 * ConversationLoop turn-runtime types.
 *
 * the public turn contract (`TurnCallbacks`,
 * `TurnStopReason`, `TurnResult`, `ConversationLoopDeps`) plus the internal
 * scope / diagnostics types shared across the `engine/turn/` units. These are
 * re-exported byte-identically from `engine/conversation-loop.js` so external
 * importers (ipc/domains/chat, subagent-runner, boot) keep the same surface.
 */
import type {
  GenericMessage,
  LLMVendor,
  TokenUsage,
  TokenUsageByModel,
  ToolSchema,
} from "../llm/types.js";
import type { RequestInputProjection } from "../request-input-projection.js";
import type { CompressionStatus } from "../../shared/compact-status.js";
import type { FallbackStatus } from "../llm/vercel/fallback-chain.js";
import type { ToolCallMeta } from "../../tools/executor.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import type { PermissionReviewEvent } from "../../shared/permission-review-status.js";
import type { ToolSource } from "../../tools/types.js";
import type { SettingsService } from "../../data/settings-store.js";
import type { SystemPromptBuilder } from "../../prompts/system-prompt-builder.js";
import type { KeywordEngine } from "../../core/keyword-engine.js";
import type { RouteEngine } from "../../core/route-engine.js";
import type { ToolRegistry } from "../../tools/registry.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { RoutineEngine } from "../../core/routine-engine.js";
import type { IdleSchedulerService } from "../../main/idle-scheduler.js";
import type { PostTurnHookChain } from "../../hooks/post-turn-hook-chain.js";
import type { HookRunner } from "../../hooks/hook-runner.js";
import type { AuditLogger } from "../../audit/audit-logger.js";
import type { HookTrustCommandOptions } from "../../hooks/hook-trust-commands.js";

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
    uiPayload: import("../../mcp/types.js").McpUiPayload | undefined,
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



    summary?: string;
    /**
     * Compact sequence number — passed to CheckpointDivider to enable
     * view-mode and branch-from-checkpoint actions.
     */
    compactNum?: number;



    compactStatus?: CompressionStatus;



    truncatedDir?: string;
  }) => void;



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
  // The turn used up its round budget (queryLoop `effectiveMaxRounds`, set by
  // a sub-agent's host-assigned `maxRounds` or the global MAX_TOOL_ROUNDS)
  // before the LLM produced a natural end_turn. The returned text is the
  // PARTIAL work so far — the task did not finish. Distinct from `interrupted`
  // (user-initiated) and `max_tokens` (single-answer output cap): this is a
  // host-imposed round budget. Sub-agents surface it to the parent as an
  // `incomplete` result (see SubAgentSpawnResult); the main chat surfaces it
  // as a "send a new message to continue" affordance (the persistent loop
  // resumes on the next user message). turn_summary / notification gates treat
  // it like a completed turn (real partial output + usage), NOT like an error.
  | "round-cap"
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
  permissionManager?: import("../../permissions/permission-manager.js").PermissionManager;
  routineEngine?: RoutineEngine;

  idleScheduler?: IdleSchedulerService;
  /** Agent 6: post-turn hook chain (compact → saveSession → extractMemory → audit → idle-poke) */
  postTurnHookChain?: PostTurnHookChain;

  bashAstValidator?: import("../../main/bash-ast-validator.js").BashAstValidator;

  approvalGate?: import("../../permissions/approval-gate.js").ApprovalGate;
  /**
   * In-process hook runner used by focused unit tests and old internal
   * extension points. Production Permission policy script hooks are carried by
   * scriptHookManager, not by hooks.json external loading.
   */
  hookRunner?: HookRunner;



  pluginRuntime?: {
    listPluginIds(): string[];
    /**
     * #1176 — whether a loaded plugin is active (its tools may be exposed).
     * `enabled !== false` in the registry; absent → active (migration-safe).
     * Used by {@link resolveToolScope} to drop inactive plugins from scope.
     */
    isPluginEnabled?(pluginId: string): boolean;
    /**
     * Record a plugin as session-activated for `sessionId` so Gate 4
     * ({@link pluginRuntimeToolDelegate}) allows its tool calls for that
     * session. NEVER persists enabled state — `setPluginEnabled` NOT called.
     * Per-session scoping ensures session A's activation is never wiped by
     * session B starting.
     */
    setSessionActivated?(sessionId: string, pluginId: string): void;
    /**
     * Clear on-demand activations for `sessionId` ONLY. Does not affect
     * any other session. Called at session-reset and routine loop completion.
     */
    clearSessionActivated?(sessionId: string): void;
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
  /** Runtime predicate for the app-managed default workspace project root. */
  isDefaultProjectRoot?: (projectRoot: string) => boolean;
  /** Default project for main conversations when the user has not selected one. */
  getDefaultProject?: () => { projectRoot?: string; projectName?: string; isDefault?: boolean };
  /** Re-authorize and canonicalize a stored or renderer-supplied project root. */
  authorizeProject?: (
    projectRoot: string,
    projectName?: string,
  ) => { projectRoot: string; projectName?: string; isDefault?: boolean } | null;
  /**
   * Script hooks. Boot owns discovery/trust and injects the manager;
   * the executor only invokes the already-trusted generic hook contract.
   */
  scriptHookManager?: import("../../hooks/script-hook-manager.js").ScriptHookManager;
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
  notificationService?: import("../../main/notification-service.js").NotificationService;
  /** Shared boot audit logger. Tool execution audit writes to this HMAC chain. */
  auditLogger?: AuditLogger;
  /** Rebuilds reviewer classifier/cache bindings after `/permission reviewer ...`. */
  rewireReviewerAgent?: () => void;
  /** Main-process fetch implementation for Azure Foundry private-endpoint calls. */
  llmFetch?: typeof fetch;
}

export interface RequestProjectionContext {
  systemPrompt: string;
  toolSchemas: ToolSchema[];
  estimateCurrent: () => RequestInputProjection;
}

export type ToolSourceCounts = Record<ToolSource, number>;

export type CompactTriggerSource = "estimate" | "context-tokens" | "manual" | "force-recover" | "rate-limit";

export interface PreflightGuardOptions {
  forceReason?: "rate-limit";
}


export interface ToolScope {
  activePluginIds: Set<string>;



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

export interface ToolExposureMetrics {
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

export interface ProviderRequestDiagnostics {
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

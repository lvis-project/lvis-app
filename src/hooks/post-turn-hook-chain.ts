




import { markStaleToolResults } from "../engine/auto-compact.js";
import { detectFromStream, type DetectorResult } from "../engine/checkpoint-detector.js";
import { isLLMVendor, type GenericMessage, type TokenUsage, type TokenUsageByModel } from "../engine/llm/types.js";
import { normalizeAiSdkUsageForCost } from "../engine/llm/pricing.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AuditLogger } from "../audit/audit-logger.js";
import type { IdleSchedulerService } from "../main/idle-scheduler.js";
import type { SettingsService } from "../data/settings-store.js";
import { createLogger } from "../lib/logger.js";
import { EMPTY_ASSISTANT_RESPONSE_TEXT } from "../lib/chat-stream-state.js";
import { t } from "../i18n/index.js";
const log = createLogger("post-turn");

export interface PostTurnHookContext {
  sessionId: string;
  projectRoot?: string;
  projectName?: string;

  messages: GenericMessage[];
  input: string;
  output: string;
  toolCalls: Array<{ name: string; isError: boolean }>;
  /**
   * AI SDK-normalized turn usage from the provider stream. `inputTokens`
   * includes cache for modern AI SDK providers; the audit step normalizes this
   * to the `computeCost` provider contract before persisting.
   */
  tokenUsage?: TokenUsage;
  usageByModel?: TokenUsageByModel[];
  toolExposure?: {
    loadedToolCount: number;
    loadedToolSourceCounts: { builtin: number; plugin: number; mcp: number };
    deferredCatalogCount: number;
    deferredCatalogSourceCounts: { plugin: number; mcp: number };
    promotedToolNames: string[];
    loadedPluginIds: string[];
    loadedMcpServerIds: string[];
    deferredPluginIds: string[];
    deferredMcpServerIds: string[];
    toolSchemaTokens: number;
    projectedRequestInputTokens: number | null;
    deferralEligibleLoadedCount: number;
    deferredLoadedRatio: number | null;
  };
  route: string;
  /**
   * Snapshot of the LLM vendor/model that actually served this turn —
   * captured at runTurn entry so that post-turn audit attribution is
   * stable even if the user mutates settings mid-flight (e.g. retry-effort
   * temporarily patches thinking config and reverts in finally). The audit
   * step uses these to emit `${provider}/${model}` for any token-bearing LLM
   * turn, including `skill` routes that still execute through the LLM.
   * Optional so non-token callers (command) can omit them.
   */
  vendorProvider?: string;
  vendorModel?: string;
}

export interface PostTurnHookChainDeps {
  memoryManager?: MemoryManager;
  auditLogger?: AuditLogger;
  idleScheduler?: IdleSchedulerService;
  settingsService?: SettingsService;
  /**
   * Optional callback invoked when a [checkpoint] marker is detected.
   * Caller (typically conversation-loop or IPC bridge) can trigger summary handling.
   */
  onCheckpointSuggested?: (sessionId: string, cleanedOutput: string) => void;
  /**
   * Session-scoped assistant TO-DO lifecycle — mark side. When the turn just
   * completed a fully-completed plan, the chain marks it for clear at the next
   * turn boundary (the conversation loop executes via `clearIfPending`). Marking
   * never emits, so the panel persists through the completing turn.
   */
  sessionTodoStore?: { markForClearIfCompleted(sessionId: string): boolean };
}

export interface PostTurnHookResult {

  compactedMessages: GenericMessage[] | null;

  detector: DetectorResult;
  /**
   * Canonical message array that this hook persisted for transcript replay.
   * It includes mark-stale compaction and marker-stripped assistant output.
   */
  messagesForPersistence: GenericMessage[];
}

export class PostTurnHookChain {
  constructor(private readonly deps: PostTurnHookChainDeps) {}




  async run(ctx: PostTurnHookContext): Promise<PostTurnHookResult> {
    let compactedMessages: GenericMessage[] | null = null;
    let messagesForPersistence = ctx.messages;



    try {
      const beforeMarkCount = ctx.messages.length;
      const { messages: afterMark, result: mr } = markStaleToolResults(ctx.messages);
      if (mr.marked) {
        compactedMessages = afterMark;
        log.info(
          `mark-stale: marked ${mr.markedCount} tool_results, ~${mr.freedCharsOnSerialize} chars saved on serialize (msgCount=${beforeMarkCount}, memory verbatim)`,
        );
      } else {
        log.info(`mark-stale: SKIPPED — no stale tool_result content found (msgCount=${beforeMarkCount})`);
      }
    } catch (err) {
      log.warn({ err }, "mark-stale failed");
    }

    // 2. Detect checkpoint/title markers.
    //    Run before persistence so durable session history stores the same
    //    cleaned assistant output that the caller and renderer receive.
    let detector: DetectorResult = { cleanedText: ctx.output, newTitle: null, checkpointSuggested: false };
    try {
      detector = detectFromStream(ctx.output);
      if (detector.checkpointSuggested) {
        log.info(`detect-checkpoint: [checkpoint] marker stripped for session ${ctx.sessionId}`);
        try {
          this.deps.onCheckpointSuggested?.(ctx.sessionId, detector.cleanedText);
        } catch (cbErr) {
          log.warn("onCheckpointSuggested callback failed: %s", cbErr);
        }
      }
    } catch (err) {
      log.warn("detect-checkpoint failed: %s", err);
    }
    const outputForHooks = detector.cleanedText;
    const outputForPersistence =
      outputForHooks.trim().length > 0
        ? outputForHooks
        : ctx.output.trim().length > 0
          ? EMPTY_ASSISTANT_RESPONSE_TEXT
          : outputForHooks;

    // 세션 영속화
    try {
      const baseMessages = compactedMessages ?? ctx.messages;
      messagesForPersistence =
        outputForPersistence !== ctx.output
          ? replaceLastAssistantOutput(baseMessages, ctx.output, outputForPersistence)
          : baseMessages;
      // saveSession owns JSONL stubbing + file-backed tool_result artifacts.
      // caller (engine) 의 in-memory verbatim 은 변경 안 됨.
      await this.deps.memoryManager?.saveSession(ctx.sessionId, messagesForPersistence);
    } catch (err) {
      log.warn("saveSession failed: %s", err);
    }

    // Memory Extraction — "기억해" 패턴 감지 시 memories/ 자동 저장
    try {
      if (this.deps.memoryManager) {
        const memoryPatterns = /기억해|기억하|잊지\s*마|remember|don't forget/i;
        if (memoryPatterns.test(ctx.input)) {
          const confirmPatterns = /기억하겠|기억.*저장|기록.*했|noted|remembered|saved/i;
          if (confirmPatterns.test(outputForHooks)) {
            const title = ctx.input.slice(0, 40).replace(/\n/g, " ").trim();
            if (title.length >= 3) {
              await this.deps.memoryManager.saveMemory(
                t("be_postTurnHookChain.autoMemoryTitle", { title }),
                t("be_postTurnHookChain.autoMemoryBody", { input: ctx.input, output: outputForHooks.slice(0, 500) }),
                {
                  ...(ctx.projectRoot ? { projectRoot: ctx.projectRoot } : {}),
                  ...(ctx.projectName ? { projectName: ctx.projectName } : {}),
                },
              );
              log.info(`memory-extraction: auto-saved note "${title}"`);
            }
          }
        }
      }
    } catch (err) {
      log.warn("extractMemory failed: %s", err);
    }

    // [title] marker handling — newTitle 가 detector 에서 추출되면
    //    session metadata 에 저장. LLM-based title chaining 은 호출처가 없어
    //    제거됨.
    try {
      if (this.deps.memoryManager && detector.newTitle) {
        const sessionMeta = this.deps.memoryManager.loadSessionMetadata(ctx.sessionId) ?? {};
        await this.deps.memoryManager.saveSessionMetadata(ctx.sessionId, {
          ...sessionMeta,
          title: detector.newTitle,
        });
        log.info(`update-title: session ${ctx.sessionId} title set to "${detector.newTitle}"`);
      }
    } catch (err) {
      log.warn("update-title failed: %s", err);
    }

    // Audit Log
    //    Emit `${provider}/${model}` for "llm" routes (usage-stats.parseRoute
    //    splits on `/`); non-LLM routes (skill/command) keep the
    //    classification verbatim. Snapshot fields on ctx win over live
    //    settings — see PostTurnHookContext docs for the drift rationale.
    try {
      const llmSettings = this.deps.settingsService?.get("llm");
      const provider = ctx.vendorProvider ?? llmSettings?.provider;
      const model =
        ctx.vendorModel ??
        (llmSettings ? llmSettings.vendors[llmSettings.provider].model : undefined);
      const auditTokenUsage = provider && isLLMVendor(provider)
        ? normalizeAiSdkUsageForCost(ctx.tokenUsage, provider)
        : ctx.tokenUsage;
      const auditUsageByModel = ctx.usageByModel?.map((segment) => ({
        ...segment,
        tokenUsage: normalizeAiSdkUsageForCost(segment.tokenUsage, segment.vendorProvider),
      }));
      const auditRoute =
        ctx.tokenUsage && provider && model
          ? `${provider}/${model}`
          : ctx.route;
      this.deps.auditLogger?.logTurn({
        sessionId: ctx.sessionId,
        input: ctx.input,
        output: outputForHooks,
        toolCalls: ctx.toolCalls,
        tokenUsage: auditTokenUsage,
        usageByModel: auditUsageByModel,
        toolExposure: ctx.toolExposure,
        route: auditRoute,
      });
    } catch (err) {
      log.warn("audit failed: %s", err);
    }

    // Mark completed session TO-DO for clear at the next turn boundary.
    //    Deterministic, runs after every turn. Marking does not emit, so the
    //    panel stays visible through the turn that completed it; the
    //    conversation loop clears it unconditionally at the next turn start.
    try {
      if (this.deps.sessionTodoStore?.markForClearIfCompleted(ctx.sessionId)) {
        log.info(`mark-session-todo-for-clear: marked session ${ctx.sessionId} for next-turn clear`);
      }
    } catch (err) {
      log.warn("mark-session-todo-for-clear failed: %s", err);
    }

    // 7. Idle poke.
    try {
      this.deps.idleScheduler?.signalConversation();
    } catch (err) {
      log.warn("idle poke failed: %s", err);
    }

    return { compactedMessages, detector, messagesForPersistence };
  }
}

function replaceLastAssistantOutput(
  messages: GenericMessage[],
  rawOutput: string,
  cleanedOutput: string,
): GenericMessage[] {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== "assistant") continue;
    const next = [...messages];
    next[i] = {
      ...message,
      content: message.content === rawOutput ? cleanedOutput : message.content.replace(rawOutput, cleanedOutput),
    };
    return next;
  }
  return messages;
}

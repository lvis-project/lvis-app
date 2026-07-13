/**
 * SubAgentRunner — host-side orchestrator for the `agent_spawn` tool.
 *
 * Spawns a child {@link ConversationLoop} with:
 *   - A fresh history (instructions become the initial user message; the
 *     parent's system prompt builder still runs but the child's session is
 *     isolated).
 *   - A scoped {@link ToolRegistry} restricted to the parent-supplied
 *     `sourceTools` list (or the parent's full tool set if omitted). The
 *     `agent_spawn` tool itself is ALWAYS stripped from the child registry
 *     regardless of the supplied list — sub-agents cannot recurse.
 *   - A host-assigned round budget (default 30; lower per mode) —
 *     runTurn(`maxRounds: cappedRounds`) terminates
 *     queryLoop cleanly between rounds, and the executor's per-round
 *     fan-out cap (5 calls/round) bounds total tool execution count.
 *   - An ApprovalGate wrapper that prepends "[Sub-Agent: <title>]" to the
 *     user-facing approval reason so users know an approval modal originated
 *     from a sub-agent.
 *
 * Per-turn updates are streamed back as events so the renderer can show a
 * live workspace-rail sub-agent viewer. Final summary is delivered as `summary`
 * in the result.
 *
 * Rationale (vs. mutating the main loop): a sub-loop helper file keeps the
 * primary ConversationLoop unchanged, avoids reentrancy hazards on the
 * shared state (`sessionId`, `history`, `cumulativeUsage`), and lets each
 * spawn audit-log under a child sessionId tagged with the origin session id.
 */
import { createHash, randomUUID } from "node:crypto";
import { ConversationLoop, type ConversationLoopDeps } from "./conversation-loop.js";
import type { TurnInputRequired, TurnStopReason } from "./turn/types.js";
import {
  GUIDE_JOINED_MAX_CHARS,
  GUIDE_MAX_CHARS,
} from "./turn/guidance-limits.js";
import type { ToolRegistry } from "../tools/registry.js";
import { isValidSessionId, type MemoryManager } from "../memory/memory-manager.js";
import type { ApprovalGate, ApprovalRequest, ApprovalDecision } from "../permissions/approval-gate.js";
import {
  isModelComplexityLevel,
  resolveModelForComplexity,
} from "../shared/model-complexity-map.js";
import {
  isLLMVendor,
  isModelAvailableForVendor,
} from "../shared/llm-vendor-defaults.js";
import {
  resolveAgentMode,
  type AgentModeConfig,
} from "../shared/agent-mode-map.js";
import { createLogger } from "../lib/logger.js";
import { t } from "../i18n/index.js";
import { SubAgentTranscriptAccumulator } from "./subagent-transcript.js";
import type { ChatEntry } from "../lib/chat-stream-state.js";
import { serializeHistoryMessage, type SerializedHistoryMessage } from "../shared/chat-history.js";
import { isToolResultStubContent } from "../shared/tool-result-stub.js";
import { maskSensitiveData } from "../shared/dlp.js";
import type { GenericMessage } from "./llm/types.js";
import type {
  A2ASubAgentMessageBus,
  DeliverToParentInput,
  DeliverToParentResult,
  ParentWakeHandler,
  ResolvedSubAgentAddress,
} from "./a2a-subagent-message-bus.js";
import type { ParentMailboxEntry } from "./subagent-message-mailbox.js";
import type {
  A2AAgentMessageBus,
  A2AStagedQuestionDelivery,
} from "./a2a-agent-message-bus.js";
import type { A2AAgentMailboxEntry } from "./a2a-agent-message-mailbox.js";
import {
  causalContextForEnvelopes,
  type A2AAgentCausalContext,
} from "./a2a-agent-message-envelope.js";
import type {
  A2AAgentSendAuditInput,
  A2AAgentSendRequest,
  A2AAgentSendResult,
  ResolveSubAgentPeerResult,
  ResolvedA2ASender,
} from "./a2a-agent-message-envelope.js";
import {
  A2A_ROLE_AGENT,
  A2ATaskState,
  canTransitionA2ATaskState,
  isA2ATerminalTaskState,
  projectSubAgentResultState,
  projectSubAgentRunState,
  subAgentRunStatusFromTaskState,
  type A2AProjectedTaskState,
} from "../shared/a2a.js";
import type {
  SubAgentRunStatus,
  SubAgentSuspension,
} from "../shared/subagent-events.js";
export type {
  SubAgentRunStatus,
  SubAgentSuspension,
  SubAgentSuspensionReason,
} from "../shared/subagent-events.js";

const log = createLogger("lvis");

function maskSubAgentText(text: string): string {
  return maskSensitiveData(text).masked;
}

export interface SubAgentSpawnInput {
  title: string;
  instructions: string;
  /** Host-visible run id created by the `agent_spawn` tool. */
  spawnId?: string;
  /** Parent `agent_spawn` tool_use id, persisted as the reload join key. */
  toolUseId?: string;
  sourceTools?: string[];
  /**
   * Host-assigned round budget for the child loop, in assistant rounds.
   * The LLM cannot pick this: the `agent_spawn` tool no longer exposes a
   * `maxTurns` schema field. It is set ONLY by host callers that run a
   * sub-agent for a FIXED-shape task (e.g. WorkBoardEngine's plan/execute
   * phases) and know the right budget for that phase. When absent, the
   * budget is derived from the profile's `mode:` (`maxToolRoundsHint`) and
   * finally `MAX_TURNS_DEFAULT` — see `spawn()`. This is host policy, not an
   * LLM-tunable knob, so it is intentionally not surfaced in the tool schema.
   */
  maxRounds?: number;
  /** Origin session id — propagated for audit attribution only. */
  originSessionId?: string;
  /** Authorized project root inherited from the spawning conversation/work item. */
  projectRoot?: string;
  /** Human-readable project name paired with the project root. */
  projectName?: string;
  /**
   * Agent profile's `model:` frontmatter. May be a complexity tier
   * ("low" / "mid" / "high"), an explicit vendor-specific model ID, or
   * undefined. Resolved against the active vendor in `spawn()`; an
   * unresolvable value leaves the child on the parent's model (design-
   * intent fallback, logged for audit).
   */
  profileModel?: string;
  /**
   * Agent profile's `mode:` frontmatter (execute / plan / research /
   * explore, or undefined). Resolved in `spawn()` to a working-posture
   * preamble + auto-skill recommendation prepended to the instructions.
   * Unknown / absent → the `default` mode (inert), logged for audit.
   */
  profileMode?: string;
  /** Trusted host execution mode; never accepted from the child model. */
  background?: boolean;
}

export interface SubAgentActivityUpdate {
  /**
   * Full child transcript snapshot as `ChatEntry[]` (the shared chat model).
   * Idempotent replace — the consumer overwrites the spawn's entries with this
   * array rather than appending. Already DLP-masked at the accumulator source.
   */
  entries: ChatEntry[];
  toolCallCount: number;
}

export interface SubAgentSpawnResult {
  summary: string;
  toolCallCount: number;
  turnCount: number;
  childSessionId: string;
  /**
   * Final child transcript as `ChatEntry[]`. Embedded verbatim in the
   * `agent_spawn` tool result so a reloaded session can rebuild the sub-agent
   * tab's full transcript without any live event stream (persistence parity).
   * Already DLP-masked.
   */
  entries: ChatEntry[];
  /**
   * Structural success signal. `true` only when the child loop completed a
   * clean `runTurn` (the `summary` is the agent's final message). `false` when
   * the run could not produce a real result — the LLM provider was not
   * configured, or the child loop threw — in which case `summary` carries the
   * error text and {@link error} repeats it. Callers (WorkBoardEngine,
   * agent_spawn) MUST branch on this rather than treating any returned
   * `summary` as a completed run: a failed run that surfaced its error string
   * as `summary` must not be recorded as success.
   */
  ok: boolean;
  /** Failure reason when `ok === false`. Absent on a clean completion. */
  error?: string;
  /**
   * Why the child loop stopped, forwarded verbatim from the child's
   * `runTurn`. Undefined when the child threw before returning a turn result
   * (in that case `ok === false` already signals the failure).
   */
  stopReason?: import("./turn/types.js").TurnStopReason;
  /**
   * A resumable terminate-and-return wait. Budget and question waits share
   * the same mechanism; the typed reason tells the caller how to continue.
   */
  suspension?: SubAgentSuspension;
  /**
   * Temporary compatibility alias derived from suspension.
   *
   * `true` when the child hit its host-assigned round budget (stopReason
   * "round-cap") before producing a natural end_turn — i.e. the sub-agent ran
   * out of rounds with WORK STILL PENDING. `summary` then holds the PARTIAL
   * output (last assistant text), not a finished answer. This is distinct from
   * `ok === false` (a failed spawn): an incomplete run is a SUCCESSFUL run that
   * simply did not finish. The parent (agent_spawn tool result) surfaces this
   * so the parent LLM can decide whether to re-spawn / continue the task rather
   * than treating the truncated summary as complete. Absent/false on a clean
   * end_turn or any non-budget stop.
   */
  incomplete?: boolean;
  /**
   * `true` when a `resume()` was REFUSED before running any turn because the
   * session hit a resume-axis loop guard (`resumeCount >= MAX_RESUMES` or
   * `cumulativeRounds >= CUMULATIVE_ROUNDS_CEILING`). Distinct from `incomplete`
   * (a run that started but hit its per-turn round budget): a resume-exhausted
   * result never ran a turn at all. Always paired with `ok === false`. Absent on
   * spawn results and on resumes that were allowed to run.
   */
  resumeExhausted?: boolean;
}

export interface SubAgentSpawnCallbacks {
  /**
   * Fired as soon as a fresh spawn has an addressable child session id. This
   * happens before the first child LLM round, so background `agent_spawn` can
   * return a durable handle immediately and the live viewer can join later
   * activity against the same persisted session.
   */
  onLinked?: (link: { childSessionId: string }) => void;
  /**
   * Fired whenever the child loop produces new transcript content (tool
   * start/end, permission review, completed assistant round). Carries the full
   * `ChatEntry[]` snapshot so the consumer swaps the whole child transcript.
   */
  onActivity?: (update: SubAgentActivityUpdate) => void;
  onError?: (message: string) => void;
}

export interface SubAgentRunSnapshot {
  spawnId?: string;
  childSessionId: string;
  title: string;
  status: SubAgentRunStatus;
  taskState: A2AProjectedTaskState;
  startedAt: string;
  updatedAt: string;
  toolCallCount: number;
  turnCount: number;
  entries: ChatEntry[];
  summary?: string;
  error?: string;
  stopReason?: import("./turn/types.js").TurnStopReason;
  suspension?: SubAgentSuspension;
}

export interface PersistedSubAgentTranscriptRequest {
  originSessionId?: string;
  childSessionId: string;
}

export type PersistedSubAgentTranscriptResult =
  | {
      ok: true;
      childSessionId: string;
      messages: SerializedHistoryMessage[];
      title?: string;
      spawnId?: string;
      originToolUseId?: string;
    }
  | { ok: false; error: string };

interface TrackedSubAgentRun {
  spawnId?: string;
  childSessionId: string;
  originSessionId?: string;
  title: string;
  status: SubAgentRunStatus;
  taskState: A2AProjectedTaskState;
  startedAt: string;
  updatedAt: string;
  toolCallCount: number;
  turnCount: number;
  entries: ChatEntry[];
  summary?: string;
  error?: string;
  stopReason?: import("./turn/types.js").TurnStopReason;
  suspension?: SubAgentSuspension;
  abort?: () => void;
  initialMetadataFailed?: boolean;
  ephemeralFallbackConsumed?: boolean;
  ephemeralParentDelivery?: {
    parentSessionId: string;
    childSessionId: string;
    childTitle: string;
    messageId: string;
  };
}

export type ReserveQuestionWaitResult =
  | { ok: true; token: symbol }
  | { ok: false; reason: "question-already-outstanding" };

interface ActiveSubAgentChild {
  lease: symbol;
  childSessionId: string;
  originSessionId?: string;
  title: string;
  loop: ConversationLoop;
  questionWait?: {
    token: symbol;
    prompt: string;
    stage?: A2AStagedQuestionDelivery;
  };
  background: boolean;
}

export interface SubAgentRunnerDeps {
  /** Parent's ConversationLoopDeps. We clone but swap toolRegistry to a scoped view. */
  parentDeps: ConversationLoopDeps;
  toolRegistry: ToolRegistry;
  /**
   * Isolated MemoryManager rooted at `~/.lvis/subagent/` (via
   * `openFeatureNamespace("subagent")` in boot). Sub-agent runs persist here,
   * NOT to the parent's `~/.lvis/sessions/` main-chat store. Reusing the
   * parent MemoryManager is exactly what leaked orphan sub-agent JSONL into
   * the main session list; the child loop is composed with THIS store so its
   * transcript lands in the subagent namespace under an addressable, regex-
   * valid session id. Mirrors the `sideChatMemoryManager` isolation pattern.
   */
  subAgentMemoryManager: MemoryManager;
  /** Optional until boot wiring is constructed; all absent-bus delivery fails closed. */
  messageBus?: A2ASubAgentMessageBus;
  /** Child-to-parent and sibling A2A message bus. */
  agentMessageBus?: A2AAgentMessageBus;
}

// Sub-agent round budget. The child runs on the same ConversationLoop whose
// per-run hard limit is MAX_TOOL_ROUNDS (30) — a child can never exceed it —
// so the ceiling is pinned to 30. The budget is HOST-ASSIGNED, not LLM-picked:
// `agent_spawn` no longer exposes a `maxTurns` schema field. Resolution order
// (see `spawn()`): explicit host `input.maxRounds` (fixed-shape host callers
// like WorkBoardEngine) → profile `mode.maxToolRoundsHint` → MAX_TURNS_DEFAULT.
// Default 30 covers most multi-step research/edit flows; the mode map assigns
// lower budgets for lighter postures (explore=15, execute=20, research=25).
const MAX_TURNS_DEFAULT = 30;
// Internal ceiling only — the child ConversationLoop's own MAX_TOOL_ROUNDS (30)
// is the real hard limit, so any resolved budget is clamped to this before
// being passed as `maxRounds`. No longer exported: agent-spawn.ts used to
// import it to clamp an LLM-supplied maxTurns, but that schema field is gone.
const MAX_TURNS_CAP = 30;
/**
 * C3(b): tools that must NEVER appear in a sub-agent's registry, regardless
 * of `sourceTools`. Adding `agent_spawn` here is the primary fork-bomb
 * defense; depth check on the tool itself (in `agent-spawn.ts`) is the
 * defense-in-depth backstop.
 */
const SUB_AGENT_TOOL_BLOCKLIST = new Set<string>([
  "agent_spawn",
  "agent_status",
  "agent_interrupt",
]);

/**
 * Resume-axis loop guards (Commit 2 — security-required to land WITH the resume
 * entry point). A sub-agent can be re-hydrated and continued via `resume()`, but
 * an unbounded resume chain is a fork-bomb on the resume axis and blows past the
 * global round budget the per-turn `maxRounds` cap enforces per turn.
 *
 *   - MAX_RESUMES: how many times a single sub-agent session may be resumed.
 *   - CUMULATIVE_ROUNDS_CEILING: total assistant rounds across the original
 *     spawn plus every resume segment. Pinned to 4× the per-turn hard cap so
 *     even a maximally-budgeted spawn + MAX_RESUMES resumes cannot exceed it.
 *
 * A resume that would breach either guard is refused BEFORE any turn runs
 * (`{ ok:false, resumeExhausted:true }`), so no LLM round is spent.
 */
const MAX_RESUMES = 3;
const CUMULATIVE_ROUNDS_CEILING = 4 * MAX_TURNS_CAP;
const MAX_TRACKED_RUNS = 100;
const QUESTION_SUSPENSION_PROMPT_FALLBACK =
  "Answer the sub-agent question to continue.";
const BUDGET_SUSPENSION_PROMPT =
  "Send any message to continue, or treat the partial result as done.";

function createBudgetSuspension(resumeId: string): SubAgentSuspension {
  return {
    reason: "budget",
    prompt: BUDGET_SUSPENSION_PROMPT,
    resumeId,
  };
}

function normalizeSuspensionPrompt(prompt: string | undefined, fallback: string): string {
  const masked = maskSubAgentText(prompt ?? "").trim();
  return (masked || fallback).slice(0, GUIDE_MAX_CHARS);
}

function createQuestionSuspension(
  resumeId: string,
  inputRequired: TurnInputRequired,
): SubAgentSuspension {
  return {
    reason: "question",
    prompt: normalizeSuspensionPrompt(
      inputRequired.prompt,
      QUESTION_SUSPENSION_PROMPT_FALLBACK,
    ),
    resumeId,
  };
}

function normalizeResultSuspension(result: SubAgentSpawnResult): void {
  const suspension = result.suspension;
  if (!suspension) return;
  result.suspension = {
    ...suspension,
    prompt: normalizeSuspensionPrompt(
      suspension.prompt,
      suspension.reason === "question"
        ? QUESTION_SUSPENSION_PROMPT_FALLBACK
        : BUDGET_SUSPENSION_PROMPT,
    ),
  };
}

function isSuccessfulSubAgentStopReason(
  stopReason: TurnStopReason | undefined,
  inputRequired: TurnInputRequired | undefined,
): boolean {
  return stopReason === "end_turn"
    || stopReason === "round-cap"
    || (stopReason === "input-required" && inputRequired?.reason === "question");
}

function subAgentStopFailureReason(
  stopReason: TurnStopReason | undefined,
  text: string,
  operation: "run" | "resume",
): string {
  if (stopReason === "interrupted") return "sub-agent run interrupted";
  return text.trim() || `sub-agent ${operation} stopped with ${stopReason ?? "unknown-stop"}`;
}

/**
 * Build the child loop's session id. It MUST satisfy MemoryManager's
 * `SESSION_ID_REGEX` (`^[a-zA-Z0-9_-]+$`) so `saveSession` persists it (that
 * method throws on an invalid id) and `loadSession` can later re-hydrate it.
 * The previous `${origin}::${uuid}` form contained `::`, which fails the
 * regex — so the child silently fell back to persisting under its bare
 * constructor UUID into the MAIN chat namespace (orphan + pollution). Here we
 * derive a short, stable ORIGIN TAG for human traceability and append a fresh
 * UUID. The `sub-` prefix also keeps the id OUT of the UUID-shaped filters
 * (`^[0-9a-f-]{8,}$`) the main session list uses, so even a misrouted file
 * would never surface there — defense in depth.
 *
 * The origin tag is a short SHA-256 hash of the origin session id, NOT a raw
 * slice of it. A raw slice let the child filename correlate directly to the
 * parent session id (an info-leak: anyone reading `~/.lvis/subagent/` could
 * tie a child back to a specific parent chat by prefix match). The hash keeps
 * the tag deterministic (same parent → same tag, useful for grouping) and
 * bounded to the id charset while breaking that correlation.
 */
function buildChildSessionId(originSessionId?: string): string {
  const origin = originSessionId ?? "";
  const originTag = origin ? originSessionTag(origin) : "";
  return originTag
    ? `sub-${originTag}-${randomUUID()}`
    : `sub-${randomUUID()}`;
}

function originSessionTag(originSessionId: string): string {
  return createHash("sha256").update(originSessionId).digest("hex").slice(0, 8);
}

/**
 * Resolve an agent profile's `model:` frontmatter to a concrete model ID
 * for the child loop, against the parent's active vendor:
 *   1. undefined / empty   → null (child stays on the parent model)
 *   2. complexity tier      → MODEL_COMPLEXITY_MAP[vendor][tier]; null when
 *                             the vendor lacks that tier (design-intent
 *                             parent-model fallback, logged for audit)
 *   3. explicit model ID    → used only when it is a selectable option for
 *                             the active vendor (LLM_VENDOR_MODEL_OPTIONS);
 *                             otherwise null (parent-model fallback, logged)
 *                             so an ID the vendor cannot serve never reaches
 *                             the provider as a non-retryable model-not-found
 *                             that the fallback chain refuses to recover from.
 *
 * Returning null means "no override" — the caller leaves `modelOverride`
 * unset so `refreshProvider()` uses the vendor block's configured model.
 * Every non-null result is therefore a model the active vendor can serve
 * (tier-resolved or option-validated).
 */
export function resolveSubAgentModel(
  profileModel: string | undefined,
  activeVendor: string,
): string | null {
  const trimmed = profileModel?.trim();
  if (!trimmed) return null;

  if (isModelComplexityLevel(trimmed)) {
    if (!isLLMVendor(activeVendor)) return null;
    const resolved = resolveModelForComplexity(activeVendor, trimmed);
    if (resolved === null) {
      log.warn(
        "sub-agent: parent-model fallback used — vendor '%s' has no '%s' tier in MODEL_COMPLEXITY_MAP",
        activeVendor,
        trimmed,
      );
    }
    return resolved;
  }

  // Explicit vendor-specific model ID. Use it only when the active vendor
  // can actually serve it; an unavailable ID resolves to null (parent-model
  // fallback, logged) rather than reaching the provider and hard-failing the
  // child with a non-retryable model-not-found.
  if (isModelAvailableForVendor(activeVendor, trimmed)) {
    return trimmed;
  }
  log.warn(
    "sub-agent: parent-model fallback used — model '%s' is not a selectable option for vendor '%s'",
    trimmed,
    activeVendor,
  );
  return null;
}

/**
 * Build the mode preamble prepended to a sub-agent's instructions:
 *   - working-posture line (mode.reasoningHint)
 *   - auto-skill RECOMMENDATION (not a force-load — LVIS gates every skill
 *     behind a body-hash approval; the LLM must call `skill_load` so the
 *     normal approval modal runs. See agent-mode-map.ts SECURITY MODEL).
 * Returns "" for the default/inert mode so the profile body is unchanged.
 */
export function buildModePreamble(config: AgentModeConfig): string {
  const parts: string[] = [];
  if (config.reasoningHint) {
    parts.push(
      `<lvis-agent-mode-posture>\n${config.reasoningHint}\n</lvis-agent-mode-posture>`,
    );
  }
  if (config.autoSkills.length > 0) {
    parts.push(
      [
        "<lvis-agent-mode-skills>",
        t("be_subagentRunner.modeSkillsRecommendation", { skills: config.autoSkills.join(", ") }),
        t("be_subagentRunner.modeSkillsLoadHint"),
        "</lvis-agent-mode-skills>",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

/**
 * ApprovalGate wrapper that prepends `[Sub-Agent: <title>] ` to the
 * `reason` text shown in the user-facing approval modal so users can
 * distinguish parent-loop approvals from sub-agent approvals at a glance.
 * No other behavior changes — the underlying gate handles HMAC/nonce, S1
 * sensitive-path block, S4 read-only short-circuit, etc.
 */
function makeSubAgentApprovalAdapter(
  base: ApprovalGate,
  title: string,
): ApprovalGate {
  // We expose the same interface ConversationLoop / ToolExecutor uses via
  // duck-typing — only `requestAndWait` is actually called from the tool
  // executor, plus `policy` / `setPolicy` from IPC bridge. The wrapper
  // forwards everything else to the original instance.
  const wrapper = Object.create(base) as ApprovalGate;
  wrapper.requestAndWait = function wrappedRequestAndWait(
    req: Omit<ApprovalRequest, "requireExplicit">,
  ): Promise<ApprovalDecision> {
    const labeledReason = `[Sub-Agent: ${title}] ${req.reason}`;
    return base.requestAndWait({ ...req, reason: labeledReason });
  };
  return wrapper;
}

function isGenericMessage(value: unknown): value is GenericMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const message = value as Record<string, unknown>;
  if (message.role === "user") {
    return typeof message.content === "string" || Array.isArray(message.content);
  }
  if (message.role === "assistant") {
    return typeof message.content === "string";
  }
  if (message.role === "tool_result") {
    return typeof message.content === "string" && typeof message.toolUseId === "string";
  }
  return false;
}

function hideUnhydratedToolResultStub(message: GenericMessage): GenericMessage {
  if (
    message.role === "tool_result" &&
    typeof message.content === "string" &&
    isToolResultStubContent(message.content)
  ) {
    return { ...message, content: "" };
  }
  return message;
}

export class SubAgentRunner {
  constructor(private readonly deps: SubAgentRunnerDeps) {}

  async deliverToParent(input: DeliverToParentInput): Promise<DeliverToParentResult> {
    const bus = this.deps.messageBus;
    if (!bus) {
      log.warn(
        { parentSessionId: input.parentSessionId, childSessionId: input.childSessionId },
        "a2a message dropped: message bus unavailable",
      );
      return {
        ok: false,
        disposition: "dropped",
        reason: "message-bus-unavailable",
      };
    }

    const fallbackCreated = this.prepareEphemeralParentDelivery(input);
    try {
      const result = await bus.deliverToParent(input);
      if (!result.ok && fallbackCreated) {
        this.releaseEphemeralParentDelivery(
          input.parentSessionId,
          input.childSessionId,
          input.message.messageId,
          false,
        );
      }
      return result;
    } catch (err) {
      if (fallbackCreated) {
        this.releaseEphemeralParentDelivery(
          input.parentSessionId,
          input.childSessionId,
          input.message.messageId,
          false,
        );
      }
      throw err;
    }
  }

  async peekParentMailbox(parentSessionId: string): Promise<ParentMailboxEntry[]> {
    const bus = this.deps.messageBus;
    return bus ? await bus.peekParentMailbox(parentSessionId) : [];
  }

  async acknowledgeParentMailbox(
    parentSessionId: string,
    ids: readonly string[],
  ): Promise<number> {
    const bus = this.deps.messageBus;
    return bus ? await bus.acknowledgeParentMailbox(parentSessionId, ids) : 0;
  }

  setParentWakeHandler(handler: ParentWakeHandler | null): void {
    this.deps.messageBus?.setWakeHandler(handler);
  }

  /**
   * Resolve a host-minted child address from persisted metadata. The bus checks
   * parentSessionId equality and audits cross-origin drops before delivery.
   */
  async resolveSubAgentAddress(
    parentSessionId: string,
    childSessionId: string,
    messageId: string,
  ): Promise<ResolvedSubAgentAddress | null> {
    if (!isValidSessionId(childSessionId)) return null;
    const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(childSessionId);
    if (!meta) {
      // A present-but-invalid/unreadable file is never treated as missing.
      if (this.deps.subAgentMemoryManager.hasSessionMetadataFile(childSessionId)) {
        return null;
      }
      const run = this.trackedRuns.get(childSessionId);
      const fallback = run?.ephemeralParentDelivery;
      if (
        !run
        || !run.initialMetadataFailed
      || run.ephemeralFallbackConsumed === true
        || run.childSessionId !== childSessionId
        || run.originSessionId !== parentSessionId
        || run.title.length === 0
        || !fallback
        || fallback.parentSessionId !== parentSessionId
        || fallback.childSessionId !== childSessionId
        || fallback.messageId !== messageId
      ) {
        return null;
      }
      return {
        parentSessionId: fallback.parentSessionId,
        childSessionId: fallback.childSessionId,
        childTitle: fallback.childTitle,
        ephemeralMessageId: fallback.messageId,
      };
    }
    if (
      meta.sessionKind !== "subagent"
      || !meta.originSessionId
      || !meta.subAgentTitle
    ) {
      return null;
    }
    if (meta.originSessionId !== parentSessionId) {
      log.warn(
        { parentSessionId, childSessionId },
        "a2a address resolution observed a cross-origin child",
      );
    }
    return {
      parentSessionId: meta.originSessionId,
      childSessionId,
      childTitle: meta.subAgentTitle,
    };
  }

  releaseEphemeralParentDelivery(
    parentSessionId: string,
    childSessionId: string,
    messageId: string,
    consume = true,
  ): void {
    const run = this.trackedRuns.get(childSessionId);
    const fallback = run?.ephemeralParentDelivery;
    if (
      !run
      || !fallback
      || fallback.parentSessionId !== parentSessionId
      || fallback.childSessionId !== childSessionId
      || fallback.messageId !== messageId
    ) {
      return;
    }
    delete run.ephemeralParentDelivery;
    if (consume) run.ephemeralFallbackConsumed = true;
    this.pruneTrackedRuns();
  }

  private prepareEphemeralParentDelivery(input: DeliverToParentInput): boolean {
    const run = this.trackedRuns.get(input.childSessionId);
    if (
      !run
      || !run.initialMetadataFailed
      || run.ephemeralFallbackConsumed === true
      || run.originSessionId !== input.parentSessionId
      || run.childSessionId !== input.childSessionId
      || !isA2ATerminalTaskState(run.taskState)
      || input.message.role !== A2A_ROLE_AGENT
      || input.message.contextId !== input.parentSessionId
      || input.message.taskId !== input.childSessionId
      || input.message.metadata?.taskState !== run.taskState
    ) {
      return false;
    }
    if (run.ephemeralParentDelivery) {
      return false;
    }
    run.ephemeralParentDelivery = {
      parentSessionId: input.parentSessionId,
      childSessionId: input.childSessionId,
      childTitle: run.title,
      messageId: input.message.messageId,
    };
    return true;
  }

  /**
   * Per-`childSessionId` in-flight lock. `resume()` loads metadata, runs a
   * turn, then rewrites the metadata (`resumeCount`/`cumulativeRounds`). That
   * load→run→save is a LOGICAL transaction; `withFileLock` (memory-manager)
   * only serializes the individual file WRITE, not the whole read-modify-write.
   * Two concurrent resumes of the same session would each load the same
   * pre-increment metadata, run, and last-writer-wins the counter (a lost
   * update that defeats MAX_RESUMES). This in-memory map fail-closes the
   * second concurrent resume of the same id. Single main-process, so a Map
   * keyed on the session id is sufficient — no cross-process contention.
   */
  private readonly inFlight = new Map<string, Promise<SubAgentSpawnResult>>();
  private readonly trackedRuns = new Map<string, TrackedSubAgentRun>();

  private readonly activeChildren = new Map<string, ActiveSubAgentChild>();

  isSubAgentOriginActive(originSessionId: string): boolean {
    if (!originSessionId) return false;
    if ([...this.activeChildren.values()].some((child) =>
      child.originSessionId === originSessionId)) {
      return true;
    }
    if ([...this.uniqueTrackedRuns()].some((run) =>
      run.originSessionId === originSessionId
      && !isA2ATerminalTaskState(run.taskState))) {
      return true;
    }
    const persisted = this.deps.subAgentMemoryManager.listSessions({
      kind: "subagent",
      limit: MAX_TRACKED_RUNS,
    });
    return persisted.some((session) => {
      const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(session.id);
      return meta?.sessionKind === "subagent"
        && meta.originSessionId === originSessionId
        && !isA2ATerminalTaskState(
          meta.subAgentTaskState ?? A2ATaskState.SUBMITTED,
        );
    });
  }
  async resolveSubAgentSender(childSessionId: string): Promise<ResolvedA2ASender | null> {
    if (!isValidSessionId(childSessionId)) return null;
    const active = this.activeChildren.get(childSessionId);
    if (!active?.originSessionId || !active.loop.hasActiveTurn()) return null;
    const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(childSessionId);
    if (
      meta?.sessionKind !== "subagent"
      || meta.originSessionId !== active.originSessionId
      || !meta.subAgentTitle
    ) {
      return null;
    }
    return {
      childSessionId,
      originSessionId: active.originSessionId,
      title: maskSubAgentText(meta.subAgentTitle).slice(0, 120),
      background: active.background,
      taskState: A2ATaskState.WORKING,
    };
  }

  async sendAgentMessage(input: A2AAgentSendRequest): Promise<A2AAgentSendResult> {
    const bus = this.deps.agentMessageBus;
    if (!bus) {
      log.warn(
        { senderChildSessionId: input.senderChildSessionId, recipient: input.recipient },
        "a2a agent message dropped: message bus unavailable",
      );
      return {
        ok: false,
        disposition: "dropped",
        reason: "message-bus-unavailable",
      };
    }
    if (input.waitForReply !== true) return bus.send(input);

    const active = this.activeChildren.get(input.senderChildSessionId);
    const questionWait = active?.questionWait;
    if (!active || !questionWait || questionWait.stage) {
      await bus.auditToolDrop({
        senderChildSessionId: input.senderChildSessionId,
        recipient: input.recipient,
        messageId: input.messageId,
        reason: "question-already-outstanding",
      });
      return {
        ok: false,
        disposition: "dropped",
        reason: "question-already-outstanding",
      };
    }

    const staged = await bus.stageQuestion(input);
    if (!staged.ok) return staged.result;
    const current = this.activeChildren.get(input.senderChildSessionId);
    const part = staged.result.canonicalMessage.parts[0];
    const canonicalPrompt = part && "text" in part && typeof part.text === "string"
      ? part.text.trim()
      : "";
    if (
      current !== active
      || current.questionWait !== questionWait
      || canonicalPrompt !== questionWait.prompt
    ) {
      const rolledBack = await bus.rollbackStagedQuestion(staged.stage);
      const reason = rolledBack ? "aborted" : "storage-failed";
      await bus.auditToolDrop({
        senderChildSessionId: input.senderChildSessionId,
        recipient: input.recipient,
        messageId: input.messageId,
        reason,
      });
      return { ok: false, disposition: "dropped", reason };
    }
    questionWait.stage = staged.stage;
    return staged.result;
  }

  async auditAgentSendDrop(input: A2AAgentSendAuditInput): Promise<void> {
    const bus = this.deps.agentMessageBus;
    if (bus) {
      await bus.auditToolDrop(input);
      return;
    }
    log.warn(
      {
        senderChildSessionId: input.senderChildSessionId,
        recipient: input.recipient,
        reason: input.reason,
      },
      "a2a agent message drop audit: message bus unavailable",
    );
  }

  async resolveSubAgentPeer(
    senderChildSessionId: string,
    recipientChildSessionId: string,
  ): Promise<ResolveSubAgentPeerResult> {
    if (!isValidSessionId(senderChildSessionId)) {
      return { ok: false, reason: "unknown-sender" };
    }
    if (!isValidSessionId(recipientChildSessionId)) {
      return { ok: false, reason: "unknown-recipient" };
    }

    const loadEndpoint = (
      childSessionId: string,
    ): {
      childSessionId: string;
      originSessionId: string;
      title: string;
      taskState: A2AProjectedTaskState;
    } | null => {
      const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(childSessionId);
      if (
        meta?.sessionKind !== "subagent"
        || !meta.originSessionId
        || !meta.subAgentTitle
      ) {
        return null;
      }
      return {
        childSessionId,
        originSessionId: meta.originSessionId,
        title: maskSubAgentText(meta.subAgentTitle).slice(0, 120),
        taskState: meta.subAgentTaskState ?? A2ATaskState.SUBMITTED,
      };
    };

    const sender = loadEndpoint(senderChildSessionId);
    if (!sender) return { ok: false, reason: "unknown-sender" };
    const recipient = loadEndpoint(recipientChildSessionId);
    if (!recipient) return { ok: false, reason: "unknown-recipient" };
    if (sender.originSessionId !== recipient.originSessionId) {
      return { ok: false, reason: "cross-origin" };
    }

    const active = this.activeChildren.get(recipientChildSessionId);
    const recipientIsActive = active?.originSessionId === sender.originSessionId;
    return {
      ok: true,
      originSessionId: sender.originSessionId,
      sender: {
        childSessionId: sender.childSessionId,
        title: sender.title,
      },
      recipient: {
        childSessionId: recipient.childSessionId,
        title: recipient.title,
        taskState: recipientIsActive ? A2ATaskState.WORKING : recipient.taskState,
        ...(recipientIsActive
          ? { activeLoop: active.loop }
          : {}),
      },
    };
  }

  reserveQuestionWait(
    senderChildSessionId: string,
    prompt: string,
  ): ReserveQuestionWaitResult {
    const active = this.activeChildren.get(senderChildSessionId);
    if (
      !active
      || !active.loop.hasActiveTurn()
      || active.questionWait
      || !prompt.trim()
    ) {
      return { ok: false, reason: "question-already-outstanding" };
    }

    const token = Symbol(senderChildSessionId);
    active.questionWait = {
      token,
      prompt: normalizeSuspensionPrompt(
        prompt,
        QUESTION_SUSPENSION_PROMPT_FALLBACK,
      ),
    };
    return { ok: true, token };
  }

  async cancelQuestionWait(
    senderChildSessionId: string,
    token: unknown,
  ): Promise<boolean> {
    const active = this.activeChildren.get(senderChildSessionId);
    if (!active?.questionWait || active.questionWait.token !== token) return false;
    const { stage } = active.questionWait;
    delete active.questionWait;
    if (!stage) return true;
    return await this.deps.agentMessageBus?.rollbackStagedQuestion(stage) ?? false;
  }

  private questionDeliveryFailure(
    result: SubAgentSpawnResult,
    message: string,
  ): SubAgentSpawnResult {
    const masked = maskSubAgentText(message);
    return {
      summary: masked,
      toolCallCount: result.toolCallCount,
      turnCount: result.turnCount,
      childSessionId: result.childSessionId,
      entries: result.entries,
      ok: false,
      error: masked,
      ...(result.stopReason === "interrupted" || message === "sub-agent run interrupted"
        ? { stopReason: "interrupted" as const }
        : {}),
    };
  }

  private async prepareQuestionStageForPersistence(
    questionWait: ActiveSubAgentChild["questionWait"] | undefined,
    result: SubAgentSpawnResult,
  ): Promise<SubAgentSpawnResult> {
    normalizeResultSuspension(result);
    const expectsQuestion = result.suspension?.reason === "question";
    const stage = questionWait?.stage;
    const stageMatches = Boolean(
      stage
      && questionWait
      && result.suspension?.prompt === questionWait.prompt,
    );
    if (expectsQuestion && stageMatches) return result;

    if (stage) {
      const rolledBack = await this.deps.agentMessageBus?.rollbackStagedQuestion(stage)
        ?? false;
      if (!rolledBack) {
        return this.questionDeliveryFailure(
          result,
          "sub-agent question staging rollback failed",
        );
      }
    }
    return expectsQuestion
      ? this.questionDeliveryFailure(
          result,
          "sub-agent question delivery was not staged",
        )
      : result;
  }

  private async commitQuestionStageAfterPersistence(
    questionWait: ActiveSubAgentChild["questionWait"] | undefined,
    result: SubAgentSpawnResult,
  ): Promise<SubAgentSpawnResult> {
    if (result.suspension?.reason !== "question") return result;
    const stage = questionWait?.stage;
    const bus = this.deps.agentMessageBus;
    if (!stage || !bus) {
      return this.questionDeliveryFailure(
        result,
        "sub-agent question delivery commit is unavailable",
      );
    }
    const committed = await bus.commitStagedQuestion(stage);
    return committed.ok
      ? result
      : this.questionDeliveryFailure(
          result,
          "sub-agent question delivery commit failed: " + committed.reason,
        );
  }

  private async cleanupTerminalRecipientMailbox(
    childSessionId: string,
    taskState: A2AProjectedTaskState,
  ): Promise<void> {
    if (!isA2ATerminalTaskState(taskState)) return;
    const cleaned = await this.deps.agentMessageBus
      ?.cleanupTerminalRecipientMailbox?.(childSessionId);
    if (cleaned && !cleaned.ok) {
      log.warn(
        "sub-agent terminal agent mailbox cleanup failed for %s",
        childSessionId,
      );
    }
  }

  private registerActiveChild(args: {
    childSessionId: string;
    originSessionId?: string;
    title: string;
    loop: ConversationLoop;
    background: boolean;
  }): symbol {
    const lease = Symbol(args.childSessionId);
    this.activeChildren.set(args.childSessionId, { ...args, lease });
    return lease;
  }

  private unregisterActiveChild(childSessionId: string, lease: symbol): void {
    const active = this.activeChildren.get(childSessionId);
    if (active?.lease === lease) this.activeChildren.delete(childSessionId);
  }

  listRunStatuses(originSessionId: string): SubAgentRunSnapshot[] {
    return [...this.uniqueTrackedRuns()]
      .filter((run) => this.isRunVisibleToOrigin(run, originSessionId))
      .map((run) => this.snapshotRun(run))
      .sort((a, b) => {
        if (a.status === "running" && b.status !== "running") return -1;
        if (a.status !== "running" && b.status === "running") return 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }

  getRunStatus(id: string, originSessionId: string): SubAgentRunSnapshot | null {
    const run = this.trackedRuns.get(id);
    if (run && !this.isRunVisibleToOrigin(run, originSessionId)) return null;
    return run ? this.snapshotRun(run) : null;
  }

  getPersistedTranscript(
    request: PersistedSubAgentTranscriptRequest,
  ): PersistedSubAgentTranscriptResult {
    const childSessionId = typeof request.childSessionId === "string" && isValidSessionId(request.childSessionId)
      ? request.childSessionId
      : undefined;
    if (!childSessionId) return { ok: false, error: "invalid-child-session-id" };

    const makeResult = (id: string, meta: ReturnType<MemoryManager["loadSessionMetadata"]>) => {
      const loaded = this.deps.subAgentMemoryManager.loadSession(id);
      if (!Array.isArray(loaded)) return null;
      const hydrated = this.deps.subAgentMemoryManager.rehydrateToolResultArtifacts(id, loaded);
      const messages = hydrated
        .filter(isGenericMessage)
        .map(hideUnhydratedToolResultStub)
        .map(serializeHistoryMessage);
      return {
        ok: true as const,
        childSessionId: id,
        messages,
        ...(meta?.subAgentTitle ? { title: meta.subAgentTitle } : {}),
        ...(meta?.spawnId ? { spawnId: meta.spawnId } : {}),
        ...(meta?.originToolUseId ? { originToolUseId: meta.originToolUseId } : {}),
      };
    };

    for (const id of [childSessionId]) {
      const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(id);
      if (meta?.sessionKind !== "subagent") continue;
      if (request.originSessionId) {
        if (meta.originSessionId !== request.originSessionId) continue;
      }
      const result = makeResult(id, meta);
      if (result) return result;
    }
    return { ok: false, error: "sub-agent transcript not found" };
  }

  interruptRun(id: string, originSessionId: string): { ok: boolean; message: string; run?: SubAgentRunSnapshot } {
    const run = this.trackedRuns.get(id);
    if (!run || !this.isRunVisibleToOrigin(run, originSessionId)) {
      return { ok: false, message: `sub-agent run not found: ${id}` };
    }
    if (run.status !== "running" || !run.abort) {
      return {
        ok: false,
        message: `sub-agent run is not running: ${id}`,
        run: this.snapshotRun(run),
      };
    }
    run.abort();
    this.updateRun(run, {
      status: "interrupted",
      taskState: projectSubAgentRunState("interrupted"),
      stopReason: "interrupted",
    });
    return {
      ok: true,
      message: `interrupt requested for sub-agent run: ${id}`,
      run: this.snapshotRun(run),
    };
  }

  private *uniqueTrackedRuns(): Iterable<TrackedSubAgentRun> {
    const seen = new Set<TrackedSubAgentRun>();
    for (const run of this.trackedRuns.values()) {
      if (seen.has(run)) continue;
      seen.add(run);
      yield run;
    }
  }

  private snapshotRun(run: TrackedSubAgentRun): SubAgentRunSnapshot {
    return {
      ...(run.spawnId ? { spawnId: run.spawnId } : {}),
      childSessionId: run.childSessionId,
      title: run.title,
      status: run.status,
      taskState: run.taskState,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      toolCallCount: run.toolCallCount,
      turnCount: run.turnCount,
      entries: run.entries,
      ...(run.summary !== undefined ? { summary: run.summary } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
      ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
      ...(run.suspension !== undefined ? { suspension: run.suspension } : {}),
    };
  }

  private trackRun(args: {
    spawnId?: string;
    childSessionId: string;
    originSessionId?: string;
    title: string;
    abort?: () => void;
    initialTaskState?: A2AProjectedTaskState;
    registerChildAlias?: boolean;
  }): TrackedSubAgentRun {
    const now = new Date().toISOString();
    const taskState = args.initialTaskState ?? projectSubAgentRunState("submitted");
    const run: TrackedSubAgentRun = {
      ...(args.spawnId ? { spawnId: args.spawnId } : {}),
      childSessionId: args.childSessionId,
      ...(args.originSessionId ? { originSessionId: args.originSessionId } : {}),
      title: args.title,
      status: subAgentRunStatusFromTaskState(taskState),
      taskState,
      startedAt: now,
      updatedAt: now,
      toolCallCount: 0,
      turnCount: 0,
      entries: [],
      ...(args.abort ? { abort: args.abort } : {}),
    };
    if (args.registerChildAlias !== false) {
      this.trackedRuns.set(args.childSessionId, run);
    }
    if (args.spawnId) this.trackedRuns.set(args.spawnId, run);
    this.pruneTrackedRuns();
    return run;
  }

  private attachTrackedRunChildAlias(run: TrackedSubAgentRun): void {
    this.trackedRuns.set(run.childSessionId, run);
  }

  private isRunVisibleToOrigin(run: TrackedSubAgentRun, originSessionId: string): boolean {
    return Boolean(originSessionId) && run.originSessionId === originSessionId;
  }

  private updateRun(
    run: TrackedSubAgentRun,
    patch: Partial<Omit<TrackedSubAgentRun, "spawnId" | "childSessionId" | "title" | "startedAt">>,
  ): void {
    if (
      patch.taskState !== undefined
      && !canTransitionA2ATaskState(run.taskState, patch.taskState)
    ) {
      return;
    }
    if (patch.taskState === undefined && isA2ATerminalTaskState(run.taskState)) {
      return;
    }
    const normalizedPatch = patch.taskState === undefined
      ? patch
      : {
          ...patch,
          status: subAgentRunStatusFromTaskState(patch.taskState),
        };
    Object.assign(run, normalizedPatch, { updatedAt: new Date().toISOString() });
  }

  private finalizeRun(
    run: TrackedSubAgentRun,
    result: SubAgentSpawnResult,
  ): void {
    result.summary = maskSubAgentText(result.summary);
    if (result.error !== undefined) {
      result.error = maskSubAgentText(result.error);
    }
    normalizeResultSuspension(result);
    const taskState = projectSubAgentResultState(result);
    const status = subAgentRunStatusFromTaskState(taskState);
    const patch: Partial<Omit<TrackedSubAgentRun, "spawnId" | "childSessionId" | "title" | "startedAt">> = {
      status,
      taskState,
      toolCallCount: result.toolCallCount,
      turnCount: result.turnCount,
      entries: result.entries,
      stopReason: result.stopReason,
      suspension: result.suspension,
    };
    if (status === "error") {
      patch.error = result.error ?? result.summary;
      delete run.summary;
    } else {
      patch.summary = result.summary;
      delete run.error;
    }
    delete run.abort;
    this.updateRun(run, patch);
  }

  private pruneTrackedRuns(): void {
    const unique = [...this.uniqueTrackedRuns()];
    if (unique.length <= MAX_TRACKED_RUNS) return;
    const removable = unique
      .filter((run) => run.status !== "running" && !run.ephemeralParentDelivery)
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
    for (const run of removable.slice(0, unique.length - MAX_TRACKED_RUNS)) {
      this.trackedRuns.delete(run.childSessionId);
      if (run.spawnId) this.trackedRuns.delete(run.spawnId);
    }
  }

  /**
   * Shared child-loop reconstruction used by BOTH `spawn()` and `resume()`.
   * Returns the composed {@link ConversationLoopDeps}, the resolved scoped tool
   * list (the frozen permission surface), and the wrapped ApprovalGate.
   *
   * The tool surface is derived ONLY from `frozenSourceTools`:
   *   - spawn passes the caller-supplied `sourceTools` (or null → full parent
   *     surface minus blocklist, the historical "no allowlist" behavior);
   *   - resume passes `meta.sourceTools` from disk as a NON-NULL explicit list,
   *     so a resumed child's scope is frozen to exactly what the original spawn
   *     recorded — the parent registry is never consulted, closing scope
   *     widening mathematically (a resume cannot gain tools the parent gained
   *     after the spawn).
   *
   * The blocklist (agent_spawn) is ALWAYS stripped so a sub-agent — spawned or
   * resumed — cannot recurse.
   */
  private buildChildDeps(args: {
    /**
     * The frozen source-tool allowlist. `null` ⇒ full parent surface minus the
     * blocklist (spawn's "no explicit allowlist" path). A non-null array ⇒ the
     * child is scoped to exactly those names (minus the blocklist). resume
     * ALWAYS passes a non-null array (meta.sourceTools) so it never widens.
     */
    frozenSourceTools: string[] | null;
    includeAgentSend?: boolean;
    title: string;
    profileModel: string | undefined;
  }): {
    childDeps: ConversationLoopDeps;
    scopedTools: import("../tools/base.js").Tool[];
  } {
    // C3(b): build the sub-agent's tool surface. Always strip the blocklist
    // (agent_spawn) so a sub-agent cannot recurse. When the allowlist is
    // null (spawn's no-allowlist path) we still want the agent_spawn block to
    // apply, so we start from the full tool list and intersect with the
    // blocklist. resume never takes the null branch — it hands a frozen list.
    const exposeAgentSend = args.includeAgentSend === true
      || args.frozenSourceTools?.includes("agent_send") === true;
    const frozenSourceTools = args.frozenSourceTools && args.includeAgentSend
      ? [...new Set([...args.frozenSourceTools, "agent_send"])]
      : args.frozenSourceTools;
    const filteredSourceTools = frozenSourceTools
      ? frozenSourceTools.filter((name) => !SUB_AGENT_TOOL_BLOCKLIST.has(name))
      : null;
    const baseToolNames = filteredSourceTools
      ? filteredSourceTools.filter((name) => name !== "agent_send")
      : this.deps.toolRegistry
          .listAll()
          .map((tool) => tool.name)
          .filter((name) =>
            !SUB_AGENT_TOOL_BLOCKLIST.has(name) && name !== "agent_send");
    const scopedRegistry = this.deps.toolRegistry.createScopedView(baseToolNames);
    if (exposeAgentSend) {
      const agentSend = this.deps.toolRegistry.findByName("agent_send");
      if (agentSend) scopedRegistry.register({ ...agentSend, modelVisible: true });
    }
    const scopedTools = scopedRegistry.listAll();
    const forcedActivePluginIds = new Set(
      filteredSourceTools
        ? scopedTools
            .filter((tool) => tool.source === "plugin" && tool.pluginId)
            .map((tool) => tool.pluginId as string)
        : [],
    );
    const forcedActiveToolNames = filteredSourceTools
      ? new Set(scopedTools.map((tool) => tool.name))
      : undefined;

    // Wrap the parent ApprovalGate so approval modals from this sub-agent's
    // tool calls show "[Sub-Agent: <title>]" in their reason text.
    const wrappedApprovalGate = this.deps.parentDeps.approvalGate
      ? makeSubAgentApprovalAdapter(this.deps.parentDeps.approvalGate, args.title)
      : undefined;

    // Compose deps for the child loop. We share the parent's permissionManager,
    // hookRunner so the child plays by the same security rules.
    // History is fresh because ConversationLoop.constructor instantiates a new
    // ConversationHistory (spawn); resume re-hydrates it via loadSession.
    // Resolve the child's model from the profile's `model:` frontmatter
    // against the parent's active vendor. null → leave modelOverride unset
    // so the child runs on the parent's configured model.
    const activeVendor = this.deps.parentDeps.settingsService.get("llm").provider;
    const resolvedModel = resolveSubAgentModel(args.profileModel, activeVendor);

    const childDeps: ConversationLoopDeps = {
      ...this.deps.parentDeps,
      toolRegistry: scopedRegistry,
      // Route the child's session persistence to the ISOLATED subagent store
      // (`~/.lvis/subagent/`), never the parent's main-chat MemoryManager.
      // Reusing the parent store is what leaked orphan sub-agent JSONL into
      // the main `~/.lvis/sessions/` list; the child's saveSession/loadSession
      // (via `self.deps.memoryManager` in run-turn) now target the subagent
      // namespace under the regex-valid childSessionId set by the caller.
      memoryManager: this.deps.subAgentMemoryManager,
      approvalGate: wrappedApprovalGate,
      // Sub-agent runs are fire-and-forget — no post-turn hook chain to keep
      // the parent session unaffected.
      postTurnHookChain: undefined,
      // Sub-agent does not request_plugin (its tool surface is fixed at spawn).
      pluginRuntime: undefined,
      forcedActivePluginIds,
      ...(forcedActiveToolNames ? { forcedActiveToolNames } : {}),
      // C2(c): the sub-agent uses the parent's SkillOverlay reference to
      // load skills if the user grants — but its own session id will be
      // tracked separately via setActiveSessionId.
      skillOverlay: this.deps.parentDeps.skillOverlay,
      // #1112: per-profile model override. undefined when unresolved so the
      // child inherits the parent vendor block's model.
      modelOverride: resolvedModel ?? undefined,
    };
    return { childDeps, scopedTools };
  }

  /**
   * Spawn a sub-agent and run it inline. Returns the final summary text.
   */
  async spawn(
    input: SubAgentSpawnInput,
    callbacks?: SubAgentSpawnCallbacks,
  ): Promise<SubAgentSpawnResult> {
    const childSessionId = buildChildSessionId(input.originSessionId);
    const cancellation = new AbortController();
    let childForAbort: ConversationLoop | undefined;
    const trackedRun = this.trackRun({
      spawnId: input.spawnId,
      childSessionId,
      originSessionId: input.originSessionId,
      title: input.title,
      abort: () => {
        cancellation.abort();
        childForAbort?.abortCurrentTurn();
      },
    });
    callbacks?.onLinked?.({ childSessionId });

    const setupResult = (() => {
      try {
        // Resolve the profile's mode → working-posture preamble + round-budget hint.
        // Unknown / absent mode resolves to the inert `default` mode; a non-empty
        // unmatched mode is logged so the audit trail captures the typo.
        const modeResult = resolveAgentMode(input.profileMode);
        if (!modeResult.matched) {
          log.warn(
            "sub-agent: unknown mode '%s' — using default (inert) mode",
            modeResult.requested,
          );
        }

        // Host-assigned round budget. Resolution: an explicit host `maxRounds`
        // wins; otherwise use the profile hint, then the default. The LLM cannot
        // change this policy because agent_spawn exposes no raw maxTurns field.
        const requestedRounds =
          input.maxRounds ?? modeResult.config.maxToolRoundsHint ?? MAX_TURNS_DEFAULT;
        const cappedRounds = Math.max(1, Math.min(MAX_TURNS_CAP, requestedRounds));

        // sourceTools empty/absent retains the historical full parent surface
        // minus the hard blocklist. Resume uses its frozen metadata instead.
        const frozenSourceTools = input.sourceTools && input.sourceTools.length > 0
          ? input.sourceTools
          : null;
        const { childDeps, scopedTools } = this.buildChildDeps({
          frozenSourceTools,
          title: input.title,
          profileModel: input.profileModel,
          includeAgentSend: true,
        });

        const child = new ConversationLoop(childDeps);
        child.newConversation(
          "subagent",
          input.projectRoot
            ? {
                projectRoot: input.projectRoot,
                ...(input.projectName ? { projectName: input.projectName } : {}),
              }
            : childDeps.getDefaultProject?.(),
        );
        childForAbort = child;
        // Bind persistence and tracing to the addressable child id before work.
        child.sessionId = childSessionId;
        child.sessionKind = "subagent";
        child.rebindTracer();
        return { ok: true as const, modeResult, cappedRounds, scopedTools, child };
      } catch (error) {
        return { ok: false as const, error };
      }
    })();

    if (!setupResult.ok) {
      trackedRun.initialMetadataFailed = true;
      const interrupted = cancellation.signal.aborted;
      const message = interrupted
        ? "sub-agent run interrupted"
        : (setupResult.error as Error).message ?? "sub-agent setup failed";
      const result: SubAgentSpawnResult = {
        summary: message,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId,
        entries: [],
        ok: false,
        error: message,
        ...(interrupted ? { stopReason: "interrupted" as const } : {}),
      };
      this.finalizeRun(trackedRun, result);
      if (!interrupted) callbacks?.onError?.(maskSubAgentText(message));
      return result;
    }

    const { modeResult, cappedRounds, scopedTools, child } = setupResult;
    // Persist resume metadata (PR-B) alongside the child JSONL before provider
    // validation and the first turn, into the SAME isolated subagent namespace (child loop's
    // MemoryManager). run-turn's saveSession writes the JSONL; this writes the
    // .meta.json sibling. `sessionKind: "subagent"` lets listing/rotation
    // distinguish sub-agent sessions from main/routine. The scoped tool surface
    // (`scopedTools`, the resolved allowlist the child was frozen with) is the
    // exact set PR-C's resume must re-scope to — permission is frozen at spawn,
    // not re-granted on resume. `resumeCount`/`cumulativeRounds` init to 0 for
    // PR-D's loop guards. No resume logic here — this is metadata foundation.
    const spawnMetadata: Parameters<MemoryManager["saveSessionMetadata"]>[1] = {
      sessionKind: "subagent",
      ...(!child.getSessionProjectIsDefault() ? child.getSessionProjectContext() : {}),
      sourceTools: scopedTools.map((tool) => tool.name),
      ...(input.profileModel !== undefined ? { profileModel: input.profileModel } : {}),
      ...(input.profileMode !== undefined ? { profileMode: input.profileMode } : {}),
      ...(input.originSessionId !== undefined ? { originSessionId: input.originSessionId } : {}),
      ...(input.toolUseId !== undefined ? { originToolUseId: input.toolUseId } : {}),
      ...(input.spawnId !== undefined ? { spawnId: input.spawnId } : {}),
      subAgentTitle: input.title,
      budgetResumeCount: 0,
      questionAnswerCount: 0,
      // Legacy alias kept in sync during the compatibility window.
      resumeCount: 0,
      cumulativeRounds: 0,
      subAgentTaskState: A2ATaskState.SUBMITTED,
      subAgentSuspensionReason: undefined,
      subAgentSuspensionPrompt: undefined,
    };
    try {
      await this.deps.subAgentMemoryManager.saveSessionMetadata(
        childSessionId,
        spawnMetadata,
      );
    } catch (err) {
      trackedRun.initialMetadataFailed = true;
      const interrupted = cancellation.signal.aborted;
      const message = interrupted
        ? "sub-agent run interrupted"
        : (err as Error).message ?? "sub-agent metadata setup failed";
      const result: SubAgentSpawnResult = {
        summary: message,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId,
        entries: [],
        ok: false,
        error: message,
        ...(interrupted ? { stopReason: "interrupted" as const } : {}),
      };
      this.finalizeRun(trackedRun, result);
      if (!interrupted) callbacks?.onError?.(maskSubAgentText(message));
      return result;
    }

    let completedQuestionWait: ActiveSubAgentChild["questionWait"];

    const metadataForResult = (
      terminalResult: SubAgentSpawnResult,
    ): Parameters<MemoryManager["saveSessionMetadata"]>[1] => ({
      ...spawnMetadata,
      cumulativeRounds: terminalResult.turnCount,
      subAgentTaskState: projectSubAgentResultState(terminalResult),
      subAgentSuspensionReason: terminalResult.suspension?.reason,
      subAgentSuspensionPrompt: terminalResult.suspension?.prompt,
    });
    const persistFinalResult = async (
      terminalResult: SubAgentSpawnResult,
    ): Promise<SubAgentSpawnResult> => {
      let stableResult = await this.prepareQuestionStageForPersistence(
        completedQuestionWait,
        terminalResult,
      );
      // Commit point: no new interrupt is accepted while terminal metadata is
      // persisted, so the in-memory and durable projections cannot diverge.
      delete trackedRun.abort;
      let durableTaskState: A2AProjectedTaskState | undefined;
      let durableResult: SubAgentSpawnResult | undefined;
      const saveResult = async (next: SubAgentSpawnResult): Promise<void> => {
        await this.deps.subAgentMemoryManager.saveSessionMetadata(
          childSessionId,
          metadataForResult(next),
        );
        durableTaskState = projectSubAgentResultState(next);
        durableResult = next;
      };
      try {
        await saveResult(stableResult);
      } catch (err) {
        const interrupted = cancellation.signal.aborted
          || stableResult.stopReason === "interrupted";
        const message = interrupted
          ? "sub-agent run interrupted"
          : (err as Error).message ?? "sub-agent metadata update failed";
        stableResult = await this.prepareQuestionStageForPersistence(
          completedQuestionWait,
          this.questionDeliveryFailure(stableResult, message),
        );
        this.finalizeRun(trackedRun, stableResult);
        if (!interrupted) callbacks?.onError?.(maskSubAgentText(message));
        return stableResult;
      }

      if (cancellation.signal.aborted && stableResult.suspension?.reason === "question") {
        stableResult = await this.prepareQuestionStageForPersistence(
          completedQuestionWait,
          this.questionDeliveryFailure(stableResult, "sub-agent run interrupted"),
        );
        try {
          await saveResult(stableResult);
        } catch {
          stableResult = durableResult ?? stableResult;
          // INPUT_REQUIRED remains durable, but no parent delivery was exposed.
        }
      } else {
        const committed = await this.commitQuestionStageAfterPersistence(
          completedQuestionWait,
          stableResult,
        );
        if (committed !== stableResult) {
          stableResult = committed;
          try {
            await saveResult(stableResult);
          } catch {
            stableResult = durableResult ?? stableResult;
            // The parent delivery failed and the staged envelope was rolled back.
          }
        }
      }

      if (durableTaskState) {
        await this.cleanupTerminalRecipientMailbox(childSessionId, durableTaskState);
      }
      this.finalizeRun(trackedRun, stableResult);
      if (!stableResult.ok && stableResult.error?.includes("question delivery")) {
        callbacks?.onError?.(stableResult.error);
      }
      return stableResult;
    };

    if (cancellation.signal.aborted) {
      const message = "sub-agent run interrupted";
      return await persistFinalResult({
        summary: message,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId,
        entries: [],
        ok: false,
        error: message,
        stopReason: "interrupted",
      });
    }

    if (!child.hasProvider()) {
      const message = "sub-agent: LLM provider not configured";
      callbacks?.onError?.(maskSubAgentText(message));
      return await persistFinalResult({
        summary: message,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId,
        entries: [],
        ok: false,
        error: message,
      });
    }
    this.updateRun(trackedRun, { taskState: projectSubAgentRunState("running") });

    let totalToolCalls = 0;
    let lastText = "";
    let turn = 0;

    // Accumulates the child's activity into a `ChatEntry[]` via the shared
    // chat-stream-state reducers (DLP-masked at the source). Snapshots are
    // forwarded on every activity so the sub-agent tab renders live through the
    // same TranscriptRenderer the main chat uses.
    const transcript = new SubAgentTranscriptAccumulator();
    const emitActivity = () => {
      const entries = transcript.snapshot();
      this.updateRun(trackedRun, {
        entries,
        toolCallCount: totalToolCalls,
        turnCount: turn,
      });
      callbacks?.onActivity?.({
        entries,
        toolCallCount: totalToolCalls,
      });
    };
    // Track whether the child loop completed cleanly. Starts false; flips true
    // only after `runTurn` returns without throwing. The catch leaves it false
    // so the error text surfaced as `summary` is reported as a FAILED spawn,
    // never a completed run.
    let ok = false;
    let failureReason: string | undefined;
    let childStopReason: import("./turn/types.js").TurnStopReason | undefined;
    let childInputRequired: TurnInputRequired | undefined;

    // Prepend the mode preamble (posture + auto-skill recommendation) to the
    // instructions. The preamble is empty for the default mode, leaving the
    // profile body to drive the sub-agent unchanged.
    const modePreamble = buildModePreamble(modeResult.config);
    const initialPrompt = modePreamble
      ? `${modePreamble}\n\n${input.instructions}`
      : input.instructions;
    let assistantRounds = 0;

    const activeLease = this.registerActiveChild({
      childSessionId,
      originSessionId: input.originSessionId,
      title: input.title,
      loop: child,
      background: input.background === true,
    });
    try {
      // C3(a): pass `maxRounds` so queryLoop terminates cleanly between
      // rounds — the previous abortCurrentTurn() approach only halted the
      // next streaming response, leaving in-flight tool calls to run.
      // C3(c): pass childSessionId so audit entries from tool calls fire
      // under the child's session id, not the parent's.
      // C3(b): spawnDepth=1 so any agent_spawn invocation that slipped
      // past the registry strip refuses with a clear error.
      const result = await child.runTurn(
        initialPrompt,
        {
          // Forward the FULL child activity — tool calls, permission reviews,
          // reasoning, and assistant rounds — into the shared ChatEntry model.
          // `toolCallCount:0` hardcode removed: real tool counts flow from the
          // accumulator's tool_start/tool_end rows.
          onToolStart: (name, input, meta) => {
            transcript.onToolStart(name, input, meta);
            emitActivity();
          },
          onPermissionReview: (event) => {
            transcript.onPermissionReview(event);
            emitActivity();
          },
          onToolEnd: (name, toolResult, isError, meta, uiPayload, durationMs) => {
            totalToolCalls += 1;
            transcript.onToolEnd(name, toolResult, isError, meta, uiPayload, durationMs);
            emitActivity();
          },
          onAssistantRound: (round) => {
            assistantRounds += 1;
            turn = assistantRounds;
            lastText = round.text;
            transcript.onAssistantRound(round.thought, round.text);
            emitActivity();
          },
          onError: (e) => {
            callbacks?.onError?.(maskSubAgentText(e));
          },
        },
        undefined,
        {
          maxRounds: cappedRounds,
          sessionIdOverride: childSessionId,
          spawnDepth: 1,
          inputOrigin: "llm-tool-arg",
        },
      );
      // `result.toolCalls.length` is the authoritative final count (the
      // incremental `totalToolCalls` matches it round-by-round; pin to the
      // engine's number in case a round dropped a callback).
      totalToolCalls = result.toolCalls.length;
      lastText = result.text;
      childStopReason = result.stopReason;
      childInputRequired = result.inputRequired;
      ok = isSuccessfulSubAgentStopReason(childStopReason, childInputRequired);
      if (!ok) {
        failureReason = subAgentStopFailureReason(childStopReason, lastText, "run");
      }
    } catch (err) {
      if (cancellation.signal.aborted) {
        const message = "sub-agent run interrupted";
        lastText = message;
        failureReason = message;
        childStopReason = "interrupted";
      } else {
        const message = (err as Error).message ?? "sub-agent run failed";
        callbacks?.onError?.(maskSubAgentText(message));
        lastText = message;
        failureReason = message;
      }
    } finally {
      const active = this.activeChildren.get(childSessionId);
      if (active?.lease === activeLease) {
        completedQuestionWait = active.questionWait;
      }
      this.unregisterActiveChild(childSessionId, activeLease);
    }

    if (cancellation.signal.aborted) {
      lastText = "sub-agent run interrupted";
      failureReason = lastText;
      childStopReason = "interrupted";
      ok = false;
    }
    const result: SubAgentSpawnResult = {
      summary: lastText,
      toolCallCount: totalToolCalls,
      turnCount: turn,
      childSessionId,
      // Final DLP-masked transcript, embedded so a reloaded session rebuilds
      // the sub-agent tab without any live stream.
      entries: transcript.snapshot(),
      ok,
      ...(ok ? {} : { error: failureReason ?? lastText }),
      ...(childStopReason ? { stopReason: childStopReason } : {}),
      ...(ok && childStopReason === "round-cap"
        ? {
            suspension: createBudgetSuspension(child.sessionId),
            // Derived compatibility alias for pre-suspension consumers.
            incomplete: true,
          }
        : {}),
      ...(ok && childStopReason === "input-required" && childInputRequired
        ? { suspension: createQuestionSuspension(child.sessionId, childInputRequired) }
        : {}),
    };
    return await persistFinalResult(result);
  }

  /**
   * Resume a previously-spawned sub-agent in the SAME instance by RE-HYDRATING
   * its persisted history and running one fresh-budget continuation turn.
   *
   * ── Security invariant: RE-HYDRATE, never RE-AUTHORIZE ──
   * A resume reconstructs the child from the metadata the ORIGINAL spawn froze
   * to disk. It does NOT re-grant permissions:
   *   - Tool scope is `meta.sourceTools` (the frozen allowlist) minus the
   *     blocklist — the parent registry is NEVER consulted, so a resume cannot
   *     gain a tool the parent registered after the spawn (scope widening is
   *     closed mathematically: there is no "empty → full parent surface" branch;
   *     spawn always persisted the concrete resolved list, so meta.sourceTools
   *     is a complete explicit allowlist).
   *   - `agent_spawn` is stripped from the registry (blocklist) AND the turn
   *     runs at `spawnDepth: 1`, so a resumed child cannot recurse — the same
   *     byte-identical double defense a fresh spawn gets.
   *   - Depth stays 1 (hard-coded); the child persists only to the isolated
   *     `~/.lvis/subagent/` store (child deps' MemoryManager).
   *   - Origin binding: `resumeId` is validated against the calling origin tag
   *     extracted from the id itself. A cross-session resume (conversation B
   *     passing conversation A's childSessionId) is refused fail-closed before
   *     any history is loaded. Untagged ids (no origin prefix) are only
   *     resumable by a no-origin caller, keeping the invariant consistent.
   *
   * ── Loop guards (Commit 2) ──
   * Refused BEFORE any turn (`{ ok:false, resumeExhausted:true }`) when the
   * session already hit `MAX_RESUMES` or `CUMULATIVE_ROUNDS_CEILING`. A
   * per-`childSessionId` in-flight lock fail-closes a second concurrent resume
   * of the same id (the load→run→save transaction is not covered by the
   * file-level write lock).
   *
   * @param resumeId  The `childSessionId` returned by the original spawn (also
   *                  surfaced to the parent LLM via the incomplete tool result).
   * @param continuationInstructions  The follow-up prompt for the fresh turn.
   * @param title     Sub-agent title for the approval-modal label. Not stored
   *                  in metadata, so the caller (agent_spawn) forwards it; a
   *                  resume without a title uses the raw reason text.
   * @param originSessionId  The calling session's id (ctx.metadata.sessionId
   *                  in agent-spawn.ts). Matched against the tag embedded in
   *                  `resumeId` to refuse cross-session hijack attempts.
   */
  async resume(
    resumeId: string,
    continuationInstructions: string,
    title: string,
    callbacks?: SubAgentSpawnCallbacks,
    originSessionId?: string,
    spawnId?: string,
    background = false,
  ): Promise<SubAgentSpawnResult> {
    // In-flight lock: fail-closed if a resume for THIS session is already
    // running. Checked before any load so two concurrent resumes cannot both
    // read the same pre-increment metadata (lost-update on the counters).
    const existing = this.inFlight.get(resumeId);
    if (existing) {
      const message = "sub-agent resume: a resume for this session is already in flight";
      const attempt = this.trackRun({
        spawnId,
        childSessionId: resumeId,
        originSessionId,
        title,
        initialTaskState: A2ATaskState.INPUT_REQUIRED,
        registerChildAlias: false,
      });
      const result: SubAgentSpawnResult = {
        summary: message,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId: resumeId,
        entries: [],
        ok: false,
        error: message,
      };
      this.finalizeRun(attempt, result);
      callbacks?.onError?.(maskSubAgentText(message));
      return result;
    }

    const runPromise = this.runResume(
      resumeId,
      continuationInstructions,
      title,
      callbacks,
      originSessionId,
      spawnId,
      background,
    );
    this.inFlight.set(resumeId, runPromise);
    try {
      return await runPromise;
    } finally {
      this.inFlight.delete(resumeId);
    }
  }

  /** Inner resume body — wrapped by {@link resume} with the in-flight lock. */
  private async runResume(
    resumeId: string,
    continuationInstructions: string,
    title: string,
    callbacks: SubAgentSpawnCallbacks | undefined,
    originSessionId: string | undefined,
    spawnId: string | undefined,
    background: boolean,
  ): Promise<SubAgentSpawnResult> {
    const cancellation = new AbortController();
    let child: ConversationLoop | null = null;
    const trackedRun = this.trackRun({
      spawnId,
      childSessionId: resumeId,
      originSessionId,
      title,
      initialTaskState: A2ATaskState.INPUT_REQUIRED,
      registerChildAlias: false,
      abort: () => {
        cancellation.abort();
        child?.abortCurrentTurn();
      },
    });

    const failureResult = (
      message: string,
      extra?: Partial<SubAgentSpawnResult>,
    ): SubAgentSpawnResult => {
      if (cancellation.signal.aborted) {
        return {
          summary: "sub-agent run interrupted",
          toolCallCount: 0,
          turnCount: 0,
          childSessionId: resumeId,
          entries: [],
          ok: false,
          error: "sub-agent run interrupted",
          stopReason: "interrupted",
        };
      }
      return {
        summary: message,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId: resumeId,
        entries: [],
        ok: false,
        error: message,
        ...extra,
      };
    };
    const finishAttemptFailure = (
      message: string,
      extra?: Partial<SubAgentSpawnResult>,
    ): SubAgentSpawnResult => {
      const result = failureResult(message, extra);
      this.finalizeRun(trackedRun, result);
      if (result.stopReason !== "interrupted") callbacks?.onError?.(maskSubAgentText(message));
      return result;
    };

    if (!isValidSessionId(resumeId)) {
      return finishAttemptFailure(
        'sub-agent resume: invalid resumeId "' + resumeId + '"',
      );
    }

    {
      const tagged = /^sub-([0-9a-f]{8})-[0-9a-f]{8}-/.exec(resumeId);
      const idTag = tagged?.[1] ?? "";
      const expectedTag = originSessionId
        ? createHash("sha256").update(originSessionId).digest("hex").slice(0, 8)
        : "";
      if (idTag !== expectedTag) {
        return finishAttemptFailure(
          "sub-agent resume: resumeId does not belong to this session",
        );
      }
    }

    const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(resumeId);
    if (meta === null) {
      return finishAttemptFailure(
        'sub-agent resume: no session metadata for "' + resumeId + '"',
      );
    }
    if (meta.sessionKind !== "subagent") {
      return finishAttemptFailure(
        'sub-agent resume: session "' + resumeId
          + '" is not a sub-agent (kind=' + (meta.sessionKind ?? "unknown") + ")",
      );
    }
    if (meta.originSessionId !== originSessionId) {
      return finishAttemptFailure(
        "sub-agent resume: origin session metadata does not match caller",
      );
    }
    if (
      meta.subAgentTaskState !== A2ATaskState.INPUT_REQUIRED
      || !meta.subAgentSuspensionReason
    ) {
      return finishAttemptFailure(
        "sub-agent resume: task is not in INPUT_REQUIRED",
      );
    }
    if (!meta.subAgentTitle) {
      return finishAttemptFailure(
        "sub-agent resume: missing persisted sub-agent title",
      );
    }
    const persistedResumeReason = meta.subAgentSuspensionReason;
    const canonicalContinuationInstructions = persistedResumeReason === "question"
      ? maskSensitiveData(continuationInstructions).masked.trim()
      : continuationInstructions;
    if (
      persistedResumeReason === "question"
      && (
        canonicalContinuationInstructions.length === 0
        || canonicalContinuationInstructions.length > GUIDE_MAX_CHARS
      )
    ) {
      return finishAttemptFailure(
        "sub-agent resume: question answer must be non-empty and within the message limit",
      );
    }

    const priorTrackedRun = this.trackedRuns.get(resumeId);
    if (priorTrackedRun && isA2ATerminalTaskState(priorTrackedRun.taskState)) {
      return finishAttemptFailure(
        "sub-agent resume: in-memory task is already terminal",
      );
    }

    trackedRun.title = meta.subAgentTitle;
    this.attachTrackedRunChildAlias(trackedRun);
    callbacks?.onLinked?.({ childSessionId: resumeId });

    const finishAuthorizedFailure = async (
      message: string,
      extra?: Partial<SubAgentSpawnResult>,
    ): Promise<SubAgentSpawnResult> => {
      const result = failureResult(message, extra);
      // Terminal commit point: after this synchronous detach, a late interrupt
      // is rejected and cannot race the single durable terminal write.
      delete trackedRun.abort;
      const taskState = projectSubAgentResultState(result);
      let persisted = false;
      try {
        await this.deps.subAgentMemoryManager.saveSessionMetadata(resumeId, {
          ...meta,
          subAgentTaskState: taskState,
          subAgentSuspensionPrompt: undefined,
          subAgentSuspensionReason: undefined,
        });
        persisted = true;
      } catch {
        // The in-memory terminal latch prevents a same-process retry.
      }
      if (persisted) {
        await this.cleanupTerminalRecipientMailbox(resumeId, taskState);
      }
      this.finalizeRun(trackedRun, result);
      if (result.stopReason !== "interrupted") callbacks?.onError?.(maskSubAgentText(message));
      return result;
    };

    const legacyResumeCount = meta.resumeCount ?? 0;
    const priorBudgetResumeCount = Math.max(
      meta.budgetResumeCount ?? 0,
      legacyResumeCount,
    );
    const priorQuestionAnswerCount = meta.questionAnswerCount ?? 0;
    const priorCumulativeRounds = meta.cumulativeRounds ?? 0;

    if (persistedResumeReason === "budget" && priorBudgetResumeCount >= MAX_RESUMES) {
      return await finishAuthorizedFailure(
        "sub-agent resume: exhausted (budgetResumeCount="
          + priorBudgetResumeCount + " >= " + MAX_RESUMES + ")",
        { resumeExhausted: true },
      );
    }
    if (priorCumulativeRounds >= CUMULATIVE_ROUNDS_CEILING) {
      return await finishAuthorizedFailure(
        "sub-agent resume: cumulative-rounds ceiling reached ("
          + priorCumulativeRounds + " >= " + CUMULATIVE_ROUNDS_CEILING + ")",
        { resumeExhausted: true },
      );
    }

    const modeResult = resolveAgentMode(meta.profileMode);
    const requestedRounds = modeResult.config.maxToolRoundsHint ?? MAX_TURNS_DEFAULT;
    const remainingRounds = CUMULATIVE_ROUNDS_CEILING - priorCumulativeRounds;
    const cappedRounds = Math.max(
      1,
      Math.min(MAX_TURNS_CAP, requestedRounds, remainingRounds),
    );

    const frozenSourceTools = meta.sourceTools ?? [];
    if (frozenSourceTools.length === 0) {
      return await finishAuthorizedFailure(
        'sub-agent resume: session "' + resumeId
          + '" has an empty frozen tool scope; metadata may be corrupted or tampered',
      );
    }
    const { childDeps } = this.buildChildDeps({
      frozenSourceTools,
      title: meta.subAgentTitle,
      profileModel: meta.profileModel,
    });

    child = new ConversationLoop(childDeps);
    child.sessionId = resumeId;
    child.sessionKind = "subagent";
    child.rebindTracer();
    if (!child.hasProvider()) {
      return await finishAuthorizedFailure(
        "sub-agent resume: LLM provider not configured",
      );
    }
    if (!child.loadSession(resumeId)) {
      return await finishAuthorizedFailure(
        'sub-agent resume: failed to load session history for "' + resumeId + '"',
      );
    }
    if (cancellation.signal.aborted) {
      return await finishAuthorizedFailure("sub-agent run interrupted");
    }
    let agentMailboxEntries: A2AAgentMailboxEntry[] = [];
    let agentMailboxGuidance: string | undefined;
    let agentMailboxApprovalPrefix = persistedResumeReason === "question"
      ? "[Sub-Agent: parent]"
      : undefined;
    let agentMailboxCausalContext: A2AAgentCausalContext | undefined;
    const agentMessageBus = this.deps.agentMessageBus;
    if (agentMessageBus) {
      try {
        agentMailboxEntries = await agentMessageBus.peekRecipientMailbox(resumeId);
      } catch {
        return await finishAuthorizedFailure(
          "sub-agent resume: agent mailbox read failed",
        );
      }
      if (agentMailboxEntries.length > 0) {
        if (agentMailboxEntries.some((entry) =>
          entry.envelope.originSessionId !== meta.originSessionId
          || entry.envelope.recipientChildSessionId !== resumeId)) {
          return await finishAuthorizedFailure(
            "sub-agent resume: agent mailbox origin validation failed",
          );
        }
        const joined = agentMailboxEntries
          .map((entry) => entry.formattedText)
          .join("\n\n");
        if (joined.length > GUIDE_JOINED_MAX_CHARS) {
          return await finishAuthorizedFailure(
            "sub-agent resume: agent mailbox guidance exceeds host limit",
          );
        }
        const causalContext = causalContextForEnvelopes(
          resumeId,
          agentMailboxEntries.map((entry) => entry.envelope),
        );
        if (!causalContext) {
          return await finishAuthorizedFailure(
            "sub-agent resume: agent mailbox causal context is invalid",
          );
        }
        const approvalLabels = new Set([
          ...(agentMailboxApprovalPrefix ? [agentMailboxApprovalPrefix] : []),
          ...agentMailboxEntries.map((entry) => entry.approvalLabel),
        ],
        );
        agentMailboxGuidance = joined;
        agentMailboxApprovalPrefix = approvalLabels.size === 1
          ? approvalLabels.values().next().value
          : "[Sub-Agent: multiple sources]";
        agentMailboxCausalContext = causalContext;
      }
    }

    this.updateRun(trackedRun, {
      taskState: A2ATaskState.WORKING,
      status: subAgentRunStatusFromTaskState(A2ATaskState.WORKING),
    });
    try {
      await this.deps.subAgentMemoryManager.saveSessionMetadata(resumeId, {
        ...meta,
        subAgentTaskState: A2ATaskState.WORKING,
        subAgentSuspensionPrompt: undefined,
        subAgentSuspensionReason: undefined,
      });
    } catch (err) {
      return await finishAuthorizedFailure(
        (err as Error).message ?? "sub-agent resume metadata start failed",
      );
    }
    if (cancellation.signal.aborted) {
      return await finishAuthorizedFailure("sub-agent run interrupted");
    }

    let totalToolCalls = 0;
    let lastText = "";
    let turn = 0;
    let assistantRounds = 0;
    const transcript = new SubAgentTranscriptAccumulator();
    const emitActivity = () => {
      const entries = transcript.snapshot();
      this.updateRun(trackedRun, {
        entries,
        toolCallCount: totalToolCalls,
        turnCount: turn,
      });
      callbacks?.onActivity?.({
        entries,
        toolCallCount: totalToolCalls,
      });
    };
    let ok = false;
    let failureReason: string | undefined;
    let childInputRequired: TurnInputRequired | undefined;
    let childStopReason: import("./turn/types.js").TurnStopReason | undefined;
    let completedQuestionWait: ActiveSubAgentChild["questionWait"];

    const activeLease = this.registerActiveChild({
      childSessionId: resumeId,
      originSessionId: meta.originSessionId,
      title: meta.subAgentTitle,
      loop: child,
      background,
    });
    try {
      const turnResult = await child.runTurn(
        canonicalContinuationInstructions,
        {
          onToolStart: (name, input, cbMeta) => {
            transcript.onToolStart(name, input, cbMeta);
            emitActivity();
          },
          onPermissionReview: (event) => {
            transcript.onPermissionReview(event);
            emitActivity();
          },
          onToolEnd: (name, toolResult, isError, cbMeta, uiPayload, durationMs) => {
            totalToolCalls += 1;
            transcript.onToolEnd(name, toolResult, isError, cbMeta, uiPayload, durationMs);
            emitActivity();
          },
          onAssistantRound: (round) => {
            assistantRounds += 1;
            turn = assistantRounds;
            lastText = round.text;
            transcript.onAssistantRound(round.thought, round.text);
            emitActivity();
          },
          onError: (message) => {
            callbacks?.onError?.(maskSubAgentText(message));
          },
        },
        cancellation.signal,
        {
          maxRounds: cappedRounds,
          sessionIdOverride: resumeId,
          spawnDepth: 1,
          ...(agentMailboxEntries.length > 0
            ? {
                initialGuidance: agentMailboxGuidance!,
                a2aCausalContext: agentMailboxCausalContext!,
              }
            : {}),
          ...(agentMailboxApprovalPrefix
            ? { approvalReasonPrefix: agentMailboxApprovalPrefix }
            : {}),
          inputOrigin: persistedResumeReason === "question" || agentMailboxEntries.length > 0
            ? "agent-message"
            : "llm-tool-arg",
        },
      );
      totalToolCalls = turnResult.toolCalls.length;
      lastText = turnResult.text;
      childInputRequired = turnResult.inputRequired;
      childStopReason = turnResult.stopReason;
      ok = isSuccessfulSubAgentStopReason(childStopReason, childInputRequired);
      if (!ok) {
        failureReason = subAgentStopFailureReason(childStopReason, lastText, "resume");
      }
    } catch (err) {
      const message = (err as Error).message ?? "sub-agent resume run failed";
      lastText = message;
      failureReason = message;
    } finally {
      const active = this.activeChildren.get(resumeId);
      if (active?.lease === activeLease) {
        completedQuestionWait = active.questionWait;
      }
      this.unregisterActiveChild(resumeId, activeLease);
    }
    let result: SubAgentSpawnResult = {
      summary: lastText,
      toolCallCount: totalToolCalls,
      turnCount: turn,
      childSessionId: resumeId,
      entries: transcript.snapshot(),
      ok,
      ...(ok ? {} : { error: failureReason ?? lastText }),
      ...(childStopReason ? { stopReason: childStopReason } : {}),
      ...(ok && childStopReason === "round-cap"
        ? {
            suspension: createBudgetSuspension(resumeId),
            incomplete: true,
          }
        : {}),
      ...(ok && childStopReason === "input-required" && childInputRequired
        ? { suspension: createQuestionSuspension(resumeId, childInputRequired) }
        : {}),
    };
    if (cancellation.signal.aborted) {
      result = {
        summary: "sub-agent run interrupted",
        toolCallCount: totalToolCalls,
        turnCount: turn,
        childSessionId: resumeId,
        entries: transcript.snapshot(),
        ok: false,
        error: "sub-agent run interrupted",
        stopReason: "interrupted",
      };
    }

    // Terminal commit point. Cancellation was sampled above; the stable result
    // now owns the single final metadata transition.
    result = await this.prepareQuestionStageForPersistence(
      completedQuestionWait,
      result,
    );
    delete trackedRun.abort;

    const nextBudgetResumeCount = priorBudgetResumeCount
      + (result.ok && persistedResumeReason === "budget" ? 1 : 0);
    const nextQuestionAnswerCount = priorQuestionAnswerCount
      + (result.ok && persistedResumeReason === "question" ? 1 : 0);
    const metadataForResult = (terminalResult: SubAgentSpawnResult) => ({
      ...meta,
      sessionKind: "subagent" as const,
      budgetResumeCount: nextBudgetResumeCount,
      questionAnswerCount: nextQuestionAnswerCount,
      resumeCount: nextBudgetResumeCount,
      cumulativeRounds: priorCumulativeRounds + turn,
      subAgentTaskState: projectSubAgentResultState(terminalResult),
      subAgentSuspensionReason: terminalResult.suspension?.reason,
      subAgentSuspensionPrompt: terminalResult.suspension?.prompt,
    });
    let durableTaskState: A2AProjectedTaskState | undefined;
    let durableResult: SubAgentSpawnResult | undefined;
    const saveResult = async (next: SubAgentSpawnResult): Promise<void> => {
      await this.deps.subAgentMemoryManager.saveSessionMetadata(
        resumeId,
        metadataForResult(next),
      );
      durableTaskState = projectSubAgentResultState(next);
      durableResult = next;
    };

    try {
      await saveResult(result);
    } catch (err) {
      const interrupted = cancellation.signal.aborted;
      const message = interrupted
        ? "sub-agent run interrupted"
        : (err as Error).message ?? "sub-agent resume metadata update failed";
      result = await this.prepareQuestionStageForPersistence(
        completedQuestionWait,
        this.questionDeliveryFailure(result, message),
      );
      try {
        await saveResult(result);
      } catch {
        // WORKING remains durable and therefore non-resumable.
      }
      if (durableTaskState) {
        await this.cleanupTerminalRecipientMailbox(resumeId, durableTaskState);
      }
      this.finalizeRun(trackedRun, result);
      if (result.stopReason !== "interrupted") callbacks?.onError?.(maskSubAgentText(message));
      return result;
    }

    if (cancellation.signal.aborted && result.stopReason !== "interrupted") {
      result = await this.prepareQuestionStageForPersistence(
        completedQuestionWait,
        this.questionDeliveryFailure(result, "sub-agent run interrupted"),
      );
      try {
        await saveResult(result);
      } catch {
        result = durableResult ?? result;
        // The already-persisted state remains authoritative and no stage commits.
      }
    } else {
      const committed = await this.commitQuestionStageAfterPersistence(
        completedQuestionWait,
        result,
      );
      if (committed !== result) {
        result = committed;
        try {
          await saveResult(result);
        } catch {
          result = durableResult ?? result;
          // The staged envelope was rolled back before this terminal projection.
        }
      }
    }

    if (
      agentMessageBus
      && agentMailboxEntries.length > 0
      && result.ok
      && (result.stopReason === "end_turn" || result.stopReason === "input-required")
    ) {
      try {
        const removed = await agentMessageBus.acknowledgeRecipientMailbox(
          resumeId,
          agentMailboxEntries,
        );
        if (removed !== agentMailboxEntries.length) {
          log.warn(
            "sub-agent resume: agent mailbox acknowledgement mismatch for %s",
            resumeId,
          );
        }
      } catch {
        log.warn("sub-agent resume: agent mailbox acknowledgement failed for %s", resumeId);
      }
    }
    if (durableTaskState) {
      await this.cleanupTerminalRecipientMailbox(resumeId, durableTaskState);
    }
    this.finalizeRun(trackedRun, result);
    return result;
  }
  /**
   * C3(b): build a scoped registry covering every parent-registered tool
   * EXCEPT the entries on {@link SUB_AGENT_TOOL_BLOCKLIST}. Used when the
   * spawn caller did not provide an explicit `sourceTools` allowlist —
   * we still need to enforce the blocklist defense.
   */
}

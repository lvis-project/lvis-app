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
 *     user-facing approval reason so users know an approval request originated
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
import type { RestoredSubAgentSession } from "../memory/memory-manager.js";
import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_MIN,
} from "../shared/subagent-policy.js";
import { createHash } from "node:crypto";
import { ConversationLoop, type ConversationLoopDeps } from "./conversation-loop.js";
import { canonicalizePathForMatch } from "../permissions/sensitive-paths.js";
import { SystemPromptBuilder } from "../prompts/system-prompt-builder.js";
import type {
  TurnInputRequired,
  TurnStopReason,
  WorkspaceRootRevocationOptions,
} from "./turn/types.js";
import {
  GUIDE_JOINED_MAX_CHARS,
  GUIDE_MAX_CHARS,
} from "./turn/guidance-limits.js";
import type { ToolRegistry } from "../tools/registry.js";
import { isValidSessionId, type MemoryManager } from "../memory/memory-manager.js";
import { projectRootEquals } from "../shared/project-identity.js";
import type {
  ApprovalGate,
  ApprovalDecision,
  ApprovalRequestInput,
} from "../permissions/approval-gate.js";
import {
  isModelComplexityLevel,
  resolveModelForComplexity,
} from "../shared/model-complexity-map.js";
import {
  isLLMVendor,
  isModelAvailableForVendor,
} from "../shared/llm-vendor-defaults.js";
import {
  MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH,
  type SubscriptionChatRuntimeSelection,
} from "../shared/subscription-runtime.js";
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
import { createDlpSafeUuid } from "../shared/dlp-safe-id.js";
import { renderAgentProfilePrompt } from "./agent-profile-prompt.js";
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
import { sanitizeA2ALabel } from "./a2a-subagent-message-codec.js";
import { hasControlChars } from "../shared/display-safe-text.js";
import {
  formatParentDirective,
  hasUnsafeDirectiveControlChars,
  PARENT_DIRECTIVE_MAX_CHARS,
  type ParentDirectiveDeliveryResult,
  type ParentDirectiveDropReason,
} from "./parent-directive.js";
import type {
  ParentDirectiveEntry,
  ParentDirectiveMailbox,
} from "./parent-directive-mailbox.js";
import {
  causalContextForEnvelopes,
  isSafeA2AStructuralId,
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
   * budget is the user's configured `chat.subAgentMaxRounds` and finally
   * `MAX_TURNS_DEFAULT` — see `spawn()`. This is host policy, not an
   * LLM-tunable knob, so it is intentionally not surfaced in the tool schema.
   */
  maxRounds?: number;
  /**
   * Origin session id — audit attribution, and the conversation a tier-2
   * approval answer is attributed to when this run has one.
   */
  originSessionId?: string;
  /**
   * The task the PARENT wrote, before any agent-profile body is rendered around
   * it. Only a caller that can vouch for that sets it, and only a run that has
   * it can have its child's approvals routed to its parent.
   *
   * Separate from `instructions` because `instructions` is what the CHILD is
   * given, which for a profile spawn is the profile body followed by the task.
   * A judgement made against the profile body is a judgement against a role
   * description that justifies almost anything.
   */
  parentAuthoredTask?: string;
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
   * Why a `resume()` was REFUSED before running any turn. ABSENT means the
   * failure is transient (or the result is not a resume at all), so retrying
   * the SAME resumeId is the correct move.
   *
   *  - `"exhausted"` — a resume-axis loop guard fired
   *    (`budgetResumeCount >= MAX_RESUMES` or
   *    `cumulativeRounds >= cumulativeRoundsCeiling()`). Distinct from
   *    `incomplete` (a run that STARTED and hit its per-turn round budget):
   *    an exhausted refusal never ran a turn at all.
   *  - `"invalid"` — a structural policy check that can never pass for this
   *    resumeId: wrong task state, origin mismatch, missing or tampered
   *    persisted metadata.
   *
   * Both refusals are permanent for that id, so the caller must NOT emit
   * retry-same-id guidance; they differ only in the recovery advice. A single
   * discriminant instead of two optional booleans makes the impossible
   * "both true" state unrepresentable — that combination used to be masked
   * only by the object-spread ORDER in agent_spawn's error path, where the
   * second guidance key silently overwrote the first. Always paired with
   * `ok === false`; absent on spawn results and on resumes allowed to run.
   */
  resumeRefusal?: "invalid" | "exhausted";
}

/**
 * SOT for "can this persisted child be resumed": the resume gate in
 * `resumeWithPolicy` accepts only INPUT_REQUIRED, and it consumes this same
 * predicate. `agent_list` advertises resumability through it too, so the two
 * can never drift. (They did once: agent_list offered SUBMITTED/WORKING ids
 * the gate then rejected, and the error path's retry guidance turned that
 * into a guided infinite retry.)
 */
export function isResumableSubAgentTaskState(
  taskState: string | undefined,
): boolean {
  return taskState === A2ATaskState.INPUT_REQUIRED;
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
  /**
   * The run reached its terminal state.
   *
   * Fired from {@link SubAgentRunner.finalizeRun} — the single completion step
   * that writes the tracked run's terminal status — synchronously and before
   * that step returns. The caller therefore cannot construct a moment in which
   * `agent_status` reports a terminal run that the renderer has not been told
   * about: the state write and this notification are one uninterruptible step.
   *
   * Two paths publish a terminal task state WITHOUT firing this, on purpose:
   * `interruptRun` and `cancelActiveWireChildForWorkspaceRoot`. Both record an
   * abort REQUEST, not an outcome — the run is still in flight, its result has
   * not been produced, and the caller that asked for the interrupt is handed
   * the snapshot synchronously. The child then unwinds and reaches
   * `finalizeRun`, which fires this with the actual outcome, so the renderer
   * still gets exactly one terminal frame and it carries a real result.
   *
   * Fires at most once per tracked run; the runner drops the reference after
   * calling it, so a second finalize on the same run cannot double-report.
   */
  onTerminal?: (result: SubAgentSpawnResult) => void;
}

export interface A2AWireSpawnCallbacks extends SubAgentSpawnCallbacks {
  /**
   * Required wire-only barrier. The runner awaits this after child metadata is
   * durable and before exposing the link or touching the provider.
   */
  onDurablyLinked: (link: { childSessionId: string }) => void | Promise<void>;
}
/** Remote-controlled portion of a new A2A wire task. */
export interface A2AWireSpawnRequest {
  messageText: unknown;
}

/** Remote-controlled portion of an A2A wire continuation. */
export interface A2AWireResumeRequest {
  resumeId: unknown;
  messageText: unknown;
}

/** Host-resolved profile/project binding. No wire field can populate this. */
export interface A2AWireHostBinding {
  handlerId: string;
  profile: {
    name: string;
    body: string;
    sourceTools: readonly string[];
    model?: string;
    mode?: string;
  };
  project: {
    root: string;
    name?: string;
  };
}

/** Host-only handler binding used to authorize a wire continuation. */
export interface A2AWireResumeBinding {
  handlerId: string;
}

export interface A2AWireRunSnapshot {
  childSessionId: string;
  title: string;
  taskState: A2AProjectedTaskState;
  updatedAt?: string;
  summary?: string;
  error?: string;
  stopReason?: TurnStopReason;
  suspension?: SubAgentSuspension;
}

export type A2AWireCancelResult =
  | { ok: true; run: A2AWireRunSnapshot }
  | {
      ok: false;
      reason: "task-not-found" | "task-not-cancelable" | "storage-failed";
      run?: A2AWireRunSnapshot;
    };

const A2A_WIRE_APPROVAL_REASON_PREFIX = "[A2A Wire]" as const;
const A2A_WIRE_ID_MAX_CHARS = 256;
// Brackets on top of the control class: a label is spliced into the bracketed
// `[A2A Wire]` approval prefix, so one in the value could forge a second tag.
const A2A_WIRE_LABEL_BRACKET = /[\[\]]/;

interface SubAgentExecutionPolicy {
  inputOrigin: "agent-message";
  approvalReasonPrefix: typeof A2A_WIRE_APPROVAL_REASON_PREFIX;
  forceExplicitToolScope: true;
  wireBinding: {
    handlerId: string;
    internalOriginSessionId: string;
  };
}

function buildA2AWireInternalOrigin(handlerId: string): string {
  const handlerTag = createHash("sha256").update(handlerId).digest("hex").slice(0, 8);
  return createDlpSafeUuid(`a2a-wire-${handlerTag}`);
}

function canonicalizeA2AWireMessage(messageText: unknown): string | null {
  if (typeof messageText !== "string") return null;
  const masked = maskSubAgentText(messageText).trim();
  return masked.length > 0 && masked.length <= GUIDE_MAX_CHARS ? masked : null;
}

function isValidA2AWireId(value: unknown): value is string {
  return isSafeA2AStructuralId(value)
    && value.length <= A2A_WIRE_ID_MAX_CHARS
    && isValidSessionId(value);
}

function isValidOptionalA2AWireText(
  value: unknown,
  maxChars: number,
  displayLabel = false,
): boolean {
  return value === undefined
    || (
      typeof value === "string"
      && value.trim().length > 0
      && value.length <= maxChars
      && !hasControlChars(value)
      && (!displayLabel || !A2A_WIRE_LABEL_BRACKET.test(value))
      && maskSensitiveData(value).detections.length === 0
    );
}

function notifyA2AWireObserver<T>(
  callback: ((value: T) => unknown) | undefined,
  value: T,
  observer: string,
): void {
  if (!callback) return;
  try {
    const result = callback(value);
    if (
      result !== null
      && typeof result === "object"
      && "then" in result
      && typeof (result as PromiseLike<unknown>).then === "function"
    ) {
      void Promise.resolve(result).catch(() => {
        log.warn("sub-agent A2A wire observer failed: %s", observer);
      });
    }
  } catch {
    log.warn("sub-agent A2A wire observer failed: %s", observer);
  }
}

function normalizeA2AWireSpawnCallbacks(value: unknown): A2AWireSpawnCallbacks | null {
  if (value === null || typeof value !== "object") return null;
  try {
    const candidate = value as Partial<A2AWireSpawnCallbacks>;
    const onDurablyLinked = candidate.onDurablyLinked;
    const onLinked = candidate.onLinked;
    const onActivity = candidate.onActivity;
    const onError = candidate.onError;
    const onTerminal = candidate.onTerminal;
    if (
      typeof onDurablyLinked !== "function"
      || (onLinked !== undefined && typeof onLinked !== "function")
      || (onActivity !== undefined && typeof onActivity !== "function")
      || (onError !== undefined && typeof onError !== "function")
      || (onTerminal !== undefined && typeof onTerminal !== "function")
    ) {
      return null;
    }
    return {
      onDurablyLinked,
      ...(onLinked
        ? { onLinked: (link) => notifyA2AWireObserver(onLinked, link, "on-linked") }
        : {}),
      ...(onActivity
        ? { onActivity: (update) => notifyA2AWireObserver(onActivity, update, "on-activity") }
        : {}),
      ...(onError
        ? { onError: (message) => notifyA2AWireObserver(onError, message, "on-error") }
        : {}),
      ...(onTerminal
        ? { onTerminal: (result) => notifyA2AWireObserver(onTerminal, result, "on-terminal") }
        : {}),
    };
  } catch {
    return null;
  }
}
export function isValidA2AWireHostBinding(binding: A2AWireHostBinding): boolean {
  const profileName = binding?.profile?.name;
  const projectRoot = binding?.project?.root;
  return isValidA2AWireId(binding?.handlerId)
    && typeof profileName === "string"
    && profileName.trim().length > 0
    && profileName.length <= 120
    && !hasControlChars(profileName) && !A2A_WIRE_LABEL_BRACKET.test(profileName)
    && maskSensitiveData(profileName).detections.length === 0
    && typeof binding.profile.body === "string"
    && Array.isArray(binding.profile.sourceTools)
    && binding.profile.sourceTools.every((tool) =>
      typeof tool === "string" && tool.length > 0 && tool.length <= 256)
    && isValidOptionalA2AWireText(binding.profile.model, 256)
    && isValidOptionalA2AWireText(binding.profile.mode, 256)
    && typeof projectRoot === "string"
    && projectRoot.trim().length > 0
    && projectRoot.length <= 2_048
    && !hasControlChars(projectRoot)
    && isValidOptionalA2AWireText(binding.project.name, 120, true);
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

/**
 * How a caller reading tracked run state intends to use what it reads.
 *
 * `agent_status` hands the whole snapshot — summary, error, transcript — to the
 * parent LLM, which IS the completion report. Other readers take the same
 * snapshot for narrower purposes: `agent_spawn` reads one line of it to fill
 * the run handle it returns, and the renderer reads it to draw a row. Only the
 * first has been told what the mailbox copy would tell, so only the first may
 * mark that copy spent. Defaulting to a plain read keeps a new call site from
 * silently swallowing a report nobody read.
 *
 * `agent_list` is deliberately NOT such a call site. It answers "which
 * sub-agents does this conversation have", listing title, resume id, and task
 * state from persisted rows — it never carries a report body, so reading it
 * cannot count as reading the report. Retiring the mailbox on it would drop
 * content the parent was never shown, trading a duplicated report for a lost
 * one.
 */
export interface SubAgentRunReadOptions {
  deliversReportToParent?: boolean;
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
  /**
   * Renderer-facing completion observer, held here rather than threaded
   * through the dozen call sites that finalize a run. `finalizeRun` clears it
   * as it fires, which is what makes the terminal frame single-shot.
   */
  onTerminal?: (result: SubAgentSpawnResult) => void;
  /**
   * The terminal report this run handed to the parent mailbox, once one was
   * accepted. Identified by message id so a mid-run `agent_send` message from
   * the same child is never mistaken for the completion report.
   */
  terminalReport?: { messageId: string };
  /**
   * The completion step's result actually LANDED on this run — the summary,
   * error, and transcript a reader gets back are the ones the report carries.
   *
   * Not the same as "the task state is terminal". `interruptRun` and the
   * workspace-revocation cancel publish CANCELED the instant an abort is
   * requested, and `persistFinalResult` claims the terminal commit before its
   * awaits, so a run can read as terminal while its result is still missing.
   * Worse, once CANCELED is written the A2A state machine refuses
   * CANCELED -> COMPLETED, so a child that finished while the interrupt was in
   * flight NEVER puts its summary into the snapshot. Marking such a snapshot
   * "read" would retire the mailbox copy and lose the child's answer outright.
   * `updateRun` is the arbiter: this flips only when the patch it was handed
   * survived that check.
   */
  terminalReportPublished?: boolean;
  /**
   * The parent has already read this run's published result — and with it the
   * summary, error, and transcript the completion report carries — through
   * `agent_status`. The queued mailbox copy of that same report is therefore
   * spent, and {@link SubAgentRunner.peekParentMailbox} consumes it instead of
   * injecting it into a later turn.
   */
  terminalReportObserved?: boolean;
  terminalCommitClaimed?: boolean;
  cancellationPersistencePending?: boolean;
  initialMetadataFailed?: boolean;
  ephemeralFallbackConsumed?: boolean;
  ephemeralParentDelivery?: {
    parentSessionId: string;
    childSessionId: string;
    childTitle: string;
    messageId: string;
  };
}

interface InFlightResumeAttempt {
  promise?: Promise<SubAgentSpawnResult>;
  run?: TrackedSubAgentRun;
}

type SubAgentSessionMetadata = NonNullable<
  ReturnType<MemoryManager["loadSessionMetadata"]>
>;
type A2AWireBoundMetadata = SubAgentSessionMetadata & Required<
  Pick<
    SubAgentSessionMetadata,
    | "subAgentTitle"
    | "sourceTools"
    | "originSessionId"
    | "a2aWireHandlerId"
    | "a2aWireInternalOrigin"
  >
>;

export type ReserveQuestionWaitResult =
  | { ok: true; token: symbol }
  | { ok: false; reason: "question-already-outstanding" };

interface ActiveSubAgentChild {
  lease: symbol;
  childSessionId: string;
  originSessionId?: string;
  /** Filesystem-canonical root frozen before any live workspace revocation. */
  wireProjectRoot?: string;
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
  /**
   * Durable parent-to-child directive queue.
   *
   * Optional for the same reason `agentMessageBus` is — boot wires it, and every
   * caller without it fails closed (`mailbox-unavailable`) instead of delivering
   * a directive nothing could make durable.
   */
  parentDirectiveMailbox?: ParentDirectiveMailbox;
}

// Sub-agent round budget — ONE number, not a per-posture split. The child runs
// on the same ConversationLoop, which honours this host-assigned budget instead
// of narrowing it to its own default bound, so what the user configures is what
// runs. The budget is HOST-ASSIGNED, not LLM-picked:
// `agent_spawn` exposes no `maxTurns` schema field. Resolution order (see
// `spawn()`): explicit host `input.maxRounds` (fixed-shape host callers like
// WorkBoardEngine) → the user's configured budget → MAX_TURNS_DEFAULT.
//
// A per-mode split (explore=15, execute=20, research=25) used to seed this and
// was REMOVED, field and all. Those per-mode numbers were the direct cause of
// agents dying mid-investigation: an "explore" agent got 15 rounds for work
// that needed far more, hit `round-cap`, and returned partial output that read
// as a silent failure. A single budget is both more generous and easier to
// reason about — and it is now user-configurable, which is the right lever.
const MAX_TURNS_DEFAULT = SUBAGENT_MAX_ROUNDS_DEFAULT;

/**
 * Normalize a resolved round budget. Type sanity only — a non-finite or
 * sub-minimum value cannot be run, but there is NO upper clamp: an absolute
 * ceiling above the configured budget can only surface as an agent that stops
 * mid-task with partial work.
 */
function normalizeRoundBudget(requested: number): number {
  return Number.isFinite(requested)
    ? Math.max(SUBAGENT_MAX_ROUNDS_MIN, Math.floor(requested))
    : MAX_TURNS_DEFAULT;
}
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
  // Parent-only: `agent_guide` addresses the caller's OWN children, and a
  // sub-agent has none. Its execute() already refuses a non-root caller; the
  // blocklist keeps it out of the child's registry so the refusal is never a
  // tool the child can see and try.
  "agent_guide",
  "memory_write",
]);

/**
 * Resume-axis loop guards (Commit 2 — security-required to land WITH the resume
 * entry point). A sub-agent can be re-hydrated and continued via `resume()`, but
 * an unbounded resume chain is a fork-bomb on the resume axis and blows past the
 * global round budget the per-turn `maxRounds` cap enforces per turn.
 *
 *   - MAX_RESUMES: how many times a single sub-agent session may be resumed.
 *   - cumulative rounds ceiling: total assistant rounds across the original
 *     spawn plus every resume segment. Pinned to
 *     CUMULATIVE_ROUNDS_BUDGET_MULTIPLIER × the CONFIGURED round budget, so the
 *     protection stays proportional (a spawn + MAX_RESUMES resumes cannot
 *     exceed it) while never binding below what the user asked a single agent
 *     to be able to run.
 *
 * A resume that would breach either guard is refused BEFORE any turn runs
 * (`{ ok:false, resumeRefusal:"exhausted" }`), so no LLM round is spent.
 */
const MAX_RESUMES = 3;
const CUMULATIVE_ROUNDS_BUDGET_MULTIPLIER = 4;
const MAX_TRACKED_RUNS = 100;
/**
 * Minimum spacing between activity emissions driven by reasoning deltas.
 *
 * Every emission serializes the WHOLE child transcript over IPC, and reasoning
 * deltas arrive at token rate — forwarding one per delta would send the entire
 * snapshot hundreds of times per round for text the user reads as a spinner.
 * ~100ms is below the threshold at which streaming stops looking continuous
 * while cutting the emission count by orders of magnitude.
 */
const REASONING_STREAM_EMIT_INTERVAL_MS = 100;

/**
 * Rate-limit `emit` to one call per `intervalMs`, leading and trailing.
 *
 * Leading, so the panel reacts to the first delta at once rather than after a
 * blank interval. Trailing, so the last delta before a pause is never the one
 * dropped — a coalescer without it leaves the visible thought truncated
 * whenever the model stops mid-interval. `cancel()` drops a pending trailing
 * call, which round boundaries use so their own unthrottled emission is the
 * final word rather than racing a stale snapshot behind it.
 */
function createCoalescedEmitter(
  emit: () => void,
  intervalMs: number,
): { schedule: () => void; cancel: () => void } {
  let lastEmitMs = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    timer = undefined;
    lastEmitMs = Date.now();
    emit();
  };
  return {
    schedule: () => {
      if (timer !== undefined) return;
      const waited = Date.now() - lastEmitMs;
      if (waited >= intervalMs) {
        fire();
        return;
      }
      timer = setTimeout(fire, intervalMs - waited);
      // The child loop keeps the process alive on its own; this timer must not
      // be what holds it open if the run ends between deltas.
      timer.unref?.();
    },
    cancel: () => {
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
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

/**
 * Whether a finished resume segment CONSUMED the parent directive injected
 * into it.
 *
 * The rule is "the turn that carried it reached a conclusion", and a round-cap
 * conclusion counts: the segment ran, the child saw the directive in its
 * initial guidance, and it produced real partial work. What it did NOT do is
 * finish the task — which is a reason to resume again, not a reason to treat
 * the directive as undelivered. Leaving it pending re-injects the SAME text at
 * the top of the next segment, so a parent that guided a long-running child
 * would have its one message replayed once per round-cap for the rest of the
 * resume chain.
 *
 * A failed or interrupted segment does NOT report it consumed: there the turn
 * may never have reached the LLM at all. That is only an acknowledgement
 * decision — what the mailbox then holds is decided separately by
 * `cleanupTerminalRecipientMailbox`, which discards every pending directive
 * once the child's projection is terminal.
 */
function resumeSegmentConsumedGuidance(result: SubAgentSpawnResult): boolean {
  if (!result.ok) return false;
  return result.stopReason === "end_turn"
    || result.stopReason === "input-required"
    // ok + round-cap always carries the budget suspension built above; the
    // suspension is asserted rather than assumed so a future stop reason
    // cannot quietly inherit this branch.
    || (result.stopReason === "round-cap" && result.suspension?.reason === "budget");
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
  return createDlpSafeUuid(originTag ? `sub-${originTag}` : "sub");
}

function originSessionTag(originSessionId: string): string {
  return createHash("sha256").update(originSessionId).digest("hex").slice(0, 8);
}

/**
 * Resolve an agent profile's `model:` frontmatter to a concrete model ID
 * for the child loop, against the parent's active vendor:
 *   1. undefined / empty   → null (child stays on the parent model)
 *   2. Codex subscription  → a clean explicit candidate is sent to the
 *                             main-owned live subscription catalog; ACP keeps
 *                             its persisted default and complexity tiers have
 *                             no static Codex mapping, so both retain it.
 *   3. API-key complexity   → MODEL_COMPLEXITY_MAP[vendor][tier]; null when
 *                             the vendor lacks that tier (design-intent
 *                             parent-model fallback, logged)
 *   4. API-key explicit ID  → used only when it is selectable for the active
 *                             vendor (LLM_VENDOR_MODEL_OPTIONS); otherwise
 *                             null (parent-model fallback, logged).
 *
 * Returning null means "no override" — the active runtime retains its
 * persisted model. A non-null Codex subscription result is only a bounded
 * candidate; the main-owned runtime independently revalidates its live
 * catalog before transport.
 */
export function resolveSubAgentModel(
  profileModel: string | undefined,
  activeVendor: string,
  subscriptionRuntime?: SubscriptionChatRuntimeSelection,
): string | null {
  const trimmed = profileModel?.trim();
  if (!trimmed) return null;

  if (subscriptionRuntime) {
    if (subscriptionRuntime.provider !== "codex") return null;
    if (isModelComplexityLevel(trimmed)) {
      log.warn(
        "sub-agent: parent-model fallback used — Codex subscription has no static complexity mapping for '%s'",
        trimmed,
      );
      return null;
    }
    if (
      trimmed.length > MAX_SUBSCRIPTION_RUNTIME_MODEL_ID_LENGTH
      || /[\u0000-\u001f\u007f]/.test(trimmed)
    ) {
      log.warn(
        "sub-agent: parent-model fallback used — invalid Codex subscription model candidate",
      );
      return null;
    }
    // The selectable Codex catalog is subscription-scoped and live in main,
    // so never validate this candidate against the inactive API-key vendor.
    return trimmed;
  }

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
 *     normal approval dock runs. See agent-mode-map.ts SECURITY MODEL).
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
 * Longest spawn-task summary attached to a child's approval asks.
 *
 * The parent's instructions can be pages long; the adjudicating side turn needs
 * enough of them to recognise what it asked for, not all of them. Truncation
 * only makes the parent less certain, and an uncertain parent escalates.
 */
const MAX_SPAWN_TASK_SUMMARY_CHARS = 600;
/** Split of that budget when the task is longer — see {@link boundSpawnTaskSummary}. */
const SPAWN_TASK_SUMMARY_HEAD_CHARS = 400;
const SPAWN_TASK_SUMMARY_TAIL_CHARS = 200;

/** What the gate needs to route a child's ask to the parent that spawned it. */
interface SubAgentApprovalProvenance {
  childSessionId: string;
  originSessionId: string;
  /** The parent-authored task, masked and truncated by the host. */
  spawnTaskSummary: string;
  /**
   * Whether the host started this run in the background — nobody is watching
   * its turn, so an approval it raises would paint a dock for no one. The
   * host's own execution posture, never anything the child model says.
   */
  background: boolean;
}

/**
 * Build the provenance an approval ask carries, when this run has a parent that
 * could answer for it.
 *
 * `null` for the two cases where it could not. A run with no origin session has
 * no parent conversation to attribute the answer to. And a run spawned or
 * resumed over the A2A wire has a REMOTE agent behind it: its "task" is text a
 * remote controller wrote, its origin is a synthetic host-minted id rather than
 * a conversation, and asking a model to judge a call against remote-authored
 * framing is the shape this feature exists to keep away from. Those asks stay
 * with the user.
 */
function buildSubAgentApprovalProvenance(input: {
  childSessionId: string;
  originSessionId: string | undefined;
  /** The parent's OWN words. Absent means no caller vouched for any. */
  task: string | undefined;
  wireBound: boolean;
  /** Host execution posture of the run; decides where a tier-3 ask goes. */
  background: boolean;
}): SubAgentApprovalProvenance | null {
  if (input.wireBound) return null;
  // A conversation id, not merely a truthy string. Host-orchestrated runs label
  // their origin with things like `work-board:<item>`, which names a work item
  // rather than a conversation: there is no parent turn behind it to answer for
  // the call, and the work-board's own prompt promises the user that each tool
  // call is theirs to approve. `isValidSessionId` is the existing definition of
  // "an actual session", so this stays true as new host callers appear.
  if (!input.originSessionId || !isValidSessionId(input.originSessionId)) {
    return null;
  }
  if (!input.task) return null;
  const spawnTaskSummary = boundSpawnTaskSummary(maskSubAgentText(input.task).trim());
  if (!spawnTaskSummary) return null;
  return {
    childSessionId: input.childSessionId,
    originSessionId: input.originSessionId,
    spawnTaskSummary,
    background: input.background,
  };
}

/**
 * Bound a task summary without cutting its end off.
 *
 * A plain head slice is not a neutral shortening of an instruction: the
 * constraints are usually at the END ("...and do not touch anything outside
 * docs/"), so head-truncation reliably deletes the half that would make a call
 * out of scope. Keeping both ends costs a few characters and preserves the part
 * a judgement actually turns on.
 */
function boundSpawnTaskSummary(masked: string): string {
  if (masked.length <= MAX_SPAWN_TASK_SUMMARY_CHARS) return masked;
  const head = masked.slice(0, SPAWN_TASK_SUMMARY_HEAD_CHARS).trim();
  const tail = masked.slice(-SPAWN_TASK_SUMMARY_TAIL_CHARS).trim();
  return `${head}\n…\n${tail}`;
}

/**
 * Both halves of the provenance policy, exposed for the suite that pins it.
 *
 * The policy is a security boundary — who may state which run is asking, and
 * which runs have no parent that may answer for them — and testing it through
 * a full spawn would test the scaffolding instead of the rule.
 */
export const buildSubAgentApprovalProvenanceForTest =
  buildSubAgentApprovalProvenance;

/**
 * ApprovalGate wrapper that prepends `[Sub-Agent: <title>] ` to the
 * `reason` text shown in the user-facing approval dock so users can
 * distinguish parent-loop approvals from sub-agent approvals at a glance.
 *
 * It is also where an ask acquires the two host-only facts the gate's tier-2
 * stage needs: which run raised it, and that the run's permission lane makes it
 * a candidate at all. Both are attached here rather than upstream because this
 * is the one place that holds the tracked run — a value the child, its tools
 * and the renderer cannot reach, let alone author. `eligible` is the caller
 * assertion the gate treats as necessary and never sufficient; the gate
 * re-derives every condition it can observe for itself.
 *
 * No other behavior changes — the underlying gate handles HMAC/nonce, S1
 * sensitive-path block, S4 read-only short-circuit, etc.
 */
export function makeSubAgentApprovalAdapter(
  base: ApprovalGate,
  title: string,
  provenance: SubAgentApprovalProvenance | null,
): ApprovalGate {
  // We expose the same interface ConversationLoop / ToolExecutor uses via
  // duck-typing — only `requestAndWait` is actually called from the tool
  // executor, plus `policy` / `setPolicy` from IPC bridge. The wrapper
  // forwards everything else to the original instance.
  const wrapper = Object.create(base) as ApprovalGate;
  wrapper.requestAndWait = function wrappedRequestAndWait(
    req: ApprovalRequestInput,
  ): Promise<ApprovalDecision> {
    const labeledReason = `[Sub-Agent: ${title}] ${req.reason}`;
    // Dropped before the spread, not overwritten after it. Overwriting only
    // covers the runs that HAVE provenance; the runs that deliberately have
    // none — a remote wire run, a host-orchestrated one — are exactly the ones
    // a forged field would smuggle into tier 2, and the gate's only entry
    // condition is that the field is present.
    const { childProvenance: _callerSupplied, ...safeReq } = req;
    return base.requestAndWait({
      ...safeReq,
      reason: labeledReason,
      ...(provenance === null
        ? {}
        : {
            childProvenance: {
              childSessionId: provenance.childSessionId,
              childTitle: title,
              originSessionId: provenance.originSessionId,
              spawnTaskSummary: provenance.spawnTaskSummary,
              background: provenance.background,
            },
          }),
    });
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

  /** Allow newly-created child sessions to bind to a root registered again. */
  allowProjectRoot(root: string): void {
    this.deps.subAgentMemoryManager.allowProjectRoot(root);
  }

  /**
   * Detach the removed project from the isolated sub-agent session store while
   * preserving transcripts. Once that durable boundary commits, cancel every
   * matching live wire child before returning so the workspace coordinator's
   * later settings write cannot leave a removed project executing in between.
   */
  async detachSessionsFromProject(root: string): Promise<number> {
    const detached = await this.deps.subAgentMemoryManager.detachSessionsFromProject(root);
    let canonicalRoot: string;
    try {
      canonicalRoot = canonicalizePathForMatch(root);
    } catch {
      return detached;
    }
    this.cancelActiveWireChildrenForWorkspaceRoot(canonicalRoot);
    return detached;
  }

  private cancelActiveWireChildForWorkspaceRoot(
    child: ActiveSubAgentChild,
    canonicalRoot: string,
  ): void {
    if (
      !child.wireProjectRoot
      || !projectRootEquals(child.wireProjectRoot, canonicalRoot)
    ) {
      return;
    }
    const trackedRun = this.inFlight.get(child.childSessionId)?.run
      ?? this.trackedRuns.get(child.childSessionId);
    if (
      trackedRun
      && (
        trackedRun.terminalCommitClaimed
        || isA2ATerminalTaskState(trackedRun.taskState)
      )
    ) {
      return;
    }
    if (trackedRun?.abort) trackedRun.abort();
    else child.loop.abortCurrentTurn();
    if (!trackedRun) return;
    delete trackedRun.abort;
    this.updateRun(trackedRun, {
      taskState: A2ATaskState.CANCELED,
      stopReason: "interrupted",
      suspension: undefined,
    });
  }

  private cancelActiveWireChildrenForWorkspaceRoot(canonicalRoot: string): unknown[] {
    const errors: unknown[] = [];
    for (const child of [...this.activeChildren.values()]) {
      try {
        this.cancelActiveWireChildForWorkspaceRoot(child, canonicalRoot);
      } catch (error: unknown) {
        errors.push(error);
        log.warn(
          {
            childSessionId: child.childSessionId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "sub-agent wire task cancellation during workspace removal failed",
        );
      }
    }
    return errors;
  }

  /**
   * Remove a workspace root from every child loop that is live right now.
   * Iterate a snapshot and isolate failures so one child cannot prevent the
   * remaining scopes from shrinking. Once every child has been attempted,
   * surface an aggregate failure so the workspace removal intent stays pending.
   */
  revokeWorkspaceRoot(
    root: string,
    options?: WorkspaceRootRevocationOptions,
  ): {
    activeChildrenVisited: number;
    liveScopesRevoked: number;
  } {
    let canonicalRoot: string;
    try {
      canonicalRoot = canonicalizePathForMatch(root);
    } catch {
      return { activeChildrenVisited: 0, liveScopesRevoked: 0 };
    }

    const errors = this.cancelActiveWireChildrenForWorkspaceRoot(canonicalRoot);
    let activeChildrenVisited = 0;
    let liveScopesRevoked = 0;
    for (const child of [...this.activeChildren.values()]) {
      activeChildrenVisited += 1;
      try {
        const result = child.loop.revokeWorkspaceRoot(canonicalRoot, options);
        liveScopesRevoked += result.sessionDirectoriesRemoved + result.turnDirectoriesRemoved;
      } catch (error: unknown) {
        errors.push(error);
        log.warn(
          {
            childSessionId: child.childSessionId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          },
          "sub-agent workspace scope revocation failed",
        );
      }
    }
    if (errors.length > 0) {
      throw Object.assign(
        new AggregateError(errors, "sub-agent-workspace-root-revoke-failed"),
        { code: "SUBAGENT_WORKSPACE_ROOT_REVOKE_FAILED" },
      );
    }
    return { activeChildrenVisited, liveScopesRevoked };
  }


  async deliverToParent(
    input: DeliverToParentInput,
    options?: {
      /**
       * This message IS the run's completion report — the same content
       * `agent_status` hands back once the run is terminal. Recording which
       * message that was is what lets a report the parent already read be
       * consumed instead of replayed as a steering row on the next turn.
       */
      terminalReport?: boolean;
    },
  ): Promise<DeliverToParentResult> {
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
      if (options?.terminalReport === true && result.ok) {
        const run = this.trackedRuns.get(input.childSessionId);
        if (
          run !== undefined
          && run.childSessionId === input.childSessionId
          && run.originSessionId === input.parentSessionId
        ) {
          run.terminalReport = { messageId: result.messageId };
        }
      }
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

  /**
   * The parent's pending child reports, minus the ones it has already read.
   *
   * A completed sub-agent reports twice by construction: once as the terminal
   * snapshot `agent_status` returns to the parent mid-turn, and once as the
   * durable mailbox entry the next turn folds in as host steering. Both are
   * legitimate — a parent that never polls must still receive the report — but
   * a parent that DID poll would otherwise be handed the same report a second
   * time, as an instruction to review work it already answered.
   *
   * The completion step owns both halves: it publishes the terminal state (and
   * the renderer frame) and records which mailbox message carries that state's
   * report. Here that record decides the entry's fate, so consumption stays
   * single-shot in either direction.
   */
  async peekParentMailbox(parentSessionId: string): Promise<ParentMailboxEntry[]> {
    const bus = this.deps.messageBus;
    if (!bus) return [];
    const entries = await bus.peekParentMailbox(parentSessionId);
    const alreadyRead = entries.filter(
      (entry) => this.isTerminalReportAlreadyRead(parentSessionId, entry),
    );
    if (alreadyRead.length === 0) return entries;
    const consumedIds = new Set(alreadyRead.map((entry) => entry.id));
    try {
      await bus.acknowledgeParentMailbox(parentSessionId, [...consumedIds]);
    } catch (err) {
      // Withholding the second delivery is unconditional — that decision is
      // already made above and this failure does not revisit it. What the
      // failure costs is DURABILITY of that decision: the read mark lives on
      // the tracked run, which is process-local and evictable by
      // `pruneTrackedRuns`, while the entry it retires is on disk. So the
      // retry on the next peek is the only thing standing between a failed
      // acknowledgement and the report reappearing after a restart. Persisting
      // the mark onto the entry instead was considered and rejected: it is the
      // same mailbox write that just failed, so it buys no durability the
      // retry does not, and it would leave a second definition of "consumed"
      // to keep in step with the first.
      log.warn(
        { parentSessionId, errorName: err instanceof Error ? err.name : "UnknownError" },
        "sub-agent completion mailbox acknowledgement failed for an already-read report",
      );
    }
    return entries.filter((entry) => !consumedIds.has(entry.id));
  }

  private isTerminalReportAlreadyRead(
    parentSessionId: string,
    entry: ParentMailboxEntry,
  ): boolean {
    const run = this.trackedRuns.get(entry.childSessionId);
    return run !== undefined
      && run.originSessionId === parentSessionId
      && run.childSessionId === entry.childSessionId
      && run.terminalReportObserved === true
      && run.terminalReport?.messageId === entry.message.messageId;
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
  private readonly inFlight = new Map<string, InFlightResumeAttempt>();
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
    // A freshly-created child is registered before metadata persistence so
    // workspace revocation can see it, but it is not message-routable until
    // runTurn owns an active turn (the pre-run routing invariant).
    const recipientIsActive = active?.originSessionId === sender.originSessionId
      && active.loop.hasActiveTurn();
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

  /**
   * A parent's mid-run directive to one of ITS OWN sub-agents.
   *
   * The other three A2A edges already existed — parent starts a child, child
   * reports to its parent, child messages a sibling — and the parent could
   * reach a SUSPENDED child by resuming it. What it could not do was tell a
   * child that is still running to change direction or stop; the only lever was
   * `agent_interrupt`, which throws the run away. This is that edge.
   *
   * AUTHORIZATION is the host-written spawn record (`isPersistedSpawnOfOrigin`),
   * never the parent's transcript: compaction can strip the linking tool_result,
   * and a claim in the model's context is not evidence of ownership. ONE HOP,
   * downward only — a sub-agent cannot direct anything (it is not a root
   * session, so `nested-parent` refuses it before ownership is even consulted),
   * and there is no `to: "parent"` here because that direction is `agent_send`.
   *
   * DELIVERY is durable-first, exactly as sibling A2A delivery is: the directive
   * is stored before the running child's guidance queue is touched, and the
   * store is acknowledged only from `onInjected`. A turn that ends before the
   * guidance reaches a round boundary therefore keeps the directive for the
   * child's next resume instead of dropping it with the queue.
   *
   * A child that is neither live nor resumable is REFUSED rather than queued.
   * `isResumableSubAgentTaskState` is the SOT the resume gate itself consumes:
   * queuing for a WORKING-but-not-live (interrupted, or restored across a
   * restart) child would store a message no code path can ever deliver, and a
   * TTL would only decide how long that lie stays on disk. The parent is told
   * the child is not resumable, which is actionable and true.
   */
  async queueParentMessageToChild(
    originSessionId: string,
    childSessionId: string,
    text: string,
  ): Promise<ParentDirectiveDeliveryResult> {
    const messageId = createDlpSafeUuid();
    const audit = (type: "info" | "warn", outcome: string): void =>
      this.auditParentDirective(type, { originSessionId, childSessionId, messageId }, outcome);
    const refuse = (
      reason: ParentDirectiveDropReason,
    ): Extract<ParentDirectiveDeliveryResult, { ok: false }> => {
      audit("warn", "dropped:" + reason);
      return { ok: false, reason };
    };

    if (!isValidSessionId(originSessionId) || !isValidSessionId(childSessionId)) {
      return refuse("unknown-recipient");
    }
    if (originSessionId === childSessionId) return refuse("self-send");
    // Hop guard, checked BEFORE ownership: a sub-agent session directing anything
    // would be a second hop on the parent axis, whatever it happens to own.
    if (
      this.deps.subAgentMemoryManager.loadSessionMetadata(originSessionId)?.sessionKind
        === "subagent"
    ) {
      return refuse("nested-parent");
    }
    const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(childSessionId);
    if (!this.isPersistedSpawnOfOrigin(originSessionId, childSessionId)) {
      // One verdict, two reasons — the same split sibling A2A already reports:
      // "no such child" and "someone else's child" are different facts to an
      // operator, and telling the parent which one it hit is what keeps it from
      // retrying an address that will never become its own. No disclosure here
      // that `agent_list` does not already make: every session is this user's.
      return refuse(meta?.sessionKind === "subagent" ? "cross-origin" : "unknown-recipient");
    }
    if (typeof text !== "string" || text.length > PARENT_DIRECTIVE_MAX_CHARS) {
      return refuse("message-too-long");
    }
    const masked = maskSubAgentText(text).trim();
    if (masked.length === 0 || hasUnsafeDirectiveControlChars(masked)) {
      return refuse("invalid-message");
    }
    const envelope = formatParentDirective(masked);
    if (envelope.length > GUIDE_MAX_CHARS) return refuse("message-too-long");

    const mailbox = this.deps.parentDirectiveMailbox;
    if (!mailbox) return refuse("mailbox-unavailable");

    const active = this.activeChildren.get(childSessionId);
    const live = active?.originSessionId === originSessionId
      && active.loop.hasActiveTurn() === true;
    const taskState = meta?.subAgentTaskState ?? A2ATaskState.SUBMITTED;
    if (!live) {
      if (isA2ATerminalTaskState(taskState)) return refuse("terminal-recipient");
      // Registered but not yet holding a turn: the run exists and will accept a
      // directive shortly, so this is a RETRY, not the "start it again" advice
      // `child-not-resumable` carries. The two look identical in persisted
      // metadata (both WORKING), which is why the live registry decides here.
      if (active?.originSessionId === originSessionId) {
        return refuse("recipient-unavailable");
      }
      // Every half of the resume gate: the state SOT, the suspension reason
      // `resumeWithPolicy` also requires, and the two resume-axis counters it
      // checks before running a turn. Accepting on any subset would store a
      // directive whose only delivery path refuses structurally — and an
      // exhausted child's refusal is permanent, so the directive would sit in
      // the mailbox until the child's terminal cleanup discarded it unread.
      if (
        !isResumableSubAgentTaskState(taskState)
        || !meta?.subAgentSuspensionReason
        || this.spentResumeAxis(meta) !== null
      ) {
        return refuse("child-not-resumable");
      }
    }

    let stored: Awaited<ReturnType<ParentDirectiveMailbox["append"]>>;
    try {
      stored = await mailbox.append({ originSessionId, childSessionId, text: envelope });
    } catch {
      return refuse("storage-failed");
    }
    if (!stored.ok) return refuse(stored.reason);
    const entryId = stored.entry.id;

    if (!live) {
      audit("info", "mailbox");
      return { ok: true, disposition: "mailbox", childSessionId, messageId };
    }

    // No `approvalReasonPrefix`, deliberately. That field is the sibling path's
    // force-ask trigger, and it belongs there: a sibling is a peer whose text
    // the receiver never agreed to act on. The parent is this child's PRINCIPAL
    // — it authored the task the child is already running, and a spawn's
    // instructions raise no force-ask. Making a mid-run amendment stricter than
    // the instructions it amends would put a modal in front of every directive,
    // which is how a real gate gets clicked through. The child's own tool calls
    // remain gated exactly as they were.
    const queued = active!.loop.queueGuidanceWithDisposition(envelope, {
      onInjected: () => mailbox
        .acknowledge(childSessionId, [entryId])
        .then((removed) => audit(
          removed === 1 ? "info" : "warn",
          removed === 1 ? "injected" : "ack-failed",
        ))
        .catch(() => audit("warn", "ack-failed")),
      onDropped: (reason) => audit("warn", "deferred:" + reason),
    });
    if (queued === "queued") {
      audit("info", "queued");
      return { ok: true, disposition: "queued", childSessionId, messageId };
    }

    // The child stopped accepting guidance between the liveness check and the
    // enqueue. The stored directive is only kept when the child landed somewhere
    // a resume can still deliver it from; otherwise it is removed, because an
    // entry no path will read is worse than an error the parent can act on.
    const settledState = this.deps.subAgentMemoryManager
      .loadSessionMetadata(childSessionId)?.subAgentTaskState ?? A2ATaskState.SUBMITTED;
    if (queued !== "queue-full" && isResumableSubAgentTaskState(settledState)) {
      audit("info", "mailbox:" + queued);
      return { ok: true, disposition: "mailbox", childSessionId, messageId };
    }
    try {
      const removed = await mailbox.acknowledge(childSessionId, [entryId]);
      if (removed !== 1) return refuse("storage-failed");
    } catch {
      return refuse("storage-failed");
    }
    return refuse(queued === "queue-full" ? "pending-cap" : "recipient-unavailable");
  }

  private auditParentDirective(
    type: "info" | "warn",
    input: { originSessionId: string; childSessionId: string; messageId: string },
    outcome: string,
  ): void {
    this.deps.parentDeps?.auditLogger?.log({
      timestamp: new Date().toISOString(),
      sessionId: isValidSessionId(input.originSessionId) ? input.originSessionId : "unknown",
      type,
      input: [
        "a2a:parent-directive:", outcome,
        ":origin=", sanitizeA2ALabel(input.originSessionId),
        ":child=", sanitizeA2ALabel(input.childSessionId),
        ":message=", input.messageId,
      ].join(""),
    });
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
    // A finished child reads nothing more, so an undelivered parent directive
    // addressed to it is now garbage that would otherwise hold a slot against
    // the per-child cap forever.
    try {
      await this.deps.parentDirectiveMailbox?.discardForChild(childSessionId);
    } catch {
      log.warn(
        "sub-agent terminal parent directive cleanup failed for %s",
        childSessionId,
      );
    }
    try {
      const cleaned = await this.deps.agentMessageBus
        ?.cleanupTerminalRecipientMailbox?.(childSessionId);
      if (!cleaned || cleaned.ok) return;
      log.warn(
        "sub-agent terminal agent mailbox cleanup failed for %s",
        childSessionId,
      );
    } catch {
      log.warn(
        "sub-agent terminal agent mailbox cleanup failed for %s",
        childSessionId,
      );
    }
  }

  private registerActiveChild(args: {
    childSessionId: string;
    originSessionId?: string;
    wireProjectRoot?: string;
    title: string;
    loop: ConversationLoop;
    background: boolean;
  }): symbol {
    const lease = Symbol(args.childSessionId);
    this.activeChildren.set(args.childSessionId, {
      ...args,
      // Workspace removal supplies the same filesystem-canonical form. Freeze
      // it here so symlink and dot-segment aliases cannot evade live aborts.
      ...(args.wireProjectRoot
        ? { wireProjectRoot: canonicalizePathForMatch(args.wireProjectRoot) }
        : {}),
      lease,
    });
    return lease;
  }

  private unregisterActiveChild(childSessionId: string, lease: symbol): void {
    const active = this.activeChildren.get(childSessionId);
    if (active?.lease === lease) this.activeChildren.delete(childSessionId);
  }

  listRunStatuses(
    originSessionId: string,
    options?: SubAgentRunReadOptions,
  ): SubAgentRunSnapshot[] {
    return [...this.uniqueTrackedRuns()]
      .filter((run) => this.isRunVisibleToOrigin(run, originSessionId))
      .map((run) => {
        if (options?.deliversReportToParent === true) this.markTerminalReportRead(run);
        return this.snapshotRun(run);
      })
      .sort((a, b) => {
        if (a.status === "running" && b.status !== "running") return -1;
        if (a.status !== "running" && b.status === "running") return 1;
        return b.updatedAt.localeCompare(a.updatedAt);
      });
  }

  getRunStatus(
    id: string,
    originSessionId: string,
    options?: SubAgentRunReadOptions,
  ): SubAgentRunSnapshot | null {
    const run = this.trackedRuns.get(id);
    if (run && !this.isRunVisibleToOrigin(run, originSessionId)) return null;
    if (!run) return null;
    if (options?.deliversReportToParent === true) this.markTerminalReportRead(run);
    return this.snapshotRun(run);
  }

  /**
   * Record that the parent has now read this run's completion report.
   *
   * A terminal snapshot carries the same summary, error, and transcript the
   * mailbox report carries, so a parent that read one has been told everything
   * the other would tell it. Marking it here is what lets
   * {@link peekParentMailbox} consume the queued copy rather than open the
   * parent's next turn with a steering row repeating work it already answered.
   *
   * Gated on `terminalReportPublished`, NOT on the task state reading terminal.
   * A run can read terminal with no result attached — an interrupt writes
   * CANCELED immediately, and the state machine then refuses the completed
   * result that arrives behind it — and a snapshot with no summary in it has
   * told the parent nothing. Only a landed result may retire the mailbox copy.
   *
   * Order between this and the delivery does not matter: the parent may poll
   * the finished run before the report is even enqueued (that is the reported
   * race). The two facts are recorded separately and combined only at peek.
   */
  private markTerminalReportRead(run: TrackedSubAgentRun): void {
    if (run.terminalReportPublished !== true) return;
    run.terminalReportObserved = true;
  }

  /**
   * Sub-agent rows persisted under one parent session, newest first.
   *
   * Must go through the runner rather than the main MemoryManager: children
   * live in their OWN namespace (`~/.lvis/subagent/`, wired in
   * `createIsolatedConversationMemoryManagers`), so the main manager's sessions
   * directory contains none of them. `getPersistedTranscript` below reaches the
   * same store the same way.
   *
   * Rows only — a child's transcript is fetched separately, on demand.
   */
  listPersistedSpawnsForOrigin(originSessionId: string): RestoredSubAgentSession[] {
    if (!isValidSessionId(originSessionId)) return [];
    return this.deps.subAgentMemoryManager.listSubAgentSessionsForOrigin(originSessionId);
  }

  /**
   * Whether `childSessionId` is a sub-agent this exact parent spawned.
   *
   * Answers ownership from the record the HOST wrote at spawn time rather than
   * from the parent's transcript, which compaction may have stripped the linking
   * tool_result out of. Both ids must be well-formed and the child must actually
   * be a sub-agent session: a main session id must never satisfy this, or it
   * would become a way to read another conversation.
   */
  isPersistedSpawnOfOrigin(originSessionId: string, childSessionId: string): boolean {
    if (!isValidSessionId(originSessionId) || !isValidSessionId(childSessionId)) return false;
    const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(childSessionId);
    return meta?.sessionKind === "subagent" && meta.originSessionId === originSessionId;
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
    onTerminal?: (result: SubAgentSpawnResult) => void;
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
      ...(args.onTerminal ? { onTerminal: args.onTerminal } : {}),
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
    run.terminalCommitClaimed = isA2ATerminalTaskState(run.taskState);
    // Ask `updateRun` whether it took the patch. It refuses a transition the
    // A2A state machine rejects — an interrupt that already wrote CANCELED
    // blocks the COMPLETED result racing in behind it — and on refusal the
    // summary, error, and transcript above never reached the run either. Only
    // a landed result is a report a reader can be told it has already seen.
    if (run.taskState === taskState) run.terminalReportPublished = true;
    // The renderer frame leaves from HERE, inside the step that publishes the
    // terminal state, and never from the caller that later awaits the run.
    // Between those two points a parent polling `agent_status` used to be able
    // to read `done` and answer from it while the sub-agent panel still showed
    // the run as live. Emitting synchronously after the state write closes that
    // window: no other code can observe the run between the two lines.
    //
    // Fired even when the patch was refused: the frame reports the outcome the
    // runner is returning to its caller, and a run whose result the state
    // machine turned away still has to stop drawing as live.
    const onTerminal = run.onTerminal;
    if (onTerminal === undefined) return;
    delete run.onTerminal;
    try {
      onTerminal(result);
    } catch (err) {
      // A renderer sink that throws must not leave the run half-committed.
      log.warn(
        {
          childSessionId: run.childSessionId,
          errorName: err instanceof Error ? err.name : "UnknownError",
        },
        "sub-agent completion observer failed",
      );
    }
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
  /**
   * The user's configured sub-agent round budget, or `null` when it is unset or
   * not a usable number. Returning `null` rather than a substituted default
   * keeps the resolution order in `spawn()` readable as a single `??` chain and
   * leaves MAX_TURNS_DEFAULT as the one place the fallback value is written.
   * The caller normalizes it (minimum of 1); it is never narrowed downward.
   */
  private configuredRoundBudget(): number | null {
    const configured = this.deps.parentDeps.settingsService.get("chat")?.subAgentMaxRounds;
    if (typeof configured !== "number" || !Number.isFinite(configured)) return null;
    return Math.floor(configured);
  }

  /**
   * The normalized round budget one invocation may run — the same resolution
   * `spawn()` and `resume()` use. The `agent_spawn` tool reads it to size its
   * executor wall clock: the round setting has no maximum, so a FIXED ceiling
   * silently reinstates the bound that setting exists to remove, killing a
   * long agent by the clock instead of by its budget.
   */
  roundBudget(): number {
    return normalizeRoundBudget(this.configuredRoundBudget() ?? MAX_TURNS_DEFAULT);
  }

  /**
   * Resume-axis cumulative ceiling, scaled to the CONFIGURED budget so the
   * resume-loop protection stays proportional instead of becoming an absolute
   * ceiling that binds below what one spawn is allowed to run.
   */
  private cumulativeRoundsCeiling(): number {
    return CUMULATIVE_ROUNDS_BUDGET_MULTIPLIER * this.roundBudget();
  }

  /**
   * Which resume-axis guard this suspended child has already spent, if any.
   *
   * ONE predicate for the two guards `resume()` enforces before it runs a
   * turn, so the ACCEPTANCE side (`queueParentMessageToChild`, `agent_list`'s
   * `resumable` flag) and the DELIVERY side cannot drift. Both axes are
   * deterministic — nothing a later resume does can lower a spent counter —
   * which is what makes "already exhausted" a fact the acceptance side may
   * act on rather than a race it would be guessing at.
   */
  private spentResumeAxis(meta: {
    subAgentSuspensionReason?: string;
    budgetResumeCount?: number;
    resumeCount?: number;
    cumulativeRounds?: number;
  }): "budget-resumes" | "cumulative-rounds" | null {
    const priorBudgetResumeCount = Math.max(
      meta.budgetResumeCount ?? 0,
      meta.resumeCount ?? 0,
    );
    if (
      meta.subAgentSuspensionReason === "budget"
      && priorBudgetResumeCount >= MAX_RESUMES
    ) {
      return "budget-resumes";
    }
    if ((meta.cumulativeRounds ?? 0) >= this.cumulativeRoundsCeiling()) {
      return "cumulative-rounds";
    }
    return null;
  }

  /**
   * Whether a resume of this child would be refused before running a turn.
   *
   * Read by `agent_list` so the `resumable` flag it advertises means what it
   * says: a child whose resume budget is spent is INPUT_REQUIRED forever, and
   * offering it as resumable spends a parent round on a guaranteed refusal.
   */
  isResumeExhausted(childSessionId: string): boolean {
    const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(childSessionId);
    if (!meta) return false;
    return this.spentResumeAxis(meta) !== null;
  }

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
    /**
     * The parent behind this run, when it has one that could answer for it.
     * `null` leaves the child's approvals on the path they took before tier 2
     * existed: straight to the user.
     */
    approvalProvenance: SubAgentApprovalProvenance | null;
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

    // Wrap the parent ApprovalGate so approval requests from this sub-agent's
    // tool calls show "[Sub-Agent: <title>]" in their reason text.
    const wrappedApprovalGate = this.deps.parentDeps.approvalGate
      ? makeSubAgentApprovalAdapter(
          this.deps.parentDeps.approvalGate,
          args.title,
          args.approvalProvenance,
        )
      : undefined;

    // Compose deps for the child loop. We share the parent's permissionManager,
    // hookRunner so the child plays by the same security rules.
    // History is fresh because ConversationLoop.constructor instantiates a new
    // ConversationHistory (spawn); resume re-hydrates it via loadSession.
    // API keys resolve through the configured vendor catalog. Codex
    // subscription selection has its own live catalog in main, while ACP
    // subscriptions intentionally retain their persisted default model.
    const llmSettings = this.deps.parentDeps.settingsService.get("llm");
    const subscriptionRuntime = llmSettings.activeChatRuntime?.kind === "subscription"
      ? llmSettings.activeChatRuntime
      : undefined;
    const resolvedModel = resolveSubAgentModel(
      args.profileModel,
      llmSettings.provider,
      subscriptionRuntime,
    );

    // A builder carries mutable project/session overlay state. Never share it
    // with a child: doing so can make the child read the parent's project
    // memory, or leave child state behind for the next parent turn.
    const parentPromptBuilder = this.deps.parentDeps.systemPromptBuilder;
    const childSystemPromptBuilder = typeof parentPromptBuilder.createIsolated === "function"
      ? parentPromptBuilder.createIsolated({
          memoryManager: this.deps.subAgentMemoryManager,
          toolRegistry: scopedRegistry,
        })
      // Test/minimal hosts that do not implement the concrete builder must
      // still fail closed: create a fresh minimal builder, never reuse parent.
      : new SystemPromptBuilder({
          // Minimal test/host doubles sometimes implement persistence only.
          // Supply empty prompt readers rather than falling back to the parent
          // builder (which would reintroduce the cross-agent leak).
          memoryManager: {
            getAgentsMd: () => this.deps.subAgentMemoryManager.getAgentsMd?.() ?? "",
            getMemoryIndex: (options) => this.deps.subAgentMemoryManager.getMemoryIndex?.(options) ?? "",
            getPromptMemoryIndex: () => this.deps.subAgentMemoryManager.getPromptMemoryIndex?.() ?? "",
            getUserPreferences: () => this.deps.subAgentMemoryManager.getUserPreferences?.() ?? "",
            getMemoryContext: (options) => this.deps.subAgentMemoryManager.getMemoryContext?.(options) ?? "",
            getProjectAgentsMd: (projectRoot) => this.deps.subAgentMemoryManager.getProjectAgentsMd?.(projectRoot)
              ?? { projectRoot, layers: [], totalBytes: 0 },
          } as MemoryManager,
          toolRegistry: scopedRegistry,
        });

    const childDeps: ConversationLoopDeps = {
      ...this.deps.parentDeps,
      toolRegistry: scopedRegistry,
      systemPromptBuilder: childSystemPromptBuilder,
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
      // The child's sessions live in the sub-agent namespace; the parent's
      // predicate scans the window's main loops and must not judge them.
      sessionHeldElsewhere: undefined,
      // Sub-agent does not request_plugin (its tool surface is fixed at spawn).
      pluginRuntime: undefined,
      forcedActivePluginIds,
      ...(forcedActiveToolNames ? { forcedActiveToolNames } : {}),
      // C2(c): the sub-agent uses the parent's SkillOverlay reference to
      // load skills if the user grants — but its own session id will be
      // tracked separately via setActiveSessionId.
      skillOverlay: this.deps.parentDeps.skillOverlay,
      // #1112: per-profile model override. Undefined keeps the active
      // runtime's persisted model selection.
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
    return await this.runSpawn(input, callbacks);
  }

  /**
   * Host-only A2A ingress. The remote-controlled request is intentionally
   * limited to message text; profile, tools, project, handler, origin, and
   * execution provenance all come from the host binding or are minted here.
   */
  async spawnFromA2AWire(
    request: A2AWireSpawnRequest,
    binding: A2AWireHostBinding,
    callbacks: A2AWireSpawnCallbacks,
  ): Promise<SubAgentSpawnResult> {
    const handlerSeed = typeof binding?.handlerId === "string"
      ? binding.handlerId
      : "invalid-handler";
    const internalOriginSessionId = buildA2AWireInternalOrigin(handlerSeed);
    const rejectedChildSessionId = buildChildSessionId(internalOriginSessionId);
    const messageText = canonicalizeA2AWireMessage(request?.messageText);
    const safeCallbacks = normalizeA2AWireSpawnCallbacks(callbacks);
    const durableLinkBarrier = safeCallbacks?.onDurablyLinked ?? null;
    if (!durableLinkBarrier || !messageText || !isValidA2AWireHostBinding(binding)) {
      return this.failA2AWireRun(
        rejectedChildSessionId,
        "sub-agent A2A wire binding is invalid",
        safeCallbacks ?? undefined,
      );
    }

    return await this.runSpawn(
      {
        title: binding.profile.name.trim(),
        instructions: renderAgentProfilePrompt(binding.profile, messageText),
        sourceTools: [...binding.profile.sourceTools],
        originSessionId: internalOriginSessionId,
        projectRoot: binding.project.root,
        ...(binding.project.name ? { projectName: binding.project.name } : {}),
        ...(binding.profile.model ? { profileModel: binding.profile.model } : {}),
        ...(binding.profile.mode ? { profileMode: binding.profile.mode } : {}),
        background: true,
      },
      safeCallbacks ?? undefined,
      {
        inputOrigin: "agent-message",
        approvalReasonPrefix: A2A_WIRE_APPROVAL_REASON_PREFIX,
        forceExplicitToolScope: true,
        wireBinding: {
          handlerId: binding.handlerId,
          internalOriginSessionId,
        },
      },
      durableLinkBarrier,
    );
  }

  private failA2AWireRun(
    childSessionId: string,
    message: string,
    callbacks?: SubAgentSpawnCallbacks,
  ): SubAgentSpawnResult {
    callbacks?.onError?.(message);
    return {
      summary: message,
      toolCallCount: 0,
      turnCount: 0,
      childSessionId,
      entries: [],
      ok: false,
      error: message,
    };
  }

  private async runSpawn(
    input: SubAgentSpawnInput,
    callbacks?: SubAgentSpawnCallbacks,
    executionPolicy?: SubAgentExecutionPolicy,
    durableLinkBarrier?: A2AWireSpawnCallbacks["onDurablyLinked"],
  ): Promise<SubAgentSpawnResult> {
    const childSessionId = buildChildSessionId(input.originSessionId);
    if (executionPolicy && typeof durableLinkBarrier !== "function") {
      return this.failA2AWireRun(
        childSessionId,
        "sub-agent A2A durable link barrier is required",
        callbacks,
      );
    }
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
      ...(callbacks?.onTerminal ? { onTerminal: callbacks.onTerminal } : {}),
    });
    if (!executionPolicy) callbacks?.onLinked?.({ childSessionId });

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
        // wins; otherwise the user's configured budget; otherwise the default.
        // The LLM cannot change this policy because agent_spawn exposes no raw
        // maxTurns field, and the profile's mode carries no budget of its own —
        // see MAX_TURNS_DEFAULT for why the per-mode split was removed.
        const requestedRounds =
          input.maxRounds ?? this.configuredRoundBudget() ?? MAX_TURNS_DEFAULT;
        const cappedRounds = normalizeRoundBudget(requestedRounds);

        // sourceTools empty/absent retains the historical full parent surface
        // minus the hard blocklist. Resume uses its frozen metadata instead.
        const frozenSourceTools = executionPolicy?.forceExplicitToolScope
          ? (input.sourceTools ?? [])
          : input.sourceTools && input.sourceTools.length > 0
            ? input.sourceTools
            : null;
        const { childDeps, scopedTools } = this.buildChildDeps({
          frozenSourceTools,
          title: input.title,
          profileModel: input.profileModel,
          includeAgentSend: true,
          approvalProvenance: buildSubAgentApprovalProvenance({
            childSessionId,
            originSessionId: input.originSessionId,
            // NOT `instructions`. By the time a profile-based spawn reaches
            // here, `instructions` is the RENDERED prompt — profile body first,
            // the parent's task last — so any bound on it keeps the role
            // charter and drops the task. A charter argues for every call.
            task: input.parentAuthoredTask,
            wireBound: executionPolicy !== undefined,
            background: input.background === true,
          }),
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
        if (
          executionPolicy
          && !projectRootEquals(child.getSessionProjectRoot(), input.projectRoot)
        ) {
          throw new Error(
            "sub-agent A2A project binding rejected (a2a-project-binding-rejected)",
          );
        }
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
      ...(executionPolicy
        ? child.getSessionProjectContext()
        : !child.getSessionProjectIsDefault()
          ? child.getSessionProjectContext()
          : {}),
      sourceTools: scopedTools.map((tool) => tool.name),
      ...(input.profileModel !== undefined ? { profileModel: input.profileModel } : {}),
      ...(input.profileMode !== undefined ? { profileMode: input.profileMode } : {}),
      ...(input.originSessionId !== undefined ? { originSessionId: input.originSessionId } : {}),
      ...(executionPolicy
        ? {
            a2aWireHandlerId: executionPolicy.wireBinding.handlerId,
            a2aWireInternalOrigin: executionPolicy.wireBinding.internalOriginSessionId,
          }
        : {}),
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
    // Register the addressable child before the first asynchronous boundary.
    // Workspace removal snapshots `activeChildren`; registering only after the
    // initial metadata write left a window where a fully-constructed child kept
    // stale project directories but was invisible to live-scope revocation.
    const activeLease = this.registerActiveChild({
      childSessionId,
      originSessionId: input.originSessionId,
      ...(executionPolicy && input.projectRoot ? { wireProjectRoot: input.projectRoot } : {}),
      title: input.title,
      loop: child,
      background: input.background === true,
    });
    let completedQuestionWait: ActiveSubAgentChild["questionWait"];
    const unregisterSpawnChild = (): void => {
      const active = this.activeChildren.get(childSessionId);
      if (active?.lease === activeLease) {
        completedQuestionWait = active.questionWait;
      }
      this.unregisterActiveChild(childSessionId, activeLease);
    };
    let initialMetadataPersisted = false;
    try {
      await this.deps.subAgentMemoryManager.saveSessionMetadata(
        childSessionId,
        spawnMetadata,
      );
      initialMetadataPersisted = true;
      if (
        executionPolicy
        && !this.hasAuthoritativeA2AWireProjectBinding(
          childSessionId,
          executionPolicy,
          input.projectRoot,
          A2ATaskState.SUBMITTED,
        )
      ) {
        cancellation.abort();
        throw new Error("sub-agent A2A project binding detached");
      }
      if (executionPolicy) {
        await durableLinkBarrier!({ childSessionId });
        callbacks?.onLinked?.({ childSessionId });
      }
    } catch (err) {
      unregisterSpawnChild();
      if (!initialMetadataPersisted) trackedRun.initialMetadataFailed = true;
      const interrupted = cancellation.signal.aborted;
      const message = interrupted
        ? "sub-agent run interrupted"
        : initialMetadataPersisted
          ? "sub-agent durable binding failed"
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
      if (initialMetadataPersisted) {
        try {
          await this.deps.subAgentMemoryManager.saveSessionMetadata(childSessionId, {
            ...spawnMetadata,
            subAgentTaskState: projectSubAgentResultState(result),
          });
        } catch {
          // The provider is still blocked; the wire/task owner must reconcile the failed bind.
        }
      }
      this.finalizeRun(trackedRun, result);
      if (!interrupted) callbacks?.onError?.(maskSubAgentText(message));
      return result;
    }

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
      // Pre-loop terminal paths (cancellation/provider setup failure) do not
      // enter runTurn's finally block. Release the same lease here; the helper
      // is idempotent and also preserves any staged question owned by it.
      unregisterSpawnChild();
      // Claim the terminal transition before the first async preparation yield.
      // Cancellation and final persistence therefore have a single winner.
      trackedRun.terminalCommitClaimed = true;
      delete trackedRun.abort;
      let stableResult = await this.prepareQuestionStageForPersistence(
        completedQuestionWait,
        terminalResult,
      );
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
    if (
      executionPolicy
      && !projectRootEquals(child.getSessionProjectRoot(), input.projectRoot)
    ) {
      const message =
        "sub-agent A2A project binding rejected (a2a-project-binding-rejected)";
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
    const reasoningStreamEmitter = createCoalescedEmitter(
      emitActivity,
      REASONING_STREAM_EMIT_INTERVAL_MS,
    );
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

    try {
      // Subagent lifecycle parity (#811): fire SubagentStart on the child loop
      // before its spawn run and SubagentStop in the finally. Observe-only and
      // fail-soft (runLifecycleEvent swallows-and-continues), so a hook can
      // never wedge or fail the spawn.
      await child.fireLifecycleEvent("SubagentStart", {
        agentId: input.spawnId,
        agentType: input.profileMode,
      });
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
          onReasoningDelta: (text) => {
            transcript.onReasoningDelta(text);
            reasoningStreamEmitter.schedule();
          },
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
            // Drop any queued delta emission first: the fold below is the
            // authoritative state for this round, and a trailing snapshot
            // landing after it would replace the finalized thought with the
            // mid-stream one.
            reasoningStreamEmitter.cancel();
            transcript.onAssistantRound(round.thought, round.text);
            emitActivity();
          },
          onError: (e) => {
            callbacks?.onError?.(maskSubAgentText(e));
          },
        },
        // The run's cancellation signal, exactly as the resume path passes it.
        // The `abortCurrentTurn()` closure registered above cannot cover the
        // window between `interruptRun` firing and this call: it is documented
        // as a no-op when no turn is in flight, so an interrupt that lands
        // during spawn setup was reported as CANCELED while the child went on
        // to burn its full `cappedRounds` — and the second interrupt returns
        // "not running", so the user could not even retry.
        cancellation.signal,
        {
          maxRounds: cappedRounds,
          sessionIdOverride: childSessionId,
          spawnDepth: 1,
          ...(executionPolicy
            ? { approvalReasonPrefix: executionPolicy.approvalReasonPrefix }
            : {}),
          inputOrigin: executionPolicy?.inputOrigin ?? "llm-tool-arg",
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
      // A run aborted mid-stream has deltas with no round boundary behind
      // them, so a queued trailing emission could still land after this run
      // has gone terminal. Drop it here rather than let an activity frame
      // trail the terminal one.
      reasoningStreamEmitter.cancel();
      unregisterSpawnChild();
      // SubagentStop — fires once whether the run completed, errored, or
      // aborted (the subagent has stopped either way). Observe-only/fail-soft.
      await child.fireLifecycleEvent("SubagentStop", {
        agentId: input.spawnId,
        agentType: input.profileMode,
      });
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
   * Refused BEFORE any turn (`{ ok:false, resumeRefusal:"exhausted" }`) when the
   * session already hit `MAX_RESUMES` or the cumulative-rounds ceiling. A
   * per-`childSessionId` in-flight lock fail-closes a second concurrent resume
   * of the same id (the load→run→save transaction is not covered by the
   * file-level write lock).
   *
   * @param resumeId  The `childSessionId` returned by the original spawn (also
   *                  surfaced to the parent LLM via the incomplete tool result).
   * @param continuationInstructions  The follow-up prompt for the fresh turn.
   * @param title     Sub-agent title for the approval-dock label. Not stored
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
    return await this.resumeWithPolicy(
      resumeId,
      continuationInstructions,
      title,
      callbacks,
      originSessionId,
      spawnId,
      background,
    );
  }

  private resolveA2AWireBindingMetadata(
    childSessionId: string,
    handlerId: string,
  ): A2AWireBoundMetadata | null {
    if (!isValidA2AWireId(childSessionId) || !isValidA2AWireId(handlerId)) return null;
    const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(childSessionId);
    const isDetachedTerminalTask = meta?.projectRoot === undefined
      && meta?.subAgentTaskState !== undefined
      && isA2ATerminalTaskState(meta.subAgentTaskState);
    if (
      !meta
      || meta.sessionKind !== "subagent"
      || !meta.subAgentTitle
      || (!meta.projectRoot && !isDetachedTerminalTask)
      || meta.sourceTools === undefined
      || meta.a2aWireHandlerId !== handlerId
      || !meta.a2aWireInternalOrigin
      || meta.a2aWireInternalOrigin !== meta.originSessionId
    ) {
      return null;
    }
    if (
      !meta.subAgentTaskState
      || (
        meta.subAgentTaskState === A2ATaskState.INPUT_REQUIRED
          ? (
              !meta.subAgentSuspensionReason
              || !meta.subAgentSuspensionPrompt?.trim()
            )
          : (
              meta.subAgentSuspensionReason !== undefined
              || meta.subAgentSuspensionPrompt !== undefined
            )
      )
    ) {
      return null;
    }
    return meta as A2AWireBoundMetadata;
  }

  private hasAuthoritativeA2AWireProjectBinding(
    childSessionId: string,
    executionPolicy: SubAgentExecutionPolicy,
    projectRoot: unknown,
    expectedTaskState: A2AProjectedTaskState,
  ): boolean {
    const meta = this.resolveA2AWireBindingMetadata(
      childSessionId,
      executionPolicy.wireBinding.handlerId,
    );
    return meta !== null
      && meta.a2aWireInternalOrigin
        === executionPolicy.wireBinding.internalOriginSessionId
      && meta.subAgentTaskState === expectedTaskState
      && projectRootEquals(meta.projectRoot, projectRoot);
  }

  private snapshotA2AWireRun(
    childSessionId: string,
    meta: A2AWireBoundMetadata,
  ): A2AWireRunSnapshot {
    const inFlightRun = this.inFlight.get(childSessionId)?.run;
    const trackedRun = inFlightRun ?? this.trackedRuns.get(childSessionId);
    const isDetachedTerminalTask = meta.projectRoot === undefined
      && meta.subAgentTaskState !== undefined
      && isA2ATerminalTaskState(meta.subAgentTaskState);
    if (
      !isDetachedTerminalTask
      && trackedRun
      && !trackedRun.cancellationPersistencePending
      && trackedRun.childSessionId === childSessionId
      && trackedRun.originSessionId === meta.a2aWireInternalOrigin
    ) {
      return {
        childSessionId,
        title: trackedRun.title,
        taskState: trackedRun.taskState,
        updatedAt: trackedRun.updatedAt,
        ...(trackedRun.summary !== undefined ? { summary: trackedRun.summary } : {}),
        ...(trackedRun.error !== undefined ? { error: trackedRun.error } : {}),
        ...(trackedRun.stopReason !== undefined ? { stopReason: trackedRun.stopReason } : {}),
        ...(trackedRun.suspension !== undefined
          ? { suspension: trackedRun.suspension }
          : {}),
      };
    }

    const taskState = meta.subAgentTaskState ?? A2ATaskState.SUBMITTED;
    const suspension = taskState === A2ATaskState.INPUT_REQUIRED
      && meta.subAgentSuspensionReason
      ? {
          reason: meta.subAgentSuspensionReason,
          ...(meta.subAgentSuspensionPrompt
            ? { prompt: meta.subAgentSuspensionPrompt }
            : {}),
          resumeId: childSessionId,
        }
      : undefined;
    return {
      childSessionId,
      title: maskSubAgentText(meta.subAgentTitle),
      taskState,
      ...(suspension ? { suspension } : {}),
    };
  }

  getA2AWireRunSnapshot(
    childSessionId: string,
    binding: A2AWireResumeBinding,
  ): A2AWireRunSnapshot | null {
    const meta = this.resolveA2AWireBindingMetadata(
      childSessionId,
      binding?.handlerId,
    );
    return meta ? this.snapshotA2AWireRun(childSessionId, meta) : null;
  }

  async cancelA2AWireRun(
    childSessionId: string,
    binding: A2AWireResumeBinding,
  ): Promise<A2AWireCancelResult> {
    const meta = this.resolveA2AWireBindingMetadata(
      childSessionId,
      binding?.handlerId,
    );
    if (!meta) return { ok: false, reason: "task-not-found" };

    const durableState = meta.subAgentTaskState ?? A2ATaskState.SUBMITTED;
    if (isA2ATerminalTaskState(durableState)) {
      return {
        ok: false,
        reason: "task-not-cancelable",
        run: this.snapshotA2AWireRun(childSessionId, meta),
      };
    }

    const trackedRun = this.inFlight.get(childSessionId)?.run
      ?? this.trackedRuns.get(childSessionId);
    if (
      trackedRun
      && trackedRun.originSessionId !== meta.a2aWireInternalOrigin
    ) {
      return { ok: false, reason: "task-not-found" };
    }
    const canceledMeta: A2AWireBoundMetadata = {
      ...meta,
      subAgentTaskState: A2ATaskState.CANCELED,
      subAgentSuspensionReason: undefined,
      subAgentSuspensionPrompt: undefined,
    };
    if (trackedRun?.cancellationPersistencePending) {
      try {
        await this.deps.subAgentMemoryManager.saveSessionMetadata(
          childSessionId,
          canceledMeta,
        );
      } catch {
        return {
          ok: false,
          reason: "storage-failed",
        };
      }
      trackedRun.cancellationPersistencePending = false;
      await this.cleanupTerminalRecipientMailbox(
        childSessionId,
        A2ATaskState.CANCELED,
      );
      return {
        ok: true,
        run: this.snapshotA2AWireRun(childSessionId, canceledMeta),
      };
    }
    if (trackedRun?.terminalCommitClaimed) {
      return {
        ok: false,
        reason: "task-not-cancelable",
        run: this.snapshotA2AWireRun(childSessionId, meta),
      };
    }
    if (trackedRun && isA2ATerminalTaskState(trackedRun.taskState)) {
      return {
        ok: false,
        reason: "task-not-cancelable",
        run: this.snapshotA2AWireRun(childSessionId, meta),
      };
    }
    if (trackedRun?.abort) {
      trackedRun.cancellationPersistencePending = true;
      trackedRun.abort();
      delete trackedRun.abort;
      this.updateRun(trackedRun, {
        taskState: A2ATaskState.CANCELED,
        stopReason: "interrupted",
        suspension: undefined,
      });
      try {
        await this.deps.subAgentMemoryManager.saveSessionMetadata(
          childSessionId,
          canceledMeta,
        );
      } catch {
        return {
          ok: false,
          reason: "storage-failed",
        };
      }
      trackedRun.cancellationPersistencePending = false;
      await this.cleanupTerminalRecipientMailbox(
        childSessionId,
        A2ATaskState.CANCELED,
      );
      return {
        ok: true,
        run: this.snapshotA2AWireRun(childSessionId, canceledMeta),
      };
    }
    if (trackedRun && trackedRun.taskState !== A2ATaskState.INPUT_REQUIRED) {
      return {
        ok: false,
        reason: "task-not-cancelable",
        run: this.snapshotA2AWireRun(childSessionId, meta),
      };
    }

    try {
      await this.deps.subAgentMemoryManager.saveSessionMetadata(
        childSessionId,
        canceledMeta,
      );
    } catch {
      return {
        ok: false,
        reason: "storage-failed",
      };
    }
    if (trackedRun) {
      delete trackedRun.abort;
      this.updateRun(trackedRun, {
        taskState: A2ATaskState.CANCELED,
        stopReason: "interrupted",
        suspension: undefined,
      });
    }
    await this.cleanupTerminalRecipientMailbox(
      childSessionId,
      A2ATaskState.CANCELED,
    );
    return {
      ok: true,
      run: this.snapshotA2AWireRun(
        childSessionId,
        canceledMeta,
      ),
    };
  }

  /** Continue a wire-bound task without accepting remote provenance choices. */
  async resumeFromA2AWire(
    request: A2AWireResumeRequest,
    binding: A2AWireResumeBinding,
    callbacks?: SubAgentSpawnCallbacks,
  ): Promise<SubAgentSpawnResult> {
    const messageText = canonicalizeA2AWireMessage(request?.messageText);
    const rawResumeId = request?.resumeId;
    const resumeId = isValidA2AWireId(rawResumeId)
      ? rawResumeId
      : "invalid-a2a-wire-resume";
    const meta = this.resolveA2AWireBindingMetadata(
      resumeId,
      binding?.handlerId,
    );
    if (
      !messageText
      || !meta
    ) {
      return this.failA2AWireRun(
        resumeId,
        "sub-agent A2A wire resume binding is invalid",
        callbacks,
      );
    }

    return await this.resumeWithPolicy(
      resumeId,
      messageText,
      meta.subAgentTitle,
      callbacks,
      meta.a2aWireInternalOrigin,
      undefined,
      true,
      {
        inputOrigin: "agent-message",
        approvalReasonPrefix: A2A_WIRE_APPROVAL_REASON_PREFIX,
        forceExplicitToolScope: true,
        wireBinding: {
          handlerId: binding.handlerId,
          internalOriginSessionId: meta.a2aWireInternalOrigin,
        },
      },
    );
  }

  private async resumeWithPolicy(
    resumeId: string,
    continuationInstructions: string,
    title: string,
    callbacks?: SubAgentSpawnCallbacks,
    originSessionId?: string,
    spawnId?: string,
    background = false,
    executionPolicy?: SubAgentExecutionPolicy,
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
        ...(callbacks?.onTerminal ? { onTerminal: callbacks.onTerminal } : {}),
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

    const attempt: InFlightResumeAttempt = {};
    const runPromise = this.runResume(
      resumeId,
      continuationInstructions,
      title,
      callbacks,
      originSessionId,
      spawnId,
      background,
      executionPolicy,
      attempt,
    );
    attempt.promise = runPromise;
    this.inFlight.set(resumeId, attempt);
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
    executionPolicy: SubAgentExecutionPolicy | undefined,
    attempt: InFlightResumeAttempt,
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
      ...(callbacks?.onTerminal ? { onTerminal: callbacks.onTerminal } : {}),
    });
    let activeLease: symbol | undefined;
    let completedQuestionWait: ActiveSubAgentChild["questionWait"];
    const unregisterResumeChild = (): void => {
      const lease = activeLease;
      if (!lease) return;
      const active = this.activeChildren.get(resumeId);
      if (active?.lease === lease) {
        completedQuestionWait = active.questionWait;
      }
      this.unregisterActiveChild(resumeId, lease);
      activeLease = undefined;
    };
    attempt.run = trackedRun;

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

    // Structural policy refusals: retrying the SAME resumeId can never
    // succeed, so each carries the `resumeRefusal: "invalid"` marker that
    // suppresses agent_spawn's retry guidance. Contrast the question-answer
    // length check below, which stays UNMARKED on purpose — fixing the answer
    // and retrying the same id is the correct move there.
    const refuseStructurally = (message: string) =>
      finishAttemptFailure(message, { resumeRefusal: "invalid" });

    if (!isValidSessionId(resumeId)) {
      return refuseStructurally(
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
        return refuseStructurally(
          "sub-agent resume: resumeId does not belong to this session",
        );
      }
    }

    const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(resumeId);
    if (meta === null) {
      return refuseStructurally(
        'sub-agent resume: no session metadata for "' + resumeId + '"',
      );
    }
    if (meta.sessionKind !== "subagent") {
      return refuseStructurally(
        'sub-agent resume: session "' + resumeId
          + '" is not a sub-agent (kind=' + (meta.sessionKind ?? "unknown") + ")",
      );
    }
    if (meta.originSessionId !== originSessionId) {
      return refuseStructurally(
        "sub-agent resume: origin session metadata does not match caller",
      );
    }
    const hasWireBinding = meta.a2aWireHandlerId !== undefined
      || meta.a2aWireInternalOrigin !== undefined;
    if (executionPolicy) {
      if (
        meta.a2aWireHandlerId !== executionPolicy.wireBinding.handlerId
        || meta.a2aWireInternalOrigin !== executionPolicy.wireBinding.internalOriginSessionId
        || meta.a2aWireInternalOrigin !== meta.originSessionId
        || !meta.projectRoot
        || meta.sourceTools === undefined
      ) {
        return refuseStructurally(
          "sub-agent resume: A2A wire binding metadata does not match caller",
        );
      }
    } else if (hasWireBinding) {
      return refuseStructurally(
        "sub-agent resume: wire-bound task requires the A2A wire entry point",
      );
    }
    if (
      !isResumableSubAgentTaskState(meta.subAgentTaskState)
      || !meta.subAgentSuspensionReason
    ) {
      return refuseStructurally(
        "sub-agent resume: task is not in INPUT_REQUIRED",
      );
    }
    if (!meta.subAgentTitle) {
      return refuseStructurally(
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
      return refuseStructurally(
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
      unregisterResumeChild();
      const result = failureResult(message, extra);
      // Terminal commit point: after this synchronous detach, a late interrupt
      // is rejected and cannot race the single durable terminal write.
      trackedRun.terminalCommitClaimed = true;
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

    const cumulativeRoundsCeiling = this.cumulativeRoundsCeiling();
    // Same predicate `queueParentMessageToChild` and `agent_list` consult, so
    // what they call "resumable" is exactly what this path will accept.
    const spentAxis = this.spentResumeAxis(meta);
    if (spentAxis === "budget-resumes") {
      return await finishAuthorizedFailure(
        "sub-agent resume: exhausted (budgetResumeCount="
          + priorBudgetResumeCount + " >= " + MAX_RESUMES + ")",
        { resumeRefusal: "exhausted" },
      );
    }
    if (spentAxis === "cumulative-rounds") {
      return await finishAuthorizedFailure(
        "sub-agent resume: cumulative-rounds ceiling reached ("
          + priorCumulativeRounds + " >= " + cumulativeRoundsCeiling + ")",
        { resumeRefusal: "exhausted" },
      );
    }

    // Same resolution as spawn: the user's configured budget, else the default.
    // No per-mode budget exists to consult (see MAX_TURNS_DEFAULT) — a resumed
    // agent given 15 rounds because its profile says "explore" would die
    // mid-investigation exactly like the spawn path did.
    const requestedRounds = this.configuredRoundBudget() ?? MAX_TURNS_DEFAULT;
    const remainingRounds = cumulativeRoundsCeiling - priorCumulativeRounds;
    const cappedRounds = Math.max(
      SUBAGENT_MAX_ROUNDS_MIN,
      Math.min(normalizeRoundBudget(requestedRounds), remainingRounds),
    );

    const frozenSourceTools = meta.sourceTools;
    if (!frozenSourceTools || (!executionPolicy && frozenSourceTools.length === 0)) {
      return await finishAuthorizedFailure(
        'sub-agent resume: session "' + resumeId
          + '" has a missing or empty frozen tool scope; metadata may be corrupted or tampered',
      );
    }
    const { childDeps } = this.buildChildDeps({
      frozenSourceTools,
      title: meta.subAgentTitle,
      profileModel: meta.profileModel,
      // A resumed run's ORIGINAL instructions are not persisted, so the task
      // here is the continuation the parent just wrote — which is the framing
      // this segment of the run is actually working to, and the only
      // parent-authored text that survives the suspension.
      approvalProvenance: buildSubAgentApprovalProvenance({
        childSessionId: resumeId,
        originSessionId,
        // The canonical form, which is what this segment actually runs on: a
        // question-answer resume masks the continuation before using it.
        task: canonicalContinuationInstructions,
        // Both the door this resume came through AND what the session itself
        // records. The guard above already refuses a wire-bound session
        // resumed through the local entry point, so these agree today — but
        // "which door" is an inference and `hasWireBinding` is the fact, and
        // the fact is what decides whether a remote peer wrote this framing.
        wireBound: executionPolicy !== undefined || hasWireBinding,
        background,
      }),
      // Spawn passes this; resume used to omit it, so a re-hydrated child came
      // back WITHOUT the ability to reach its parent unless `agent_send` happened
      // to survive in the persisted scope — and spawn deliberately filters it out
      // of `sourceTools` before registering it separately, so it usually did not.
      // A resumed sub-agent is the same agent as before the suspension; losing
      // its channel to the parent on re-hydration is a capability regression, not
      // a scope narrowing. This does NOT widen the frozen tool scope: every other
      // tool still comes from persisted metadata.
      includeAgentSend: true,
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
    if (
      executionPolicy
      && !projectRootEquals(child.getSessionProjectRoot(), meta.projectRoot)
    ) {
      return await finishAuthorizedFailure(
        "sub-agent resume: A2A project binding rejected (a2a-project-binding-rejected)",
      );
    }
    if (cancellation.signal.aborted) {
      return await finishAuthorizedFailure("sub-agent run interrupted");
    }
    // A resumed child is live as soon as its loop and project scope exist.
    // Register it before mailbox or metadata I/O so workspace removal cannot
    // snapshot activeChildren in the construction-to-run gap and leave stale
    // directories on the child loop.
    activeLease = this.registerActiveChild({
      childSessionId: resumeId,
      originSessionId: meta.originSessionId,
      ...(executionPolicy && meta.projectRoot ? { wireProjectRoot: meta.projectRoot } : {}),
      title: meta.subAgentTitle,
      loop: child,
      background,
    });
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
    // Parent directives queued while this child was suspended. They ride the
    // SAME initial-guidance channel as sibling mail — one injection path, one
    // joined bound — and carry no A2A causal context: the parent is this run's
    // own principal, not a peer whose hop has to be accounted for.
    let parentDirectiveEntries: ParentDirectiveEntry[] = [];
    const parentDirectiveMailbox = this.deps.parentDirectiveMailbox;
    // A resume with no origin (host-internal callers) addresses no parent, so
    // there is no authority under which a stored directive could be delivered.
    if (parentDirectiveMailbox && originSessionId) {
      try {
        // The caller's origin, which the gate above already proved equal to the
        // persisted `meta.originSessionId`: a directive is delivered on the
        // authority of the parent asking for this resume, not on its own claim.
        parentDirectiveEntries = await parentDirectiveMailbox.peek(
          resumeId,
          originSessionId,
        );
      } catch {
        return await finishAuthorizedFailure(
          "sub-agent resume: parent directive read failed",
        );
      }
    }
    const initialGuidance = [
      agentMailboxGuidance,
      ...parentDirectiveEntries.map((entry) => entry.text),
    ].filter((part): part is string => part !== undefined && part.length > 0)
      .join("\n\n");
    if (initialGuidance.length > GUIDE_JOINED_MAX_CHARS) {
      return await finishAuthorizedFailure(
        "sub-agent resume: injected guidance exceeds host limit",
      );
    }
    if (cancellation.signal.aborted) {
      return await finishAuthorizedFailure("sub-agent run interrupted");
    }
    if (
      executionPolicy
      && !projectRootEquals(child.getSessionProjectRoot(), meta.projectRoot)
    ) {
      return await finishAuthorizedFailure(
        "sub-agent resume: A2A project binding rejected (a2a-project-binding-rejected)",
      );
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
    if (
      executionPolicy
      && !this.hasAuthoritativeA2AWireProjectBinding(
        resumeId,
        executionPolicy,
        meta.projectRoot,
        A2ATaskState.WORKING,
      )
    ) {
      cancellation.abort();
      return await finishAuthorizedFailure("sub-agent run interrupted");
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
    const reasoningStreamEmitter = createCoalescedEmitter(
      emitActivity,
      REASONING_STREAM_EMIT_INTERVAL_MS,
    );
    let ok = false;
    let failureReason: string | undefined;
    let childInputRequired: TurnInputRequired | undefined;
    let childStopReason: import("./turn/types.js").TurnStopReason | undefined;

    try {
      const turnResult = await child.runTurn(
        canonicalContinuationInstructions,
        {
          onReasoningDelta: (text) => {
            transcript.onReasoningDelta(text);
            reasoningStreamEmitter.schedule();
          },
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
            // Drop any queued delta emission first: the fold below is the
            // authoritative state for this round, and a trailing snapshot
            // landing after it would replace the finalized thought with the
            // mid-stream one.
            reasoningStreamEmitter.cancel();
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
          ...(initialGuidance.length > 0 ? { initialGuidance } : {}),
          ...(agentMailboxCausalContext
            ? { a2aCausalContext: agentMailboxCausalContext }
            : {}),
          ...(executionPolicy
            ? { approvalReasonPrefix: executionPolicy.approvalReasonPrefix }
            : agentMailboxApprovalPrefix
              ? { approvalReasonPrefix: agentMailboxApprovalPrefix }
              : {}),
          inputOrigin: executionPolicy?.inputOrigin
            ?? (persistedResumeReason === "question" || agentMailboxEntries.length > 0
              ? "agent-message"
              : "llm-tool-arg"),
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
      // Same reason as the spawn path: an abort mid-stream leaves deltas with
      // no round boundary to cancel their queued emission.
      reasoningStreamEmitter.cancel();
      unregisterResumeChild();
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

    // Claim the terminal transition before the first async preparation yield.
    // Cancellation and final persistence therefore have a single winner.
    trackedRun.terminalCommitClaimed = true;
    delete trackedRun.abort;
    result = await this.prepareQuestionStageForPersistence(
      completedQuestionWait,
      result,
    );

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

    // The SIBLING mailbox deliberately keeps the narrower rule: a peer's
    // message rides an at-least-once lane whose entry also carries the causal
    // context and force-ask label governing the segment, and retaining it on a
    // round-cap is what carries that governance into the continuation. See the
    // "retains idle sibling mailbox delivery" case in subagent-resume.test.ts.
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
    // A parent directive is consumed when the turn that carried it reached a
    // conclusion — INCLUDING a round-cap (see `resumeSegmentConsumedGuidance`).
    // It carries no causal context and no force-ask label, so unlike the
    // sibling entry above there is nothing in it that a continuation still
    // needs; re-injecting it would only replay the parent's one message at the
    // top of every remaining segment. A run that failed or was interrupted
    // acknowledges nothing.
    if (
      parentDirectiveMailbox
      && parentDirectiveEntries.length > 0
      && resumeSegmentConsumedGuidance(result)
    ) {
      try {
        const removed = await parentDirectiveMailbox.acknowledge(
          resumeId,
          parentDirectiveEntries.map((entry) => entry.id),
        );
        if (removed !== parentDirectiveEntries.length) {
          log.warn(
            "sub-agent resume: parent directive acknowledgement mismatch for %s",
            resumeId,
          );
        }
      } catch {
        log.warn(
          "sub-agent resume: parent directive acknowledgement failed for %s",
          resumeId,
        );
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

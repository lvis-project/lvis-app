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
import type { GenericMessage } from "./llm/types.js";

const log = createLogger("lvis");

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

export type SubAgentRunStatus = "running" | "done" | "error" | "interrupted";

export interface SubAgentRunSnapshot {
  spawnId?: string;
  childSessionId: string;
  title: string;
  status: SubAgentRunStatus;
  startedAt: string;
  updatedAt: string;
  toolCallCount: number;
  turnCount: number;
  entries: ChatEntry[];
  summary?: string;
  error?: string;
  stopReason?: import("./turn/types.js").TurnStopReason;
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
  startedAt: string;
  updatedAt: string;
  toolCallCount: number;
  turnCount: number;
  entries: ChatEntry[];
  summary?: string;
  error?: string;
  stopReason?: import("./turn/types.js").TurnStopReason;
  abort?: () => void;
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
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      toolCallCount: run.toolCallCount,
      turnCount: run.turnCount,
      entries: run.entries,
      ...(run.summary !== undefined ? { summary: run.summary } : {}),
      ...(run.error !== undefined ? { error: run.error } : {}),
      ...(run.stopReason !== undefined ? { stopReason: run.stopReason } : {}),
    };
  }

  private trackRun(args: {
    spawnId?: string;
    childSessionId: string;
    originSessionId?: string;
    title: string;
    abort?: () => void;
  }): TrackedSubAgentRun {
    const now = new Date().toISOString();
    const run: TrackedSubAgentRun = {
      ...(args.spawnId ? { spawnId: args.spawnId } : {}),
      childSessionId: args.childSessionId,
      ...(args.originSessionId ? { originSessionId: args.originSessionId } : {}),
      title: args.title,
      status: "running",
      startedAt: now,
      updatedAt: now,
      toolCallCount: 0,
      turnCount: 0,
      entries: [],
      ...(args.abort ? { abort: args.abort } : {}),
    };
    this.trackedRuns.set(args.childSessionId, run);
    if (args.spawnId) this.trackedRuns.set(args.spawnId, run);
    this.pruneTrackedRuns();
    return run;
  }

  private isRunVisibleToOrigin(run: TrackedSubAgentRun, originSessionId: string): boolean {
    return Boolean(originSessionId) && run.originSessionId === originSessionId;
  }

  private updateRun(
    run: TrackedSubAgentRun,
    patch: Partial<Omit<TrackedSubAgentRun, "spawnId" | "childSessionId" | "title" | "startedAt">>,
  ): void {
    Object.assign(run, patch, { updatedAt: new Date().toISOString() });
  }

  private finalizeRun(
    run: TrackedSubAgentRun,
    result: SubAgentSpawnResult,
  ): void {
    const patch: Partial<Omit<TrackedSubAgentRun, "spawnId" | "childSessionId" | "title" | "startedAt">> = {
      status: result.stopReason === "interrupted"
        ? "interrupted"
        : result.ok
          ? "done"
          : "error",
      toolCallCount: result.toolCallCount,
      turnCount: result.turnCount,
      entries: result.entries,
      stopReason: result.stopReason,
    };
    if (result.ok) {
      patch.summary = result.summary;
    } else {
      patch.error = result.error ?? result.summary;
    }
    delete run.abort;
    this.updateRun(run, patch);
  }

  private pruneTrackedRuns(): void {
    const unique = [...this.uniqueTrackedRuns()];
    if (unique.length <= MAX_TRACKED_RUNS) return;
    const removable = unique
      .filter((run) => run.status !== "running")
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
    const filteredSourceTools = args.frozenSourceTools
      ? args.frozenSourceTools.filter((name) => !SUB_AGENT_TOOL_BLOCKLIST.has(name))
      : null;
    const scopedRegistry = filteredSourceTools
      ? this.deps.toolRegistry.createScopedView(filteredSourceTools)
      : this.parentRegistryWithoutBlocklist();
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
    callbacks?.onLinked?.({ childSessionId });

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
    // (fixed-shape callers such as WorkBoardEngine's plan/execute phases) wins;
    // otherwise the profile mode's `maxToolRoundsHint` (explore/execute/
    // research/plan); otherwise MAX_TURNS_DEFAULT. The LLM has no say — the
    // `agent_spawn` tool dropped its `maxTurns` field, so a sub-agent's budget
    // is pure host policy derived from the (coarse-grained) mode the LLM chose
    // via agentName.
    const requestedRounds =
      input.maxRounds ?? modeResult.config.maxToolRoundsHint ?? MAX_TURNS_DEFAULT;
    const cappedRounds = Math.max(1, Math.min(MAX_TURNS_CAP, requestedRounds));

    // C3(b): build the sub-agent's tool surface. `sourceTools` empty/absent →
    // null so buildChildDeps falls back to the full parent surface minus the
    // blocklist (historical no-allowlist behavior). Resume never takes this
    // path — it hands buildChildDeps the frozen meta.sourceTools list.
    const frozenSourceTools = input.sourceTools && input.sourceTools.length > 0
      ? input.sourceTools
      : null;
    const { childDeps, scopedTools } = this.buildChildDeps({
      frozenSourceTools,
      title: input.title,
      profileModel: input.profileModel,
    });

    const child = new ConversationLoop(childDeps);
    // Bind the child loop's session identity to the regex-valid childSessionId
    // BEFORE any turn runs. run-turn's persistence path keys saveSession on
    // `self.sessionId`, so this is the seam that makes the child's JSONL land
    // under the addressable id (not the bare constructor UUID). Assigning
    // `sessionId` directly mirrors how `newConversation` establishes identity.
    child.sessionId = childSessionId;
    child.sessionKind = "subagent";
    // The tracer was created at field-init against the constructor UUID (see
    // ConversationLoop.tracer). We just rebound `sessionId`, so re-init the
    // tracer to key dev traces on the addressable childSessionId — otherwise a
    // trace under the stale UUID would never correlate to the persisted
    // session. Mirrors how `newConversation`/`loadSession` re-init the tracer
    // after they change the session identity.
    child.rebindTracer();
    const trackedRun = this.trackRun({
      spawnId: input.spawnId,
      childSessionId,
      originSessionId: input.originSessionId,
      title: input.title,
      abort: () => child.abortCurrentTurn(),
    });
    if (!child.hasProvider()) {
      const msg = "sub-agent: LLM provider not configured";
      const result: SubAgentSpawnResult = {
        summary: msg,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId,
        entries: [],
        // Provider-missing is a failed spawn, not a completed run with the
        // error text as its summary — signal it structurally so callers do
        // not record it as success.
        ok: false,
        error: msg,
      };
      this.finalizeRun(trackedRun, result);
      callbacks?.onError?.(msg);
      return result;
    }

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

    // Prepend the mode preamble (posture + auto-skill recommendation) to the
    // instructions. The preamble is empty for the default mode, leaving the
    // profile body to drive the sub-agent unchanged.
    const modePreamble = buildModePreamble(modeResult.config);
    const initialPrompt = modePreamble
      ? `${modePreamble}\n\n${input.instructions}`
      : input.instructions;
    let assistantRounds = 0;

    // Persist resume metadata (PR-B) alongside the child JSONL BEFORE the turn
    // runs, into the SAME isolated subagent namespace (child loop's
    // MemoryManager). run-turn's saveSession writes the JSONL; this writes the
    // .meta.json sibling. `sessionKind: "subagent"` lets listing/rotation
    // distinguish sub-agent sessions from main/routine. The scoped tool surface
    // (`scopedTools`, the resolved allowlist the child was frozen with) is the
    // exact set PR-C's resume must re-scope to — permission is frozen at spawn,
    // not re-granted on resume. `resumeCount`/`cumulativeRounds` init to 0 for
    // PR-D's loop guards. No resume logic here — this is metadata foundation.
    await this.deps.subAgentMemoryManager.saveSessionMetadata(childSessionId, {
      sessionKind: "subagent",
      sourceTools: scopedTools.map((tool) => tool.name),
      ...(input.profileModel !== undefined ? { profileModel: input.profileModel } : {}),
      ...(input.profileMode !== undefined ? { profileMode: input.profileMode } : {}),
      ...(input.originSessionId !== undefined ? { originSessionId: input.originSessionId } : {}),
      ...(input.toolUseId !== undefined ? { originToolUseId: input.toolUseId } : {}),
      ...(input.spawnId !== undefined ? { spawnId: input.spawnId } : {}),
      subAgentTitle: input.title,
      resumeCount: 0,
      cumulativeRounds: 0,
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
            callbacks?.onError?.(e);
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
      ok = true;
    } catch (err) {
      const msg = (err as Error).message ?? "sub-agent run failed";
      callbacks?.onError?.(msg);
      lastText = msg;
      failureReason = msg;
    }

    // Commit 2: record the spawn's OWN assistant-round count into
    // cumulativeRounds. The pre-turn write above seeded it at 0; without this
    // update a resume chain would start counting from 0 as if the original
    // spawn spent no rounds, making CUMULATIVE_ROUNDS_CEILING inaccurate. This
    // is a FULL-OVERWRITE write (saveSessionMetadata does not merge), so we
    // re-supply every field the pre-turn write set. Only on a clean run (ok) —
    // a failed/threw spawn leaves the seeded 0 (no real rounds to account).
    if (ok) {
      await this.deps.subAgentMemoryManager.saveSessionMetadata(childSessionId, {
        sessionKind: "subagent",
        sourceTools: scopedTools.map((tool) => tool.name),
        ...(input.profileModel !== undefined ? { profileModel: input.profileModel } : {}),
        ...(input.profileMode !== undefined ? { profileMode: input.profileMode } : {}),
        ...(input.originSessionId !== undefined ? { originSessionId: input.originSessionId } : {}),
        ...(input.toolUseId !== undefined ? { originToolUseId: input.toolUseId } : {}),
        ...(input.spawnId !== undefined ? { spawnId: input.spawnId } : {}),
        subAgentTitle: input.title,
        resumeCount: 0,
        cumulativeRounds: turn,
      });
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
      // A clean-but-budget-capped run: the child returned real partial work
      // (ok === true) but stopped on its round budget, so the task is unfinished.
      ...(ok && childStopReason === "round-cap" ? { incomplete: true } : {}),
    };
    this.finalizeRun(trackedRun, result);
    return result;
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
  ): Promise<SubAgentSpawnResult> {
    // In-flight lock: fail-closed if a resume for THIS session is already
    // running. Checked before any load so two concurrent resumes cannot both
    // read the same pre-increment metadata (lost-update on the counters).
    const existing = this.inFlight.get(resumeId);
    if (existing) {
      const msg = "sub-agent resume: a resume for this session is already in flight";
      callbacks?.onError?.(msg);
      return {
        summary: msg,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId: resumeId,
        entries: [],
        ok: false,
        error: msg,
      };
    }

    const runPromise = this.runResume(resumeId, continuationInstructions, title, callbacks, originSessionId, spawnId);
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
    callbacks?: SubAgentSpawnCallbacks,
    originSessionId?: string,
    spawnId?: string,
  ): Promise<SubAgentSpawnResult> {
    const fail = (msg: string, extra?: Partial<SubAgentSpawnResult>): SubAgentSpawnResult => {
      callbacks?.onError?.(msg);
      return {
        summary: msg,
        toolCallCount: 0,
        turnCount: 0,
        childSessionId: resumeId,
        entries: [],
        ok: false,
        error: msg,
        ...extra,
      };
    };

    // 1. Load + validate the frozen metadata. loadSessionMetadata throws on an
    //    invalid id (not returns null), so guard the id shape first to keep the
    //    failure fail-closed rather than an uncaught throw.
    if (!isValidSessionId(resumeId)) {
      return fail(`sub-agent resume: invalid resumeId "${resumeId}"`);
    }

    // 1b. Origin binding — refuse cross-session hijack BEFORE loading any
    //     history. The id format is `sub-<originTag8>-<uuid>` where originTag8
    //     is sha256(originSessionId).hex.slice(0,8). Extract that tag and
    //     compare it to what THIS caller's origin hashes to.
    //
    //     Why this is safe to do on the id alone (without consulting metadata):
    //     the tag is embedded at spawn time in the id itself, so an attacker
    //     must both know the tag AND forge a regex-valid sub-<tag>-<uuid> form
    //     to pass `isValidSessionId`. The tag is non-reversible (sha256), so
    //     guessing it for an unknown originSessionId is computationally
    //     infeasible.
    //
    //     Session ID stability: `originSessionId` in agent-spawn.ts comes from
    //     `ctx.metadata.sessionId`, which is `sessionIdOverride ?? self.sessionId`
    //     in query-loop (run-turn.ts:66). For the PARENT conversation loop (not
    //     a sub-agent), there is no `sessionIdOverride`, so it is `self.sessionId`
    //     — the field assigned once at `newConversation` / `loadSession` and
    //     never mutated during a conversation. Compaction creates a checkpoint
    //     snapshot but does NOT change `self.sessionId`. Therefore the tag
    //     computed at spawn time and the tag computed at resume time are
    //     identical within the same conversation, and the check correctly allows
    //     a legitimate same-conversation resume while refusing a cross-session one.
    {
      // Distinguishing pattern: origin-tagged ids are `sub-<8hex>-<uuid>` where
      // uuid starts with another 8-hex segment (`sub-<8hex>-<8hex>-<4hex>-...`).
      // Untagged ids are `sub-<uuid>` = `sub-<8hex>-<4hex>-...`. The two 8-hex
      // segments in a row are unique to the tagged form (a UUID's second segment
      // is only 4 hex chars), so this regex only extracts a tag from a truly
      // origin-tagged id and correctly returns undefined for untagged ids.
      const m = /^sub-([0-9a-f]{8})-[0-9a-f]{8}-/.exec(resumeId);
      const idTag = m?.[1] ?? "";
      const expectedTag = originSessionId
        ? createHash("sha256").update(originSessionId).digest("hex").slice(0, 8)
        : "";
      if (idTag !== expectedTag) {
        return fail(
          `sub-agent resume: resumeId does not belong to this session`,
        );
      }
    }

    const meta = this.deps.subAgentMemoryManager.loadSessionMetadata(resumeId);
    if (meta === null) {
      return fail(`sub-agent resume: no session metadata for "${resumeId}"`);
    }
    if (meta.sessionKind !== "subagent") {
      // Refuse to resume anything that is not a sub-agent session (a main or
      // routine session must never be driven through the sub-agent seam).
      return fail(
        `sub-agent resume: session "${resumeId}" is not a sub-agent (kind=${meta.sessionKind ?? "unknown"})`,
      );
    }

    // 2. Loop guards (Commit 2). Refuse BEFORE running any turn.
    const priorResumeCount = meta.resumeCount ?? 0;
    const priorCumulativeRounds = meta.cumulativeRounds ?? 0;
    if (priorResumeCount >= MAX_RESUMES) {
      return fail(
        `sub-agent resume: exhausted (resumeCount=${priorResumeCount} >= ${MAX_RESUMES})`,
        { resumeExhausted: true },
      );
    }
    if (priorCumulativeRounds >= CUMULATIVE_ROUNDS_CEILING) {
      return fail(
        `sub-agent resume: cumulative-rounds ceiling reached (${priorCumulativeRounds} >= ${CUMULATIVE_ROUNDS_CEILING})`,
        { resumeExhausted: true },
      );
    }

    // 3. Re-derive the round budget from the FROZEN profile mode (same
    //    resolution spawn used, minus the host `maxRounds` override which is a
    //    spawn-time-only knob). A resume gets a fresh per-turn budget.
    const modeResult = resolveAgentMode(meta.profileMode);
    const requestedRounds = modeResult.config.maxToolRoundsHint ?? MAX_TURNS_DEFAULT;
    const cappedRounds = Math.max(1, Math.min(MAX_TURNS_CAP, requestedRounds));

    // 4. Reconstruct child deps from the FROZEN scope. meta.sourceTools is the
    //    ONLY scope source — passed as a non-null explicit list so buildChildDeps
    //    never falls back to the parent surface (scope widening closed).
    //
    //    Empty scope is fail-closed: a legitimate spawn ALWAYS persists a
    //    concrete non-empty allowlist (the resolved scoped surface after blocklist
    //    strip). An empty `meta.sourceTools` at resume time means the metadata
    //    was corrupted or tampered — spending an LLM round on a knowingly-broken
    //    session wastes budget and obscures the anomaly. Refuse immediately.
    const frozenSourceTools = meta.sourceTools ?? [];
    if (frozenSourceTools.length === 0) {
      return fail(
        `sub-agent resume: session "${resumeId}" has an empty frozen tool scope — metadata may be corrupted or tampered`,
      );
    }
    const { childDeps } = this.buildChildDeps({
      frozenSourceTools,
      title,
      profileModel: meta.profileModel,
    });

    const child = new ConversationLoop(childDeps);
    // Bind identity to the resumeId BEFORE loading so persistence + tracing key
    // on the addressable id (mirrors spawn's rebind seam).
    child.sessionId = resumeId;
    child.sessionKind = "subagent";
    child.rebindTracer();
    if (!child.hasProvider()) {
      return fail("sub-agent resume: LLM provider not configured");
    }

    // 5. RE-HYDRATE the full history from the isolated subagent store. loadSession
    //    validates the id, restores + normalizes the tool-pair invariant, and
    //    re-applies metadata. A false return (missing/unsafe) fails closed.
    const loaded = child.loadSession(resumeId);
    if (!loaded) {
      return fail(`sub-agent resume: failed to load session history for "${resumeId}"`);
    }
    const trackedRun = this.trackRun({
      spawnId,
      childSessionId: resumeId,
      originSessionId,
      title,
      abort: () => child.abortCurrentTurn(),
    });

    let totalToolCalls = 0;
    let lastText = "";
    let turn = 0;
    let assistantRounds = 0;
    // Accumulator seed decision: keep the engine accumulator segment-local.
    // `historyToEntries` lives in renderer code, so seeding from hydrated child
    // history here would cross the main/renderer layer boundary. Continuity is
    // handled downstream: each resume writes its own `agent_spawn` tool result
    // with a distinct `toolUseId`, and the renderer groups segments by shared
    // childSessionId into one unified transcript.
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
    let childStopReason: import("./turn/types.js").TurnStopReason | undefined;

    try {
      const result = await child.runTurn(
        continuationInstructions,
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
          onError: (e) => {
            callbacks?.onError?.(e);
          },
        },
        undefined,
        {
          maxRounds: cappedRounds,
          // Same addressable id → the continuation turn's audit + persistence
          // stay under the resumed session.
          sessionIdOverride: resumeId,
          // spawnDepth 1 is the byte-identical recursion defense a fresh spawn
          // gets — a resumed child cannot agent_spawn.
          spawnDepth: 1,
          inputOrigin: "llm-tool-arg",
        },
      );
      totalToolCalls = result.toolCalls.length;
      lastText = result.text;
      childStopReason = result.stopReason;
      ok = true;
    } catch (err) {
      const msg = (err as Error).message ?? "sub-agent resume run failed";
      callbacks?.onError?.(msg);
      lastText = msg;
      failureReason = msg;
    }

    // 6. Commit 2: update counters. saveSessionMetadata is FULL-OVERWRITE (not
    //    merge), so spread the loaded meta to preserve sourceTools/profile*
    //    (dropping them would corrupt the frozen scope on the NEXT resume) and
    //    bump resumeCount by 1 + cumulativeRounds by this turn's round count.
    //    Only on a clean run — a failed run spent no accountable rounds and must
    //    not consume a resume slot.
    if (ok) {
      await this.deps.subAgentMemoryManager.saveSessionMetadata(resumeId, {
        ...meta,
        sessionKind: "subagent",
        resumeCount: priorResumeCount + 1,
        cumulativeRounds: priorCumulativeRounds + turn,
      });
    }

    const result: SubAgentSpawnResult = {
      summary: lastText,
      toolCallCount: totalToolCalls,
      turnCount: turn,
      childSessionId: resumeId,
      entries: transcript.snapshot(),
      ok,
      ...(ok ? {} : { error: failureReason ?? lastText }),
      ...(childStopReason ? { stopReason: childStopReason } : {}),
      ...(ok && childStopReason === "round-cap" ? { incomplete: true } : {}),
    };
    this.finalizeRun(trackedRun, result);
    return result;
  }

  /**
   * C3(b): build a scoped registry covering every parent-registered tool
   * EXCEPT the entries on {@link SUB_AGENT_TOOL_BLOCKLIST}. Used when the
   * spawn caller did not provide an explicit `sourceTools` allowlist —
   * we still need to enforce the blocklist defense.
   */
  private parentRegistryWithoutBlocklist(): ToolRegistry {
    const allNames = this.deps.toolRegistry
      .listAll()
      .map((t) => t.name)
      .filter((n) => !SUB_AGENT_TOOL_BLOCKLIST.has(n));
    return this.deps.toolRegistry.createScopedView(allNames);
  }
}

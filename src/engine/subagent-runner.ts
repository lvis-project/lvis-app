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
 *     fan-out cap (10 calls/round) bounds total tool execution count.
 *   - An ApprovalGate wrapper that prepends "[Sub-Agent: <title>]" to the
 *     user-facing approval reason so users know an approval modal originated
 *     from a sub-agent.
 *
 * Per-turn updates are streamed back as events so the renderer can show a
 * live SubAgentCard. Final summary is delivered as `summary` in the result.
 *
 * Rationale (vs. mutating the main loop): a sub-loop helper file keeps the
 * primary ConversationLoop unchanged, avoids reentrancy hazards on the
 * shared state (`sessionId`, `history`, `cumulativeUsage`), and lets each
 * spawn audit-log under a child sessionId tagged with the origin session id.
 */
import { randomUUID } from "node:crypto";
import { ConversationLoop, type ConversationLoopDeps } from "./conversation-loop.js";
import type { ToolRegistry } from "../tools/registry.js";
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

const log = createLogger("lvis");

export interface SubAgentSpawnInput {
  title: string;
  instructions: string;
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
}

export interface SubAgentSpawnCallbacks {
  /**
   * Fired whenever the child loop produces new transcript content (tool
   * start/end, permission review, completed assistant round). Carries the full
   * `ChatEntry[]` snapshot so the consumer swaps the whole child transcript.
   */
  onActivity?: (update: SubAgentActivityUpdate) => void;
  onError?: (message: string) => void;
}

export interface SubAgentRunnerDeps {
  /** Parent's ConversationLoopDeps. We clone but swap toolRegistry to a scoped view. */
  parentDeps: ConversationLoopDeps;
  toolRegistry: ToolRegistry;
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
const SUB_AGENT_TOOL_BLOCKLIST = new Set<string>(["agent_spawn"]);

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

export class SubAgentRunner {
  constructor(private readonly deps: SubAgentRunnerDeps) {}

  /**
   * Spawn a sub-agent and run it inline. Returns the final summary text.
   */
  async spawn(
    input: SubAgentSpawnInput,
    callbacks?: SubAgentSpawnCallbacks,
  ): Promise<SubAgentSpawnResult> {
    const childSessionId = `${input.originSessionId ?? "spawn"}::${randomUUID()}`;

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

    // C3(b): build the sub-agent's tool surface. Always strip the blocklist
    // (agent_spawn) so a sub-agent cannot recurse. When `sourceTools` is
    // empty/absent we still want the agent_spawn block to apply, so we
    // start from the full tool list and intersect with the blocklist.
    const filteredSourceTools = input.sourceTools && input.sourceTools.length > 0
      ? input.sourceTools.filter((name) => !SUB_AGENT_TOOL_BLOCKLIST.has(name))
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
      ? makeSubAgentApprovalAdapter(this.deps.parentDeps.approvalGate, input.title)
      : undefined;

    // Compose deps for the child loop. We share the parent's permissionManager,
    // hookRunner so the child plays by the same security rules.
    // History is fresh because ConversationLoop.constructor instantiates a new
    // ConversationHistory.
    // Resolve the child's model from the profile's `model:` frontmatter
    // against the parent's active vendor. null → leave modelOverride unset
    // so the child runs on the parent's configured model.
    const activeVendor = this.deps.parentDeps.settingsService.get("llm").provider;
    const resolvedModel = resolveSubAgentModel(input.profileModel, activeVendor);

    const childDeps: ConversationLoopDeps = {
      ...this.deps.parentDeps,
      toolRegistry: scopedRegistry,
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

    const child = new ConversationLoop(childDeps);
    if (!child.hasProvider()) {
      const msg = "sub-agent: LLM provider not configured";
      callbacks?.onError?.(msg);
      return {
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
    }

    let totalToolCalls = 0;
    let lastText = "";
    let turn = 0;

    // Accumulates the child's activity into a `ChatEntry[]` via the shared
    // chat-stream-state reducers (DLP-masked at the source). Snapshots are
    // forwarded on every activity so the sub-agent tab renders live through the
    // same TranscriptRenderer the main chat uses.
    const transcript = new SubAgentTranscriptAccumulator();
    const emitActivity = () =>
      callbacks?.onActivity?.({
        entries: transcript.snapshot(),
        toolCallCount: totalToolCalls,
      });
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

    return {
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

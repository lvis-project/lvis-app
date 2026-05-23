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
 *   - A turn cap (default 5) — runTurn(`maxRounds: cappedTurns`) terminates
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
import { isLLMVendor } from "../shared/llm-vendor-defaults.js";
import {
  resolveAgentMode,
  type AgentModeConfig,
} from "../shared/agent-mode-map.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("lvis");

export interface SubAgentSpawnInput {
  title: string;
  instructions: string;
  sourceTools?: string[];
  maxTurns?: number;
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

export interface SubAgentTurnUpdate {
  turn: number;
  text: string;
  toolCallCount: number;
}

export interface SubAgentSpawnResult {
  summary: string;
  toolCallCount: number;
  turnCount: number;
  childSessionId: string;
}

export interface SubAgentSpawnCallbacks {
  onTurn?: (update: SubAgentTurnUpdate) => void;
  onError?: (message: string) => void;
}

export interface SubAgentRunnerDeps {
  /** Parent's ConversationLoopDeps. We clone but swap toolRegistry to a scoped view. */
  parentDeps: ConversationLoopDeps;
  toolRegistry: ToolRegistry;
}

// Sub-agent turn budget: default 30 covers most multi-step research/edit
// flows; cap 60 leaves headroom for genuinely complex investigations. The
// LLM is instructed (see `agent_spawn` description) to set `maxTurns`
// based on its own complexity judgment of the task it is delegating.
const MAX_TURNS_DEFAULT = 30;
const MAX_TURNS_CAP = 60;
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
 *   3. explicit model ID    → passed through unchanged
 *
 * Returning null means "no override" — the caller leaves `modelOverride`
 * unset so `refreshProvider()` uses the vendor block's configured model.
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

  // Explicit vendor-specific model ID — pass through.
  return trimmed;
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
        `이 작업에는 다음 skill 이 유용합니다: ${config.autoSkills.join(", ")}.`,
        "필요하면 skill_load 로 로드하세요 (첫 로드 시 사용자 승인 모달이 뜹니다).",
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

    // Resolve the profile's mode → working-posture preamble + maxTurns hint.
    // Unknown / absent mode resolves to the inert `default` mode; a non-empty
    // unmatched mode is logged so the audit trail captures the typo.
    const modeResult = resolveAgentMode(input.profileMode);
    if (!modeResult.matched) {
      log.warn(
        "sub-agent: unknown mode '%s' — using default (inert) mode",
        modeResult.requested,
      );
    }

    // Mode's maxToolRoundsHint seeds maxTurns only when the agent_spawn call
    // did not specify one; explicit input.maxTurns always wins.
    const requestedTurns =
      input.maxTurns ?? modeResult.config.maxToolRoundsHint ?? MAX_TURNS_DEFAULT;
    const cappedTurns = Math.max(1, Math.min(MAX_TURNS_CAP, requestedTurns));

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
    const forcedActivePluginIds = new Set(
      scopedRegistry
        .listAll()
        .filter((tool) => tool.source === "plugin" && tool.pluginId)
        .map((tool) => tool.pluginId as string),
    );

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
      };
    }

    let totalToolCalls = 0;
    let lastText = "";
    let turn = 0;

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
          onAssistantRound: (round) => {
            assistantRounds += 1;
            turn = assistantRounds;
            callbacks?.onTurn?.({
              turn: assistantRounds,
              text: round.text,
              toolCallCount: 0,
            });
          },
          onError: (e) => {
            callbacks?.onError?.(e);
          },
        },
        undefined,
        {
          maxRounds: cappedTurns,
          sessionIdOverride: childSessionId,
          spawnDepth: 1,
          inputOrigin: "llm-tool-arg",
        },
      );
      totalToolCalls = result.toolCalls.length;
      lastText = result.text;
    } catch (err) {
      const msg = (err as Error).message ?? "sub-agent run failed";
      callbacks?.onError?.(msg);
      lastText = msg;
    }

    return {
      summary: lastText,
      toolCallCount: totalToolCalls,
      turnCount: turn,
      childSessionId,
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

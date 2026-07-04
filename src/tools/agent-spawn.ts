/**
 * `agent_spawn` LLM tool — spin up a sub-agent with restricted tools and
 * a turn cap. The sub-agent runs inline (await) and the assistant gets the
 * final summary string + tool call count.
 *
 * Renderer integration: per-spawn lifecycle events stream to a SubAgentCard
 * (start → turn → done|error) so the user sees what the sub-agent is doing.
 */
import { randomUUID } from "node:crypto";
import { createDynamicTool, type Tool } from "./base.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";
import {
  AGENT_NAME_ALLOWLIST,
  type LoadedAgentProfile,
} from "../main/agent-profile-store.js";
import { t } from "../i18n/index.js";

import type { ChatEntry } from "../lib/chat-stream-state.js";

export interface AgentSpawnEvent {
  spawnId: string;
  /**
   * Lifecycle phase:
   *   - `start`    — spawn created; carries `title` + `toolUseId`.
   *   - `activity` — the child loop produced new transcript content; carries
   *                  the FULL {@link entries} snapshot (idempotent replace, not
   *                  a delta) so the renderer swaps the whole child transcript.
   *   - `done`     — clean completion; carries `summary`, `toolCallCount`, and
   *                  the final {@link entries} snapshot (embedded for persistence
   *                  parity — the same array is written into the tool result).
   *   - `error`    — failed run; carries `message` (+ any partial `entries`).
   */
  type: "start" | "activity" | "done" | "error";
  title?: string;
  /**
   * Full child transcript snapshot as `ChatEntry[]` — the SAME model the main
   * chat renders. Present on `activity` / `done` (and `error` when partial
   * output exists). DLP-masked at the source (child tool results + thoughts run
   * through `maskSensitiveData` before entering this snapshot). Idempotent
   * replace: the renderer overwrites the spawn's entries with each snapshot
   * rather than appending, so a re-emitted event never double-renders.
   */
  entries?: ChatEntry[];
  summary?: string;
  toolCallCount?: number;
  message?: string;
  /**
   * The `tool_use` id of the `agent_spawn` invocation that triggered this
   * spawn. Set on the `start` event so the renderer can attach the sub-agent
   * to the originating ToolGroupCard (completion chip) instead of stacking all
   * spawns at the top of the chat.
   */
  toolUseId?: string;
  /**
   * The addressable sub-agent session id (`SubAgentSpawnResult.childSessionId`).
   * This is the JOIN KEY the renderer uses to unify a spawn and its resumes into
   * a single sub-agent transcript: a resume is a SEPARATE `agent_spawn` call
   * (own `toolUseId`) but shares the original's `childSessionId`, so the viewer
   * groups on this field. A resume carries it on EVERY phase (it equals the
   * `resumeId` from the tool call); the original spawn learns its own value only
   * on completion, so it is set on the `done` (or terminal `error`) phase.
   */
  childSessionId?: string;
}

export interface AgentSpawnToolDeps {
  getRunner: () => SubAgentRunner | undefined;
  getAgentProfile?: (name: string) => Promise<LoadedAgentProfile | null>;
  /** Renderer event sink — emitted on each lifecycle phase. */
  emit: (event: AgentSpawnEvent) => void;
}

export function createAgentSpawnTool(deps: AgentSpawnToolDeps): Tool {
  return createDynamicTool({
    name: "agent_spawn",
    description: t("be_agentSpawn.toolDescription"),
    source: "builtin",
    category: "meta",
    decisionOverride: "ask",
    jsonSchema: {
      type: "object",
      required: ["instructions"],
      properties: {
        title: {
          type: "string",
          description: t("be_agentSpawn.propTitleDescription"),
        },
        agentName: {
          type: "string",
          description: t("be_agentSpawn.propAgentNameDescription"),
        },
        instructions: {
          type: "string",
          description: t("be_agentSpawn.propInstructionsDescription"),
        },
        sourceTools: {
          type: "array",
          items: { type: "string" },
          description: t("be_agentSpawn.propSourceToolsDescription"),
        },
        resumeId: {
          type: "string",
          description: t("be_agentSpawn.propResumeIdDescription"),
        },
      },
    },
    execute: async (rawInput, ctx) => {
      // C3(b): defense-in-depth — even if SubAgentRunner forgets to strip
      // agent_spawn from the child registry, this guard refuses any
      // invocation when the executor's metadata reports we are inside an
      // already-spawned sub-agent.
      const depth = typeof ctx.metadata?.spawnDepth === "number"
        ? (ctx.metadata.spawnDepth as number)
        : 0;
      if (depth >= 1) {
        return {
          output: JSON.stringify({
            error: "agent_spawn cannot be invoked from a sub-agent",
          }),
          isError: true,
        };
      }
      const runner = deps.getRunner();
      if (!runner) {
        return {
          output: JSON.stringify({ error: "agent_spawn runner not configured" }),
          isError: true,
        };
      }
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const agentName = typeof a.agentName === "string" ? a.agentName.trim() : "";
      if (agentName && !AGENT_NAME_ALLOWLIST.test(agentName)) {
        return {
          output: JSON.stringify({
            error: `invalid agentName: must match ${AGENT_NAME_ALLOWLIST.source}`,
          }),
          isError: true,
        };
      }
      const profile = agentName && deps.getAgentProfile
        ? await deps.getAgentProfile(agentName)
        : null;
      if (agentName && !profile) {
        return {
          output: JSON.stringify({ error: `agent profile not found: ${agentName}` }),
          isError: true,
        };
      }
      const title = typeof a.title === "string" && a.title.trim()
        ? a.title.trim()
        : profile?.name ?? "";
      const instructions =
        typeof a.instructions === "string" ? a.instructions.trim() : "";
      // Resume path: a `resumeId` re-hydrates a previously-spawned sub-agent and
      // continues it with `instructions` as the follow-up prompt (its tool scope
      // stays frozen to the original spawn — permission is NOT re-granted). The
      // title still labels approval modals but is not otherwise required for a
      // resume (the profile/allowlist come from persisted metadata), so the
      // title-required rule below is relaxed when resuming.
      const resumeId = typeof a.resumeId === "string" && a.resumeId.trim()
        ? a.resumeId.trim()
        : undefined;
      if (!instructions || (!resumeId && !title)) {
        return {
          output: JSON.stringify({
            error: "instructions are required; title is required when agentName is not provided (unless resumeId is set)",
          }),
          isError: true,
        };
      }
      const requestedSourceTools = Array.isArray(a.sourceTools)
        ? (a.sourceTools as unknown[]).filter(
            (t): t is string => typeof t === "string" && t.trim().length > 0,
          )
        : undefined;
      const sourceTools = requestedSourceTools && requestedSourceTools.length > 0
        ? requestedSourceTools
        : profile?.sourceTools && profile.sourceTools.length > 0
          ? profile.sourceTools
          : undefined;
      const originSessionId =
        typeof ctx.metadata?.sessionId === "string"
          ? (ctx.metadata.sessionId as string)
          : undefined;
      const toolUseId =
        typeof ctx.metadata?.toolUseId === "string"
          ? (ctx.metadata.toolUseId as string)
          : undefined;
      const spawnId = randomUUID();
      // A resume knows its join key up front (it equals `resumeId`); the original
      // spawn learns `childSessionId` only from the run result (set on `done`).
      const resumeChildSessionId = resumeId ? { childSessionId: resumeId } : {};
      deps.emit({ spawnId, type: "start", title, toolUseId, ...resumeChildSessionId });
      try {
        const callbacks = {
          onActivity: (u: { entries: ChatEntry[]; toolCallCount: number }) =>
            deps.emit({
              spawnId,
              type: "activity" as const,
              entries: u.entries,
              toolCallCount: u.toolCallCount,
              ...resumeChildSessionId,
            }),
          onError: (msg: string) =>
            deps.emit({ spawnId, type: "error" as const, message: msg, ...resumeChildSessionId }),
        };
        // Resume RE-HYDRATES a frozen sub-agent; spawn starts a fresh one. The
        // resume path takes NO sourceTools/profile from the tool call — those are
        // read from the persisted metadata so a resume cannot re-scope the child.
        const result = resumeId
          ? await runner.resume(resumeId, instructions, title, callbacks, originSessionId)
          : await runner.spawn(
              {
                title,
                instructions: profile
                  ? renderAgentProfilePrompt(profile, instructions)
                  : instructions,
                sourceTools,
                originSessionId,
                // #1112: profile's `model:` frontmatter (complexity tier or
                // explicit model ID). SubAgentRunner resolves it against the
                // active vendor; undefined leaves the child on the parent model.
                profileModel: profile?.model,
                // #1113: profile's `mode:` frontmatter (execute/plan/research/
                // explore). SubAgentRunner prepends a working-posture preamble +
                // auto-skill recommendation; undefined → inert default mode.
                profileMode: profile?.mode,
              },
              callbacks,
            );
        // A spawn that could not run (LLM provider unconfigured, child loop
        // threw) returns `ok: false` with the error text as `summary` rather
        // than throwing. Surface it as a tool error so the assistant does not
        // treat the error string as a successful sub-agent result.
        if (result.ok === false) {
          const message = result.error ?? result.summary;
          deps.emit({ spawnId, type: "error", message, ...resumeChildSessionId });
          return {
            output: JSON.stringify({ error: message }),
            isError: true,
          };
        }
        // On the terminal `done` phase the join key is always available from the
        // result (for a resume it equals `resumeId`; for the original spawn this
        // is the first phase carrying it), so the renderer can group segments.
        deps.emit({
          spawnId,
          type: "done",
          summary: result.summary,
          toolCallCount: result.toolCallCount,
          entries: result.entries,
          childSessionId: result.childSessionId,
        });
        return {
          output: JSON.stringify({
            summary: result.summary,
            toolCallCount: result.toolCallCount,
            turnCount: result.turnCount,
            spawnId,
            agentName: profile?.name,
            // Cut-off resume signal (Claude Code "the sub-agent ran out of
            // turns and didn't finish" pattern). When the child hit its
            // host-assigned round budget, `summary` is PARTIAL — surface that
            // explicitly so the parent LLM does not treat the truncated text as
            // a completed result and can decide to re-spawn / continue the task.
            // Omitted entirely on a clean end_turn so normal completions carry
            // no extra fields.
            ...(result.incomplete
              ? {
                  incomplete: true,
                  incompleteReason: t("be_agentSpawn.incompleteNotice"),
                  // Same-instance resume handle (PR-C). `childSessionId` is the
                  // addressable sub-agent session id; passing it back as
                  // `resumeId` on a follow-up agent_spawn RE-HYDRATES this exact
                  // sub-agent (frozen tool scope, full history) instead of
                  // starting a fresh one. This is the ONLY surface the parent
                  // LLM learns the id from.
                  resumeId: result.childSessionId,
                }
              : {}),
            // Embed the child transcript so a reloaded session rebuilds the
            // sub-agent tab's full tool/reasoning timeline from persistence
            // (derive-subagent-spawns reads `entries` here). DLP-masked at the
            // SubAgentTranscriptAccumulator source.
            entries: result.entries,
          }),
          isError: false,
        };
      } catch (err) {
        const message = (err as Error).message ?? "agent_spawn failed";
        deps.emit({ spawnId, type: "error", message, ...resumeChildSessionId });
        return {
          output: JSON.stringify({ error: message }),
          isError: true,
        };
      }
    },
  });
}

function renderAgentProfilePrompt(
  profile: LoadedAgentProfile,
  taskInstructions: string,
): string {
  return [
    `<lvis-agent-profile name="${escapeAttr(profile.name)}">`,
    neutralizeAgentProfileFence(profile.body),
    "</lvis-agent-profile>",
    "",
    "<lvis-agent-task>",
    neutralizeAgentProfileFence(taskInstructions),
    "</lvis-agent-task>",
  ].join("\n");
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const AGENT_PROFILE_FENCE_PATTERN = /<(\s*\/?\s*lvis-agent-(?:profile|task)[^>]*)>/gi;
const ZWSP = "​";
function neutralizeAgentProfileFence(body: string): string {
  return body.replace(AGENT_PROFILE_FENCE_PATTERN, `<${ZWSP}$1>`);
}

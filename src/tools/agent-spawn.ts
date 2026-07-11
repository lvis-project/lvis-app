/**
 * `agent_spawn` LLM tool — spin up a sub-agent with restricted tools and
 * a turn cap. The sub-agent runs inline (await) and the assistant gets the
 * final summary string + tool call count.
 *
 * Renderer integration: per-spawn lifecycle events stream to the workspace-rail
 * sub-agent viewer (start → turn → done|error) so the user sees what the
 * sub-agent is doing.
 */
import { randomUUID } from "node:crypto";
import { createDynamicTool, type Tool } from "./base.js";
import type {
  SubAgentRunner,
  SubAgentSpawnResult,
} from "../engine/subagent-runner.js";
import {
  AGENT_NAME_ALLOWLIST,
  type LoadedAgentProfile,
} from "../main/agent-profile-store.js";
import { t } from "../i18n/index.js";

import type { ChatEntry } from "../lib/chat-stream-state.js";
import {
  A2A_ROLE_AGENT,
  projectSubAgentResultState,
  projectSubAgentRunState,
  subAgentRunStatusFromTaskState,
  type A2AMessage,
} from "../shared/a2a.js";
import type { AgentSpawnEvent as SharedAgentSpawnEvent } from "../shared/subagent-events.js";


function backgroundResultText(result: SubAgentSpawnResult): string {
  const summary = result.error ?? result.summary;
  if (!result.suspension) return summary;
  const requestedInput = result.suspension.reason === "question"
    ? result.suspension.prompt ?? "answer the sub-agent question"
    : "send any message to continue, or treat this partial result as done";
  return `${summary}\n\n[Input required: ${requestedInput}]`;
}

function createBackgroundResultMessage(
  result: SubAgentSpawnResult,
  parentSessionId: string,
  spawnId: string,
): A2AMessage {
  const suspension = result.suspension;
  return {
    messageId: randomUUID(),
    role: A2A_ROLE_AGENT,
    parts: [{ text: backgroundResultText(result) }],
    contextId: parentSessionId,
    taskId: result.childSessionId,
    metadata: {
      taskState: projectSubAgentResultState(result),
      spawnId,
      ...(suspension
        ? {
            suspension: {
              reason: suspension.reason,
              resumeId: suspension.resumeId,
              ...(suspension.prompt ? { prompt: suspension.prompt } : {}),
            },
          }
        : {}),
    },
  };
}

export type AgentSpawnEvent = SharedAgentSpawnEvent<ChatEntry>;

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
    parallelSafe: true,
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
        background: {
          type: "boolean",
          description: "When true, start the sub-agent and return a run handle immediately. Use agent_status to inspect progress and agent_interrupt to stop it.",
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
            taskState: projectSubAgentRunState("rejected"),
          }),
          isError: true,
        };
      }
      const a = (rawInput ?? {}) as Record<string, unknown>;
      const background = a.background === true;
      if (background && ctx.metadata?.supportsA2AParentDelivery !== true) {
        return {
          output: JSON.stringify({
            error: "background-parent-unsupported",
            message: "Background sub-agent delivery is unavailable for this conversation surface.",
            taskState: projectSubAgentRunState("rejected"),
          }),
          isError: true,
        };
      }
      const runner = deps.getRunner();
      if (!runner) {
        return {
          output: JSON.stringify({
            error: "agent_spawn runner not configured",
            taskState: projectSubAgentRunState("error"),
          }),
          isError: true,
        };
      }
      const agentName = typeof a.agentName === "string" ? a.agentName.trim() : "";
      if (agentName && !AGENT_NAME_ALLOWLIST.test(agentName)) {
        return {
          output: JSON.stringify({
            error: `invalid agentName: must match ${AGENT_NAME_ALLOWLIST.source}`,
            taskState: projectSubAgentRunState("rejected"),
          }),
          isError: true,
        };
      }
      const profile = agentName && deps.getAgentProfile
        ? await deps.getAgentProfile(agentName)
        : null;
      if (agentName && !profile) {
        return {
          output: JSON.stringify({ error: `agent profile not found: ${agentName}`, taskState: projectSubAgentRunState("rejected") }),
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
            taskState: projectSubAgentRunState("rejected"),
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
      const promptPayload = instructions ? { instructions } : {};
      let linkedChildSessionId = resumeId;
      const linkedPayload = () => linkedChildSessionId ? { childSessionId: linkedChildSessionId } : {};
      deps.emit({
        spawnId,
        type: "start",
        taskState: projectSubAgentRunState("submitted"),
        title,
        toolUseId,
        ...promptPayload,
        ...resumeChildSessionId,
      });
      try {
        const callbacks = {
          onLinked: ({ childSessionId }: { childSessionId: string }) => {
            linkedChildSessionId = childSessionId;
            deps.emit({
              spawnId,
              type: "activity" as const,
              taskState: projectSubAgentRunState("running"),
              childSessionId,
              ...promptPayload,
            });
          },
          onActivity: (u: { entries: ChatEntry[]; toolCallCount: number }) =>
            deps.emit({
              spawnId,
              type: "activity" as const,
              taskState: projectSubAgentRunState("running"),
              entries: u.entries,
              toolCallCount: u.toolCallCount,
              ...promptPayload,
              ...linkedPayload(),
            }),
          onError: (msg: string) =>
            deps.emit({
              spawnId,
              type: "error" as const,
              taskState: projectSubAgentRunState("error"),
              message: msg,
              ...promptPayload,
              ...linkedPayload(),
            }),
        };
        // Resume RE-HYDRATES a frozen sub-agent; spawn starts a fresh one. The
        // resume path takes NO sourceTools/profile from the tool call — those are
        // read from the persisted metadata so a resume cannot re-scope the child.
        const run = async () => resumeId
          ? await runner.resume(resumeId, instructions, title, callbacks, originSessionId, spawnId)
          : await runner.spawn(
              {
                title,
                instructions: profile
                  ? renderAgentProfilePrompt(profile, instructions)
                  : instructions,
                spawnId,
                toolUseId,
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
        if (background) {
          const runPromise = run();
          void runPromise
            .then(async (result) => {
              linkedChildSessionId = result.childSessionId;
              const taskState = projectSubAgentResultState(result);
              const status = subAgentRunStatusFromTaskState(taskState);
              if (status === "error") {
                const message = result.error ?? result.summary;
                deps.emit({
                  spawnId,
                  type: "error",
                  taskState,
                  status,
                  message,
                  ...promptPayload,
                  childSessionId: result.childSessionId,
                });
              } else {
                deps.emit({
                  spawnId,
                  type: "done",
                  taskState,
                  status,
                  ...(result.suspension ? { suspension: result.suspension } : {}),
                  summary: result.summary,
                  toolCallCount: result.toolCallCount,
                  entries: result.entries,
                  ...promptPayload,
                  childSessionId: result.childSessionId,
                });
              }
              const parentSessionId = originSessionId ?? "";
              await runner.deliverToParent({
                parentSessionId,
                childSessionId: result.childSessionId,
                message: createBackgroundResultMessage(
                  result,
                  parentSessionId,
                  spawnId,
                ),
              });
            })
            .catch((err) => {
              const message = (err as Error).message ?? "agent_spawn failed";
              deps.emit({
                spawnId,
                type: "error",
                taskState: projectSubAgentRunState("error"),
                message,
                ...promptPayload,
                ...linkedPayload(),
              });
            });
          return {
            output: JSON.stringify({
              spawnId,
              status: "running",
              taskState: projectSubAgentRunState("running"),
              background: true,
              ...(resumeId ? { resumeId } : {}),
              ...(linkedChildSessionId ? { childSessionId: linkedChildSessionId } : {}),
              agentName: profile?.name,
            }),
            isError: false,
          };
        }

        const result = await run();
        const taskState = projectSubAgentResultState(result);
        const status = subAgentRunStatusFromTaskState(taskState);
        // FAILED and REJECTED are errors even when runTurn returned a result,
        // for example a UserPromptSubmit stopReason of blocked.
        if (status === "error") {
          const message = result.error ?? result.summary;
          deps.emit({
            spawnId,
            type: "error",
            taskState,
            status,
            message,
            ...promptPayload,
            childSessionId: result.childSessionId,
          });
          return {
            output: JSON.stringify({ error: message, taskState }),
            isError: true,
          };
        }
        // A terminal non-error event carries the addressable child join key.
        deps.emit({
          spawnId,
          type: "done",
          taskState,
          status,
          ...(result.suspension ? { suspension: result.suspension } : {}),
          summary: result.summary,
          toolCallCount: result.toolCallCount,
          entries: result.entries,
          ...promptPayload,
          childSessionId: result.childSessionId,
        });
        return {
          output: JSON.stringify({
            summary: result.summary,
            toolCallCount: result.toolCallCount,
            turnCount: result.turnCount,
            spawnId,
            agentName: profile?.name,
            childSessionId: result.childSessionId,
            taskState,
            ...(result.stopReason ? { stopReason: result.stopReason } : {}),
            ...(result.suspension ? { suspension: result.suspension } : {}),
            ...(result.incomplete
              ? {
                  incomplete: true,
                  incompleteReason: t("be_agentSpawn.incompleteNotice"),
                  resumeId: result.childSessionId,
                }
              : {}),
          }),
          isError: false,
        };      } catch (err) {
        const message = (err as Error).message ?? "agent_spawn failed";
        const taskState = projectSubAgentRunState("error");
        deps.emit({ spawnId, type: "error", taskState, message, ...promptPayload, ...linkedPayload() });
        return {
          output: JSON.stringify({ error: message, taskState }),
          isError: true,
        };
      }
    },
  });
}

export function createAgentStatusTool(deps: Pick<AgentSpawnToolDeps, "getRunner">): Tool {
  return createDynamicTool({
    name: "agent_status",
    description: "Inspect active or recent sub-agent runs. Pass spawnId or childSessionId as id; omit id to list all tracked runs.",
    source: "builtin",
    category: "meta",
    decisionOverride: "always-allow-with-audit",
    jsonSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "spawnId or childSessionId to inspect. Omit to list tracked runs.",
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const runner = deps.getRunner();
      if (!runner) {
        return {
          output: JSON.stringify({ error: "agent_status runner not configured" }),
          isError: true,
        };
      }
      const originSessionId =
        typeof ctx.metadata?.sessionId === "string"
          ? (ctx.metadata.sessionId as string)
          : "";
      if (!originSessionId) {
        return {
          output: JSON.stringify({ error: "agent_status requires a session id" }),
          isError: true,
        };
      }
      const input = (rawInput ?? {}) as Record<string, unknown>;
      const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
      if (id) {
        const run = runner.getRunStatus(id, originSessionId);
        return {
          output: JSON.stringify(run ? { run } : { error: `sub-agent run not found: ${id}` }),
          isError: !run,
        };
      }
      return {
        output: JSON.stringify({ runs: runner.listRunStatuses(originSessionId) }),
        isError: false,
      };
    },
  });
}

export function createAgentInterruptTool(deps: Pick<AgentSpawnToolDeps, "getRunner">): Tool {
  return createDynamicTool({
    name: "agent_interrupt",
    description: "Request interruption of a running sub-agent by spawnId or childSessionId.",
    source: "builtin",
    category: "meta",
    decisionOverride: "ask",
    jsonSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description: "spawnId or childSessionId for the running sub-agent.",
        },
        reason: {
          type: "string",
          description: "Short reason for interrupting the sub-agent.",
        },
      },
    },
    execute: async (rawInput, ctx) => {
      const runner = deps.getRunner();
      if (!runner) {
        return {
          output: JSON.stringify({ error: "agent_interrupt runner not configured" }),
          isError: true,
        };
      }
      const originSessionId =
        typeof ctx.metadata?.sessionId === "string"
          ? (ctx.metadata.sessionId as string)
          : "";
      if (!originSessionId) {
        return {
          output: JSON.stringify({ error: "agent_interrupt requires a session id" }),
          isError: true,
        };
      }
      const input = (rawInput ?? {}) as Record<string, unknown>;
      const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : "";
      if (!id) {
        return {
          output: JSON.stringify({ error: "id is required" }),
          isError: true,
        };
      }
      const result = runner.interruptRun(id, originSessionId);
      return {
        output: JSON.stringify(result),
        isError: !result.ok,
      };
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

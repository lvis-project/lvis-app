/**
 * `agent_spawn` LLM tool — spin up a sub-agent with restricted tools and
 * a turn cap. The sub-agent runs inline (await) and the assistant gets the
 * final summary string + tool call count.
 *
 * Renderer integration: per-spawn lifecycle events stream to the workspace-rail
 * sub-agent viewer (start → turn → done|error) so the user sees what the
 * sub-agent is doing.
 */
import { createDynamicTool, type Tool } from "./base.js";
import type {
  SubAgentRunner,
  SubAgentSpawnResult,
} from "../engine/subagent-runner.js";
import {
  AGENT_NAME_ALLOWLIST,
  type LoadedAgentProfile,
} from "../main/agent-profile-store.js";
import { renderAgentProfilePrompt } from "../engine/agent-profile-prompt.js";
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
import { createDlpSafeUuid } from "../shared/dlp-safe-id.js";
import { resolveSubAgentCeilingMs } from "../shared/tool-timeout-policy.js";
import { SUBAGENT_MAX_ROUNDS_DEFAULT } from "../shared/subagent-rounds.js";
import { isDeterministicProviderRequestRejection } from "../engine/llm/error-classifier.js";

/**
 * Guidance for a resume that WAS authorized and did run, then failed.
 *
 * This population used to get one text: "retry the SAME resumeId, transient
 * provider errors clear on retry". That is true only for failures whose cause
 * can change between attempts. When the provider REFUSED the request — a tool
 * schema its grammar compiler cannot translate, a strict-mode schema rejection
 * — the next attempt sends the same frozen tool scope and gets the same
 * refusal, so the retry text drives the parent around a loop that can never
 * exit.
 *
 * It is deliberately NOT modelled as a `resumeRefusal` value. That field means
 * "the runner refused before spending a turn", and it carries the promise that
 * the host made the decision. Here the host authorized the resume, the turn
 * ran, and a REMOTE system rejected the payload — a different fact that must
 * not be laundered through a host-refusal discriminant. So the caller still
 * gets `resumeId` (the child is intact and becomes resumable again once the
 * model, provider, or tool scope changes) plus an explicit marker that the
 * cause is deterministic.
 */
function resumeRanGuidance(error: string): Record<string, unknown> {
  return isDeterministicProviderRequestRejection(error)
    ? {
        resumeDeterministicFailure: true,
        resumeGuidance: t("be_agentSpawn.resumeProviderRejectedGuidance"),
      }
    : { resumeGuidance: t("be_agentSpawn.resumeRetryGuidance") };
}


/**
 * A terminal outcome as the emit/delivery path sees it. Identical to
 * `SubAgentSpawnResult` except that `childSessionId` is optional: a run that
 * rejected before the runner ever linked a child has no id to report, and the
 * authorized id the delivery path actually addresses is passed separately.
 */
type SubAgentTerminalOutcome =
  Omit<SubAgentSpawnResult, "childSessionId">
  & { childSessionId?: string };

/**
 * A terminal delivery must always carry something the parent can act on.
 *
 * `summary` is the child's last assistant text, which is empty whenever a run
 * ends without producing one (a resumed child that only ran tools, for example).
 * Delivering that verbatim produced an id-only envelope — header, no body — that
 * the parent LLM could not respond to, so name the final state and the way back
 * in instead. The way back in is the AUTHORIZED link the caller passes, not
 * `result.childSessionId`: a refusal that never linked reports the unvalidated
 * id it was handed, which is no route back to anything.
 */
function backgroundResultText(
  result: SubAgentTerminalOutcome,
  childSessionId: string,
): string {
  const reported = result.error ?? result.summary;
  const summary = reported.trim().length > 0
    ? reported
    : t("be_agentSpawn.emptySummaryFallback", {
        taskState: projectSubAgentResultState(result),
        resumeId: childSessionId,
      });
  if (!result.suspension) return summary;
  const requestedInput = result.suspension.reason === "question"
    ? result.suspension.prompt ?? "answer the sub-agent question"
    : "send any message to continue, or treat this partial result as done";
  return `${summary}\n\n[Input required: ${requestedInput}]`;
}

function createBackgroundResultMessage(
  result: SubAgentTerminalOutcome,
  parentSessionId: string,
  spawnId: string,
  /** The AUTHORIZED child link — the same id the delivery addresses. */
  childSessionId: string,
): A2AMessage {
  const suspension = result.suspension;
  return {
    messageId: createDlpSafeUuid(),
    role: A2A_ROLE_AGENT,
    parts: [{ text: backgroundResultText(result, childSessionId) }],
    contextId: parentSessionId,
    taskId: childSessionId,
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
    // The executor's default wall clock bounds a single tool call; this one
    // supervises a whole sub-agent loop whose length the user configures and
    // which has no maximum. Sizing the deadline from that same budget is what
    // keeps "unlimited rounds" from meaning "unlimited rounds until 600s".
    // When no runner is wired the tool refuses at execute() anyway, so the
    // shipped floor is the honest bound for that case.
    resolveHostCeilingMs: () =>
      resolveSubAgentCeilingMs(
        deps.getRunner()?.roundBudget() ?? SUBAGENT_MAX_ROUNDS_DEFAULT,
      ),
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
          description: "Deprecated and ignored: sub-agents always run in the background on surfaces that can deliver their results. You receive a run handle immediately; results arrive as parent messages, and agent_status inspects progress.",
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
      // Sub-agents ALWAYS run in the background on a surface that can deliver
      // their results (user directive 2026-08-14, superseding the earlier
      // model-picks design). Foreground blocked the parent on `await` for the
      // child's whole run, making the A2A channel inert for that spawn — the
      // parent could not read or answer anything until the child finished.
      // With autonomous wake on by default, background results always reach
      // the parent. The model's `background` flag is ignored; surfaces without
      // parent delivery fall back to foreground, the only coherent posture
      // there.
      const background = ctx.metadata?.supportsA2AParentDelivery === true;
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
      // title still labels approval requests but is not otherwise required for a
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
      const spawnId = createDlpSafeUuid();
      const initialTaskState = resumeId
        ? projectSubAgentRunState("waiting")
        : projectSubAgentRunState("submitted");
      const promptPayload = instructions ? { instructions } : {};
      // A known resumeId is not an authorized parent-delivery link. The runner
      // calls onLinked only after exact origin + durable INPUT_REQUIRED checks.
      let linkedChildSessionId: string | undefined;
      const linkedPayload = () => linkedChildSessionId ? { childSessionId: linkedChildSessionId } : {};
      /**
       * The single place a TERMINAL renderer frame is emitted for this spawn.
       *
       * Three sites used to hand-roll this object — the background
       * `terminalize`, the foreground success return, and the foreground error
       * return — and they had drifted on the join key: the background frames
       * carried `linkedChildSessionId` while the foreground ones carried
       * `result.childSessionId`. Those are not the same id. `onLinked` fires
       * only AFTER the runner's origin + durable-state checks pass, so a
       * structurally refused resume has no link but still reports the
       * caller-supplied `resumeId` as `result.childSessionId`. The foreground
       * frames were therefore handing the viewer an unvalidated join key.
       *
       * The helper resolves it once, to the AUTHORIZED link only, and returns
       * the projected state so callers do not re-derive it.
       */
      const emitTerminalFrame = (result: SubAgentTerminalOutcome) => {
        const taskState = projectSubAgentResultState(result);
        const status = subAgentRunStatusFromTaskState(taskState);
        if (status === "error") {
          deps.emit({
            spawnId,
            type: "error",
            taskState,
            status,
            message: result.error ?? result.summary,
            ...promptPayload,
            ...linkedPayload(),
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
            ...linkedPayload(),
          });
        }
        return { taskState, status };
      };
      deps.emit({
        spawnId,
        type: "start",
        taskState: initialTaskState,
        title,
        toolUseId,
        ...promptPayload,
      });
      try {
        const callbacks = {
          onLinked: ({ childSessionId }: { childSessionId: string }) => {
            linkedChildSessionId = childSessionId;
            deps.emit({
              spawnId,
              type: "activity" as const,
              taskState: resumeId
                ? projectSubAgentRunState("waiting")
                : projectSubAgentRunState("submitted"),
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
          // `onError` is diagnostic and may precede a structurally returned
          // INPUT_REQUIRED/REJECTED result. Only the final result below may
          // emit a terminal renderer event for this spawnId.
        };
        // Resume RE-HYDRATES a frozen sub-agent; spawn starts a fresh one. The
        // resume path takes NO sourceTools/profile from the tool call — those are
        // read from the persisted metadata so a resume cannot re-scope the child.
        const run = async () => resumeId
          ? await runner.resume(
              resumeId,
              instructions,
              title,
              callbacks,
              originSessionId,
              spawnId,
              background,
            )
          : await runner.spawn(
              {
                title,
                instructions: profile
                  ? renderAgentProfilePrompt(profile, instructions)
                  : instructions,
                // The same text, before the profile body is rendered around it.
                // This is the half a parent adjudicating its own child's tool
                // call needs; the rendered prompt above leads with a role
                // charter that would stand in for the task.
                parentAuthoredTask: instructions,
                spawnId,
                toolUseId,
                sourceTools,
                originSessionId,
                background,
                projectRoot: ctx.cwd,
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
          let terminalized = false;
          const terminalize = async (result: SubAgentTerminalOutcome): Promise<void> => {
            if (terminalized) return;
            terminalized = true;
            const authorizedChildSessionId = linkedChildSessionId;
            emitTerminalFrame(result);

            if (
              !authorizedChildSessionId
              || result.suspension?.reason === "question"
            ) {
              return;
            }
            const parentSessionId = originSessionId ?? "";
            try {
              await runner.deliverToParent({
                parentSessionId,
                childSessionId: authorizedChildSessionId,
                message: createBackgroundResultMessage(
                  result,
                  parentSessionId,
                  spawnId,
                  authorizedChildSessionId,
                ),
              });
            } catch {
              // Delivery owns its audit path. The renderer terminal state is final.
            }
          };
          // A rejection is just a failure-shaped result: `terminalize` already
          // owns the emit latch and skips parent delivery when there is no
          // authorized link, so the unlinked case needs no separate frame.
          const terminalizeRejection = async (err: unknown): Promise<void> => {
            const message = (err as Error).message ?? "agent_spawn failed";
            await terminalize({
              summary: message,
              error: message,
              toolCallCount: 0,
              turnCount: 0,
              childSessionId: linkedChildSessionId,
              entries: [],
              ok: false,
            });
          };

          void run().then(terminalize, terminalizeRejection);
          const handleTaskState = originSessionId
            && typeof runner.getRunStatus === "function"
            ? runner.getRunStatus(spawnId, originSessionId)?.taskState ?? initialTaskState
            : initialTaskState;
          return {
            output: JSON.stringify({
              spawnId,
              status: subAgentRunStatusFromTaskState(handleTaskState),
              taskState: handleTaskState,
              background: true,
              ...(resumeId ? { resumeId } : {}),
              ...(linkedChildSessionId ? { childSessionId: linkedChildSessionId } : {}),
              agentName: profile?.name,
            }),
            isError: false,
          };
        }

        const result = await run();
        // FAILED and REJECTED are errors even when runTurn returned a result,
        // for example a UserPromptSubmit stopReason of blocked.
        const { taskState, status } = emitTerminalFrame(result);
        if (status === "error") {
          // A failed RESUME must hand the parent its way back to the SAME
          // child. Observed failure mode without this: a transient provider
          // error surfaced as a bare string, the parent had nothing telling it
          // the child was still resumable, and it respawned FRESH agents —
          // silently discarding the suspended child's entire context.
          //
          // The refusal discriminant picks exactly one guidance text. Retry-
          // same-id guidance is for TRANSIENT failures only (`resumeRefusal`
          // absent); both refusal kinds are permanent for that id, so
          // repeating the retry text for either guides the model into an
          // infinite loop. As one switch on one field the three texts cannot
          // collide — the previous shape spread two independent booleans into
          // the same `resumeGuidance` key and relied on spread ORDER to pick a
          // winner if both were ever set.
          //
          // `resumeRefusal` absent does NOT by itself mean transient: it means
          // the resume was authorized and actually ran, and the turn then died.
          // `resumeRanGuidance` splits that population on the only property
          // that decides whether retrying helps — see its doc comment.
          const resumeFields = ((): Record<string, unknown> => {
            switch (result.resumeRefusal) {
              case "exhausted":
                return {
                  resumeRefusal: "exhausted",
                  resumeGuidance: t("be_agentSpawn.resumeExhaustedGuidance"),
                };
              case "invalid":
                return {
                  resumeRefusal: "invalid",
                  resumeGuidance: t("be_agentSpawn.resumeInvalidGuidance"),
                };
              case undefined:
                return resumeId === undefined
                  ? {}
                  : { resumeId, ...resumeRanGuidance(result.error ?? result.summary) };
            }
          })();
          return {
            output: JSON.stringify({
              error: result.error ?? result.summary,
              taskState,
              ...resumeFields,
            }),
            isError: true,
          };
        }
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
                  // The id is interpolated into the notice, not just returned
                  // beside it: a parent that reads the prose and not the
                  // sibling field is the failure mode this exists to prevent.
                  incompleteReason: t("be_agentSpawn.incompleteNotice", {
                    resumeId: result.childSessionId,
                  }),
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
          output: JSON.stringify({
            error: message,
            taskState,
            // A throw never marks the resume chain exhausted, so a resume that
            // died here (provider error, transport) is still continuable — but
            // only retryable when the provider did not refuse the request
            // itself, which is what `resumeRanGuidance` decides.
            ...(resumeId ? { resumeId, ...resumeRanGuidance(message) } : {}),
          }),
          isError: true,
        };
      }
    },
  });
}

export function createAgentStatusTool(deps: Pick<AgentSpawnToolDeps, "getRunner">): Tool {
  return createDynamicTool({
    name: "agent_status",
    // Says what this list is NOT, because the empty version of it is the one
    // that gets misread: a restart leaves the live runs behind while the
    // conversation's children stay on disk, and "no live runs" has been read
    // as "the work finished". The same fact the restored-runs hint states
    // after the call, stated where the model reads before making it.
    description: t("be_agentSpawn.statusToolDescription"),
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
      const runs = runner.listRunStatuses(originSessionId);
      // Live runs are process-local; persisted spawns are not. After an app
      // restart this list is empty while the conversation's sub-agents are
      // still sitting on disk, and the observed reading of that empty list was
      // "no active sub-agents, so the work is done" — a wrong conclusion drawn
      // from a true fact. Name the other list rather than restate this one:
      // `agent_list` is where the restored children appear, with resumeId.
      const restoredCount = runs.length === 0
        ? runner.listPersistedSpawnsForOrigin(originSessionId).length
        : 0;
      return {
        output: JSON.stringify({
          runs,
          ...(restoredCount > 0
            ? {
                restoredSubAgentsHint: t("be_agentSpawn.statusRestoredHint", {
                  count: String(restoredCount),
                }),
              }
            : {}),
        }),
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

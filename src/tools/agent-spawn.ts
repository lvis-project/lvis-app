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

export interface AgentSpawnEvent {
  spawnId: string;
  type: "start" | "turn" | "done" | "error";
  title?: string;
  turn?: number;
  text?: string;
  summary?: string;
  toolCallCount?: number;
  message?: string;
  /**
   * The `tool_use` id of the `agent_spawn` invocation that triggered this
   * spawn. Set on the `start` event so the renderer can render the
   * SubAgentCard inline next to the originating ToolGroupCard instead of
   * stacking all spawns at the top of the chat.
   */
  toolUseId?: string;
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
    description:
      "sub-agent 를 띄워 별도의 작은 작업을 실행합니다. 부모 대화 히스토리와 분리된 fresh 컨텍스트, " +
      "지정한 sourceTools 만 사용 가능. maxTurns (기본 30, 최대 60) — task 복잡도를 직접 판단해서 명시하세요: " +
      "단일 lookup/요약은 5-10, 표준 multi-step 작업은 20-30, 깊은 코드 탐색·다중 파일 분석·복합 디버깅은 40-60. " +
      "agentName 을 지정하면 ~/.lvis/agents/<name>.md 또는 ~/.lvis/agents/<name>/AGENTS.md 프로필을 profile prompt 로 결합합니다. " +
      "결과로 요약 텍스트 + tool call 수 반환. " +
      "특정 tool/plugin 을 직접 호출하라는 요청의 대체 경로로 사용하지 마세요. 요청 대상 도구가 현재 보이면 직접 호출하고, 보이지 않으면 request_plugin 으로 활성화하세요.",
    source: "builtin",
    category: "meta",
    decisionOverride: "ask",
    jsonSchema: {
      type: "object",
      required: ["instructions"],
      properties: {
        title: {
          type: "string",
          description:
            "sub-agent 의 짧은 제목 (UI 카드 헤더에 표시). agentName 이 없으면 필수입니다.",
        },
        agentName: {
          type: "string",
          description:
            "선택: ~/.lvis/agents/ 에 정의된 agent profile 이름. 지정 시 해당 프로필 본문과 기본 sourceTools 를 사용합니다.",
        },
        instructions: {
          type: "string",
          description: "sub-agent 가 수행할 작업 — system+user prompt 결합본.",
        },
        sourceTools: {
          type: "array",
          items: { type: "string" },
          description:
            "sub-agent 에 노출할 tool 이름 목록. 생략 시 부모와 동일한 tool 셋.",
        },
        maxTurns: {
          type: "integer",
          minimum: 1,
          maximum: 60,
          description:
            "최대 어시스턴트 라운드 수. 기본 30. 간단 lookup 5-10 · 표준 20-30 · 복잡 multi-step 40-60. LLM 이 task 복잡도로 직접 판단.",
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
      if (!title || !instructions) {
        return {
          output: JSON.stringify({
            error: "instructions are required; title is required when agentName is not provided",
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
      const maxTurns =
        typeof a.maxTurns === "number" && Number.isFinite(a.maxTurns)
          ? Math.max(1, Math.min(60, Math.floor(a.maxTurns)))
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
      deps.emit({ spawnId, type: "start", title, toolUseId });
      try {
        const result = await runner.spawn(
          {
            title,
            instructions: profile
              ? renderAgentProfilePrompt(profile, instructions)
              : instructions,
            sourceTools,
            maxTurns,
            originSessionId,
          },
          {
            onTurn: (u) =>
              deps.emit({
                spawnId,
                type: "turn",
                turn: u.turn,
                text: u.text,
                toolCallCount: u.toolCallCount,
              }),
            onError: (msg) =>
              deps.emit({ spawnId, type: "error", message: msg }),
          },
        );
        deps.emit({
          spawnId,
          type: "done",
          summary: result.summary,
          toolCallCount: result.toolCallCount,
        });
        return {
          output: JSON.stringify({
            summary: result.summary,
            toolCallCount: result.toolCallCount,
            turnCount: result.turnCount,
            spawnId,
            agentName: profile?.name,
          }),
          isError: false,
        };
      } catch (err) {
        const message = (err as Error).message ?? "agent_spawn failed";
        deps.emit({ spawnId, type: "error", message });
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
    `<lvis-agent-profile name="${escapeAttr(profile.name)}" source="${profile.source}">`,
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

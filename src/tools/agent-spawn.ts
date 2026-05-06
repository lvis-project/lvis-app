/**
 * `agent_spawn` LLM tool — spin up a sub-agent with restricted tools and
 * a turn cap. The sub-agent runs inline (await) and the assistant gets the
 * final summary string + tool call count.
 *
 * Renderer integration: per-spawn lifecycle events stream to a SubAgentCard
 * (start → turn → done|error) so the user sees what the sub-agent is doing.
 */
import { createDynamicTool, type Tool } from "./base.js";
import type { SubAgentRunner } from "../engine/subagent-runner.js";

export interface AgentSpawnEvent {
  spawnId: string;
  type: "start" | "turn" | "done" | "error";
  title?: string;
  turn?: number;
  text?: string;
  summary?: string;
  toolCallCount?: number;
  message?: string;
}

export interface AgentSpawnToolDeps {
  getRunner: () => SubAgentRunner | undefined;
  /** Renderer event sink — emitted on each lifecycle phase. */
  emit: (event: AgentSpawnEvent) => void;
}

import { randomUUID } from "node:crypto";

export function createAgentSpawnTool(deps: AgentSpawnToolDeps): Tool {
  return createDynamicTool({
    name: "agent_spawn",
    description:
      "sub-agent 를 띄워 별도의 작은 작업을 실행합니다. 부모 대화 히스토리와 분리된 fresh 컨텍스트, " +
      "지정한 sourceTools 만 사용 가능, maxTurns (기본 5) 이내. 결과로 요약 텍스트 + tool call 수 반환. " +
      "특정 tool/plugin 을 직접 호출하라는 요청의 대체 경로로 사용하지 마세요. Agent Hub work board 조회는 agent_hub_* 도구를 직접 호출하세요.",
    source: "builtin",
    category: "dangerous",
    jsonSchema: {
      type: "object",
      required: ["title", "instructions"],
      properties: {
        title: {
          type: "string",
          description: "sub-agent 의 짧은 제목 (UI 카드 헤더에 표시).",
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
          maximum: 20,
          description: "최대 어시스턴트 라운드 수. 기본 5.",
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
      const title = typeof a.title === "string" ? a.title.trim() : "";
      const instructions =
        typeof a.instructions === "string" ? a.instructions.trim() : "";
      if (!title || !instructions) {
        return {
          output: JSON.stringify({
            error: "title and instructions are required",
          }),
          isError: true,
        };
      }
      const sourceTools = Array.isArray(a.sourceTools)
        ? (a.sourceTools as unknown[]).filter(
            (t): t is string => typeof t === "string" && t.trim().length > 0,
          )
        : undefined;
      const maxTurns =
        typeof a.maxTurns === "number" && Number.isFinite(a.maxTurns)
          ? Math.max(1, Math.min(20, Math.floor(a.maxTurns)))
          : undefined;
      const parentSessionId =
        typeof ctx.metadata?.sessionId === "string"
          ? (ctx.metadata.sessionId as string)
          : undefined;
      const spawnId = randomUUID();
      deps.emit({ spawnId, type: "start", title });
      try {
        const result = await runner.spawn(
          {
            title,
            instructions,
            sourceTools,
            maxTurns,
            parentSessionId,
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

/**
 * Agent Route Engine — §6.2
 *
 * KeywordEngine이 분류한 의도를 올바른 실행 경로로 전달하는 라우터.
 * TypeScript 구현 — 향후 Rust NAPI-RS 포팅 대비 인터페이스 분리.
 *
 * Route Resolution 우선순위 (§6.2):
 * 1. Governance Policy Check
 * 2. Permission Check
 * 3. Local Skill Match → 플러그인 스킬 매칭
 * 4. Marketplace API
 * 5. LLM Fallback → LLM 직접 대화
 */
import type { InputClassification } from "./keyword-engine.js";
import type { ToolRegistry } from "../tools/registry.js";

// ─── Types ──────────────────────────────────────────

export type RouteResult =
  | { route: "command"; command: string; args: string }
  | { route: "skill"; skillId: string; input: string }
  | { route: "llm"; input: string };

export interface RouteEngineDeps {
  toolRegistry: ToolRegistry;
}

// ─── Engine ─────────────────────────────────────────

export class RouteEngine {
  private readonly toolRegistry: ToolRegistry;

  constructor(deps: RouteEngineDeps) {
    this.toolRegistry = deps.toolRegistry;
  }

  /** 분류된 입력을 실행 경로로 라우팅 */
  route(classification: InputClassification): RouteResult {
    switch (classification.type) {
      case "command":
        return {
          route: "command",
          command: classification.command,
          args: classification.args,
        };

      case "skill": {
        // 스킬에 매핑된 도구가 ToolRegistry에 존재하는지 확인
        const tool = this.toolRegistry.findByName(classification.skillId);
        if (tool) {
          return {
            route: "skill",
            skillId: classification.skillId,
            input: classification.input,
          };
        }
        // 도구가 없으면 LLM으로 fallback — 스킬 컨텍스트를 포함
        return { route: "llm", input: classification.input };
      }

      case "general":
        return { route: "llm", input: classification.input };
    }
  }
}

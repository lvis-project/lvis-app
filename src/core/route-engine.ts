



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


  route(classification: InputClassification): RouteResult {
    switch (classification.type) {
      case "command":
        return {
          route: "command",
          command: classification.command,
          args: classification.args,
        };

      case "skill": {

        const tool = this.toolRegistry.findByName(classification.skillId);
        if (tool) {
          return {
            route: "skill",
            skillId: classification.skillId,
            input: classification.input,
          };
        }

        return { route: "llm", input: classification.input };
      }

      case "general":
        return { route: "llm", input: classification.input };
    }
  }
}

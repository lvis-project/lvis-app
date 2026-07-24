



import type { InputClassification } from "./input-classifier.js";

// ─── Types ──────────────────────────────────────────

export type RouteResult =
  | { route: "command"; command: string; args: string }
  | { route: "llm"; input: string };

// ─── Engine ─────────────────────────────────────────

export class RouteEngine {
  route(classification: InputClassification): RouteResult {
    switch (classification.type) {
      case "command":
        return {
          route: "command",
          command: classification.command,
          args: classification.args,
        };

      case "general":
        return { route: "llm", input: classification.input };
    }
  }
}

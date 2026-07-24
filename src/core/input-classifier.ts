import { parseImportedTriggerEnvelope } from "../shared/overlay-trigger-source.js";
import { parseAppMessageEnvelope } from "../shared/mcp-app-message-source.js";

export type InputClassification =
  | { type: "command"; command: string; args: string }
  | { type: "general"; input: string };

/**
 * Classifies only host-owned command syntax.
 *
 * Plugin Skills are instruction bundles, not keyword routers. Tool selection is
 * model-driven through the visible Tool inventory and tool_search.
 */
export class InputClassifier {
  classify(input: string): InputClassification {
    const trimmed = input.trim();

    // Imported plugin/MCP app envelopes are data staged by a trusted host path,
    // never user-authored command syntax.
    if (
      parseImportedTriggerEnvelope(trimmed) !== null ||
      parseAppMessageEnvelope(trimmed) !== null
    ) {
      return { type: "general", input: trimmed };
    }

    const commandMatch = trimmed.match(/^\/(\S+)\s*(.*)?$/s);
    if (commandMatch) {
      return {
        type: "command",
        command: commandMatch[1],
        args: commandMatch[2]?.trim() ?? "",
      };
    }

    return { type: "general", input: trimmed };
  }
}

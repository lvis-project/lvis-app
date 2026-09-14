import { prepareMarkedToolResultsForWire } from "../../wire-serialize.js";
import { projectToolCallForWire, type GenericMessage, type ToolSchema } from "../types.js";

/** Model-visible history shared by the API and isolated subscription connections. */
export function projectOpenAiMessages(messages: GenericMessage[]): GenericMessage[] {
  return prepareMarkedToolResultsForWire(messages).map((message) => {
    switch (message.role) {
      case "user":
        return { role: message.role, content: message.content };
      case "assistant":
        // Display reasoning and signed blocks from another provider are not
        // replayable on either connection. Tool registry provenance stays local.
        return {
          role: message.role,
          content: message.content,
          ...(message.toolCalls === undefined
            ? {}
            : { toolCalls: message.toolCalls.map(projectToolCallForWire) }),
        };
      case "tool_result":
        return {
          role: message.role,
          toolUseId: message.toolUseId,
          ...(message.toolName === undefined ? {} : { toolName: message.toolName }),
          content: message.content,
          ...(message.isError === undefined ? {} : { isError: message.isError }),
          ...(message.image === undefined ? {} : { image: message.image }),
        };
    }
  });
}

/** Schema validation and transport-specific tool naming remain with their owners. */
export function projectOpenAiTools(tools: ToolSchema[]): ToolSchema[] {
  return tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

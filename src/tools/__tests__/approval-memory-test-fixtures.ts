import { createDynamicTool, type Tool } from "../base.js";

export function makeWriteProbeTool(
  executeSpy: (input: unknown) => Promise<unknown>,
): Tool {
  return createDynamicTool({
    name: "write_probe",
    description: "write probe",
    source: "builtin",
    category: "write",
    pathFields: ["path"],
    jsonSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    execute: async (rawInput) => {
      const value = await executeSpy(rawInput);
      return { output: String(value), isError: false };
    },
  });
}

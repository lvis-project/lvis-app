/**
 * BaseTool → legacy ToolDefinition adapter — Tier A1 wiring W1.
 *
 * The legacy {@link ToolRegistry} in `../core/tool-registry.ts` is the §6.4
 * source/trust-aware registry consumed by the conversation loop + system
 * prompt builder. It expects tools of shape {@link ToolDefinition} (fields
 * `parameters` + `execute(args)`), not the OpenHarness-port {@link BaseTool}
 * shape (fields `inputSchema` + `execute(input, ctx)`).
 *
 * This adapter bridges the two without migrating the legacy registry. It:
 *   1. Builds a JSON-Schema (drawn from the tool's zod `inputSchema`) that
 *      matches the `{ type: "object", properties, required? }` shape the
 *      legacy registry exposes to LLM providers.
 *   2. Wraps the BaseTool's typed `execute(input, ctx)` as a legacy
 *      `execute(args)` — parsing `args` through the zod schema first, then
 *      invoking with a synthetic {@link ToolExecutionContext} (cwd defaults
 *      to `process.cwd()`, metadata empty).
 *   3. Returns the typed {@link ToolResult} as-is so downstream consumers
 *      (ToolExecutor → AuditLogger) receive the full `{ output, isError,
 *      metadata }` triple.
 *
 * This keeps W1 a pure additive wiring: no legacy tool is rewritten, no new
 * registry is introduced, and the BaseTool remains the single source of
 * truth for its zod schema.
 */
import { z } from "zod";
import type { ToolDefinition, ToolSource } from "../core/tool-registry.js";
import type { BaseTool, ToolResult } from "./base.js";

/**
 * Convert a {@link BaseTool} into a legacy {@link ToolDefinition} that can
 * be registered with the §6.4 {@link ToolRegistry}. `source` defaults to
 * `"builtin"` because Tier A1 BaseTool subclasses (e.g. {@link BashTool})
 * ship as host-native core tools.
 */
export function baseToolToLegacyDefinition<T extends z.ZodTypeAny>(
  tool: BaseTool<T>,
  source: ToolSource = "builtin",
): ToolDefinition {
  const parameters = deriveLegacyParameters(tool);

  return {
    name: tool.name,
    description: tool.description,
    parameters,
    source,
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      // Zod-parse drops unknown keys + fills defaults so the BaseTool
      // execute() receives the exact shape its inputSchema promises.
      const parsed = tool.inputSchema.parse(args) as z.infer<T>;
      return tool.execute(parsed, {
        cwd: process.cwd(),
        metadata: {},
      });
    },
  };
}

/**
 * Derive the legacy `{ type: "object"; properties; required? }` parameters
 * shape directly from a BaseTool's top-level zod object schema.
 *
 * Rationale: legacy `ToolDefinition.parameters` expects a flat
 * `{type, properties, required}` shape, while `BaseTool.toApiSchema()`
 * (which uses `z.toJSONSchema()`) returns a richer JSON Schema 2020-12
 * structure that may include `$ref`/`$defs`. To avoid coupling the legacy
 * registry to the full JSON Schema dialect, we walk `ZodObject.shape`
 * directly: tag each property with a primitive JSON Schema `type`, and
 * collect required keys using the public `isOptional()` API.
 *
 * For non-ZodObject inputSchemas (rare), we fall back to an empty object
 * schema — the tool still executes, and the LLM simply sees a no-arg tool.
 */
function deriveLegacyParameters(
  tool: BaseTool,
): ToolDefinition["parameters"] {
  if (!(tool.inputSchema instanceof z.ZodObject)) {
    return { type: "object", properties: {} };
  }

  const shape = tool.inputSchema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    properties[key] = describeZod(value);
    if (!value.isOptional()) {
      required.push(key);
    }
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function describeZod(zodValue: z.ZodTypeAny): Record<string, unknown> {
  // Unwrap ZodOptional / ZodDefault / ZodNullable to reach the inner type.
  let current: z.ZodTypeAny = zodValue;
  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodNullable
  ) {
    current = (current as unknown as { _def: { innerType: z.ZodTypeAny } })
      ._def.innerType;
  }

  const desc: Record<string, unknown> = {};
  if (current instanceof z.ZodString) desc.type = "string";
  else if (current instanceof z.ZodNumber) desc.type = "number";
  else if (current instanceof z.ZodBoolean) desc.type = "boolean";
  else if (current instanceof z.ZodArray) desc.type = "array";
  else if (current instanceof z.ZodObject) desc.type = "object";
  // Unknown types: omit `type`, runtime zod parse still validates on
  // execute(); the LLM sees a free-form value which is the fallback path.

  const description = (current as unknown as { description?: string })
    .description;
  if (description) desc.description = description;
  return desc;
}

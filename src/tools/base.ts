/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/tools/base.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export interface ToolExecutionContext {
  cwd: string;
  metadata: Record<string, unknown>;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

export abstract class BaseTool<TInputSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: TInputSchema;

  abstract execute(
    input: z.infer<TInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult>;

  isReadOnly(_input: z.infer<TInputSchema>): boolean {
    return false;
  }

  toApiSchema(): { name: string; description: string; input_schema: unknown } {
    return {
      name: this.name,
      description: this.description,
      input_schema: zodToJsonSchema(this.inputSchema, {
        name: this.name,
        $refStrategy: "none",
      }),
    };
  }
}

/**
 * AF1: renamed from `ToolRegistry` to `BaseToolRegistry` to avoid a
 * symbol collision with {@link ../core/tool-registry.ts::ToolRegistry},
 * which implements the richer §6.4 source/trust aware registry used by
 * the conversation loop. This registry is the minimal OpenHarness-port
 * BaseTool container used by Tier S3 unit tests and tool fixtures.
 */
export class BaseToolRegistry {
  private readonly tools = new Map<string, BaseTool>();

  register(tool: BaseTool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  get(name: string): BaseTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): BaseTool[] {
    return [...this.tools.values()];
  }

  toApiSchema(): Array<{ name: string; description: string; input_schema: unknown }> {
    return [...this.tools.values()].map((t) => t.toApiSchema());
  }
}

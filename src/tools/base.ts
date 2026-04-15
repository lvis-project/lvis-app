/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/tools/base.py
 * Copyright (c) 2026 HKU Data Intelligence Lab
 *
 * Modern tool base class — single-file-per-tool, Zod input validation,
 * native v4 JSON Schema export. Tools register into the canonical §6.4
 * {@link ../core/tool-registry.js ToolRegistry} via
 * {@link ./adapter.js baseToolToLegacyDefinition}; this module no longer
 * exposes its own registry to avoid dual-registry drift (the legacy one
 * carries the §6.3 deny rules + §6.4 trust governance and is the single
 * production source of truth).
 */
import { z } from "zod";
import type { ToolSource } from "../core/tool-registry.js";

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

  /**
   * Source category used by §6.3 trust governance. The adapter propagates
   * this into {@link ../core/tool-registry.js ToolDefinition.source} which
   * PermissionManager + RateLimiter consume for trust-tier enforcement.
   * Subclasses override (`override readonly source = "plugin" as const`)
   * when shipped from a plugin or MCP server.
   */
  readonly source: ToolSource = "builtin";

  abstract execute(
    input: z.infer<TInputSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult>;

  isReadOnly(_input: z.infer<TInputSchema>): boolean {
    return false;
  }

  toApiSchema(): { name: string; description: string; input_schema: unknown } {
    // zod v4 ships with native JSON Schema export via z.toJSONSchema().
    // Replaces the v3-only `zod-to-json-schema` package which was removed
    // by Phase 3 follow-up T7-E.
    return {
      name: this.name,
      description: this.description,
      input_schema: z.toJSONSchema(this.inputSchema),
    };
  }
}

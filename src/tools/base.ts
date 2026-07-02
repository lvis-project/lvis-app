/**
 * Portions adapted from OpenHarness (MIT License)
 * https://github.com/HKUDS/OpenHarness/blob/main/src/openharness/tools/base.py
 * Copyright (c) 2025 OpenHarness Contributors
 *
 * Tool interface + ergonomic bases.
 *
 * Every tool registered with the §6.4 {@link ./registry.js ToolRegistry}
 * implements {@link Tool}, regardless of whether it was hand-written as
 * a {@link ZodTool} subclass or generated dynamically via
 * {@link createDynamicTool} (plugin manifest, MCP discovery,
 * knowledge-search factory).
 *
 * This is the single source of truth for the tool contract — the
 * permission manager, the 8-step executor pipeline, the system prompt
 * builder, and the plugin/MCP lifecycle all consume this shape.
 */
import { z } from "zod";
import type {
  ToolSource,
  ToolCategory,
  ToolDecisionOverride,
  ToolExecutionContext,
  ToolResult,
} from "./types.js";

// Re-export governance types so downstream modules can grab the full
// tool surface from a single import path (tools/base.js).
export type {
  ToolSource,
  ToolCategory,
  ToolDecisionOverride,
  ToolExecutionContext,
  ToolResult,
} from "./types.js";

/**
 * Canonical tool contract used by the §6.4 {@link ToolRegistry}, the
 * §6.3 permission stack, the executor pipeline, and
 * {@link ../prompts/system-prompt-builder.js SystemPromptBuilder}.
 *
 * Implementations must be self-describing: {@link toJsonSchema} produces
 * the schema sent to LLM providers, {@link isReadOnly} drives the
 * approval-gate §S4 read-only short-circuit, and {@link execute}
 * validates + runs the tool against the shared execution context.
 */
export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly source: ToolSource;
  readonly category: ToolCategory;
  readonly categoryForInput?: (input: unknown) => ToolCategory;
  /**
   * Permission policy — declared only on `category === "meta"` tools. Tells the executor
   * to take the explicit short-circuit path rather than the standard Layer 3
   * decision matrix. See {@link ToolDecisionOverride} for semantics.
   */
  readonly decisionOverride?: ToolDecisionOverride;
  readonly pluginId?: string;
  /**
   * Host-owned plugin worker identity for plugin tools whose side effects are
   * actually routed through a long-lived worker. Paired with `pluginId` so the
   * permission reviewer can resolve the real ASRT substrate for that specific
   * worker. Manifest `_meta.workerId` alone must not populate this field; it is
   * only safe when the host controls the invocation path into that worker.
   */
  readonly workerId?: string;
  readonly mcpServerId?: string;
  /**
   * Manifest-declared filesystem path fields. Used by the executor's
   * Layer 0/1 path policy for dynamic plugin/MCP tools whose argument names
   * are not the built-in `path | file_path | filePath` convention.
   */
  readonly pathFields?: readonly string[];
  /**
   * Issue #664 P1 — manifest-declared self-attestation that every value
   * resolved through `pathFields` stays inside the owning plugin's
   * sandbox root (`~/.lvis/plugins/<pluginId>/`). When true AND the
   * runtime verifies that every resolved path is inside the owner
   * sandbox, the reviewer auto-LOWs the verdict so plugin tools can
   * touch their own data dir without round-tripping the user. The
   * runtime still verifies path containment — a tool that declares the
   * flag but emits an out-of-sandbox path falls back to the normal
   * write rules. Only meaningful for `category === "write"` and
   * `pluginId` is set.
   */
  readonly writesToOwnSandbox?: boolean;
  /**
   * §6.4 Tool versioning — semver string (e.g. "1.0.0"). Required so the
   * registry can pick the latest implementation when multiple versions of the
   * same tool are registered and so deprecation metadata has a concrete
   * baseline. Hand-written tools default to "1.0.0" via {@link ZodTool}.
   */
  readonly version: string;
  /**
   * Semver string marking when this tool was deprecated. When present, the
   * registry emits a warning on every invocation lookup so callers can
   * observe usage during the migration window. Undefined = active tool.
   */
  readonly deprecatedSince?: string;
  /**
   * Name of the tool that replaces this one. When set, registry lookups for
   * the deprecated name transparently redirect to the replacement tool so
   * existing callers keep working through the deprecation window.
   */
  readonly replacedBy?: string;
  /**
   * Optional user-approval cache identity for authority-sensitive tools.
   *
   * The executor prefixes this with `tool.name:` before handing it to the
   * permission manager. Tools that declare this opt out of bare tool-name
   * "allow always" reuse because their arguments carry permission scope.
   */
  approvalCacheKey?(input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">): string | undefined;

  /** JSON Schema describing the input shape — sent to LLM providers. */
  toJsonSchema(): unknown;

  /** Per-invocation read-only check — false = mutating. */
  isReadOnly(input: unknown): boolean;

  /**
   * Validate + execute. Implementations parse `rawInput` to whatever
   * typed shape they need. Returns a {@link ToolResult} (with isError
   * for downstream pipeline steps) instead of throwing for normal
   * failures.
   */
  execute(rawInput: unknown, ctx: ToolExecutionContext): Promise<ToolResult>;
}

/**
 * Ergonomic abstract base for hand-written tools backed by a Zod schema.
 * Subclasses implement {@link executeTyped}; {@link execute} parses
 * `rawInput` via the schema first then dispatches typed.
 *
 * Override `source` / `category` with `override readonly` for plugin or
 * dangerous tools — see {@link BashTool} for a complete example.
 */
export abstract class ZodTool<TSchema extends z.ZodTypeAny = z.ZodTypeAny>
  implements Tool
{
  abstract readonly name: string;
  abstract readonly description: string;
  abstract readonly inputSchema: TSchema;

  readonly source: ToolSource = "builtin";
  abstract readonly category: ToolCategory;
  readonly decisionOverride?: ToolDecisionOverride;
  readonly pluginId?: string;
  readonly workerId?: string;
  readonly mcpServerId?: string;
  /** Issue #664 P1 — sandbox-write self-attestation (see {@link Tool.writesToOwnSandbox}). */
  readonly writesToOwnSandbox?: boolean;
  /** §6.4 — default version for hand-written builtins. Override via `override readonly version = "2.0.0"`. */
  readonly version: string = "1.0.0";
  readonly deprecatedSince?: string;
  readonly replacedBy?: string;

  toJsonSchema(): unknown {
    // zod v4 ships with native JSON Schema export.
    return z.toJSONSchema(this.inputSchema);
  }

  isReadOnly(_input: unknown): boolean {
    return false;
  }

  async execute(
    rawInput: unknown,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult> {
    const parsed = this.inputSchema.parse(rawInput) as z.infer<TSchema>;
    return this.executeTyped(parsed, ctx);
  }

  /**
   * Typed execution after Zod parsing. Subclasses implement this — the
   * public {@link execute} entry point threads raw LLM-supplied input
   * through the zod schema before dispatching.
   */
  protected abstract executeTyped(
    input: z.infer<TSchema>,
    ctx: ToolExecutionContext,
  ): Promise<ToolResult>;
}

/**
 * Specification consumed by {@link createDynamicTool}. Runtime-built
 * tools (plugin manifest registration, MCP discovery, knowledge-search
 * factory) supply a raw JSON Schema and an execute callback rather
 * than a Zod schema + subclass.
 */
export interface DynamicToolSpec {
  name: string;
  description: string;
  source: ToolSource;
  category: ToolCategory;
  categoryForInput?: (input: unknown) => ToolCategory;
  decisionOverride?: ToolDecisionOverride;
  pluginId?: string;
  workerId?: string;
  mcpServerId?: string;
  pathFields?: readonly string[];
  /** Issue #664 P1 — sandbox-write self-attestation (see {@link Tool.writesToOwnSandbox}). */
  writesToOwnSandbox?: boolean;
  /** §6.4 — semver. Defaults to "1.0.0" when omitted. */
  version?: string;
  /** §6.4 — semver string marking deprecation; enables warn on lookup. */
  deprecatedSince?: string;
  /** §6.4 — replacement tool name; enables transparent redirect. */
  replacedBy?: string;
  /** Permission policy #634 — per-tool approval cache identity. */
  approvalCacheKey?: (input: unknown, ctx?: Pick<ToolExecutionContext, "cwd">) => string | undefined;
  /** Raw JSON Schema — used when no Zod schema is available (plugin/MCP). */
  jsonSchema: object;
  execute: (
    rawInput: unknown,
    ctx: ToolExecutionContext,
  ) => Promise<ToolResult>;
  isReadOnly?: (input: unknown) => boolean;
}

/**
 * Factory for runtime-built tools. Plugin manifest registration, MCP
 * discovery, and the knowledge-search factory call this to skip the
 * abstract subclass ceremony and pass a spec object — the returned
 * value is a fully-fledged {@link Tool} ready for
 * {@link ToolRegistry.register}.
 */
export function createDynamicTool(spec: DynamicToolSpec): Tool {
  return {
    name: spec.name,
    description: spec.description,
    source: spec.source,
    category: spec.category,
    categoryForInput: spec.categoryForInput,
    decisionOverride: spec.decisionOverride,
    pluginId: spec.pluginId,
    workerId: spec.workerId,
    mcpServerId: spec.mcpServerId,
    pathFields: spec.pathFields,
    writesToOwnSandbox: spec.writesToOwnSandbox,
    version: spec.version ?? "1.0.0",
    deprecatedSince: spec.deprecatedSince,
    replacedBy: spec.replacedBy,
    approvalCacheKey: spec.approvalCacheKey,
    toJsonSchema: () => spec.jsonSchema,
    isReadOnly: spec.isReadOnly ?? ((): boolean => false),
    execute: spec.execute,
  };
}

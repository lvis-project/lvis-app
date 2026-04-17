/**
 * §6.4 Tool Registry — single source of truth for tool registration,
 * lookup, and visibility filtering.
 *
 * Every host-side consumer (SystemPromptBuilder, ConversationLoop,
 * ToolExecutor, PermissionManager, McpClient, plugin registration in
 * boot.ts) reads and writes tools through this class. There is no
 * second registry, no adapter layer, and no "legacy" shape — tools
 * implement the canonical {@link Tool} interface from
 * {@link ./base.js} and nothing else.
 *
 * §6.3 Layer 1 deny rules apply here: blocked tools never appear in
 * {@link getVisibleTools} / {@link getToolSchemas} so the LLM cannot
 * even see their existence — the architectural security boundary
 * remains intact. §6.4 source/trust governance + plugin/MCP kill
 * switches ({@link unregisterByPlugin} / {@link unregisterByMcp}) are
 * carried forward from the prior interface-based registry.
 */
import type { Tool } from "./base.js";
import type { DenyRule } from "./types.js";

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private denyRules: DenyRule[] = [];

  /** Register a tool. Throws if a tool with the same name already exists. */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Bulk register — used by plugin load and builtin tool registration. */
  registerBatch(tools: Tool[]): void {
    for (const tool of tools) this.register(tool);
  }

  /** Remove a single tool by name. No-op if absent. */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /** Remove every tool contributed by the given plugin. */
  unregisterByPlugin(pluginId: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.pluginId === pluginId) this.tools.delete(name);
    }
  }

  /**
   * Kill Switch (tool-governance.md §10.1) — drop every tool from the
   * given MCP server in one pass. Called by McpManager.killSwitch.
   */
  unregisterByMcp(mcpServerId: string): void {
    for (const [name, tool] of this.tools) {
      if (tool.mcpServerId === mcpServerId) this.tools.delete(name);
    }
  }

  /** §4.5.6 lookup — used by the executor's Step 1 (Lookup). */
  findByName(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Full tool list (includes denied tools — for diagnostics). */
  listAll(): Tool[] {
    return [...this.tools.values()];
  }

  /** §6.3 Layer 1 — deny rules applied, returns what the LLM sees. */
  getVisibleTools(): Tool[] {
    return this.listAll().filter((tool) => !this.isDenied(tool.name));
  }

  /** LLM-facing schema array — consumed by SystemPromptBuilder. */
  getToolSchemas(): Array<{
    name: string;
    description: string;
    input_schema: unknown;
  }> {
    return this.getVisibleTools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.toJsonSchema(),
    }));
  }

  /**
   * Phase 1 Lazy Tool Scoping — return schemas restricted to the given scope.
   *
   * - Builtins (tool.source === "builtin") are included when includeBuiltins.
   * - Plugin tools are included only when their pluginId is in activePluginIds.
   * - MCP tools (tool.source === "mcp") are included when includeMcp.
   * - Deny rules still apply (§6.3 Layer 1).
   *
   * Matches {@link getToolSchemas} shape for drop-in replacement in the
   * ConversationLoop streaming path.
   */
  getToolSchemasForScope(scope: {
    activePluginIds: Set<string> | string[];
    includeBuiltins: boolean;
    includeMcp: boolean;
  }): Array<{ name: string; description: string; input_schema: unknown }> {
    const active = scope.activePluginIds instanceof Set
      ? scope.activePluginIds
      : new Set(scope.activePluginIds);

    return this.getVisibleTools()
      .filter((tool) => {
        if (tool.source === "builtin") return scope.includeBuiltins;
        if (tool.source === "mcp") return scope.includeMcp;
        // plugin / other sources gated by pluginId
        if (tool.pluginId) return active.has(tool.pluginId);
        // Unknown source without pluginId — be conservative, treat as builtin
        return scope.includeBuiltins;
      })
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.toJsonSchema(),
      }));
  }

  /** Replace the deny-rule list (admin policy load). */
  setDenyRules(rules: DenyRule[]): void {
    this.denyRules = rules;
  }

  /** Registered tool count (includes denied). */
  get size(): number {
    return this.tools.size;
  }

  /**
   * Create a scoped view restricted to the given tool names.
   * Used by subagent-runner to enforce allowedTools isolation.
   * Deny rules are not inherited — the caller controls what the sub-agent sees.
   */
  createScopedView(allowedNames: Set<string> | string[]): ToolRegistry {
    const allowed = new Set(allowedNames);
    const scoped = new ToolRegistry();
    for (const [name, tool] of this.tools) {
      if (allowed.has(name)) scoped.register(tool);
    }
    return scoped;
  }

  // ─── Private ──────────────────────────────────────

  private isDenied(name: string): boolean {
    return this.denyRules.some((rule) =>
      this.matchPattern(rule.pattern, name),
    );
  }

  private matchPattern(pattern: string, name: string): boolean {
    // Simple glob: "*" = any chars, "." literal
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
    );
    return regex.test(name);
  }
}

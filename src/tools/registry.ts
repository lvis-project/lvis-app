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
import { createLogger } from "../lib/logger.js";
const log = createLogger("tool-registry");

/**
 * Tool-Level Deferral — name of the `tool_search` meta-tool. This low-level
 * registry module owns the stable tool name; ConversationLoop owns whether
 * plugin/MCP tools are eagerly exposed or deferred for the current turn.
 */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

/**
 * §6.4 — observer fired whenever a deprecated tool is resolved via
 * {@link ToolRegistry.findByName}. Supplies enough context for an audit
 * listener (AuditLogger, cost-monitor) to log a `warn`/`tool_call` entry
 * without pulling AuditLogger into this module.
 */
export interface DeprecationEvent {
  /** Name the caller requested. */
  requested: string;
  /** Resolved tool (may differ from requested when `replacedBy` redirect fires). */
  resolved: Tool;
  deprecatedSince: string;
  replacedBy?: string;
}

export interface ToolSchemaEntry {
  name: string;
  description: string;
  input_schema: unknown;
  source: Tool["source"];
  category: Tool["category"];
  pluginId?: string;
  mcpServerId?: string;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  source: Extract<Tool["source"], "plugin" | "mcp">;
  pluginId?: string;
  mcpServerId?: string;
}

/**
 * Compare two semver-ish version strings. Returns `a < b ? -1 : a > b ? 1 : 0`.
 * Non-numeric segments fall back to lexical compare so pre-release tags
 * (`1.0.0-beta`) still sort deterministically. Good enough for picking
 * "latest" among registered versions without pulling in `semver`.
 */
function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const sa = pa[i] ?? "0";
    const sb = pb[i] ?? "0";
    const na = Number(sa);
    const nb = Number(sb);
    const bothNum = !Number.isNaN(na) && !Number.isNaN(nb);
    if (bothNum) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else {
      if (sa !== sb) return sa < sb ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Tool-Level Deferral — compress a tool description for the catalog: first
 * sentence (up to the first period) capped at ~100 chars. Keeps the per-turn
 * catalog cheap while leaving enough signal for the model to pick a tool to
 * promote via `tool_search`.
 */
function trimCatalogDescription(description: string): string {
  const oneLine = description.replace(/\s+/g, " ").trim();
  const firstSentence = oneLine.split(/(?<=\.)\s/)[0] ?? oneLine;
  const candidate = firstSentence.length > 0 ? firstSentence : oneLine;
  return candidate.length > 100 ? `${candidate.slice(0, 97)}...` : candidate;
}

function schemaEntryForTool(tool: Tool, inputSchema: unknown): ToolSchemaEntry {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: inputSchema,
    source: tool.source,
    category: tool.category,
    ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
    ...(tool.mcpServerId ? { mcpServerId: tool.mcpServerId } : {}),
  };
}

function catalogEntryForTool(tool: Tool): ToolCatalogEntry | null {
  if (tool.source !== "plugin" && tool.source !== "mcp") return null;
  return {
    name: tool.name,
    description: trimCatalogDescription(tool.description),
    source: tool.source,
    ...(tool.pluginId ? { pluginId: tool.pluginId } : {}),
    ...(tool.mcpServerId ? { mcpServerId: tool.mcpServerId } : {}),
  };
}

function toolOwnerKey(tool: Tool): string {
  if (tool.source === "builtin") return "builtin";
  if (tool.source === "plugin") {
    if (!tool.pluginId) {
      throw new Error(`Plugin tool '${tool.name}' is missing pluginId`);
    }
    return `plugin:${tool.pluginId}`;
  }
  if (tool.source === "mcp") {
    if (!tool.mcpServerId) {
      throw new Error(`MCP tool '${tool.name}' is missing mcpServerId`);
    }
    return `mcp:${tool.mcpServerId}`;
  }
  throw new Error(`Unsupported tool source for '${tool.name}': ${String(tool.source)}`);
}

export class ToolRegistry {
  /**
   * `name → latest active tool` — fast path for the common lookup.
   * Populated/updated on every register; may point at a deprecated tool when
   * no active version exists.
   */
  private readonly tools = new Map<string, Tool>();
  /**
   * `name → (version → tool)` — secondary index that keeps every registered
   * version so legacy callers can pin a specific version via
   * {@link findByNameVersion} while the LLM-facing path sees only the latest.
   */
  private readonly versioned = new Map<string, Map<string, Tool>>();
  private denyRules: DenyRule[] = [];
  private deprecationHandler: ((event: DeprecationEvent) => void) | null = null;

  /**
   * Register a tool.
   *
   * - Same name + same version → throws (duplicate registration bug).
   * - Same name + different version → allowed only within the same source
   *   owner; versioning is not a cross-plugin/MCP/builtin override channel.
   *   The name→tool map points at whichever owner-local version is newest
   *   (semver compare) and is not deprecated.
   */
  register(tool: Tool): void {
    const versionMap = this.addToVersioned(this.versioned, tool);
    this.tools.set(tool.name, this.pickLatest(versionMap));
  }

  /** Bulk register — used by plugin load and builtin tool registration. */
  registerBatch(tools: Tool[]): void {
    for (const tool of tools) this.register(tool);
  }

  /** Remove a single tool by name (every registered version). No-op if absent. */
  unregister(name: string): void {
    this.tools.delete(name);
    this.versioned.delete(name);
  }

  /** Remove every tool contributed by the given plugin. */
  unregisterByPlugin(pluginId: string): void {
    this.replacePluginTools([pluginId], []);
  }

  /** Plugin ids that currently contribute at least one registered tool version. */
  listPluginIds(): string[] {
    const ids = new Set<string>();
    for (const versionMap of this.versioned.values()) {
      for (const tool of versionMap.values()) {
        if (tool.source === "plugin" && tool.pluginId) ids.add(tool.pluginId);
      }
    }
    return [...ids];
  }

  /**
   * Atomically replace every registered tool owned by the given plugins.
   *
   * The replacement is computed against cloned indexes first. If validation or
   * duplicate detection fails, the live registry is untouched.
   */
  replacePluginTools(pluginIds: Iterable<string>, replacementTools: Tool[]): void {
    const targetPluginIds = new Set([...pluginIds].filter((id) => id.length > 0));
    if (targetPluginIds.size === 0) {
      if (replacementTools.length > 0) {
        throw new Error("replacePluginTools requires pluginIds for replacement tools");
      }
      return;
    }

    for (const tool of replacementTools) {
      if (tool.source !== "plugin" || !tool.pluginId) {
        throw new Error(`replacePluginTools expected plugin-sourced tool: ${tool.name}`);
      }
      if (!targetPluginIds.has(tool.pluginId)) {
        throw new Error(
          `replacePluginTools received tool '${tool.name}' for plugin '${tool.pluginId}' outside target set`,
        );
      }
    }

    const nextVersioned = this.cloneVersioned();
    for (const [name, versionMap] of nextVersioned) {
      for (const [version, tool] of versionMap) {
        if (tool.source === "plugin" && tool.pluginId && targetPluginIds.has(tool.pluginId)) {
          versionMap.delete(version);
        }
      }
      if (versionMap.size === 0) nextVersioned.delete(name);
    }

    for (const tool of replacementTools) {
      this.addToVersioned(nextVersioned, tool);
    }
    const nextTools = this.buildLatestMap(nextVersioned);

    this.versioned.clear();
    for (const [name, versionMap] of nextVersioned) {
      this.versioned.set(name, versionMap);
    }
    this.tools.clear();
    for (const [name, tool] of nextTools) {
      this.tools.set(name, tool);
    }
  }

  /**
   * Kill Switch (tool-governance.md §10.1) — drop every tool from the
   * given MCP server in one pass. Called by McpManager.killSwitch.
   */
  unregisterByMcp(mcpServerId: string): void {
    for (const [name, versionMap] of this.versioned) {
      for (const [version, tool] of versionMap) {
        if (tool.mcpServerId === mcpServerId) versionMap.delete(version);
      }
      this.syncLatest(name, versionMap);
    }
  }

  /**
   * §4.5.6 lookup — used by the executor's Step 1 (Lookup).
   *
   * Resolution order:
   *   1. Look up the `name → latest` map entry.
   *   2. If the resolved tool carries `replacedBy`, follow the redirect to
   *      the replacement tool (one-hop only to avoid cycles) and emit a
   *      deprecation event for the legacy name.
   *   3. If the resolved tool carries `deprecatedSince` (with no redirect),
   *      still emit a deprecation event so audit/telemetry can observe it.
   */
  findByName(name: string): Tool | undefined {
    const hit = this.tools.get(name);
    if (!hit) return undefined;
    if (hit.replacedBy) {
      const replacement = this.tools.get(hit.replacedBy);
      if (replacement) {
        this.emitDeprecation({
          requested: name,
          resolved: replacement,
          deprecatedSince: hit.deprecatedSince ?? hit.version,
          replacedBy: hit.replacedBy,
        });
        return replacement;
      }
    }
    if (hit.deprecatedSince) {
      this.emitDeprecation({
        requested: name,
        resolved: hit,
        deprecatedSince: hit.deprecatedSince,
        replacedBy: hit.replacedBy,
      });
    }
    return hit;
  }

  /**
   * Pin a specific version — used by legacy callers that need the old
   * behaviour during a deprecation window. Does NOT emit a deprecation
   * event (caller has explicitly opted in).
   */
  findByNameVersion(name: string, version: string): Tool | undefined {
    return this.versioned.get(name)?.get(version);
  }

  /** Every registered version of `name`, ordered oldest → newest. */
  listVersions(name: string): Tool[] {
    const map = this.versioned.get(name);
    if (!map) return [];
    return [...map.values()].sort((a, b) =>
      compareSemver(a.version, b.version),
    );
  }

  /**
   * Install/replace the deprecation observer. Passing `null` clears it.
   * Wired by boot.ts to {@link AuditLogger.log} so every deprecated-tool
   * call lands in the daily JSONL + `warn` stream without coupling the
   * registry to AuditLogger directly.
   */
  setDeprecationHandler(handler: ((event: DeprecationEvent) => void) | null): void {
    this.deprecationHandler = handler;
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
  getToolSchemas(): ToolSchemaEntry[] {
    return this.getVisibleTools().map((tool) =>
      schemaEntryForTool(tool, tool.toJsonSchema()),
    );
  }

  /**
   * Lazy Tool Scoping — return schemas restricted to the given scope.
   *
   * Builtins/meta-tools load when `includeBuiltins` is set. Plugin/MCP tools
   * load individually only when their name is in `scope.activeToolNames`
   * (keyword-preloaded, `tool_search`-promoted, carried forward in current
   * scope, or explicitly allowlisted by a sub-agent/routine/headless caller).
   * Everything else is deferred to {@link getToolCatalogForScope}.
   *
   * Deny rules still apply first (§6.3 Layer 1, via {@link getVisibleTools}).
   * Matches {@link getToolSchemas} shape for drop-in replacement in the
   * ConversationLoop streaming path.
   */
  getToolSchemasForScope(scope: {
    activePluginIds: Set<string> | string[];
    activeToolNames?: Set<string> | string[];
    includeBuiltins: boolean;
    includeMcp: boolean;
    deferral?: boolean;
  }): ToolSchemaEntry[] {
    const active = scope.activePluginIds instanceof Set
      ? scope.activePluginIds
      : new Set(scope.activePluginIds);
    const activeNames = scope.activeToolNames instanceof Set
      ? scope.activeToolNames
      : new Set(scope.activeToolNames ?? []);

    // Eager mode (#1176): below the EAGER_TOOL_EXPOSURE_CEILING the turn
    // exposes every in-scope plugin/MCP tool's full schema directly, so the
    // model never has to spend `tool_search` rounds discovering them. Deferred
    // mode keeps the per-tool gating where only `activeToolNames` entries load
    // and the rest live in the compact catalog.
    const deferral = scope.deferral !== false;

    return this.getVisibleTools()
      .filter((tool) => {
        if (tool.source === "builtin") {
          // Builtins/meta-tools are always eager — never deferred, never
          // counted toward the exposure ceiling.
          if (!scope.includeBuiltins) return false;
          return true;
        }
        if (tool.source === "mcp") {
          if (!scope.includeMcp) return false;
          // Eager: every in-scope MCP tool loads. Deferred: only promoted ones.
          return deferral ? activeNames.has(tool.name) : true;
        }
        if (tool.source === "plugin") {
          // A plugin tool without a pluginId is a registration bug; drop it
          // rather than expose a misconfigured tool as if it were a builtin.
          if (!tool.pluginId) {
            log.warn(`plugin tool '${tool.name}' missing pluginId — skipped in scope filter`);
            return false;
          }
          if (!active.has(tool.pluginId)) return false;
          // Eager: the whole active plugin's suite loads. Deferred: only the
          // tools individually promoted via keyword/carry-forward/tool_search.
          return deferral ? activeNames.has(tool.name) : true;
        }
        // Fallback for any new source kind added later — exclude from scope.
        return false;
      })
      .map((tool) => {
        // Copilot review: a broken toJsonSchema() must not kill the whole
        // scope computation. Drop the offending tool with a warn instead so
        // the rest of the turn keeps working.
        try {
          return schemaEntryForTool(tool, tool.toJsonSchema());
        } catch (err) {
          log.warn(`toJsonSchema failed for '${tool.name}': %s`, (err as Error).message);
          return null;
        }
      })
      .filter((entry): entry is ToolSchemaEntry => entry !== null);
  }

  /**
   * Tool-Level Deferral catalog — the compact `{ name, description }[]` of
   * visible plugin/MCP tools that are *in scope* (plugin active OR MCP included)
   * but NOT loaded (`activeToolNames` excludes them). The LLM sees these as
   * candidates and promotes them with `tool_search({ query })`.
   *
   * - Deny rules apply first (same as the loaded path — {@link getVisibleTools}).
   * - Loaded tools (in `activeToolNames`) are excluded so they never appear twice.
   * - Builtins/meta-tools are never catalog entries (they are always loaded).
   * - Description is trimmed to the first sentence / ~100 chars for compactness.
   */
  getToolCatalogForScope(scope: {
    activePluginIds: Set<string> | string[];
    activeToolNames?: Set<string> | string[];
    includeMcp: boolean;
    deferral?: boolean;
  }): ToolCatalogEntry[] {
    // Eager mode (#1176): every in-scope tool is already exposed in full by
    // {@link getToolSchemasForScope}, so there is nothing left to discover —
    // the catalog is empty and the `<tool-catalog>` block naturally vanishes.
    if (scope.deferral === false) return [];

    const active = scope.activePluginIds instanceof Set
      ? scope.activePluginIds
      : new Set(scope.activePluginIds);
    const activeNames = scope.activeToolNames instanceof Set
      ? scope.activeToolNames
      : new Set(scope.activeToolNames ?? []);

    return this.getVisibleTools()
      .filter((tool) => {
        if (activeNames.has(tool.name)) return false; // already loaded
        if (tool.source === "mcp") return scope.includeMcp;
        if (tool.source === "plugin") {
          if (!tool.pluginId) return false;
          return active.has(tool.pluginId);
        }
        return false; // builtins/meta-tools are never deferred
      })
      .map((tool) => catalogEntryForTool(tool))
      .filter((entry): entry is ToolCatalogEntry => entry !== null);
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

  /**
   * Pick the newest version from a version map, preferring active tools
   * over deprecated ones. When every registered version is deprecated the
   * newest deprecated tool wins — callers still see it but the deprecation
   * observer fires on each lookup.
   */
  private pickLatest(versionMap: Map<string, Tool>): Tool {
    const tools = [...versionMap.values()];
    const active = tools.filter((t) => !t.deprecatedSince);
    const pool = active.length > 0 ? active : tools;
    return pool.reduce((best, cur) =>
      compareSemver(cur.version, best.version) > 0 ? cur : best,
    );
  }

  private cloneVersioned(): Map<string, Map<string, Tool>> {
    const clone = new Map<string, Map<string, Tool>>();
    for (const [name, versionMap] of this.versioned) {
      clone.set(name, new Map(versionMap));
    }
    return clone;
  }

  private addToVersioned(index: Map<string, Map<string, Tool>>, tool: Tool): Map<string, Tool> {
    const versionMap = index.get(tool.name) ?? new Map<string, Tool>();
    this.assertNameOwnerCompatible(versionMap, tool);
    if (versionMap.has(tool.version)) {
      throw new Error(`Tool already registered: ${tool.name}@${tool.version}`);
    }
    versionMap.set(tool.version, tool);
    index.set(tool.name, versionMap);
    return versionMap;
  }

  private buildLatestMap(index: Map<string, Map<string, Tool>>): Map<string, Tool> {
    const latest = new Map<string, Tool>();
    for (const [name, versionMap] of index) {
      if (versionMap.size > 0) latest.set(name, this.pickLatest(versionMap));
    }
    return latest;
  }

  /** Recompute the `tools` map entry for `name` after a version change. */
  private syncLatest(name: string, versionMap: Map<string, Tool>): void {
    if (versionMap.size === 0) {
      this.tools.delete(name);
      this.versioned.delete(name);
      return;
    }
    this.tools.set(name, this.pickLatest(versionMap));
  }

  private emitDeprecation(event: DeprecationEvent): void {
    const redirect = event.replacedBy ? ` → ${event.replacedBy}` : "";
    log.warn(
      `deprecated tool call: ${event.requested}@${event.resolved.version} (deprecatedSince=${event.deprecatedSince})${redirect}`,
    );
    if (this.deprecationHandler) {
      try {
        this.deprecationHandler(event);
      } catch (err) {
        log.warn(
          `deprecation handler threw: %s`,
          (err as Error).message,
        );
      }
    }
  }

  private assertNameOwnerCompatible(versionMap: Map<string, Tool>, tool: Tool): void {
    const nextOwner = toolOwnerKey(tool);
    for (const existing of versionMap.values()) {
      const existingOwner = toolOwnerKey(existing);
      if (existingOwner !== nextOwner) {
        throw new Error(
          `Tool name collision: '${tool.name}' already owned by ${existingOwner}; cannot register ${nextOwner}`,
        );
      }
    }
  }

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

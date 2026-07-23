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
 *
 * Registration ≠ model exposure. Registry membership answers ONE question —
 * "what may execute under the gate" — and an MCP Apps app-only tool
 * (`_meta.ui.visibility: ["app"]`, callable by its card, hidden from the model
 * by spec) is registered for exactly that reason: it is the only way its call
 * can reach `inspectHostRisk` → reviewer/approval → audit. What the LLM is SHOWN
 * is the narrower {@link getModelVisibleTools}, through which every model-facing
 * listing here runs.
 */
import { isModelExposedTool, type Tool } from "./base.js";
import type { DenyRule } from "./types.js";
import { compareSemver } from "../shared/semver-compare.js";
import { createLogger } from "../lib/logger.js";

export { compareSemver };
const log = createLogger("tool-registry");

/**
 * Tool-Level Deferral — name of the `tool_search` meta-tool. This low-level
 * registry module owns the stable tool name; ConversationLoop owns whether
 * plugin/MCP tools are eagerly exposed or deferred for the current turn.
 */
export const TOOL_SEARCH_TOOL_NAME = "tool_search";

export interface ToolSchemaEntry {
  name: string;
  description: string;
  input_schema: unknown;
  source: Tool["source"];
  category: Tool["category"];
  pluginId?: string;
  workerId?: string;
  mcpServerId?: string;
}

export interface ToolCatalogEntry {
  name: string;
  description: string;
  source: Extract<Tool["source"], "plugin" | "mcp">;
  pluginId?: string;
  workerId?: string;
  mcpServerId?: string;
}

export interface PreparedMcpRegistryReplacement {
  readonly replacementTools: readonly Tool[];
  publish(): void;
  cancel(): void;
}

export interface PreparedPluginRegistryReplacement {
  readonly replacementTools: readonly Tool[];
  publish(): void;
  cancel(): void;
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
    ...(tool.workerId ? { workerId: tool.workerId } : {}),
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
    ...(tool.workerId ? { workerId: tool.workerId } : {}),
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

function assertToolGovernanceShape(tool: Tool): void {
  const external = tool.source !== "builtin";
  const hasDecisionOverride = tool.decisionOverride !== undefined;
  const hasDynamicCategory = tool.categoryForInput !== undefined;

  if (external && tool.category === "meta") {
    throw new Error(`External tool '${tool.name}' cannot declare the host-only meta category`);
  }
  if (external && hasDecisionOverride) {
    throw new Error(`External tool '${tool.name}' cannot declare decisionOverride`);
  }
  if (external && hasDynamicCategory) {
    throw new Error(`External tool '${tool.name}' cannot declare categoryForInput`);
  }
  if (tool.category === "meta") {
    if (hasDynamicCategory) {
      throw new Error(`Meta tool '${tool.name}' cannot declare categoryForInput`);
    }
    if (
      tool.decisionOverride !== "ask" &&
      tool.decisionOverride !== "always-allow-with-audit"
    ) {
      throw new Error(
        `Builtin meta tool '${tool.name}' requires a supported decisionOverride`,
      );
    }
    return;
  }
  if (hasDecisionOverride) {
    throw new Error(`Non-meta builtin tool '${tool.name}' cannot declare decisionOverride`);
  }
}

export class ToolRegistry {
  /**
   * `name → latest active tool` — fast path for the common lookup.
   * Populated/updated on every register; may point at a deprecated tool when
   * no active version exists.
   */
  private tools = new Map<string, Tool>();
  /**
   * `name → (version → tool)` — secondary index that keeps every registered
   * version so legacy callers can pin a specific version via
   * {@link findByNameVersion} while the LLM-facing path sees only the latest.
   */
  private versioned = new Map<string, Map<string, Tool>>();
  private denyRules: DenyRule[] = [];
  private generation = 0;
  private readonly reservedMcpToolNames = new Map<string, symbol>();
  private readonly reservedPluginOwners = new Map<string, symbol>();
  private readonly reservedMcpOwners = new Map<string, symbol>();

  constructor(private readonly parentGeneration?: () => string) {}

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
    if (this.reservedMcpToolNames.has(tool.name)) {
      throw new Error(`Tool name is reserved by an MCP generation transition: ${tool.name}`);
    }
    if (tool.pluginId && this.reservedPluginOwners.has(tool.pluginId)) {
      throw new Error(`Plugin tool owner is reserved by a generation transition: ${tool.pluginId}`);
    }
    if (tool.mcpServerId && this.reservedMcpOwners.has(tool.mcpServerId)) {
      throw new Error(`MCP tool owner is reserved by a generation transition: ${tool.mcpServerId}`);
    }
    const versionMap = this.addToVersioned(this.versioned, tool);
    this.tools.set(tool.name, this.pickLatest(versionMap));
    this.generation += 1;
  }

  /** Bulk register — used by plugin load and builtin tool registration. */
  registerBatch(tools: Tool[]): void {
    for (const tool of tools) assertToolGovernanceShape(tool);
    for (const tool of tools) this.register(tool);
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
    for (const pluginId of targetPluginIds) {
      if (this.reservedPluginOwners.has(pluginId)) {
        throw new Error(`Plugin tool owner is reserved by a generation transition: ${pluginId}`);
      }
    }
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
      if (this.reservedMcpToolNames.has(tool.name)) {
        throw new Error(`Tool name is reserved by a generation transition: ${tool.name}`);
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
    this.generation += 1;
  }

  /**
   * Kill Switch (tool-governance.md §10.1) — drop every tool from the
   * given MCP server in one pass. Called by McpManager.killSwitch.
   */
  unregisterByMcp(mcpServerId: string): void {
    if (this.reservedMcpOwners.has(mcpServerId)) {
      throw new Error(`MCP tool owner is reserved by a generation transition: ${mcpServerId}`);
    }
    let changed = false;
    for (const [name, versionMap] of this.versioned) {
      for (const [version, tool] of versionMap) {
        if (tool.mcpServerId === mcpServerId) {
          versionMap.delete(version);
          changed = true;
        }
      }
      this.syncLatest(name, versionMap);
    }
    if (changed) this.generation += 1;
  }

  /**
   * Validate and reserve an exact MCP owner replacement without mutating the
   * live registry. publish() performs one synchronous map swap and cannot be
   * interleaved with another registration for a reserved replacement name.
   */
  reserveMcpReplacement(
    predecessorServerIds: Iterable<string>,
    replacementTools: readonly Tool[],
  ): PreparedMcpRegistryReplacement {
    const predecessors = new Set(predecessorServerIds);
    const names = new Set(replacementTools.map((tool) => tool.name));
    for (const tool of replacementTools) {
      if (tool.source !== "mcp" || !tool.mcpServerId) {
        throw new Error(`MCP replacement expected an MCP-owned tool: ${tool.name}`);
      }
    }
    const replacementOwners = new Set(replacementTools.map((tool) => tool.mcpServerId!));
    const reservedOwners = new Set([...predecessors, ...replacementOwners]);
    for (const owner of reservedOwners) {
      if (this.reservedMcpOwners.has(owner)) {
        throw new Error(`MCP tool owner is already reserved: ${owner}`);
      }
    }
    const affectedNames = new Set(names);
    for (const [name, versionMap] of this.versioned) {
      if ([...versionMap.values()].some((tool) =>
        tool.source === "mcp" && tool.mcpServerId && predecessors.has(tool.mcpServerId)
      )) {
        affectedNames.add(name);
      }
    }
    for (const name of affectedNames) {
      if (this.reservedMcpToolNames.has(name)) {
        throw new Error(`MCP replacement tool name is already reserved: ${name}`);
      }
    }
    const validate = this.cloneVersioned();
    this.removeMcpOwners(validate, predecessors);
    for (const tool of replacementTools) this.addToVersioned(validate, tool);
    const nextTools = this.buildLatestMap(validate);
    const token = Symbol("mcp-generation-replacement");
    for (const name of affectedNames) this.reservedMcpToolNames.set(name, token);
    for (const owner of reservedOwners) this.reservedMcpOwners.set(owner, token);

    let settled = false;
    const releaseReservations = () => {
      for (const name of affectedNames) {
        if (this.reservedMcpToolNames.get(name) === token) this.reservedMcpToolNames.delete(name);
      }
      for (const owner of reservedOwners) {
        if (this.reservedMcpOwners.get(owner) === token) this.reservedMcpOwners.delete(owner);
      }
    };
    return Object.freeze({
      replacementTools: Object.freeze([...replacementTools]),
      publish: () => {
        if (settled) return;
        this.publishPreparedNames(validate, nextTools, affectedNames);
        this.generation += 1;
        settled = true;
        releaseReservations();
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        releaseReservations();
      },
    });
  }

  /** Prebuild a plugin-owned registry snapshot; publish is assignment-only. */
  reservePluginReplacement(
    pluginId: string,
    replacementTools: readonly Tool[],
    predecessorMcpServerIds: Iterable<string> = [],
  ): PreparedPluginRegistryReplacement {
    if (!pluginId) throw new Error("Plugin registry replacement requires pluginId");
    if (this.reservedPluginOwners.has(pluginId)) {
      throw new Error(`Plugin tool owner is already reserved: ${pluginId}`);
    }
    for (const tool of replacementTools) {
      if (tool.source !== "plugin" || tool.pluginId !== pluginId) {
        throw new Error(`Plugin replacement expected '${pluginId}' tool: ${tool.name}`);
      }
    }
    const mcpPredecessors = new Set(predecessorMcpServerIds);
    const affectedNames = new Set(replacementTools.map((tool) => tool.name));
    for (const [name, versionMap] of this.versioned) {
      if ([...versionMap.values()].some((tool) =>
        (tool.source === "plugin" && tool.pluginId === pluginId) ||
        (tool.mcpServerId !== undefined && mcpPredecessors.has(tool.mcpServerId))
      )) {
        affectedNames.add(name);
      }
    }
    const nextVersioned = this.cloneVersioned();
    for (const [name, versionMap] of nextVersioned) {
      for (const [version, tool] of versionMap) {
        if (
          (tool.source === "plugin" && tool.pluginId === pluginId) ||
          (tool.mcpServerId !== undefined && mcpPredecessors.has(tool.mcpServerId))
        ) {
          versionMap.delete(version);
        }
      }
      if (versionMap.size === 0) nextVersioned.delete(name);
    }
    for (const tool of replacementTools) this.addToVersioned(nextVersioned, tool);
    const nextTools = this.buildLatestMap(nextVersioned);
    const token = Symbol("plugin-generation-replacement");
    for (const owner of mcpPredecessors) {
      if (this.reservedMcpOwners.has(owner)) {
        throw new Error(`MCP tool owner is already reserved: ${owner}`);
      }
    }
    for (const name of affectedNames) {
      if (this.reservedMcpToolNames.has(name)) {
        throw new Error(`Tool name is already reserved: ${name}`);
      }
    }
    this.reservedPluginOwners.set(pluginId, token);
    for (const owner of mcpPredecessors) this.reservedMcpOwners.set(owner, token);
    for (const name of affectedNames) this.reservedMcpToolNames.set(name, token);
    let settled = false;
    const release = () => {
      if (this.reservedPluginOwners.get(pluginId) === token) this.reservedPluginOwners.delete(pluginId);
      for (const owner of mcpPredecessors) {
        if (this.reservedMcpOwners.get(owner) === token) this.reservedMcpOwners.delete(owner);
      }
      for (const name of affectedNames) {
        if (this.reservedMcpToolNames.get(name) === token) this.reservedMcpToolNames.delete(name);
      }
    };
    return Object.freeze({
      replacementTools: Object.freeze([...replacementTools]),
      publish: () => {
        if (settled) return;
        this.publishPreparedNames(nextVersioned, nextTools, affectedNames);
        this.generation += 1;
        settled = true;
        release();
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        release();
      },
    });
  }

  /**
   * §4.5.6 lookup — used by the executor's Step 1 (Lookup). Returns the
   * `name → latest` map entry (semver-latest for the name's owner), or
   * `undefined` when unregistered.
   */
  findByName(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /**
   * Pin a specific version — used by callers that need to resolve a specific
   * registered version rather than the latest.
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

  /** Full tool list (includes denied tools — for diagnostics). */
  listAll(): Tool[] {
    return [...this.tools.values()];
  }

  /**
   * §6.3 Layer 1 — deny rules applied. Every REGISTERED, non-denied tool: the
   * executable surface, which is a superset of what the model is shown (an MCP Apps
   * app-only tool is registered so the governed executor can run it for its card —
   * see {@link getModelVisibleTools}).
   */
  getVisibleTools(): Tool[] {
    return this.listAll().filter((tool) => !this.isDenied(tool.name));
  }

  /**
   * MODEL-EXPOSURE BOUNDARY — deny rules AND MCP Apps `_meta.ui.visibility`.
   *
   * The ONE place an app-only tool (`["app"]`, hidden from the model by spec) is
   * subtracted, so it holds for BOTH arms at once: a first-party plugin's loopback
   * server and a foreign MCP server both land here through an adapter that
   * materialized {@link Tool.modelVisible}. Every model-facing listing below routes
   * through this; nothing else does — {@link findByName} (the executor's lookup)
   * deliberately still sees app-only tools, because being hidden from the model is
   * not being exempt from the gate.
   */
  getModelVisibleTools(): Tool[] {
    return this.getVisibleTools().filter(isModelExposedTool);
  }

  /** LLM-facing schema array — consumed by SystemPromptBuilder. */
  getToolSchemas(): ToolSchemaEntry[] {
    return this.getModelVisibleTools().map((tool) =>
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
   * Deny rules AND MCP Apps model-visibility apply first (§6.3 Layer 1 + the
   * model-exposure boundary, via {@link getModelVisibleTools}).
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

    return this.getModelVisibleTools()
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
   * - Deny rules + model-visibility apply first (same as the loaded path —
   *   {@link getModelVisibleTools}): a tool the model may not see is not a
   *   candidate it may promote either.
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

    return this.getModelVisibleTools()
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
    this.denyRules = [...rules];
    this.generation += 1;
  }

  /** Monotonic host identity used to invalidate sealed rationale actions. */
  getGeneration(): string {
    const local = String(this.generation);
    return this.parentGeneration ? `${this.parentGeneration()}:${local}` : local;
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
    const scoped = new ToolRegistry(() => this.getGeneration());
    for (const [name, tool] of this.tools) {
      if (allowed.has(name)) scoped.register(tool);
    }
    return scoped;
  }

  // ─── Private ──────────────────────────────────────

  /** Pick the newest version (semver compare) from a version map. */
  private pickLatest(versionMap: Map<string, Tool>): Tool {
    return [...versionMap.values()].reduce((best, cur) =>
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

  private removeMcpOwners(
    index: Map<string, Map<string, Tool>>,
    serverIds: ReadonlySet<string>,
  ): void {
    for (const [name, versionMap] of index) {
      for (const [version, tool] of versionMap) {
        if (tool.source === "mcp" && tool.mcpServerId && serverIds.has(tool.mcpServerId)) {
          versionMap.delete(version);
        }
      }
      if (versionMap.size === 0) index.delete(name);
    }
  }

  private addToVersioned(index: Map<string, Map<string, Tool>>, tool: Tool): Map<string, Tool> {
    assertToolGovernanceShape(tool);
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

  /** Publish only prevalidated entries; unrelated registrations remain intact. */
  private publishPreparedNames(
    nextVersioned: ReadonlyMap<string, Map<string, Tool>>,
    nextTools: ReadonlyMap<string, Tool>,
    affectedNames: ReadonlySet<string>,
  ): void {
    for (const name of affectedNames) {
      const versions = nextVersioned.get(name);
      if (versions) this.versioned.set(name, versions);
      else this.versioned.delete(name);
      const latest = nextTools.get(name);
      if (latest) this.tools.set(name, latest);
      else this.tools.delete(name);
    }
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

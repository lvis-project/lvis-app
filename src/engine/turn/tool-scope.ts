/**
 * Lazy tool-scope resolution helpers (C9 Wave 2).
 *
 * `resolveToolScope` + `rebuildToolSchemas` + scope predicates, extracted from
 * `conversation-loop.ts`. The class keeps delegators that forward `this.deps`
 * and the carry-forward state (lastTurnScope / lastTurnToolNames /
 * sessionActivatedPluginIds).
 */
import type { ToolSchema } from "../llm/types.js";
import type { ToolRegistry } from "../../tools/registry.js";
import { EAGER_TOOL_EXPOSURE_CEILING } from "../../shared/tool-exposure-policy.js";
import { createLogger } from "../../lib/logger.js";
import type { ConversationLoopDeps, ToolScope } from "./types.js";

const log = createLogger("lvis");

function isBuiltinToolInventoryQuestion(input: string): boolean {
  const text = input.toLowerCase();
  const mentionsTool = /tool|툴|도구/.test(text);
  const mentionsBuiltin = /builtin|built-in|빌트인|내장|기본/.test(text);
  const mentionsNonBuiltin = /plugin|플러그인|mcp/.test(text);
  return mentionsTool && mentionsBuiltin && !mentionsNonBuiltin;
}

export function rebuildToolSchemas(toolRegistry: ToolRegistry, scope: ToolScope): ToolSchema[] {
    const raw = toolRegistry.getToolSchemasForScope(scope);
    const result: ToolSchema[] = [];
    for (const s of raw) {
      try {
        result.push({
          name: s.name,
          description: s.description,
          inputSchema: s.input_schema as ToolSchema["inputSchema"],
        });
      } catch (err) {
        log.warn(`rebuildToolSchemas: tool '${s.name}' schema 변환 실패, 건너뜀: %s`, err);
      }
    }
    return result;
  }

export function resolveToolScope(
  input: string,
  deps: ConversationLoopDeps,
  state: {
    lastTurnScope: Set<string> | null;
    lastTurnToolNames: Set<string> | null;
    sessionActivatedPluginIds: Set<string>;
  },
): ToolScope {
    const matched = deps.keywordEngine.matchAllPluginIds(input);
    const resetCarryForward = isBuiltinToolInventoryQuestion(input);
    const activePluginIds = new Set(matched.size > 0
      ? matched
      : (resetCarryForward ? new Set<string>() : (state.lastTurnScope ?? new Set<string>())));
    for (const pluginId of deps.forcedActivePluginIds ?? []) {
      activePluginIds.add(pluginId);
    }
    const allowed = deps.allowedPluginIds;
    if (allowed) {
      const effectiveAllowed = new Set(allowed);
      for (const pluginId of deps.forcedActivePluginIds ?? []) {
        effectiveAllowed.add(pluginId);
      }
      for (const pluginId of [...activePluginIds]) {
        if (!effectiveAllowed.has(pluginId)) activePluginIds.delete(pluginId);
      }
    }

    // #1176 active/inactive — a plugin toggled inactive stays loaded but its
    // tools are hidden from the model. Drop inactive plugins from scope here so
    // their tools vanish next turn with no runtime reload. `enabled !== false`
    // is the active predicate (undefined → active, migration-safe).
    const pluginRuntime = deps.pluginRuntime;
    if (pluginRuntime?.isPluginEnabled) {
      for (const pluginId of [...activePluginIds]) {
        // Session-scoped on-demand activation — a disabled plugin that this
        // session activated via request_plugin keeps its tools in scope for
        // the session lifetime (its tools are already in getVisibleTools).
        // The registry stays `enabled:false`; this is NON-PERSISTENT.
        if (
          !pluginRuntime.isPluginEnabled(pluginId) &&
          !state.sessionActivatedPluginIds.has(pluginId)
        ) {
          activePluginIds.delete(pluginId);
        }
      }
    }

    // #1176 deferral gate — eligible tools are active-plugin + in-scope MCP
    // tools only (builtins/meta-tools are always eager and never counted).
    // Below the ceiling the turn exposes every eligible tool's full schema so
    // the model needs zero `tool_search` discovery rounds; at/above it the turn
    // falls back to deferral so a very large surface does not flood context.
    const deferral = shouldDeferToolSchemas(deps, activePluginIds);

    // (B) keyword→tool preload ∪ carried-forward loaded tools ∪ explicit
    // fixed-surface allowlist. Keyword/carry-forward entries are restricted to
    // tools whose owning plugin is in scope, so a keyword can never load a tool
    // the plugin-scope path would have hidden.
    const activeToolNames = new Set<string>();
    const preloadedToolNames = new Set<string>();
    const forcedToolNames = new Set<string>();
    const inScopeToolNames = scopedToolNameSet(deps, activePluginIds);
    const preloaded = deps.keywordEngine.matchToolNames(
      input,
      (name) => inScopeToolNames.has(name),
    );
    for (const name of preloaded) {
      activeToolNames.add(name);
      preloadedToolNames.add(name);
    }
    for (const name of resetCarryForward ? [] : (state.lastTurnToolNames ?? [])) {
      if (inScopeToolNames.has(name)) activeToolNames.add(name);
    }
    const registeredToolNames = new Set(deps.toolRegistry.getVisibleTools().map((tool) => tool.name));
    for (const name of deps.forcedActiveToolNames ?? []) {
      if (registeredToolNames.has(name)) {
        activeToolNames.add(name);
        forcedToolNames.add(name);
      }
    }

    return {
      activePluginIds,
      activeToolNames,
      preloadedToolNames,
      forcedToolNames,
      includeBuiltins: true,
      includeMcp: deps.headless !== true,
      deferral,
    };
  }

export function scopedToolNameSet(deps: ConversationLoopDeps, activePluginIds: Set<string>): Set<string> {
    const includeMcp = deps.headless !== true;
    const names = new Set<string>();
    for (const tool of deps.toolRegistry.getVisibleTools()) {
      if (tool.source === "plugin") {
        if (tool.pluginId && activePluginIds.has(tool.pluginId)) names.add(tool.name);
      } else if (tool.source === "mcp" && includeMcp) {
        names.add(tool.name);
      }
    }
    return names;
  }

export function shouldDeferToolSchemas(deps: ConversationLoopDeps, activePluginIds: Set<string>): boolean {
    return scopedToolNameSet(deps, activePluginIds).size >= EAGER_TOOL_EXPOSURE_CEILING;
  }

export function filterAllowedPluginIds(deps: ConversationLoopDeps, pluginIds: string[]): string[] {
    const allowed = deps.allowedPluginIds;
    if (!allowed) return pluginIds;
    const effectiveAllowed = new Set(allowed);
    for (const pluginId of deps.forcedActivePluginIds ?? []) {
      effectiveAllowed.add(pluginId);
    }
    return pluginIds.filter((id) => effectiveAllowed.has(id));
  }

export function nextCarryForwardToolNames(
  deps: ConversationLoopDeps,
    scope: ToolScope,
    toolCalls: Array<{ name: string }>,
  ): Set<string> {
    const inScopeToolNames = scopedToolNameSet(deps, scope.activePluginIds);
    const next = new Set<string>();

    for (const name of scope.preloadedToolNames) {
      if (inScopeToolNames.has(name)) next.add(name);
    }
    for (const name of scope.forcedToolNames) {
      if (inScopeToolNames.has(name)) next.add(name);
    }
    for (const call of toolCalls) {
      if (inScopeToolNames.has(call.name)) next.add(call.name);
    }

    return next;
  }

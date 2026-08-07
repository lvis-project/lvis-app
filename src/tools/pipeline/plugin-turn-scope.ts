/**
 * "Which plugin does this invocation reach into?" — the one derivation behind
 * the turn-scope admission check.
 *
 * `ToolScope.activePluginIds` (src/engine/turn/tool-scope.ts) is the per-turn
 * set of plugins the model may use. It reaches enforcement as
 * `permissionContext.allowedPluginIds` (src/engine/turn/query-loop.ts) and the
 * prompt as the skill-catalog / plugin-card filter — one set, several readers.
 *
 * Enforcement used to key on `tool.source === "plugin"` alone, which covers a
 * plugin's TOOLS but not a plugin's SKILL: `skill_load("plugin:<id>:<localId>")`
 * is a BUILTIN tool that pulls a plugin-owned body into the system prompt. The
 * catalog filter (src/prompts/system-prompt-builder.ts) already scoped skills
 * with the same set — docs/development/skill-loading-policy.md states the model
 * must not "see (or load) a skill that references Tools it currently cannot
 * call" — but nothing enforced the "or load" half.
 *
 * Returning the target from ONE function keeps the deny site single: the
 * invocation runner asks what plugin an invocation targets and applies one rule.
 */
import { parsePluginSkillSelector } from "../../shared/plugin-skill-selector.js";

/** The tool-shaped facts the derivation needs. */
export interface PluginTurnScopeToolFacts {
  readonly name: string;
  readonly source: string;
  readonly pluginId?: string;
}

export interface PluginTurnScopeTarget {
  /**
   * The plugin id this invocation reaches into. `null` means "a plugin surface
   * whose owner could not be identified" — fail-closed: the caller denies it,
   * matching the pre-existing `!!tool.pluginId &&` guard for plugin tools.
   */
  readonly pluginId: string | null;
  /** Which plugin-owned surface is being reached — used only for messages. */
  readonly surface: "tool" | "skill";
}

/**
 * The plugin surface this invocation reaches into, or `null` when it reaches
 * none (a builtin, an MCP tool, or `skill_load` of a USER skill).
 */
export function pluginTurnScopeTarget(
  tool: PluginTurnScopeToolFacts,
  input: Record<string, unknown> | undefined,
): PluginTurnScopeTarget | null {
  if (tool.source === "plugin") {
    return { pluginId: tool.pluginId ?? null, surface: "tool" };
  }
  if (tool.name !== "skill_load") return null;
  const skillName = input?.skillName;
  if (typeof skillName !== "string") return null;
  const selector = parsePluginSkillSelector(skillName);
  // A user skill has no plugin owner and is not turn-scoped. A malformed
  // plugin selector is not admitted here either — `skill_load` rejects it
  // against SKILL_SELECTOR_ALLOWLIST, which is built from the SAME pattern this
  // parser uses, so "unparseable here" and "refused there" cannot diverge.
  return selector ? { pluginId: selector.pluginId, surface: "skill" } : null;
}

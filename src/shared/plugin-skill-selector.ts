/**
 * Single authority for the `plugin:<pluginId>:<localId>` skill selector.
 *
 * The selector is MINTED by the skill catalog (`SkillStore`), VALIDATED by
 * `skill_load` / `skill_read`, and — since a plugin skill's body is a
 * plugin-owned surface — must also be READ by the turn-scope gate that decides
 * whether the caller may reach that plugin at all. Three consumers, so the
 * pattern and its parser live here rather than being re-spelled per site.
 */

/**
 * The selector body, WITHOUT anchors, so callers can embed it in a larger
 * alternation (`SKILL_SELECTOR_ALLOWLIST`) without re-typing it.
 */
export const PLUGIN_SKILL_SELECTOR_PATTERN =
  "plugin:([a-z][a-z0-9-]{2,127}):([a-zA-Z_][a-zA-Z0-9_]*)";

const PLUGIN_SKILL_SELECTOR = new RegExp(`^${PLUGIN_SKILL_SELECTOR_PATTERN}$`);

/**
 * Parse a plugin skill selector. Returns `null` for a user skill name or for
 * anything that is not a well-formed plugin selector.
 *
 * By construction this accepts EXACTLY the plugin arm of
 * `SKILL_SELECTOR_ALLOWLIST` (both are built from
 * {@link PLUGIN_SKILL_SELECTOR_PATTERN}): a string this returns non-null for is
 * a string `skill_load` will treat as a plugin selector, and vice versa.
 */
export function parsePluginSkillSelector(
  skillName: string,
): { pluginId: string; localId: string } | null {
  const match = PLUGIN_SKILL_SELECTOR.exec(skillName);
  if (!match) return null;
  return { pluginId: match[1], localId: match[2] };
}

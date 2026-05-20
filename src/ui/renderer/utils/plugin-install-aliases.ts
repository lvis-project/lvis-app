export function getPluginInstallAliases(
  pluginId: string,
  runtimeAliases: readonly string[] = [],
): string[] {
  const normalized = pluginId.trim();
  if (!normalized) return [];
  const aliases = new Set<string>([
    normalized,
    `lvis-plugin-${normalized}`,
    ...runtimeAliases.map((alias) => alias.trim()).filter((alias) => alias.length > 0),
  ]);
  return Array.from(aliases);
}

export function isPluginInstallKey(
  pluginId: string,
  slug: string,
  runtimeAliases: readonly string[] = [],
): boolean {
  return getPluginInstallAliases(pluginId, runtimeAliases).includes(slug);
}

const MARKETPLACE_SLUG_ALIASES: Readonly<Record<string, readonly string[]>> = {
  "work-assistant": ["lvis-plugin-work-proactive"],
};

export function getPluginInstallAliases(pluginId: string): string[] {
  const normalized = pluginId.trim();
  if (!normalized) return [];
  const aliases = new Set<string>([
    normalized,
    `lvis-plugin-${normalized}`,
    ...(MARKETPLACE_SLUG_ALIASES[normalized] ?? []),
  ]);
  return Array.from(aliases);
}

export function isPluginInstallKey(pluginId: string, slug: string): boolean {
  return getPluginInstallAliases(pluginId).includes(slug);
}

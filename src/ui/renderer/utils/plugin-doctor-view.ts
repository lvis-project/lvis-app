const PLUGIN_DOCTOR_VIEW_PREFIX = "plugin-doctor:";

export function toPluginDoctorViewKey(pluginId: string): string {
  return `${PLUGIN_DOCTOR_VIEW_PREFIX}${pluginId}`;
}

export function parsePluginDoctorViewKey(viewKey: string): string | null {
  if (!viewKey.startsWith(PLUGIN_DOCTOR_VIEW_PREFIX)) return null;
  const pluginId = viewKey.slice(PLUGIN_DOCTOR_VIEW_PREFIX.length);
  return pluginId.length > 0 ? pluginId : null;
}

/**
 * Pseudo-key for an installed-but-inactive plugin's sidebar row. Like
 * {@link toPluginDoctorViewKey} it never becomes a location: `handleSidebarSelect`
 * intercepts it and opens Plugin Settings, where the active/inactive toggle
 * lives. It is a SEPARATE prefix because the two rows mean different things —
 * one is a repair, this one is a switch the user themselves turned off — and
 * the doctor key drives a warning toast that would be wrong here.
 */
const PLUGIN_SETTINGS_VIEW_PREFIX = "plugin-settings:";

export function toPluginSettingsViewKey(pluginId: string): string {
  return `${PLUGIN_SETTINGS_VIEW_PREFIX}${pluginId}`;
}

export function parsePluginSettingsViewKey(viewKey: string): string | null {
  if (!viewKey.startsWith(PLUGIN_SETTINGS_VIEW_PREFIX)) return null;
  const pluginId = viewKey.slice(PLUGIN_SETTINGS_VIEW_PREFIX.length);
  return pluginId.length > 0 ? pluginId : null;
}

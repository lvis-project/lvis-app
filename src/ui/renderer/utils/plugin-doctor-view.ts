const PLUGIN_DOCTOR_VIEW_PREFIX = "plugin-doctor:";

export function toPluginDoctorViewKey(pluginId: string): string {
  return `${PLUGIN_DOCTOR_VIEW_PREFIX}${pluginId}`;
}

export function parsePluginDoctorViewKey(viewKey: string): string | null {
  if (!viewKey.startsWith(PLUGIN_DOCTOR_VIEW_PREFIX)) return null;
  const pluginId = viewKey.slice(PLUGIN_DOCTOR_VIEW_PREFIX.length);
  return pluginId.length > 0 ? pluginId : null;
}

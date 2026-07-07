export const PLUGIN_INSTALL_FAILURE_KINDS = [
  "catalog-grant-mismatch",
  "manifest-validation-error",
] as const;

export type PluginInstallFailureKind = (typeof PLUGIN_INSTALL_FAILURE_KINDS)[number];

export function isPluginInstallFailureKind(value: unknown): value is PluginInstallFailureKind {
  return typeof value === "string" && PLUGIN_INSTALL_FAILURE_KINDS.includes(value as PluginInstallFailureKind);
}

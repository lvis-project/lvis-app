export const PLUGIN_INSTALL_FAILURE_KINDS = [
  "catalog-grant-mismatch",
  "manifest-validation-error",
  "incompatible-app-version",
] as const;

export type PluginInstallFailureKind = (typeof PLUGIN_INSTALL_FAILURE_KINDS)[number];

export function isPluginInstallFailureKind(value: unknown): value is PluginInstallFailureKind {
  return typeof value === "string" && PLUGIN_INSTALL_FAILURE_KINDS.includes(value as PluginInstallFailureKind);
}

/**
 * Kinds the Plugin Doctor cannot repair by reinstalling the latest marketplace
 * version:
 *   - `catalog-grant-mismatch` — the downloaded artifact manifest disagrees with
 *     the catalog-approved grant; only fixed by republishing the package.
 *   - `incompatible-app-version` — the plugin requires a newer LVIS build; a
 *     reinstall re-fetches the same too-new package and re-throws, so the user
 *     must update the app instead.
 */
const REINSTALL_NOT_FIXABLE_KINDS: ReadonlySet<PluginInstallFailureKind> = new Set([
  "catalog-grant-mismatch",
  "incompatible-app-version",
]);

/**
 * Doctor cause classifier. Returns `true` when the failure is repairable by
 * reinstalling the latest marketplace version:
 *   - `manifest-validation-error` — a stale/pre-v6/schema-invalid on-disk
 *     manifest; the latest marketplace package ships a valid manifest.
 *   - `undefined` — an unclassified load failure (missing/corrupt files, entry
 *     import error, …). Treated as fixable so the Doctor still offers one
 *     reinstall attempt; if it fails, the caller degrades to the diagnostic +
 *     user-initiated Remove path.
 *
 * NOT-locally-fixable kinds (see {@link REINSTALL_NOT_FIXABLE_KINDS}) return
 * `false` so the Doctor shows a diagnosis instead of looping on a reinstall that
 * cannot succeed.
 */
export function isReinstallFixableFailureKind(kind: PluginInstallFailureKind | undefined): boolean {
  if (kind === undefined) return true;
  return !REINSTALL_NOT_FIXABLE_KINDS.has(kind);
}

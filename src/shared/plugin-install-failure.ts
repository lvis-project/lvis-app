export const PLUGIN_INSTALL_FAILURE_KINDS = [
  "catalog-grant-mismatch",
  "manifest-validation-error",
  "incompatible-app-version",
  "plugin-revoked",
  "untrusted-manifest-path",
  "load-crash",
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
 *   - `plugin-revoked` — the marketplace revocation registry blocks this
 *     exact `slug@version` (explicit blocklist) or the version is below the
 *     plugin's pinned minimum. A reinstall from the marketplace either
 *     re-fetches the same blocked version (the install path enforces the same
 *     registry) or, if the catalog has since published a newer version, is a
 *     genuine upgrade rather than a "repair" — either way looping a reinstall
 *     here is not the right remedy; the Doctor must show the block reason and
 *     point at Remove instead.
 *
 * `untrusted-manifest-path` and `load-crash` are deliberately NOT listed: both
 * are repaired by a reinstall. A marketplace install rewrites the registry row
 * with a `manifestPath` relative to the plugin root (see `marketplace.ts`
 * `commit`), which is exactly the containment the trust predicate demands; and
 * a crash part-way through a load is most often an incomplete or damaged
 * payload, which a reinstall replaces wholesale.
 */
const REINSTALL_NOT_FIXABLE_KINDS: ReadonlySet<PluginInstallFailureKind> = new Set([
  "catalog-grant-mismatch",
  "incompatible-app-version",
  "plugin-revoked",
]);

/**
 * Doctor cause classifier. Returns `true` when the failure is repairable by
 * reinstalling the latest marketplace version:
 *   - `manifest-validation-error` — a stale/pre-v6/schema-invalid on-disk
 *     manifest; the latest marketplace package ships a valid manifest.
 *   - `untrusted-manifest-path` — the registry row names a manifest outside the
 *     plugin root; a marketplace reinstall rewrites that row in place.
 *   - `load-crash` — the load sequence threw somewhere the runtime does not
 *     classify; a reinstall replaces the payload it was reading.
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

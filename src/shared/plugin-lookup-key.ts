/**
 * Plugin catalog lookup-key normalization — shared between main and renderer.
 *
 * Both sides answer the same question: "does this installed plugin correspond
 * to that marketplace catalog item?" Main uses the key to decide whether an
 * admin install is still managed by the catalog (`marketplace.ts`); the
 * renderer uses it to pick which catalog package the plugin Doctor reinstalls
 * (`PluginConfigTab.tsx`). Both compare normalized forms of ids, slugs, names
 * and package specs, so a one-sided edit to the normalization chain silently
 * changes which package one of them resolves — with no type or test to catch
 * it. Same corrective pattern as `shared/plugin-partition.ts` (#498).
 *
 * Pure string function, no DOM / Electron / node deps, so main, renderer and
 * worker contexts can all import it.
 */

/**
 * Reduce a plugin id / package spec / display name to its comparison key.
 *
 * Steps, in order: trim, lowercase, drop an `@scope/` prefix, drop a trailing
 * `@version`, drop the `lvis-plugin-` then `plugin-` package prefixes, collapse
 * every run of non-alphanumerics to a single dash, and trim leading/trailing
 * dashes. Returns `""` for nullish input.
 */
export function normalizePluginLookupKey(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/@[^/@]+$/, "")
    .replace(/^lvis-plugin-/, "")
    .replace(/^plugin-/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
